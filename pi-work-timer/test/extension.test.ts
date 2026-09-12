import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piWorkTimer, { formatDuration } from "../src/index.ts";

type Handler = (event: unknown, ctx: any) => unknown;

test("formatDuration formats seconds, minutes, and hours", () => {
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(1_000), "1s");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(3_665_000), "1h 1m 5s");
});

test("the working message updates until the agent fully settles", async () => {
  const originalNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let now = 10_000;
  let intervalCallback: (() => void) | undefined;
  let setIntervalCalls = 0;
  let clearIntervalCalls = 0;

  Date.now = () => now;
  globalThis.setInterval = ((callback: () => void) => {
    intervalCallback = callback;
    setIntervalCalls++;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {
    clearIntervalCalls++;
  }) as typeof clearInterval;

  try {
    const handlers = new Map<string, Handler[]>();
    const workingMessages: Array<string | undefined> = [];
    const entries: Array<{ customType: string; data: unknown }> = [];
    let entryRenderer:
      | ((
          entry: { data?: { durationMs: number } },
          options: unknown,
          theme: { fg(color: string, text: string): string },
        ) => { render(width: number): string[] } | undefined)
      | undefined;

    const api = {
      on(name: string, handler: Handler) {
        const registered = handlers.get(name) ?? [];
        registered.push(handler);
        handlers.set(name, registered);
      },
      registerEntryRenderer(_customType: string, renderer: typeof entryRenderer) {
        entryRenderer = renderer;
      },
      appendEntry(customType: string, data: unknown) {
        entries.push({ customType, data });
      },
    } as unknown as ExtensionAPI;

    const context = {
      mode: "tui",
      ui: {
        setWorkingMessage(message?: string) {
          workingMessages.push(message);
        },
      },
    };

    const emit = async (name: string): Promise<void> => {
      for (const handler of handlers.get(name) ?? []) {
        await handler({ type: name }, context);
      }
    };

    piWorkTimer(api);

    await emit("agent_start");
    assert.deepEqual(workingMessages, ["Working · 0s"]);
    assert.equal(setIntervalCalls, 1);

    now += 65_000;
    intervalCallback?.();
    assert.deepEqual(workingMessages, ["Working · 0s", "Working · 1m 5s"]);

    await emit("agent_start");
    assert.equal(setIntervalCalls, 1, "automatic continuations must keep the original timer");

    await emit("agent_settled");
    assert.equal(clearIntervalCalls, 1);
    assert.equal(workingMessages.at(-1), undefined);
    assert.deepEqual(entries, [
      { customType: "pi-work-timer", data: { durationMs: 65_000 } },
    ]);
    const renderedEntry = entryRenderer?.(
      { data: { durationMs: 65_000 } },
      {},
      { fg: (_color, text) => text },
    );
    assert.equal(renderedEntry?.render(40)[0]?.trim(), "Worked for 1m 5s");

    intervalCallback?.();
    assert.equal(workingMessages.length, 3, "a stopped timer must not update the working message");
  } finally {
    Date.now = originalNow;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
