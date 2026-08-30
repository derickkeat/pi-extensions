# pi-undo

A [pi](https://pi.dev) extension that rewinds both conversation context and file edits.

## What it does

- `/undo` opens a picker containing the user messages on the active branch.
- Selecting a message removes that message and everything after it from the next model prompt.
- The selected prompt text is put back in the editor so it can be changed and resubmitted.
- Changes made by pi's `edit` and `write` tools are restored to their state before the selected turn; in UI modes, pi-undo asks for confirmation first when files are affected.
- `/undo-recover` restores the conversation branch and file state from the most recent undo.
- Repeated undos can be recovered one at a time, as long as the conversation has not continued.

The abandoned conversation is not deleted. pi-undo uses pi's session tree without a branch summary, so future messages are retained for recovery but are not included in subsequent model context.

## Install

From this checkout, symlink the source directory into pi's global extension folder. This keeps the checkout as the source of truth:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/src" ~/.pi/agent/extensions/pi-undo
```

Do not also install the same checkout with `pi install`, or pi will load the extension twice.

To try it for one run instead:

```bash
pi -e ./src/index.ts
```

## Usage

```text
/undo
/undo <user-message-id-or-prefix>
/undo-recover
```

`/undo` normally shows an interactive message picker. Passing an entry ID is useful in RPC or other non-interactive integrations.

## File and Git semantics

pi-undo checkpoints local file content immediately before every `edit` and `write` tool call. It does **not** run Git commands when undoing and never moves `HEAD`, resets the index, deletes commits, or reverses shell commands.

For example, if pi edits a file and then runs `git commit`, undo leaves the commit in place and restores the earlier working-tree content. The repository may therefore have an unstaged reverse diff against that commit. Recovering the undo restores the post-edit content while still leaving the commit untouched.

Deliberate boundaries:

- Files changed only through `bash`, `!`, or `!!` are not restored.
- Side effects such as commits, package installs, database changes, and network operations are not reversed.
- The extension assumes tools named `edit` and `write` operate on the local paths in their arguments. Remote or sandbox overrides with those names should not be combined with pi-undo.

These boundaries keep undo from attempting to reverse arbitrary commands while still making normal pi file edits recoverable.

## Persistence and privacy

Snapshots and recovery metadata are stored under:

```text
<pi agent directory>/extension-data/pi-undo/<session-id>/
```

The agent directory defaults to `~/.pi/agent` and respects `PI_CODING_AGENT_DIR`. Snapshot blobs are content-addressed and created with user-only permissions. They may contain prior versions of sensitive files; remove the corresponding directory when that recovery history is no longer wanted.

Invisible custom session entries persist branch positions. They do not participate in model context.

## Development

```bash
npm install
npm run check
```

Requires Node.js 22.19 or newer and a pi version exposing extension tree navigation (tested with `@earendil-works/pi-coding-agent` 0.84.2).
