import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piWorkTimer, { formatDuration, formatWorkLog } from "../src/index.ts";

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
    const messages: Array<{ customType: string; content: string; display: boolean; details: unknown; triggerTurn?: boolean }> = [];
    const omissions: Array<{ targetId: string; replacement: null }> = [];
    let entryRenderer:
      | ((
          entry: { data?: { durationMs: number } },
          options: unknown,
          theme: { fg(color: string, text: string): string },
        ) => { render(width: number): string[] } | undefined)
      | undefined;
    let messageRenderer:
      | ((
          message: { content: string; details?: { durationMs: number } },
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
      registerMessageRenderer(_customType: string, renderer: typeof messageRenderer) {
        messageRenderer = renderer;
      },
      sendMessage(
        message: { customType: string; content: string; display: boolean; details: unknown },
        options?: { triggerTurn?: boolean },
      ) {
        messages.push({ ...message, triggerTurn: options?.triggerTurn });
      },
    } as unknown as ExtensionAPI;

    const context = {
      mode: "tui",
      ui: {
        setWorkingMessage(message?: string) {
          workingMessages.push(message);
        },
      },
      sessionManager: {
        getLeafEntry() {
          return messages.length === 0
            ? undefined
            : { id: "work-log", type: "custom_message", customType: "pi-work-timer" };
        },
        appendContextEdit(targetId: string, replacement: null) {
          omissions.push({ targetId, replacement });
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
    assert.deepEqual(messages, [
      {
        customType: "pi-work-timer",
        content: "Worked for 1m 5s",
        display: true,
        details: { durationMs: 65_000 },
        triggerTurn: false,
      },
    ]);
    assert.deepEqual(omissions, [{ targetId: "work-log", replacement: null }]);
    const renderedEntry = entryRenderer?.(
      { data: { durationMs: 65_000 } },
      {},
      { fg: (_color, text) => text },
    );
    assert.equal(renderedEntry?.render(40)[0]?.trim(), "Worked for 1m 5s");
    const renderedMessage = messageRenderer?.(
      { content: formatWorkLog(65_000), details: { durationMs: 65_000 } },
      {},
      { fg: (_color, text) => text },
    );
    assert.equal(renderedMessage?.render(40)[0]?.trim(), "Worked for 1m 5s");

    const contextHandler = handlers.get("context")?.[0];
    const contextResult = await contextHandler?.(
      {
        type: "context",
        messages: [
          { role: "user", content: "hello" },
          { role: "custom", customType: "pi-work-timer", content: "Worked for 1m 5s", display: true },
        ],
      },
      context,
    );
    assert.deepEqual(contextResult, {
      messages: [{ role: "user", content: "hello" }],
    });

    intervalCallback?.();
    assert.equal(workingMessages.length, 3, "a stopped timer must not update the working message");
  } finally {
    Date.now = originalNow;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
