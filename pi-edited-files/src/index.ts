import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateUnifiedPatch,
  getAgentDir,
  isEditToolResult,
  isToolCallEventType,
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { BaselineStore, type BaselineCapture, type BaselineSnapshot } from "./store.ts";

const DETAILS_KEY = "piEditedFiles";
const WIDGET_KEY = "pi-edited-files";

export interface LineChanges {
  added: number;
  removed: number;
}

interface TrackedFile extends LineChanges {
  path: string;
  order: number;
  available: boolean;
}

interface PersistedMutation {
  version: 2;
  sessionId: string;
  path: string;
  order: number;
}

interface PendingMutation {
  path: string;
  order: number;
  baseline?: BaselineSnapshot;
  capture?: BaselineCapture;
  captureError?: string;
}

interface DisplayFile extends LineChanges {
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseMutation(value: unknown, sessionId: string): PersistedMutation | undefined {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.sessionId !== sessionId ||
    typeof value.path !== "string" ||
    !value.path ||
    !isNonNegativeInteger(value.order)
  ) {
    return undefined;
  }

  return {
    version: 2,
    sessionId,
    path: value.path,
    order: value.order,
  };
}

function mutationFromDetails(details: unknown, sessionId: string): PersistedMutation | undefined {
  return isRecord(details) ? parseMutation(details[DETAILS_KEY], sessionId) : undefined;
}

function filesFromBranch(branch: readonly SessionEntry[], sessionId: string): TrackedFile[] {
  const files = new Map<string, TrackedFile>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const mutation = mutationFromDetails(entry.message.details, sessionId);
    if (!mutation) continue;

    const existing = files.get(mutation.path);
    if (existing) existing.order = Math.min(existing.order, mutation.order);
    else {
      files.set(mutation.path, {
        path: mutation.path,
        order: mutation.order,
        added: 0,
        removed: 0,
        available: false,
      });
    }
  }
  return [...files.values()];
}

function attachMutation(details: unknown, mutation: PersistedMutation): Record<string, unknown> {
  return {
    ...(isRecord(details) ? details : {}),
    [DETAILS_KEY]: mutation,
  };
}

function rawMutationPath(input: Record<string, unknown>): string | undefined {
  if (typeof input.path === "string") return input.path;
  if (typeof input.file_path === "string") return input.file_path;
  return undefined;
}

function safeSessionDirectoryName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function normalizeWindowsShellPath(input: string, platform = process.platform): string {
  if (platform !== "win32" || !input.startsWith("/") || input.startsWith("//") || input.includes("\\")) {
    return input;
  }
  const match = input.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return input;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

/** Resolve paths like pi's local edit and write tools, then follow existing symlinks. */
export async function resolveMutationPath(rawPath: string, cwd: string): Promise<string> {
  let input = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  input = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  input = normalizeWindowsShellPath(input);

  if (input === "~") input = homedir();
  else if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
    input = resolve(homedir(), input.slice(2));
  }

  const localPath = input.startsWith("file://") ? fileURLToPath(input) : input;
  const absolute = normalize(isAbsolute(localPath) ? localPath : resolve(cwd, localPath));
  return canonicalizePotentialPath(absolute);
}

async function canonicalizePotentialPath(input: string, depth = 0): Promise<string> {
  if (depth > 32) throw new Error(`Too many symbolic links while resolving ${input}`);

  try {
    return await realpath(input);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  // realpath() also fails for a dangling final symlink. Follow its target because
  // writeFile() would write through that link rather than replacing the link itself.
  try {
    const stat = await lstat(input);
    if (stat.isSymbolicLink()) {
      const target = await readlink(input);
      const targetPath = isAbsolute(target) ? target : resolve(dirname(input), target);
      return canonicalizePotentialPath(targetPath, depth + 1);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  // The final path may not exist while one of its parents is a symlink. Resolve
  // the nearest existing ancestor and then append the missing path segments.
  const suffix: string[] = [];
  let cursor = input;
  while (true) {
    const parent = dirname(cursor);
    if (parent === cursor) return input;
    suffix.push(basename(cursor));
    cursor = parent;

    try {
      const resolvedAncestor = await realpath(cursor);
      return resolve(resolvedAncestor, ...suffix.reverse());
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
}

function displayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  if (
    relativePath &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  ) {
    return relativePath;
  }
  return path;
}

/** Count additions and removals in a standard unified patch. */
export function countPatchLines(patch: string): LineChanges {
  let added = 0;
  let removed = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }

  return { added, removed };
}

export function countChangedLines(before: string, after: string): LineChanges {
  return countPatchLines(generateUnifiedPatch("file", before, after, 0));
}

async function readCurrentFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
}

function renderFileLine(
  file: DisplayFile,
  width: number,
  addedWidth: number,
  removedWidth: number,
  theme: Theme,
): string {
  const added = `+${file.added}`;
  const removed = `-${file.removed}`;
  const counts =
    theme.fg("toolDiffAdded", added) +
    " ".repeat(addedWidth - visibleWidth(added)) +
    " " +
    theme.fg("toolDiffRemoved", removed) +
    " ".repeat(removedWidth - visibleWidth(removed));
  const countsWidth = addedWidth + 1 + removedWidth;

  if (width <= countsWidth) return truncateToWidth(counts, width, "");

  const pathWidth = width - countsWidth - 1;
  const path = truncateToWidth(
    theme.fg("muted", `  ${file.path}`),
    pathWidth,
    theme.fg("muted", "…"),
  );
  const gap = " ".repeat(Math.max(1, width - visibleWidth(path) - countsWidth));
  return path + gap + counts;
}

class EditedFilesWidget implements Component {
  constructor(
    private readonly files: readonly DisplayFile[],
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const title = ` Edited files (${this.files.length}) `;
    const leftBorderWidth = 2;
    const rightBorderWidth = Math.max(0, width - leftBorderWidth - visibleWidth(title));
    const heading = truncateToWidth(
      this.theme.fg("borderMuted", "─".repeat(leftBorderWidth)) +
        this.theme.fg("muted", this.theme.bold(title)) +
        this.theme.fg("borderMuted", "─".repeat(rightBorderWidth)),
      width,
      this.theme.fg("muted", "…"),
    );
    const addedWidth = Math.max(...this.files.map((file) => visibleWidth(`+${file.added}`)));
    const removedWidth = Math.max(...this.files.map((file) => visibleWidth(`-${file.removed}`)));
    return [
      heading,
      ...this.files.map((file) =>
        renderFileLine(file, width, addedWidth, removedWidth, this.theme),
      ),
    ];
  }

  invalidate(): void {}
}

export default function piEditedFiles(pi: ExtensionAPI): void {
  let store: BaselineStore | undefined;
  let storeError: string | undefined;
  let sessionId = "";
  let changes = new Map<string, TrackedFile>();
  let nextOrder = 0;
  const pending = new Map<string, PendingMutation>();
  const reportedErrors = new Map<string, string>();

  const reportFileError = (path: string, error: unknown, ctx: ExtensionContext): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (reportedErrors.get(path) === message) return;
    reportedErrors.set(path, message);
    ctx.ui.notify(`pi-edited-files could not update ${displayPath(path, ctx.cwd)}: ${message}`, "warning");
  };

  const restoreBranchState = (ctx: ExtensionContext): void => {
    const files = filesFromBranch(ctx.sessionManager.getBranch(), sessionId);
    changes = new Map(files.map((file) => [file.path, file]));
    nextOrder = files.reduce((maximum, file) => Math.max(maximum, file.order + 1), 0);
  };

  const refreshCounts = async (ctx: ExtensionContext): Promise<void> => {
    if (!store) return;

    for (const file of changes.values()) {
      const baseline = store.get(file.path);
      if (!baseline) {
        file.available = false;
        reportFileError(file.path, new Error("the saved baseline is missing"), ctx);
        continue;
      }

      try {
        const [before, after] = await Promise.all([
          store.read(baseline),
          readCurrentFile(file.path),
        ]);
        const lineChanges = countChangedLines(before, after);
        file.added = lineChanges.added;
        file.removed = lineChanges.removed;
        file.available = true;
        reportedErrors.delete(file.path);
      } catch (error) {
        file.available = false;
        reportFileError(file.path, error, ctx);
      }
    }
  };

  const updateWidget = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const availableFiles = [...changes.values()].filter((file) => file.available);
    if (availableFiles.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    const files = availableFiles
      .sort((left, right) => left.order - right.order)
      .map((file) => ({
        path: displayPath(file.path, ctx.cwd),
        added: file.added,
        removed: file.removed,
      }));
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => new EditedFilesWidget(files, theme),
      { placement: "aboveEditor" },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    pending.clear();
    reportedErrors.clear();
    store = undefined;
    storeError = undefined;
    sessionId = ctx.sessionManager.getSessionId();

    try {
      const root = join(
        getAgentDir(),
        "extension-data",
        "pi-edited-files",
        safeSessionDirectoryName(sessionId),
      );
      store = await BaselineStore.open(root, sessionId);
      restoreBranchState(ctx);
      await refreshCounts(ctx);
    } catch (error) {
      changes.clear();
      storeError = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-edited-files disabled: ${storeError}`, "error");
    }
    updateWidget(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    pending.clear();
    restoreBranchState(ctx);
    await refreshCounts(ctx);
    updateWidget(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    let rawPath: string;
    if (isToolCallEventType("edit", event)) rawPath = event.input.path;
    else if (isToolCallEventType("write", event)) rawPath = event.input.path;
    else return;
    if (!store) return;

    try {
      const path = await resolveMutationPath(rawPath, ctx.cwd);
      const order = changes.get(path)?.order ?? nextOrder++;
      const savedBaseline = store.get(path);
      if (savedBaseline) {
        pending.set(event.toolCallId, { path, order, baseline: savedBaseline });
        return;
      }

      try {
        const capture = await store.capture(path);
        pending.set(event.toolCallId, { path, order, capture });
      } catch (error) {
        pending.set(event.toolCallId, {
          path,
          order,
          captureError: error instanceof Error ? error.message : String(error),
        });
      }
    } catch {
      // A malformed or non-local path should not interfere with the tool itself.
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const isEdit = isEditToolResult(event);
    const isWrite = isWriteToolResult(event);
    if (!isEdit && !isWrite) return;

    const mutation = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (event.isError || !store) return;

    let path = mutation?.path;
    if (!path) {
      const rawPath = rawMutationPath(event.input);
      if (!rawPath) return;
      try {
        path = await resolveMutationPath(rawPath, ctx.cwd);
      } catch {
        return;
      }
    }

    let baseline = store.get(path) ?? mutation?.baseline;
    if (!baseline && mutation?.capture) {
      try {
        baseline = await store.ensure(path, mutation.capture);
      } catch (error) {
        reportFileError(path, error, ctx);
        return;
      }
    }
    if (!baseline) {
      reportFileError(
        path,
        new Error(mutation?.captureError ?? storeError ?? "the pre-edit baseline was not captured"),
        ctx,
      );
      return;
    }

    const order = mutation?.order ?? changes.get(path)?.order ?? nextOrder++;
    const existing = changes.get(path);
    if (existing) existing.order = Math.min(existing.order, order);
    else {
      changes.set(path, {
        path,
        order,
        added: 0,
        removed: 0,
        available: false,
      });
    }

    await refreshCounts(ctx);
    updateWidget(ctx);

    const tracked = changes.get(path)!;
    const persistedMutation: PersistedMutation = {
      version: 2,
      sessionId,
      path,
      order: tracked.order,
    };
    return { details: attachMutation(event.details, persistedMutation) };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    await refreshCounts(ctx);
    updateWidget(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    pending.clear();
    store = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
