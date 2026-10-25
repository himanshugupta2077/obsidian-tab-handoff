# Tab Handoff

Pick up where you left off, on any device.

Close Obsidian on your laptop, open it on your phone, and your tabs are there: the same notes, the same pinned tabs, scrolled to the line you were reading, and your PDFs open on the same page. Go back to the laptop and it catches up with what you did on the phone. It works like a Kindle that syncs your page, but for your whole vault.

Obsidian keeps open tabs per device (`workspace.json` on desktop, `workspace-mobile.json` on mobile), and Obsidian Sync doesn't carry them between devices. Tab Handoff fills that gap.

## What it hands off

- **Open tabs**: every note open in the main area, in desktop splits or on the phone's tab strip.
- **Pinned tabs**: pinned on one device, pinned on the other.
- **The note you were looking at**: it becomes the active tab.
- **Reading position in every note**: in reading view and in editing view. Positions are stored as line numbers, not pixels, so a phone and a 27" monitor land on the same paragraph.
- **Page in every PDF**: the page and how far down it you were, so it opens halfway down page 12 if that's where you stopped.

## How it works

```
 Laptop                       Phone
 ──────                       ─────
 _tab-handoff/k3f9a1.md  ◀──▶  _tab-handoff/p8x2c0.md
   (tabs + positions)    sync    (tabs + positions)
```

1. Each device writes one small note in `_tab-handoff/` with its open tabs and the last position in each note it read. It's saved a few seconds after a change, and right away when the app goes to the background.
2. Your sync (Obsidian Sync, iCloud, Syncthing, Git…) carries those notes like any other note. Each device writes **only its own file**, so there are never sync conflicts.
3. When you open or come back to Obsidian on a device, it checks whether another device has newer tabs. If it does, it opens them, and scrolls the active note to where you stopped. If the other device's file arrives a few seconds late (sync is still catching up), it still gets picked up.
4. While you're working on a device, nothing gets pulled out from under you. A handoff only happens when you come back to a device.

Opening any note or PDF that lands at the top also restores where you last read it, on whichever device that was.

## Install

Requires Obsidian 1.8.7 or later, on desktop or mobile.

**With BRAT**: install [BRAT](https://github.com/TfTHacker/obsidian42-brat), choose *Add beta plugin*, and enter `himanshugupta2077/obsidian-tab-handoff`.

**By hand**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/himanshugupta2077/obsidian-tab-handoff/releases/latest) into `<vault>/.obsidian/plugins/tab-handoff/`, then enable **Tab Handoff** in *Settings → Community plugins*.

Install it on **every** device. With Obsidian Sync you can install it once and turn on *Settings → Sync → Installed community plugins* and *Active community plugin list* to get it on your phone too.

## Settings

| Setting | Default | |
|---|---|---|
| This device's name | Mac / iPhone / … | Shown on your other devices. Kept on this device only. |
| Hand off open tabs | on | |
| When newer tabs are found | Open them automatically | Or *Ask first*: a notice with **Open them** / **Not now**. |
| Mirror closed tabs | on | Also close tabs you closed on the other device. Tabs pinned on this device are never closed. Off: only add tabs. |
| Hand off reading position | on | |
| Restore position when opening a note | on | |
| Show a notice after a handoff | on | |
| State folder | `_tab-handoff` | Must sync, so no leading dot. You can also just move or rename the folder in the file explorer; the plugin follows it. The **Hide** button adds it to *Excluded files* so it stays out of search and the graph. |

The settings page also lists your other devices, with a button to open any device's tabs.

## Commands

- **Pick up tabs from another device**: choose a device and open its tabs now.
- **Jump to the latest reading position of this file**
- **Save this device's tabs and position now**

## Notes

- Only notes and files in the main area are handed off. Sidebars and the split layout stay as each device has them, and tabs from the other device open in the current tab group.
- Files that haven't synced to this device yet are skipped.
- On a phone, Obsidian Sync uploads when the app is open. If you lock the phone the moment you stop reading, the last few seconds may only upload the next time you open Obsidian there.
- Reading positions are tracked for Markdown notes and PDFs. Canvases and other views open as tabs, but their position isn't handed off.
- Device clocks are used to decide which device is newer, so keep automatic time on (it is by default).

## Development

```sh
npm install
npm test                                   # unit tests for the state format and merge rules
npm run lint                               # Obsidian's official review rules (eslint-plugin-obsidianmd)
VAULTS="/path/to/vault" npm run build      # build and copy into a vault's plugin folder
```

## License

MIT
