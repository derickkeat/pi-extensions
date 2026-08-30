import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import piUndo from "../src/index.ts";

class FakeSessionManager {
  private readonly entries = new Map<string, SessionEntry>();
  private markerSequence = 0;
  private leafId: string | null = null;

  constructor(private readonly sessionId: string) {}

  add(entry: SessionEntry): void {
    this.entries.set(entry.id, entry);
    this.leafId = entry.id;
  }

  appendMarker(customType: string, data: unknown): void {
    this.add({
      type: "custom",
      id: `marker-${++this.markerSequence}`,
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      customType,
      data,
    });
  }

  navigate(targetId: string): void {
    const target = this.entries.get(targetId);
    if (!target) throw new Error(`Unknown target ${targetId}`);
    if (target.type === "message" && target.message.role === "user") {
      this.leafId = target.parentId;
    } else {
      this.leafId = target.id;
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  getBranch(): SessionEntry[] {
    const reversed: SessionEntry[] = [];
    let cursor = this.leafId;
    while (cursor) {
      const entry = this.entries.get(cursor);
      if (!entry) throw new Error(`Broken fake branch at ${cursor}`);
      reversed.push(entry);
      cursor = entry.parentId;
    }
    return reversed.reverse();
  }
}

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

function customEntry(id: string, parentId: string, customType = "fake-assistant"): SessionEntry {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    customType,
    data: {},
  };
}

test("/undo branches and restores files while /undo-recover unwinds repeated undos", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-undo-extension-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");

  try {
    const project = join(root, "project");
    const file = join(project, "tracked.txt");
    await mkdir(project, { recursive: true });
    await writeFile(file, "before", "utf8");

    const manager = new FakeSessionManager("integration-session");
    manager.add(userEntry("user-1", null, "make the change"));
    manager.add(customEntry("assistant-tool-call", "user-1"));

    const eventHandlers = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
    const commands = new Map<string, { handler: (argument: string, ctx: any) => Promise<void> }>();
    const notifications: string[] = [];
    const confirmations: Array<{ title: string; message: string }> = [];
    let confirmResult = false;
    let editorText = "";
    let pickerOptions: string[] = [];

    const api = {
      on(name: string, handler: (event: any, ctx: any) => Promise<any> | any) {
        const handlers = eventHandlers.get(name) ?? [];
        handlers.push(handler);
        eventHandlers.set(name, handlers);
      },
      registerCommand(name: string, command: { handler: (argument: string, ctx: any) => Promise<void> }) {
        commands.set(name, command);
      },
      appendEntry(customType: string, data: unknown) {
        manager.appendMarker(customType, data);
      },
    } as unknown as ExtensionAPI;

    const context = {
      cwd: project,
      mode: "rpc",
      hasUI: true,
      sessionManager: manager,
      ui: {
        theme: {
          italic(text: string) {
            return `\u001b[3m${text}\u001b[23m`;
          },
        },
        async select(_title: string, options: string[]) {
          pickerOptions = options;
          return options.at(-1);
        },
        async confirm(title: string, message: string) {
          confirmations.push({ title, message });
          return confirmResult;
        },
        notify(message: string) {
          notifications.push(message);
        },
        getEditorText() {
          return editorText;
        },
        setEditorText(text: string) {
          editorText = text;
        },
      },
      waitForIdle: async () => {},
      navigateTree: async (targetId: string) => {
        manager.navigate(targetId);
        return { cancelled: false };
      },
    };

    piUndo(api);
    for (const handler of eventHandlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, context);
    }
    const statePath = join(
      root,
      "agent",
      "extension-data",
      "pi-undo",
      "integration-session",
      "state.json",
    );
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).sessionId, "integration-session");

    for (const handler of eventHandlers.get("tool_call") ?? []) {
      const result = await handler(
        {
          type: "tool_call",
          toolName: "edit",
          toolCallId: "edit-call-1",
          input: { path: file, edits: [{ oldText: "before", newText: "after" }] },
        },
        context,
      );
      assert.notEqual(result?.block, true);
    }
    await writeFile(file, "after", "utf8");
    const commandSideEffect = join(project, "command-side-effect.txt");
    await writeFile(commandSideEffect, "shell command state", "utf8");
    for (const handler of eventHandlers.get("tool_result") ?? []) {
      await handler(
        {
          type: "tool_result",
          toolName: "edit",
          toolCallId: "edit-call-1",
          input: { path: file },
          content: [],
          details: {},
          isError: false,
        },
        context,
      );
    }

    manager.add(customEntry("assistant-final-1", "assistant-tool-call"));
    manager.add(userEntry("user-2", "assistant-final-1", "future question"));
    manager.add(customEntry("assistant-final-2", "user-2"));

    await commands.get("undo")!.handler("user-2", context);
    assert.equal(await readFile(file, "utf8"), "after");
    assert.deepEqual(confirmations, [], "an undo without file changes must not ask for confirmation");
    assert.deepEqual(
      manager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id),
      ["user-1"],
      "the selected newest message must be absent from model context",
    );

    await commands.get("undo")!.handler("user-1", context);
    assert.equal(await readFile(file, "utf8"), "after", "declining must leave the file unchanged");
    assert.deepEqual(confirmations, [
      {
        title: "Revert file changes?",
        message: "This undo will also revert 1 file to its earlier state. Continue?",
      },
    ]);
    assert.deepEqual(
      manager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id),
      ["user-1"],
      "declining file restoration must cancel the conversation undo",
    );

    confirmResult = true;
    await commands.get("undo")!.handler("user-1", context);
    assert.equal(confirmations.length, 2);
    assert.equal(await readFile(file, "utf8"), "before");
    assert.equal(
      await readFile(commandSideEffect, "utf8"),
      "shell command state",
      "side effects not made by edit/write must remain untouched",
    );
    assert.equal(
      manager.getBranch().some((entry) => entry.id === "user-1" || entry.id === "user-2"),
      false,
      "selected and future user messages must not remain on the active branch",
    );

    await commands.get("undo-recover")!.handler("", context);
    assert.equal(await readFile(file, "utf8"), "after");
    assert.deepEqual(
      manager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id),
      ["user-1"],
      "the first recovery should return to the state after the first undo",
    );

    await commands.get("undo-recover")!.handler("", context);
    assert.deepEqual(
      manager
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")
        .map((entry) => entry.id),
      ["user-1", "user-2"],
    );
    assert.ok(notifications.some((message) => message.includes("Use /undo-recover")));
    assert.equal(
      notifications.filter((message) => message.startsWith("Recovered the conversation")).length,
      2,
    );

    const leafBeforeCurrentSelection = manager.getLeafId();
    await commands.get("undo")!.handler("", context);
    const visibleOptions = pickerOptions.map((option) =>
      option.replace(/\u001b\[[0-9;]*m/g, "").replace(/[\u200b\u2063]/g, ""),
    );
    assert.deepEqual(visibleOptions, [
      "make the change  (1 file)",
      "future question",
      "(current)",
    ]);
    assert.equal(manager.getLeafId(), leafBeforeCurrentSelection, "choosing (current) must cancel undo");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
