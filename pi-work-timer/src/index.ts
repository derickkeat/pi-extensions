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

  pi.registerEntryRenderer<WorkDurationEntry>(ENTRY_TYPE, (entry, _options, theme) => {
    if (!entry.data) return undefined;
    return new Text(
      theme.fg("dim", `Worked for ${formatDuration(entry.data.durationMs)}`),
      1,
      0,
    );
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
    pi.appendEntry<WorkDurationEntry>(ENTRY_TYPE, { durationMs });
  });

  pi.on("session_shutdown", () => {
    startedAt = undefined;
    stopUpdateTimer();
  });
}
