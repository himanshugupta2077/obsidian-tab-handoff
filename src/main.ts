import { FuzzySuggestModal, Notice, Platform, Plugin, TFile, View, WorkspaceLeaf, debounce, normalizePath } from "obsidian";
import { DeviceState, TabEntry, emptyState, newestPosition, newestTabs, parse, prunePositions, renamePath, serialize, tabSignature, timeAgo } from "./state";

interface WorkspacesInternals {
	activeWorkspace?: string;
}
import { Reader, readerFor } from "./readers";
import { DEFAULT_SETTINGS, TabHandoffSettings, TabHandoffSettingTab } from "./settings";

const DEVICE_ID_KEY = "tab-handoff-device-id";
const DEVICE_NAME_KEY = "tab-handoff-device-name";
// After the app opens or comes back to the foreground, Sync needs a few seconds to pull the other
// device's latest file. State that arrives inside this window is still handed off.
const RESUME_WINDOW_MS = 45_000;
const FLUSH_INTERVAL_MS = 3_000;

export default class TabHandoffPlugin extends Plugin {
	settings: TabHandoffSettings = DEFAULT_SETTINGS;
	deviceId = "";
	deviceName = "";
	local!: DeviceState;
	remotes = new Map<string, DeviceState>();

	private ready = false;
	private dirty = false;
	private applying = false;
	private lastSig = "";
	private ignoreScrollUntil = 0;
	private resumedAt = 0;
	private declinedTabs = 0;
	private askNotice: Notice | null = null;

	async onload() {
		await this.loadSettings();
		this.deviceId = this.loadString(DEVICE_ID_KEY) ?? "";
		if (!this.deviceId) {
			this.deviceId = Math.random().toString(36).slice(2, 10);
			this.app.saveLocalStorage(DEVICE_ID_KEY, this.deviceId);
		}
		this.deviceName = this.loadString(DEVICE_NAME_KEY) ?? defaultDeviceName();
		this.local = emptyState(this.deviceId, this.deviceName);

		this.addSettingTab(new TabHandoffSettingTab(this.app, this));
		this.addCommand({ id: "pick-up-tabs", name: "Pick up tabs from another device", callback: () => new DevicePicker(this).open() });
		this.addCommand({
			id: "jump-to-latest-position",
			name: "Jump to the latest reading position of this file",
			checkCallback: (checking) => {
				const reader = this.activeReader();
				if (!reader) return false;
				if (!checking) this.catchUpPosition(reader, true);
				return true;
			},
		});
		this.addCommand({ id: "save-now", name: "Save this device's tabs and position now", callback: () => this.saveNow() });

		this.app.workspace.onLayoutReady(() => this.start());
	}

	onunload() {
		void this.flush();
	}

	private async start() {
		const strays = await this.strayOwnFiles();
		let own = await this.readState(this.ownPath());
		if (!own && strays.length) {
			// The folder changed since this device last saved: carry its state over to the new one.
			own = await this.readState(strays[0].path);
			this.dirty = true;
		}
		if (own) {
			this.local = own;
			this.local.device.name = this.deviceName;
		}
		// Obsidian restores this device's own tabs on launch. If they match what we saved last time,
		// keep the old timestamp so a newer handoff from another device still wins.
		const tabs = this.currentTabs();
		const sig = tabSignature(tabs.list, tabs.active, tabs.workspace);
		if (sig !== tabSignature(this.local.tabs.list, this.local.tabs.active, this.local.tabs.workspace)) {
			this.local.tabs = { ...tabs, updated: own ? Date.now() : 0 };
			this.dirty = true;
		}
		this.lastSig = sig;
		await this.loadRemotes();
		this.ready = true;

		const { workspace, vault } = this.app;
		this.registerEvent(workspace.on("layout-change", () => this.recordTabs()));
		this.registerEvent(workspace.on("active-leaf-change", () => this.recordTabs()));
		this.registerEvent(workspace.on("file-open", (file) => file && this.onFileOpen(file)));
		const onScroll = debounce(() => this.recordPosition(), 400, true);
		// Scroll events don't bubble, but they can be caught on the way down.
		this.registerDomEvent(document, "scroll", () => onScroll(), { capture: true, passive: true });

		this.registerEvent(vault.on("modify", (f) => this.onVaultFile(f.path)));
		this.registerEvent(vault.on("create", (f) => this.onVaultFile(f.path)));
		this.registerEvent(vault.on("rename", (f, oldPath) => this.onRename(f.path, oldPath)));

		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.hidden) this.saveNow();
			else void this.resume();
		});
		this.registerDomEvent(window, "focus", () => void this.resume());
		this.registerDomEvent(window, "blur", () => this.saveNow());
		this.registerInterval(window.setInterval(() => void this.flush(), FLUSH_INTERVAL_MS));

		await this.flush();
		await this.trashStrays(strays);
		await this.resume();
	}

	// ── Recording this device ─────────────────────────────────────────────

	/** Main-area tabs that show a file. Uses the saved view state so tabs Obsidian hasn't loaded yet still count. */
	private fileLeaves(): { leaf: WorkspaceLeaf; path: string; pinned: boolean }[] {
		const out: { leaf: WorkspaceLeaf; path: string; pinned: boolean }[] = [];
		this.app.workspace.iterateRootLeaves((leaf) => {
			const vs = leaf.getViewState();
			const path = vs.state?.file;
			if (typeof path === "string") out.push({ leaf, path, pinned: !!vs.pinned });
		});
		return out;
	}

	/** Active workspace of the core Workspaces plugin, if it's on and one is active. */
	private activeWorkspace(): string | undefined {
		const plugins = (this.app as unknown as { internalPlugins?: { getEnabledPluginById?(id: string): unknown } }).internalPlugins;
		const workspaces = plugins?.getEnabledPluginById?.("workspaces") as WorkspacesInternals | null | undefined;
		return workspaces?.activeWorkspace || undefined;
	}

	private currentTabs(): { list: TabEntry[]; active: string | null; workspace?: string } {
		const seen = new Set<string>();
		const list: TabEntry[] = [];
		for (const { path, pinned } of this.fileLeaves()) {
			if (seen.has(path)) continue;
			seen.add(path);
			list.push({ path, pinned });
		}
		const recent = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
		const active = recent?.getViewState().state?.file;
		return { list, active: typeof active === "string" ? active : null, workspace: this.activeWorkspace() };
	}

	private recordTabs() {
		if (!this.ready || this.applying || !this.settings.syncTabs) return;
		const tabs = this.currentTabs();
		const sig = tabSignature(tabs.list, tabs.active, tabs.workspace);
		if (sig === this.lastSig) return;
		this.lastSig = sig;
		this.local.tabs = { ...tabs, updated: Date.now() };
		this.markDirty();
	}

	private recordPosition() {
		if (!this.ready || !this.settings.syncPositions || Date.now() < this.ignoreScrollUntil) return;
		const reader = this.activeReader();
		const scroll = reader?.get();
		if (!reader || scroll == null) return;
		const prev = this.local.positions[reader.file.path];
		if (prev && Math.abs(prev.scroll - scroll) < reader.epsilon / 2) return;
		this.local.positions[reader.file.path] = { scroll, ts: Date.now() };
		this.markDirty();
	}

	private markDirty() {
		this.dirty = true;
	}

	private saveNow() {
		this.recordTabs();
		this.recordPosition();
		void this.flush();
	}

	async flush() {
		if (!this.dirty || !this.ready) return;
		this.dirty = false;
		this.local.device.name = this.deviceName;
		this.local.positions = prunePositions(this.local.positions, this.settings.maxPositions);
		try {
			const { vault } = this.app;
			if (!vault.getFolderByPath(this.folder())) await vault.createFolder(this.folder());
			const text = serialize(this.local);
			const file = vault.getFileByPath(this.ownPath());
			if (file) await vault.process(file, () => text);
			else await vault.create(this.ownPath(), text);
		} catch (e) {
			this.dirty = true;
			console.error("Tab Handoff: could not save device state", e);
		}
	}

	// ── Reading other devices ─────────────────────────────────────────────

	folder() {
		return normalizePath(this.settings.folder || DEFAULT_SETTINGS.folder);
	}

	private ownPath() {
		return normalizePath(`${this.folder()}/${this.deviceId}.md`);
	}

	private async readState(path: string): Promise<DeviceState | null> {
		try {
			const file = this.app.vault.getFileByPath(path);
			return file ? parse(await this.app.vault.read(file)) : null;
		} catch {
			return null;
		}
	}

	async loadRemotes() {
		const folder = this.app.vault.getFolderByPath(this.folder());
		if (!folder) return;
		for (const f of folder.children) if (f instanceof TFile) await this.loadRemote(f.path);
	}

	private async loadRemote(path: string) {
		if (path === this.ownPath() || !path.endsWith(".md")) return;
		const s = await this.readState(path);
		if (s && s.device.id !== this.deviceId) this.remotes.set(s.device.id, s);
	}

	private async onVaultFile(path: string) {
		if (!path.startsWith(this.folder() + "/") || path === this.ownPath()) return;
		await this.loadRemote(path);
		// Sync delivered another device's state. Hand it off only if this device just woke up;
		// otherwise you're working here and shouldn't be yanked around.
		if (Date.now() - this.resumedAt < RESUME_WINDOW_MS) await this.handoff();
	}

	/**
	 * Copies of this device's state outside the state folder: left behind when the folder was moved or
	 * changed on another device, or brought back by Sync. Only this device writes its file, so they are stale.
	 */
	private async strayOwnFiles(): Promise<TFile[]> {
		const out: TFile[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (f.basename !== this.deviceId || f.path === this.ownPath()) continue;
			if ((await this.readState(f.path))?.device.id === this.deviceId) out.push(f);
		}
		return out;
	}

	/** Trashes stray copies, and their folder once it is empty, so an old state folder stops coming back. */
	private async trashStrays(strays: TFile[]) {
		const { fileManager } = this.app;
		for (const f of strays) {
			const parent = f.parent;
			await fileManager.trashFile(f);
			if (parent && !parent.isRoot() && parent.path !== this.folder() && parent.children.length === 0) await fileManager.trashFile(parent);
		}
	}

	private async onRename(path: string, oldPath: string) {
		// The state folder itself was moved or renamed: follow it rather than recreating it.
		if (oldPath === this.folder()) {
			this.settings.folder = path;
			await this.saveSettings();
		}
		if (renamePath(this.local, oldPath, path)) this.markDirty();
	}

	// ── Handing off ───────────────────────────────────────────────────────

	private async resume() {
		if (!this.ready || Date.now() - this.resumedAt < 1500) return;
		this.resumedAt = Date.now();
		await this.loadRemotes();
		await this.handoff();
	}

	private async handoff() {
		if (this.settings.syncTabs) {
			const src = newestTabs(this.remotes.values(), this.activeWorkspace());
			if (src && src.tabs.updated > this.local.tabs.updated && src.tabs.updated > this.declinedTabs) {
				if (this.settings.handoffMode === "auto") await this.applyTabs(src);
				else this.askToApply(src);
				return;
			}
		}
		const reader = this.activeReader();
		if (reader) this.catchUpPosition(reader, false);
	}

	private askToApply(src: DeviceState) {
		this.askNotice?.hide();
		const frag = createFragment((f) => {
			f.createDiv({ text: `${src.device.name} has ${src.tabs.list.length} open tabs (${timeAgo(src.tabs.updated)}).` });
			const row = f.createDiv({ cls: "tab-handoff-actions" });
			row.createEl("button", { text: "Open them", cls: "mod-cta" }).onclick = () => {
				this.askNotice?.hide();
				void this.applyTabs(src);
			};
			row.createEl("button", { text: "Not now" }).onclick = () => this.askNotice?.hide();
		});
		this.declinedTabs = src.tabs.updated;
		this.askNotice = new Notice(frag, 0);
	}

	async applyTabs(src: DeviceState) {
		const { workspace, vault } = this.app;
		this.applying = true;
		try {
			const wanted: (TabEntry & { file: TFile })[] = [];
			for (const t of src.tabs.list) {
				const file = vault.getFileByPath(t.path);
				if (file) wanted.push({ ...t, file });
			}
			const wantedPaths = new Set(wanted.map((t) => t.path));
			const open = new Map<string, WorkspaceLeaf>();
			for (const { leaf, path } of this.fileLeaves()) if (!open.has(path)) open.set(path, leaf);

			for (const t of wanted) {
				let leaf = open.get(t.path);
				if (!leaf) {
					leaf = workspace.getLeaf("tab");
					await leaf.openFile(t.file, { active: false });
					open.set(t.path, leaf);
				}
				if (!!leaf.getViewState().pinned !== t.pinned) leaf.setPinned(t.pinned);
			}
			// Mirror: close what the other device closed. Pinned tabs on this device are never closed.
			if (this.settings.mirror) {
				for (const { leaf, path, pinned } of this.fileLeaves()) if (!wantedPaths.has(path) && !pinned) leaf.detach();
			}

			const activeLeaf = src.tabs.active ? open.get(src.tabs.active) : undefined;
			if (activeLeaf) {
				workspace.setActiveLeaf(activeLeaf, { focus: !Platform.isMobile });
				await activeLeaf.loadIfDeferred();
				const reader = readerFor(activeLeaf.view);
				if (reader) this.catchUpPosition(reader, false);
			}
			if (this.settings.notify) new Notice(`Picked up ${wanted.length} tabs from ${src.device.name}`, 3000);
		} finally {
			this.applying = false;
			// Adopt the other device's timestamp, so it doesn't see our copy as "newer" and bounce it back.
			const tabs = this.currentTabs();
			this.lastSig = tabSignature(tabs.list, tabs.active, tabs.workspace);
			this.local.tabs = { ...tabs, updated: src.tabs.updated };
			this.markDirty();
		}
	}

	private activeReader(): Reader | null {
		return readerFor(this.app.workspace.getActiveViewOfType(View));
	}

	/** Moves to the newest position recorded on another device, if that's newer than this device's own. */
	catchUpPosition(reader: Reader, force: boolean) {
		if (!this.settings.syncPositions) return;
		const best = newestPosition([this.local, ...this.remotes.values()], reader.file.path);
		if (!best || (best.from === this.local && !force)) return;
		whenReady(reader, (current) => {
			if (Math.abs(current - best.scroll) < reader.epsilon) return;
			this.moveTo(reader, best.scroll, best.ts);
			if (this.settings.notify && best.from !== this.local) new Notice(`Resumed where you left off on ${best.from.device.name}`, 2500);
		});
	}

	/** A file was opened. If it opened at the top, put it back where it was last read on any device. */
	private onFileOpen(file: TFile) {
		if (!this.settings.restoreOnOpen || !this.settings.syncPositions || this.applying) return;
		window.setTimeout(() => {
			const reader = this.activeReader();
			if (reader?.file !== file) return;
			whenReady(reader, (current) => {
				// Already moved: a link to a heading or page, back/forward history, or a tab that kept its place.
				if (current > reader.epsilon) return;
				const best = newestPosition([this.local, ...this.remotes.values()], file.path);
				if (best && best.scroll > reader.epsilon) this.moveTo(reader, best.scroll, best.ts);
			});
		}, 60);
	}

	private moveTo(reader: Reader, scroll: number, ts: number) {
		const path = reader.file.path;
		const apply = () => {
			if (reader.view.file?.path !== path) return;
			this.ignoreScrollUntil = Date.now() + 1500;
			reader.set(scroll);
		};
		apply();
		// Views lay out lazily (reading view, PDF pages); apply again once they have.
		window.setTimeout(apply, 150);
		window.setTimeout(apply, 500);
		// Same reasoning as tabs: keep the source timestamp so the position doesn't ping-pong.
		this.local.positions[path] = { scroll, ts };
		this.markDirty();
	}

	// ── Settings ──────────────────────────────────────────────────────────

	setDeviceName(name: string) {
		this.deviceName = name.trim() || defaultDeviceName();
		this.app.saveLocalStorage(DEVICE_NAME_KEY, this.deviceName);
		this.markDirty();
	}

	private loadString(key: string): string | null {
		const v: unknown = this.app.loadLocalStorage(key);
		return typeof v === "string" ? v : null;
	}

	/** data.json changed through sync, for example the state folder was changed on another device. */
	async onExternalSettingsChange() {
		const before = this.folder();
		await this.loadSettings();
		if (this.folder() !== before) {
			// Save this device's state in the new folder, then clear it out of the old one.
			this.dirty = true;
			await this.flush();
			await this.trashStrays(await this.strayOwnFiles());
		}
		this.remotes.clear();
		await this.loadRemotes();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<TabHandoffSettings> | null);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/** Calls back with the position once the view has loaded (PDFs take a moment), or gives up after 5 s. */
function whenReady(reader: Reader, cb: (current: number) => void, tries = 25) {
	const pos = reader.get();
	if (pos != null) cb(pos);
	else if (tries > 0) window.setTimeout(() => whenReady(reader, cb, tries - 1), 200);
}

function defaultDeviceName(): string {
	if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android phone";
	if (Platform.isMacOS) return "Mac";
	if (Platform.isWin) return "Windows PC";
	return "Linux PC";
}

class DevicePicker extends FuzzySuggestModal<DeviceState> {
	constructor(private plugin: TabHandoffPlugin) {
		super(plugin.app);
		this.setPlaceholder("Pick up tabs from…");
	}

	getItems() {
		return [...this.plugin.remotes.values()].filter((s) => s.tabs.list.length).sort((a, b) => b.tabs.updated - a.tabs.updated);
	}

	getItemText(s: DeviceState) {
		const workspace = s.tabs.workspace ? ` · ${s.tabs.workspace}` : "";
		return `${s.device.name}${workspace} · ${s.tabs.list.length} tabs · ${timeAgo(s.tabs.updated)}`;
	}

	onChooseItem(s: DeviceState) {
		void this.plugin.applyTabs(s);
	}
}
