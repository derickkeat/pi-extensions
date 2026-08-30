import { join } from "node:path";
import {
  DynamicBorder,
  getAgentDir,
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
  selectUndoSnapshots,
  resolveMutationPath,
  type PathSnapshot,
  type RecoveryRecord,
  type RestoreFailure,
  UndoStore,
} from "./snapshots.ts";

const ENTRY_TYPE = "pi-undo";
const CURRENT_PICKER_VALUE = "__pi_undo_current__";

interface UserTurn {
  entry: SessionMessageEntry;
  text: string;
}

interface MarkerData {
  version: 1;
  action: "source" | "undo" | "recover";
  recoveryId: string;
  targetUserEntryId: string;
}

function userMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role !== "user") return "";
  const { content } = entry.message;
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function userTurns(branch: readonly SessionEntry[]): UserTurn[] {
  return branch
    .filter(
      (entry): entry is SessionMessageEntry =>
        entry.type === "message" && entry.message.role === "user",
    )
    .map((entry) => ({ entry, text: userMessageText(entry) }));
}

function latestUserTurn(branch: readonly SessionEntry[]): UserTurn | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type === "message" && entry.message.role === "user") {
      return { entry, text: userMessageText(entry) };
    }
  }
  return undefined;
}

function oneLine(text: string, maximum = 88): string {
  const collapsed = text.replace(/\s+/g, " ").trim() || "[image-only message]";
  return collapsed.length <= maximum ? collapsed : `${collapsed.slice(0, maximum - 1)}…`;
}

function markerEntry(entry: SessionEntry | undefined): boolean {
  return entry?.type === "custom" && entry.customType === ENTRY_TYPE;
}

/** Trailing pi-undo custom entries do not affect model context. */
function contextEquivalent(
  sessionManager: ExtensionCommandContext["sessionManager"],
  currentLeafId: string | null,
  expectedLeafId: string,
): boolean {
  let cursor = currentLeafId;
  while (cursor !== null) {
    if (cursor === expectedLeafId) return true;
    const entry = sessionManager.getEntry(cursor);
    if (!markerEntry(entry)) return false;
    cursor = entry!.parentId;
  }
  return false;
}

function appendMarker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  data: MarkerData,
): string {
  pi.appendEntry(ENTRY_TYPE, data);
  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) throw new Error("pi-undo could not persist the session branch marker");
  return leafId;
}

function safeSessionDirectoryName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function restoreErrorStrings(failures: readonly RestoreFailure[]): string[] {
  return failures.map(({ snapshot, error }) => `${snapshot.path}: ${error.message}`);
}

function notifyRestoreFailures(
  ctx: ExtensionCommandContext,
  action: "Undo" | "Recovery",
  failures: readonly RestoreFailure[],
): void {
  if (failures.length === 0) return;
  const first = failures[0]!;
  const extra = failures.length > 1 ? ` (+${failures.length - 1} more)` : "";
  ctx.ui.notify(`${action} completed, but ${first.snapshot.path} failed: ${first.error.message}${extra}`, "error");
}

async function captureCurrentFiles(store: UndoStore, snapshots: readonly PathSnapshot[]): Promise<PathSnapshot[]> {
  const captured: PathSnapshot[] = [];
  for (const snapshot of snapshots) captured.push(await store.capture(snapshot.path));
  return captured;
}

async function chooseTurn(
  argument: string,
  turns: readonly UserTurn[],
  store: UndoStore,
  ctx: ExtensionCommandContext,
): Promise<UserTurn | undefined> {
  const requested = argument.trim();
  if (requested) {
    const matches = turns.filter(({ entry }) => entry.id === requested || entry.id.startsWith(requested));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      ctx.ui.notify(`Message id prefix is ambiguous: ${requested}`, "error");
      return undefined;
    }
    ctx.ui.notify(`No user message on the active branch matches: ${requested}`, "error");
    return undefined;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify("Usage: /undo <user-message-id>", "error");
    return undefined;
  }

  const appliedChanges = store.getChanges().filter((change) => change.status === "applied");
  const turnOptions = turns.map((turn) => {
    const { entry, text } = turn;
    const changedFiles = new Set(
      appliedChanges
        .filter((change) => change.userEntryId === entry.id)
        .map((change) => change.before.path),
    ).size;
    const fileSuffix = changedFiles > 0 ? `  (${changedFiles} file${changedFiles === 1 ? "" : "s"})` : "";
    return { turn, label: `${oneLine(text)}${fileSuffix}` };
  });

  if (ctx.mode === "tui") {
    const selectedId = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Undo this user message and everything after it:")), 1, 0));

      const items: SelectItem[] = [
        ...turnOptions.map(({ turn, label }) => ({ value: turn.entry.id, label })),
        { value: CURRENT_PICKER_VALUE, label: theme.italic("(current)") },
      ];
      const list = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      list.setSelectedIndex(items.length - 1);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
      container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

      return {
        render: (width) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
    if (selectedId === null || selectedId === CURRENT_PICKER_VALUE) return undefined;
    return turns.find(({ entry }) => entry.id === selectedId);
  }

  const optionToTurn = new Map<string, UserTurn>();
  const options = turnOptions.map(({ turn, label }) => {
    let option = label;
    // Keep identical messages independently selectable without adding visible metadata.
    while (optionToTurn.has(option)) option += "\u200b";
    optionToTurn.set(option, turn);
    return option;
  });
  const currentOption = `${ctx.ui.theme.italic("(current)")}\u2063`;
  options.push(currentOption);
  const selected = await ctx.ui.select("Undo this user message and everything after it:", options);
  if (selected === undefined || selected === currentOption) return undefined;
  return optionToTurn.get(selected);
}

function findRecoverableRecord(
  recoveries: readonly RecoveryRecord[],
  ctx: ExtensionCommandContext,
): RecoveryRecord | undefined {
  const currentLeafId = ctx.sessionManager.getLeafId();
  for (let index = recoveries.length - 1; index >= 0; index--) {
    const recovery = recoveries[index]!;
    if (
      recovery.status === "available" &&
      recovery.undoLeafId &&
      contextEquivalent(ctx.sessionManager, currentLeafId, recovery.undoLeafId)
    ) {
      return recovery;
    }
  }
  return undefined;
}

export default function piUndo(pi: ExtensionAPI): void {
  let store: UndoStore | undefined;
  let storeError: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    store = undefined;
    storeError = undefined;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const root = join(getAgentDir(), "extension-data", "pi-undo", safeSessionDirectoryName(sessionId));
      store = await UndoStore.open(root, sessionId, ctx.cwd);
    } catch (error) {
      storeError = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-undo disabled: ${storeError}`, "error");
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    let rawPath: string | undefined;
    if (isToolCallEventType("edit", event)) rawPath = event.input.path;
    else if (isToolCallEventType("write", event)) rawPath = event.input.path;
    else return;

    if (!store) {
      const reason = storeError ?? "snapshot store is not initialized";
      return { block: true, reason: `pi-undo cannot checkpoint this file edit: ${reason}` };
    }

    const userTurn = latestUserTurn(ctx.sessionManager.getBranch());
    if (!userTurn) {
      return {
        block: true,
        reason: "pi-undo cannot associate this file edit with a user message",
      };
    }

    try {
      const path = await resolveMutationPath(rawPath, ctx.cwd);
      await store.beginChange(event.toolCallId, userTurn.entry.id, path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`File edit blocked because pi-undo could not checkpoint it: ${message}`, "error");
      return {
        block: true,
        reason: `pi-undo could not checkpoint ${rawPath}: ${message}`,
      };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (!store) return;
    try {
      await store.completeChange(event.toolCallId, !event.isError);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-undo could not finalize a file checkpoint: ${message}`, "error");
    }
  });

  pi.registerCommand("undo", {
    description: "Undo back through a chosen user message, including edit/write file changes",
    handler: async (argument, ctx) => {
      await ctx.waitForIdle();
      if (!store) {
        ctx.ui.notify(`pi-undo is unavailable: ${storeError ?? "snapshot store is not initialized"}`, "error");
        return;
      }

      const branch = ctx.sessionManager.getBranch();
      const turns = userTurns(branch);
      if (turns.length === 0) {
        ctx.ui.notify("There are no user messages to undo", "warning");
        return;
      }

      const target = await chooseTurn(argument, turns, store, ctx);
      if (!target) return;
      const targetIndex = turns.findIndex(({ entry }) => entry.id === target.entry.id);
      const undoneTurns = turns.slice(targetIndex);
      const undoFiles = selectUndoSnapshots(
        store.getChanges(),
        undoneTurns.map(({ entry }) => entry.id),
      );

      if (undoFiles.length > 0 && ctx.hasUI) {
        const fileCount = undoFiles.length;
        const confirmed = await ctx.ui.confirm(
          "Revert file changes?",
          `This undo will also revert ${fileCount} file${fileCount === 1 ? "" : "s"} to ${fileCount === 1 ? "its" : "their"} earlier state. Continue?`,
        );
        if (!confirmed) {
          ctx.ui.notify("Undo cancelled", "info");
          return;
        }
      }

      let redoFiles: PathSnapshot[];
      try {
        redoFiles = await captureCurrentFiles(store, undoFiles);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Undo cancelled because current files could not be checkpointed: ${message}`, "error");
        return;
      }

      const originalLeafId = ctx.sessionManager.getLeafId();
      if (!originalLeafId) {
        ctx.ui.notify("Undo could not determine the current session position", "error");
        return;
      }

      let recovery: RecoveryRecord;
      try {
        recovery = await store.addRecovery({
          targetUserEntryId: target.entry.id,
          originalLeafId,
          undoFiles,
          redoFiles,
          status: "preparing",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Undo cancelled because recovery state could not be saved: ${message}`, "error");
        return;
      }

      let branchUndone = false;
      try {
        const oldLeafId = appendMarker(pi, ctx, {
          version: 1,
          action: "source",
          recoveryId: recovery.id,
          targetUserEntryId: target.entry.id,
        });
        await store.updateRecovery(recovery.id, { oldLeafId });

        const navigation = await ctx.navigateTree(target.entry.id, { summarize: false });
        if (navigation.cancelled) {
          await store.updateRecovery(recovery.id, { status: "cancelled" });
          ctx.ui.notify("Undo cancelled", "info");
          return;
        }
        branchUndone = true;

        const undoLeafId = appendMarker(pi, ctx, {
          version: 1,
          action: "undo",
          recoveryId: recovery.id,
          targetUserEntryId: target.entry.id,
        });
        await store.updateRecovery(recovery.id, { undoLeafId, status: "available" });

        const failures = await store.restore(undoFiles);
        if (failures.length > 0) {
          await store.updateRecovery(recovery.id, { errors: restoreErrorStrings(failures) });
        }

        if (target.text && ctx.hasUI && !ctx.ui.getEditorText().trim()) {
          ctx.ui.setEditorText(target.text);
        }

        const restoredCount = undoFiles.length - failures.length;
        ctx.ui.notify(
          `Undid ${undoneTurns.length} turn${undoneTurns.length === 1 ? "" : "s"}` +
            ` and restored ${restoredCount} file${restoredCount === 1 ? "" : "s"}. ` +
            "Use /undo-recover to reverse it.",
          failures.length === 0 ? "info" : "warning",
        );
        notifyRestoreFailures(ctx, "Undo", failures);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          const currentLeafId = ctx.sessionManager.getLeafId();
          await store.updateRecovery(recovery.id, {
            status: branchUndone ? "available" : "cancelled",
            ...(branchUndone && currentLeafId ? { undoLeafId: currentLeafId } : {}),
            errors: [message],
          });
        } catch {
          // Preserve the original failure in the notification.
        }
        ctx.ui.notify(
          branchUndone
            ? `Conversation was undone, but file restoration did not finish: ${message}`
            : `Undo failed: ${message}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("undo-recover", {
    description: "Recover the conversation and files from the most recent /undo",
    handler: async (_argument, ctx) => {
      await ctx.waitForIdle();
      if (!store) {
        ctx.ui.notify(`pi-undo is unavailable: ${storeError ?? "snapshot store is not initialized"}`, "error");
        return;
      }

      const recovery = findRecoverableRecord(store.getRecoveries(), ctx);
      if (!recovery || !recovery.oldLeafId) {
        const hasAvailableRecovery = store.getRecoveries().some((candidate) => candidate.status === "available");
        ctx.ui.notify(
          hasAvailableRecovery
            ? "The last undo can only be recovered before continuing the conversation"
            : "There is no undo to recover",
          "warning",
        );
        return;
      }

      try {
        // Keep the record available until recovery is complete. If navigation
        // is cancelled or interrupted, /undo-recover can be tried again.
        const navigation = await ctx.navigateTree(recovery.oldLeafId, { summarize: false });
        if (navigation.cancelled) {
          await store.updateRecovery(recovery.id, { status: "available" });
          ctx.ui.notify("Undo recovery cancelled", "info");
          return;
        }

        appendMarker(pi, ctx, {
          version: 1,
          action: "recover",
          recoveryId: recovery.id,
          targetUserEntryId: recovery.targetUserEntryId,
        });

        const failures = await store.restore(recovery.redoFiles);
        await store.updateRecovery(recovery.id, {
          status: "recovered",
          errors: failures.length > 0 ? restoreErrorStrings(failures) : undefined,
        });

        if (ctx.hasUI) ctx.ui.setEditorText("");
        const restoredCount = recovery.redoFiles.length - failures.length;
        ctx.ui.notify(
          `Recovered the conversation and ${restoredCount} file${restoredCount === 1 ? "" : "s"}`,
          failures.length === 0 ? "info" : "warning",
        );
        notifyRestoreFailures(ctx, "Recovery", failures);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await store.updateRecovery(recovery.id, { status: "available", errors: [message] });
        } catch {
          // Preserve the original failure in the notification.
        }
        ctx.ui.notify(`Undo recovery failed: ${message}`, "error");
      }
    },
  });
}
