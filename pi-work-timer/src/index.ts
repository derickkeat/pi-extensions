import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-work-timer";
const UPDATE_INTERVAL_MS = 1_000;

interface WorkDurationEntry {
  durationMs: number;
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatWorkLog(durationMs: number): string {
  return `Worked for ${formatDuration(durationMs)}`;
}

function omitWorkLogFromModelContext(sessionManager: ExtensionContext["sessionManager"]): void {
  const leaf = sessionManager.getLeafEntry();
  if (!leaf || leaf.type !== "custom_message" || leaf.customType !== ENTRY_TYPE) return;

  const editor = sessionManager as ExtensionContext["sessionManager"] & {
    appendContextEdit?(targetId: string, replacement: null): string;
  };
  editor.appendContextEdit?.(leaf.id, null);
}

export default function piWorkTimer(pi: ExtensionAPI): void {
  let startedAt: number | undefined;
  let updateTimer: ReturnType<typeof setInterval> | undefined;

  const stopUpdateTimer = (): void => {
    if (updateTimer === undefined) return;
    clearInterval(updateTimer);
    updateTimer = undefined;
  };

  const updateWorkingMessage = (ctx: ExtensionContext): void => {
    if (startedAt === undefined) return;
    ctx.ui.setWorkingMessage(`Working · ${formatDuration(Date.now() - startedAt)}`);
  };

  const renderWorkLog = (text: string, theme: { fg(color: string, value: string): string }): Text =>
    new Text(theme.fg("dim", text), 1, 0);

  // Older sessions stored this as a custom entry. New runs use a custom message so
  // HTML and JSONL exports include the same line. Both stay out of model context.
  pi.registerEntryRenderer<WorkDurationEntry>(ENTRY_TYPE, (entry, _options, theme) => {
    if (!entry.data) return undefined;
    return renderWorkLog(formatWorkLog(entry.data.durationMs), theme);
  });

  pi.registerMessageRenderer<WorkDurationEntry>(ENTRY_TYPE, (message, _options, theme) => {
    const durationMs = message.details?.durationMs;
    const text = typeof durationMs === "number"
      ? formatWorkLog(durationMs)
      : typeof message.content === "string"
        ? message.content
        : undefined;
    return text ? renderWorkLog(text, theme) : undefined;
  });

  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) => message.role !== "custom" || message.customType !== ENTRY_TYPE,
    );
    if (messages.length === event.messages.length) return;
    return { messages };
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || startedAt !== undefined) return;

    startedAt = Date.now();
    updateWorkingMessage(ctx);
    updateTimer = setInterval(() => updateWorkingMessage(ctx), UPDATE_INTERVAL_MS);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (startedAt === undefined) return;

    const durationMs = Math.max(0, Date.now() - startedAt);
    startedAt = undefined;
    stopUpdateTimer();
    ctx.ui.setWorkingMessage();
    pi.sendMessage(
      {
        customType: ENTRY_TYPE,
        content: formatWorkLog(durationMs),
        display: true,
        details: { durationMs },
      },
      { triggerTurn: false },
    );
    omitWorkLogFromModelContext(ctx.sessionManager);
  });

  pi.on("session_shutdown", () => {
    startedAt = undefined;
    stopUpdateTimer();
  });
}
