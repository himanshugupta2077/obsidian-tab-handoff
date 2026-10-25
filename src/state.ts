// Pure helpers for the per-device state files. No Obsidian imports, so they can be unit tested.

export interface TabEntry {
	path: string;
	pinned: boolean;
}

export interface Position {
	/** Top visible line (fractional). Lines, not pixels, so it means the same thing on every screen size. */
	scroll: number;
	ts: number;
}

export interface DeviceState {
	version: 1;
	device: { id: string; name: string };
	tabs: { updated: number; active: string | null; list: TabEntry[] };
	positions: Record<string, Position>;
}

const FENCE_OPEN = "```json";
const FENCE_CLOSE = "```";

export function emptyState(id: string, name: string): DeviceState {
	return { version: 1, device: { id, name }, tabs: { updated: 0, active: null, list: [] }, positions: {} };
}

// Each device writes only its own file, so Obsidian Sync never has to merge two writers.
// It's Markdown (not .json) because Sync carries .md files with default settings.
export function serialize(state: DeviceState): string {
	return [
		"---",
		"tab-handoff: device-state",
		`device: ${JSON.stringify(state.device.name)}`,
		"---",
		"",
		"Managed by the Tab Handoff plugin: open tabs and reading positions for this device. Don't edit by hand.",
		"",
		FENCE_OPEN,
		JSON.stringify(state, null, "\t"),
		FENCE_CLOSE,
		"",
	].join("\n");
}

export function parse(text: string): DeviceState | null {
	const start = text.indexOf(FENCE_OPEN);
	if (start < 0) return null;
	const end = text.indexOf("\n" + FENCE_CLOSE, start + FENCE_OPEN.length);
	if (end < 0) return null;
	try {
		const s = JSON.parse(text.slice(start + FENCE_OPEN.length, end)) as Partial<DeviceState> | null;
		if (s?.version !== 1 || typeof s.device?.id !== "string" || !Array.isArray(s.tabs?.list)) return null;
		return { ...s, positions: s.positions ?? {} } as DeviceState;
	} catch {
		return null;
	}
}

/** Order-independent: a desktop with splits and a phone with one tab strip list the same tabs in different orders. */
export function tabSignature(list: TabEntry[], active: string | null): string {
	return JSON.stringify([active, list.map((t) => (t.pinned ? "*" : "") + t.path).sort()]);
}

export function newestTabs(remotes: Iterable<DeviceState>): DeviceState | null {
	let best: DeviceState | null = null;
	for (const s of remotes) if (s.tabs.list.length && (!best || s.tabs.updated > best.tabs.updated)) best = s;
	return best;
}

export function newestPosition(states: Iterable<DeviceState>, path: string): (Position & { from: DeviceState }) | null {
	let best: (Position & { from: DeviceState }) | null = null;
	for (const s of states) {
		const p = s.positions[path];
		if (p && (!best || p.ts > best.ts)) best = { ...p, from: s };
	}
	return best;
}

export function prunePositions(positions: Record<string, Position>, max: number): Record<string, Position> {
	const entries = Object.entries(positions);
	if (entries.length <= max) return positions;
	return Object.fromEntries(entries.sort((a, b) => b[1].ts - a[1].ts).slice(0, max));
}

/** Rewrites paths after a file or folder rename. Returns true if anything changed. */
export function renamePath(state: DeviceState, oldPath: string, newPath: string): boolean {
	const move = (p: string) => (p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : null);
	let changed = false;
	for (const t of state.tabs.list) {
		const n = move(t.path);
		if (n) {
			t.path = n;
			changed = true;
		}
	}
	const active = state.tabs.active && move(state.tabs.active);
	if (active) {
		state.tabs.active = active;
		changed = true;
	}
	for (const [p, pos] of Object.entries(state.positions)) {
		const n = move(p);
		if (n) {
			delete state.positions[p];
			state.positions[n] = pos;
			changed = true;
		}
	}
	return changed;
}

export function timeAgo(ts: number, now = Date.now()): string {
	const s = Math.max(0, Math.round((now - ts) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
}
