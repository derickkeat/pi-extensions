import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  capturePath,
  restorePath,
  selectUndoSnapshots,
  type ChangeRecord,
  type PathSnapshot,
  UndoStore,
} from "../src/snapshots.ts";

const execFile = promisify(execFileCallback);

async function fixture(): Promise<{ root: string; blobs: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-undo-test-"));
  const blobs = join(root, "blobs");
  return {
    root,
    blobs,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("captures and restores file bytes and mode", async () => {
  const { root, blobs, cleanup } = await fixture();
  try {
    const path = join(root, "file.txt");
    await writeFile(path, Buffer.from([0, 1, 2, 255]));
    await chmod(path, 0o640);
    const snapshot = await capturePath(path, blobs);

    await writeFile(path, "changed");
    await chmod(path, 0o600);
    await restorePath(snapshot, blobs);

    assert.deepEqual(await readFile(path), Buffer.from([0, 1, 2, 255]));
    assert.equal((await stat(path)).mode & 0o777, 0o640);
  } finally {
    await cleanup();
  }
});

test("restoring a missing path removes the new file and empty parents", async () => {
  const { root, blobs, cleanup } = await fixture();
  try {
    const createdDirectory = join(root, "new", "nested");
    const path = join(createdDirectory, "file.txt");
    const snapshot = await capturePath(path, blobs);
    assert.equal(snapshot.kind, "missing");

    await mkdir(createdDirectory, { recursive: true });
    await writeFile(path, "new file");
    await restorePath(snapshot, blobs);

    await assert.rejects(access(path));
    await assert.rejects(access(join(root, "new")));
  } finally {
    await cleanup();
  }
});

test("restoring file content does not move or delete a Git commit", async (context) => {
  try {
    await execFile("git", ["--version"]);
  } catch {
    context.skip("git is not installed");
    return;
  }

  const { root, cleanup } = await fixture();
  try {
    const repository = join(root, "repository");
    await mkdir(repository);
    await execFile("git", ["init", "-q"], { cwd: repository });
    const path = join(repository, "tracked.txt");
    await writeFile(path, "before\n");
    await execFile("git", ["add", "tracked.txt"], { cwd: repository });
    await execFile(
      "git",
      ["-c", "user.name=pi-undo test", "-c", "user.email=pi-undo@example.invalid", "commit", "-qm", "baseline"],
      { cwd: repository },
    );

    const store = await UndoStore.open(join(root, "undo-state"), "session-git", repository);
    const beforeEdit = await store.capture(path);
    await writeFile(path, "after\n");
    await execFile("git", ["add", "tracked.txt"], { cwd: repository });
    await execFile(
      "git",
      ["-c", "user.name=pi-undo test", "-c", "user.email=pi-undo@example.invalid", "commit", "-qm", "edited"],
      { cwd: repository },
    );
    const commitAfterEdit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    const recoveryState = await store.capture(path);

    assert.deepEqual(await store.restore([beforeEdit]), []);
    assert.equal(
      (await execFile("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(),
      commitAfterEdit,
    );
    assert.equal(await readFile(path, "utf8"), "before\n");
    assert.match((await execFile("git", ["status", "--porcelain"], { cwd: repository })).stdout, /tracked\.txt/);

    assert.deepEqual(await store.restore([recoveryState]), []);
    assert.equal(
      (await execFile("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(),
      commitAfterEdit,
    );
    assert.equal((await execFile("git", ["status", "--porcelain"], { cwd: repository })).stdout, "");
  } finally {
    await cleanup();
  }
});

test("UndoStore restores newer siblings first so created parents are removed", async () => {
  const { root, cleanup } = await fixture();
  try {
    const store = await UndoStore.open(join(root, "state"), "session-siblings", root);
    const first = join(root, "created", "nested", "first.txt");
    const second = join(root, "created", "second.txt");

    const firstSnapshot = await store.capture(first);
    await mkdir(join(root, "created", "nested"), { recursive: true });
    await writeFile(first, "first");
    const secondSnapshot = await store.capture(second);
    await writeFile(second, "second");

    assert.deepEqual(await store.restore([firstSnapshot, secondSnapshot]), []);
    await assert.rejects(access(join(root, "created")));
  } finally {
    await cleanup();
  }
});

test("selectUndoSnapshots keeps the earliest state for each affected path", () => {
  const missing = (path: string): PathSnapshot => ({ path, kind: "missing", missingParents: [] });
  const changes: ChangeRecord[] = [
    {
      toolCallId: "a",
      userEntryId: "user-1",
      sequence: 1,
      before: missing("/a"),
      status: "applied",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      toolCallId: "b",
      userEntryId: "user-2",
      sequence: 2,
      before: { path: "/a", kind: "file", blob: "later", mode: 0o644 },
      status: "applied",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    {
      toolCallId: "c",
      userEntryId: "user-2",
      sequence: 3,
      before: missing("/b"),
      status: "applied",
      createdAt: "2026-01-01T00:00:02.000Z",
    },
    {
      toolCallId: "failed",
      userEntryId: "user-1",
      sequence: 0,
      before: missing("/ignored"),
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  assert.deepEqual(
    selectUndoSnapshots(changes, ["user-1", "user-2"]),
    [missing("/a"), missing("/b")],
  );
  assert.deepEqual(
    selectUndoSnapshots(changes, ["user-2"]),
    [
      { path: "/a", kind: "file", blob: "later", mode: 0o644 },
      missing("/b"),
    ],
  );
});

test("UndoStore persists successful changes and drops failed changes", async () => {
  const { root, cleanup } = await fixture();
  try {
    const tracked = join(root, "tracked.txt");
    const failed = join(root, "failed.txt");
    await writeFile(tracked, "before");
    await writeFile(failed, "unchanged");

    const storeRoot = join(root, "state");
    const store = await UndoStore.open(storeRoot, "session-1", root);
    await store.beginChange("call-1", "user-1", tracked);
    await store.completeChange("call-1", true);
    await store.beginChange("call-2", "user-1", failed);
    await store.completeChange("call-2", false);

    const reopened = await UndoStore.open(storeRoot, "session-1", root);
    assert.equal(reopened.getChanges().length, 1);
    assert.equal(reopened.getChanges()[0]?.toolCallId, "call-1");
    assert.equal(reopened.getChanges()[0]?.status, "applied");
  } finally {
    await cleanup();
  }
});

test("UndoStore retains a checkpoint when a tool reports an error after mutating", async () => {
  const { root, cleanup } = await fixture();
  try {
    const path = join(root, "tracked.txt");
    await writeFile(path, "before");
    const store = await UndoStore.open(join(root, "state"), "session-aborted", root);
    await store.beginChange("aborted-after-write", "user-1", path);
    await writeFile(path, "changed before abort");
    await store.completeChange("aborted-after-write", false);

    assert.equal(store.getChanges().length, 1);
    assert.equal(store.getChanges()[0]?.status, "applied");
  } finally {
    await cleanup();
  }
});

test("UndoStore conservatively promotes interrupted pending changes", async () => {
  const { root, cleanup } = await fixture();
  try {
    const path = join(root, "tracked.txt");
    await writeFile(path, "before");
    const storeRoot = join(root, "state");
    const store = await UndoStore.open(storeRoot, "session-2", root);
    await store.beginChange("interrupted", "user-1", path);

    const reopened = await UndoStore.open(storeRoot, "session-2", root);
    assert.equal(reopened.getChanges()[0]?.status, "applied");
  } finally {
    await cleanup();
  }
});
