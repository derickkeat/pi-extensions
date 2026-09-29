# pi-edited-files

A [pi](https://pi.dev) extension that keeps the files edited in the current session visible above the editor.

## What it does

After a successful `edit` or `write` tool call, the widget shows every affected file and right-aligns its line counts:

```text
── Edited files (2) ────────────────────────────────────────
  src/index.ts                                       +12 -3
  README.md                                          +4  -1
```

The heading is rendered as a border to separate the file summary from the running-agent output. Files are appended in the order they are first successfully edited; editing a listed file again does not move it. Additions and removals use separate left-aligned columns within a fixed area on the right, so both signs stay aligned as counts gain digits.

The counts are the current net diff against each file's contents immediately before its first successful edit in the session. Repeated edits and reversions therefore update the totals instead of accumulating tool activity. A file remains listed as `+0 -0` if its contents return to the baseline.

The file list is stored alongside tool-result details, while baseline contents are kept in user-only files under:

```text
<pi agent directory>/extension-data/pi-edited-files/<session-id>/
```

This lets the summary survive `/reload` and resumed sessions. Baselines may contain sensitive file contents; remove the corresponding directory when that history is no longer wanted.

The widget is only shown in the interactive TUI. It starts tracking a file when a tool named `edit` or `write` first changes it. Later changes to that tracked file—including shell commands or user edits—affect its net counts when the extension next refreshes, but files changed only through other mechanisms are not added to the list.

## Install

From this directory, symlink the source directory into pi's global extension folder:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/src" ~/.pi/agent/extensions/pi-edited-files
```

Do not also install the same checkout with `pi install`, or pi will load the extension twice.

To try it for one run instead:

```bash
pi -e ./src/index.ts
```

There are no commands or settings. The widget appears after the first successful file edit in a session.

## Development

```bash
npm install
npm run check
```

Requires Node.js 22.19 or newer and a pi version exposing extension widgets and unified-patch helpers (tested with `@earendil-works/pi-coding-agent` 0.85.1). The extension assumes tools named `edit` and `write` operate on local paths; remote or sandbox overrides with those names are not supported.
