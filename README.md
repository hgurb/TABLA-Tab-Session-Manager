# TABLA Tab & Session Manager

Group Chrome tabs, organize windows, save sessions, and recover group layouts locally.

**1.0.1**

## Features

- Automatic grouping by domain or opening tab, with favicon colors, custom rules, exclusions, and size limits.
- Separate options to ungroup the last remaining tab after other tabs are closed or moved out.
- Merge same-named groups intact while keeping mixed-domain tabs and the first group’s name and color.
- Group, ungroup, collapse/expand, or move groups left/right in one window or all regular windows.
- Merge windows into the current window while preserving tabs, pins, and existing groups.
- Save sessions with or without closing their window; restore whole sessions or individual links.
- Local group recovery, backups, and section-selective settings import/export.

## Install

1. Download the repository and extract it.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted extension folder. No build step is needed.
4. Pin TABLA. For restart recovery, set Chrome to **Continue where you left off**.

## Use

Open the toolbar popup for window actions, saved sessions, and the session library. **Auto-group** controls automatic grouping only. **Merge windows** gathers windows; **Group tabs** then combines same-named groups. Grouping and movement have per-window Undo; merging windows does not.

Chrome restores tabs; TABLA repairs their groups. Startup recovery can take up to two minutes and does not reopen missing tabs. Identical windows and duplicate URLs can make recovery ambiguous. Expand keeps groups open until you switch tabs. Chrome controls the placement of ungrouped tabs.

Data stays in your Chrome profile. Incognito is excluded. See [Privacy](PRIVACY.md).

## License

[MIT](LICENSE). Bundled third-party code retains its included license.
