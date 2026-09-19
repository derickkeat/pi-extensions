import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import piEditedFiles, { countChangedLines, countPatchLines } from "../src/index.ts";

type Handler = (event: any, ctx: any) => unknown;
type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[] };

function createHarness(sessionId: string, initialBranch: SessionEntry[] = []) {
  const handlers = new Map<string, Handler[]>();
  const notifications: string[] = [];
  let branch = initialBranch;
  let widget: WidgetFactory | undefined;
  const widgetUpdates: Array<WidgetFactory | undefined> = [];

  const api = {
    on(name: string, handler: Handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
  } as unknown as ExtensionAPI;

  const context = {
    cwd: "",
    mode: "tui",
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getBranch() {
        return branch;
      },
    },
    ui: {
      setWidget(_key: string, content: WidgetFactory | undefined) {
        widget = content;
        widgetUpdates.push(content);
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
  };

  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      result = await handler({ type: name, ...event }, context);
    }
    return result as { details?: unknown } | undefined;
  };

  return {
    api,
    context,
    emit,
    getWidget: () => widget,
    getWidgetUpdates: () => widgetUpdates,
    getNotifications: () => notifications,
    setBranch(nextBranch: SessionEntry[]) {
      branch = nextBranch;
    },
  };
}

const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

const mutedTheme = {
  fg(color: string, text: string) {
    return color === "muted" ? `\u001b[2m${text}\u001b[22m` : text;
  },
  bold(text: string) {
    return text;
  },
};

function toolResultEntry(details: unknown): SessionEntry {
  return {
    type: "message",
    id: "result-1",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "edit-2",
      toolName: "edit",
      content: [],
      details,
      isError: false,
      timestamp: Date.now(),
    },
  } as SessionEntry;
}

test("line changes count additions and removals", () => {
  assert.deepEqual(countChangedLines("one\ntwo\n", "one\nthree\nfour\n"), {
    added: 2,
    removed: 1,
  });
  assert.deepEqual(countChangedLines("same\n", "same\n"), { added: 0, removed: 0 });
  assert.deepEqual(
    countPatchLines("--- file\n+++ file\n@@ -1 +1 @@\n-old\n+++ content beginning with pluses\n"),
    { added: 1, removed: 1 },
  );
});

test("the widget shows the current net diff and restores its baseline with the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-edited-files-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");

  try {
    const project = join(root, "project");
    const file = join(project, "src", "example.ts");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(file, "one\ntwo\n", "utf8");

    const harness = createHarness("session-1");
    harness.context.cwd = project;
    piEditedFiles(harness.api);

    await harness.emit("session_start", { reason: "startup" });
    assert.equal(harness.getWidget(), undefined);

    const writeContent = "one\nthree\n";
    await harness.emit("tool_call", {
      toolName: "write",
      toolCallId: "write-1",
      input: { path: "src/example.ts", content: writeContent },
    });
    await writeFile(file, writeContent, "utf8");
    const writeResult = await harness.emit("tool_result", {
      toolName: "write",
      toolCallId: "write-1",
      input: { path: "src/example.ts", content: writeContent },
      content: [],
      details: undefined,
      isError: false,
    });

    assert.ok(writeResult?.details);
    let component = harness.getWidget()!({}, plainTheme);
    let lines = component.render(50);
    assert.equal(lines[0]?.length, 50);
    assert.ok(lines[0]?.startsWith("── Edited files (1) ─"));
    const mutedNarrowLines = harness.getWidget()!({}, mutedTheme).render(16);
    assert.ok(mutedNarrowLines[0]?.includes("\u001b[2m…\u001b[22m"));
    assert.ok(mutedNarrowLines[1]?.includes("\u001b[2m  src/"));
    assert.ok(mutedNarrowLines[1]?.includes("\u001b[2m…\u001b[22m"));
    assert.equal(lines[1]?.length, 50);
    assert.ok(lines[1]?.includes("src/example.ts"));
    assert.ok(lines[1]?.endsWith("+1 -1"));

    await harness.emit("tool_call", {
      toolName: "edit",
      toolCallId: "edit-1",
      input: {
        path: "src/example.ts",
        edits: [{ oldText: "three", newText: "three\nfour" }],
      },
    });
    await writeFile(file, "one\nthree\nfour\n", "utf8");
    await harness.emit("tool_result", {
      toolName: "edit",
      toolCallId: "edit-1",
      input: {
        path: "src/example.ts",
        edits: [{ oldText: "three", newText: "three\nfour" }],
      },
      content: [],
      details: { diff: "", patch: "" },
      isError: false,
    });

    component = harness.getWidget()!({}, plainTheme);
    lines = component.render(50);
    assert.ok(lines[1]?.endsWith("+2 -1"));

    await harness.emit("tool_call", {
      toolName: "edit",
      toolCallId: "edit-2",
      input: {
        path: "src/example.ts",
        edits: [{ oldText: "three", newText: "two" }],
      },
    });
    await writeFile(file, "one\ntwo\nfour\n", "utf8");
    const finalResult = await harness.emit("tool_result", {
      toolName: "edit",
      toolCallId: "edit-2",
      input: {
        path: "src/example.ts",
        edits: [{ oldText: "three", newText: "two" }],
      },
      content: [],
      details: { diff: "", patch: "" },
      isError: false,
    });

    assert.ok(
      harness.getWidget()!({}, plainTheme).render(50)[1]?.endsWith("+1 -0"),
      "reverting a prior change must reduce the net counts",
    );

    const largeFile = join(project, "src", "large.ts");
    const largeBefore = Array.from({ length: 12 }, (_, index) => `old ${index}`).join("\n") + "\n";
    const largeAfter = Array.from({ length: 123 }, (_, index) => `new ${index}`).join("\n") + "\n";
    await writeFile(largeFile, largeBefore, "utf8");
    await harness.emit("tool_call", {
      toolName: "write",
      toolCallId: "write-large",
      input: { path: "src/large.ts", content: largeAfter },
    });
    await writeFile(largeFile, largeAfter, "utf8");
    await harness.emit("tool_result", {
      toolName: "write",
      toolCallId: "write-large",
      input: { path: "src/large.ts", content: largeAfter },
      content: [],
      details: undefined,
      isError: false,
    });

    const alignedLines = harness.getWidget()!({}, plainTheme).render(50);
    assert.equal(alignedLines[1]?.length, 50);
    assert.equal(alignedLines[2]?.length, 50);
    assert.equal(alignedLines[1]?.lastIndexOf("+"), alignedLines[2]?.lastIndexOf("+"));
    assert.equal(alignedLines[1]?.lastIndexOf("-"), alignedLines[2]?.lastIndexOf("-"));
    assert.ok(alignedLines[1]?.endsWith("+1   -0 "));
    assert.ok(alignedLines[2]?.endsWith("+123 -12"));

    await harness.emit("tool_call", {
      toolName: "write",
      toolCallId: "write-failed",
      input: { path: "failed.ts", content: "not written\n" },
    });
    const failedResult = await harness.emit("tool_result", {
      toolName: "write",
      toolCallId: "write-failed",
      input: { path: "failed.ts", content: "not written\n" },
      content: [],
      details: undefined,
      isError: true,
    });
    assert.equal(failedResult, undefined);
    assert.equal(harness.getWidget()!({}, plainTheme).render(50).length, 3);

    const statePath = join(
      root,
      "agent",
      "extension-data",
      "pi-edited-files",
      "session-1",
      "state.json",
    );
    const storedState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(storedState.sessionId, "session-1");
    assert.equal(storedState.baselines.length, 2);

    const persistedEntry = toolResultEntry(finalResult?.details);
    const restored = createHarness("session-1", [persistedEntry]);
    restored.context.cwd = project;
    piEditedFiles(restored.api);
    await restored.emit("session_start", { reason: "resume" });
    assert.ok(restored.getWidget()!({}, plainTheme).render(50)[1]?.endsWith("+1 -0"));

    await writeFile(file, "one\ntwo\n", "utf8");
    await restored.emit("agent_settled");
    assert.ok(
      restored.getWidget()!({}, plainTheme).render(50)[1]?.endsWith("+0 -0"),
      "returning to the baseline must clear the net counts without removing the edited file",
    );

    const forked = createHarness("session-2", [persistedEntry]);
    forked.context.cwd = project;
    piEditedFiles(forked.api);
    await forked.emit("session_start", { reason: "fork" });
    assert.equal(forked.getWidget(), undefined, "a fork is a new session with its own baseline");

    restored.setBranch([]);
    await restored.emit("session_tree", { newLeafId: null, oldLeafId: "result-1" });
    assert.equal(restored.getWidget(), undefined);
    assert.equal(restored.getWidgetUpdates().at(-1), undefined);
    assert.deepEqual(restored.getNotifications(), []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
