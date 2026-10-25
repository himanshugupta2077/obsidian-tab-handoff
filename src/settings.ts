import { App, PluginSettingTab, Setting } from "obsidian";
import type TabHandoffPlugin from "./main";
import { timeAgo } from "./state";

export interface TabHandoffSettings {
	syncTabs: boolean;
	handoffMode: "auto" | "ask";
	mirror: boolean;
	syncPositions: boolean;
	restoreOnOpen: boolean;
	notify: boolean;
	folder: string;
	maxPositions: number;
}

export const DEFAULT_SETTINGS: TabHandoffSettings = {
	syncTabs: true,
	handoffMode: "auto",
	mirror: true,
	syncPositions: true,
	restoreOnOpen: true,
	notify: true,
	folder: "_tab-handoff",
	maxPositions: 1000,
};

export class TabHandoffSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: TabHandoffPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl, plugin } = this;
		const s = plugin.settings;
		const save = () => plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl)
			.setName("This device's name")
			.setDesc("Shown on your other devices. Stored on this device only.")
			.addText((t) => t.setValue(plugin.deviceName).onChange((v) => plugin.setDeviceName(v)));

		new Setting(containerEl).setName("Open tabs").setHeading();
		new Setting(containerEl)
			.setName("Hand off open tabs")
			.setDesc("When you come back to this device, open the tabs (and pinned tabs) you had open on the device you used last.")
			.addToggle((t) => t.setValue(s.syncTabs).onChange((v) => ((s.syncTabs = v), save())));
		new Setting(containerEl)
			.setName("When newer tabs are found")
			.addDropdown((d) =>
				d
					.addOptions({ auto: "Open them automatically", ask: "Ask first" })
					.setValue(s.handoffMode)
					.onChange((v) => ((s.handoffMode = v as TabHandoffSettings["handoffMode"]), save())),
			);
		new Setting(containerEl)
			.setName("Mirror closed tabs")
			.setDesc("Also close tabs here that you closed on the other device. Tabs pinned on this device are always kept. Off: only add tabs.")
			.addToggle((t) => t.setValue(s.mirror).onChange((v) => ((s.mirror = v), save())));

		new Setting(containerEl).setName("Reading position").setHeading();
		new Setting(containerEl)
			.setName("Hand off reading position")
			.setDesc("Remember where you were in each note and resume there on your other devices. Works in reading view and editing view.")
			.addToggle((t) => t.setValue(s.syncPositions).onChange((v) => ((s.syncPositions = v), save())));
		new Setting(containerEl)
			.setName("Restore position when opening a note")
			.setDesc("A note that opens at the top jumps to where you last read it, on any device.")
			.addToggle((t) => t.setValue(s.restoreOnOpen).onChange((v) => ((s.restoreOnOpen = v), save())));

		new Setting(containerEl).setName("Other").setHeading();
		new Setting(containerEl)
			.setName("Show a notice after a handoff")
			.addToggle((t) => t.setValue(s.notify).onChange((v) => ((s.notify = v), save())));
		new Setting(containerEl)
			.setName("State folder")
			.setDesc("One small note per device lives here. It must sync, so don't start it with a dot. Use the same folder on every device.")
			.addText((t) =>
				t
					.setPlaceholder(DEFAULT_SETTINGS.folder)
					.setValue(s.folder)
					.onChange((v) => ((s.folder = v.trim() || DEFAULT_SETTINGS.folder), save())),
			);
		new Setting(containerEl)
			.setName("Hide the state folder")
			.setDesc("Adds it to Settings → Files and links → Excluded files, so it stays out of search, graph and the quick switcher.")
			.addButton((b) =>
				b.setButtonText("Hide").onClick(() => {
					// Not in the public API, but it's the same list the "Excluded files" setting edits.
					const vault = this.app.vault as unknown as { getConfig(k: string): unknown; setConfig(k: string, v: unknown): void };
					const filters = (vault.getConfig("userIgnoreFilters") as string[] | null) ?? [];
					const entry = plugin.folder() + "/";
					if (!filters.includes(entry)) vault.setConfig("userIgnoreFilters", [...filters, entry]);
					b.setButtonText("Hidden").setDisabled(true);
				}),
			);

		const devices = [...plugin.remotes.values()];
		new Setting(containerEl).setName("Other devices").setHeading();
		if (!devices.length) containerEl.createEl("p", { text: "None seen yet. Install the plugin on your other devices and open Obsidian there.", cls: "setting-item-description" });
		for (const d of devices)
			new Setting(containerEl)
				.setName(d.device.name)
				.setDesc(`${d.tabs.list.length} tabs · last change ${d.tabs.updated ? timeAgo(d.tabs.updated) : "never"} · ${Object.keys(d.positions).length} positions`)
				.addButton((b) => b.setButtonText("Open its tabs").onClick(() => plugin.applyTabs(d)));
	}
}
