# Pi Extensions

A collection of extensions for the [pi coding agent](https://pi.dev). Each extension is maintained as an independent package with its own documentation, tests, and license.

## Extensions

| Extension | Description |
| --- | --- |
| [pi-edited-files](./pi-edited-files/) | Show files edited in the current session with their current net added and removed line counts. |
| [pi-undo](./pi-undo/) | Rewind conversation context and restore file changes made by pi's `edit` and `write` tools. |
| [pi-work-timer](./pi-work-timer/) | Show elapsed time beside the working indicator and record the final duration. |

## Install from this checkout

> **Security:** Pi extensions execute with your user account's full permissions. Review an extension before enabling it.

From this checkout, install each package by its local path. Pi records the path and loads that directory directly; it does not copy the files:

```bash
cd /path/to/pi-extensions
pi install "$PWD/pi-edited-files"
pi install "$PWD/pi-undo"
pi install "$PWD/pi-work-timer"
```

That makes them available in every project. Pulling this checkout updates the installed extensions in place. `pi update --extensions` does not pull local packages:

```bash
cd /path/to/pi-extensions
git pull --ff-only
```

After pulling, run `/reload` in pi (or restart pi) to load the updated code.

Do not also symlink these packages into `~/.pi/agent/extensions/`. Pi would load each extension twice.

## Development

Install dependencies and run checks from an individual extension directory:

```bash
cd <extension-directory>
npm install
npm run check
```

See each extension's README for its commands, behavior, persistence details, and limitations.

## License

Each extension is licensed separately. See the `LICENSE` file in its directory.
