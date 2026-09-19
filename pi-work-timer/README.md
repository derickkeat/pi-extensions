# pi-work-timer

A [pi](https://pi.dev) extension that shows how long the agent has been working.

## What it does

While pi is running, the built-in working row updates once per second:

```text
Working · 12s
```

After the agent fully settles, a transcript entry records the total:

```text
Worked for 1m 5s
```

The timer covers the complete agent run, including tool calls, automatic retries, compaction retries, and queued continuations. The final entry is stored in the session but does not participate in model context.

pi-work-timer only changes the interactive TUI. It has no effect in print, JSON, or RPC modes.

## Install

From this directory, symlink the source directory into pi's global extension folder:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/src" ~/.pi/agent/extensions/pi-work-timer
```

Do not also install the same checkout with `pi install`, or pi will load the extension twice.

To try it for one run instead:

```bash
pi -e ./src/index.ts
```

There are no commands or settings. Send a prompt normally and the timer appears automatically.

## Development

```bash
npm install
npm run check
```

Requires Node.js 22.19 or newer and a pi version exposing `setWorkingMessage` and `agent_settled` (tested with `@earendil-works/pi-coding-agent` 0.85.1).
