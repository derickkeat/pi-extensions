# Pi Extensions

A collection of extensions for the [pi coding agent](https://pi.dev). Each extension is maintained as an independent package with its own documentation, tests, and license.

## Extensions

| Extension | Description |
| --- | --- |
| [pi-undo](./pi-undo/) | Rewind conversation context and restore file changes made by pi's `edit` and `write` tools. |
| [pi-work-timer](./pi-work-timer/) | Show elapsed time beside the working indicator and record the final duration. |

## Install from this checkout

> **Security:** Pi extensions execute with your user account's full permissions. Review an extension before enabling it.

For a Git checkout, this repository recommends symlinking each extension into pi's global extension directory:

```bash
cd /path/to/pi-extensions
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-undo/src" ~/.pi/agent/extensions/pi-undo
ln -s "$PWD/pi-work-timer/src" ~/.pi/agent/extensions/pi-work-timer
```

Pi auto-discovers extensions under `~/.pi/agent/extensions/`, making them available in every project.

A symlink is not an automatic updater by itself. It keeps pi pointed at the files in this checkout, so pulling changes updates the extension in place without copying or reinstalling it:

```bash
cd /path/to/pi-extensions
git pull --ff-only
```

After pulling, run `/reload` in pi (or restart pi) to load the updated code.

### Local-package alternative

Pi can also reference a local package without copying it:

```bash
cd /path/to/pi-extensions
pi install "$PWD/pi-undo"
pi install "$PWD/pi-work-timer"
```

This has the same update-in-place behavior after `git pull`. Choose either the symlink or local-package method; using both would load the extension twice.

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
