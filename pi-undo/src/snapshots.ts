import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STATE_VERSION = 1;

export type PathSnapshot =
  | {
      path: string;
      kind: "missing";
      missingParents: string[];
    }
  | {
      path: string;
      kind: "file";
      blob: string;
      mode: number;
    }
  | {
      path: string;
      kind: "symlink";
      target: string;
    };

export interface ChangeRecord {
  toolCallId: string;
  userEntryId: string;
  sequence: number;
  before: PathSnapshot;
  status: "pending" | "applied";
  createdAt: string;
}

export interface RecoveryRecord {
  id: string;
  createdAt: string;
  targetUserEntryId: string;
  originalLeafId: string;
  oldLeafId?: string;
  undoLeafId?: string;
  undoFiles: PathSnapshot[];
  redoFiles: PathSnapshot[];
  status: "preparing" | "available" | "recovered" | "cancelled";
  errors?: string[];
}

interface PersistedState {
  version: number;
  sessionId: string;
  cwd: string;
  nextSequence: number;
  changes: ChangeRecord[];
  recoveries: RecoveryRecord[];
}

export interface RestoreFailure {
  snapshot: PathSnapshot;
  error: Error;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function normalizeWindowsShellPath(input: string): string {
  if (process.platform !== "win32" || !input.startsWith("/") || input.startsWith("//") || input.includes("\\")) {
    return input;
  }
  const match = input.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return input;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

/** Resolve paths the same way pi's local edit/write tools do, then follow existing symlinks. */
export async function resolveMutationPath(rawPath: string, cwd: string): Promise<string> {
  const withoutAt = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const withNormalSpaces = withoutAt.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  const expanded = expandHome(normalizeWindowsShellPath(withNormalSpaces));
  const localPath = /^file:\/\//.test(expanded) ? fileURLToPath(expanded) : expanded;
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

async function missingParentDirectories(path: string): Promise<string[]> {
  const missing: string[] = [];
  let cursor = dirname(path);

  while (true) {
    try {
      await lstat(cursor);
      return missing;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }

    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) return missing;
    cursor = parent;
  }
}

async function writeBlob(blobDir: string, content: Buffer): Promise<string> {
  const hash = createHash("sha256").update(content).digest("hex");
  const blobPath = join(blobDir, hash);
  await mkdir(blobDir, { recursive: true, mode: 0o700 });

  try {
    await writeFile(blobPath, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }

  return hash;
}

export async function capturePath(path: string, blobDir: string): Promise<PathSnapshot> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return {
        path,
        kind: "missing",
        missingParents: await missingParentDirectories(path),
      };
    }
    throw error;
  }

  if (stat.isFile()) {
    const content = await readFile(path);
    return {
      path,
      kind: "file",
      blob: await writeBlob(blobDir, content),
      mode: stat.mode & 0o7777,
    };
  }

  if (stat.isSymbolicLink()) {
    return { path, kind: "symlink", target: await readlink(path) };
  }

  throw new Error(`Cannot checkpoint non-file path: ${path}`);
}

async function readAndVerifyBlob(blobDir: string, hash: string): Promise<Buffer> {
  const content = await readFile(join(blobDir, hash));
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== hash) throw new Error(`Snapshot blob ${hash} is corrupt`);
  return content;
}

async function currentKind(path: string): Promise<"missing" | "file" | "symlink" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isFile()) return "file";
    if (stat.isSymbolicLink()) return "symlink";
    return "other";
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    throw error;
  }
}

async function snapshotMatchesCurrent(snapshot: PathSnapshot, blobDir: string): Promise<boolean> {
  const kind = await currentKind(snapshot.path);
  if (snapshot.kind === "missing") return kind === "missing";
  if (snapshot.kind === "symlink") {
    return kind === "symlink" && (await readlink(snapshot.path)) === snapshot.target;
  }
  if (kind !== "file") return false;
  const [content, checkpoint] = await Promise.all([
    readFile(snapshot.path),
    readAndVerifyBlob(blobDir, snapshot.blob),
  ]);
  return content.equals(checkpoint);
}

export async function restorePath(snapshot: PathSnapshot, blobDir: string): Promise<void> {
  const kind = await currentKind(snapshot.path);

  if (snapshot.kind === "missing") {
    if (kind === "file" || kind === "symlink") {
      await unlink(snapshot.path);
    } else if (kind === "other") {
      throw new Error(`Refusing to remove non-file path: ${snapshot.path}`);
    }

    // write creates missing parents. Remove only parents that were absent at
    // checkpoint time, and only while they are still empty.
    for (const directory of snapshot.missingParents) {
      try {
        await rmdir(directory);
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        if (isErrno(error, "ENOTEMPTY") || isErrno(error, "EEXIST")) break;
        throw error;
      }
    }
    return;
  }

  await mkdir(dirname(snapshot.path), { recursive: true, mode: 0o700 });

  if (snapshot.kind === "symlink") {
    if (kind === "file" || kind === "symlink") await unlink(snapshot.path);
    else if (kind === "other") throw new Error(`Refusing to replace non-file path: ${snapshot.path}`);
    await symlink(snapshot.target, snapshot.path);
    return;
  }

  if (kind === "symlink") {
    // Never write through a link that appeared after the checkpoint.
    await unlink(snapshot.path);
  } else if (kind === "other") {
    throw new Error(`Refusing to replace non-file path: ${snapshot.path}`);
  }

  const content = await readAndVerifyBlob(blobDir, snapshot.blob);
  await writeFile(snapshot.path, content, { mode: snapshot.mode });
  await chmod(snapshot.path, snapshot.mode);
}

export function selectUndoSnapshots(changes: readonly ChangeRecord[], userEntryIds: readonly string[]): PathSnapshot[] {
  const userOrder = new Map(userEntryIds.map((id, index) => [id, index]));
  const ordered = changes
    .filter((change) => change.status === "applied" && userOrder.has(change.userEntryId))
    .sort((left, right) => {
      const userDifference = userOrder.get(left.userEntryId)! - userOrder.get(right.userEntryId)!;
      return userDifference || left.sequence - right.sequence;
    });

  const seen = new Set<string>();
  const snapshots: PathSnapshot[] = [];
  for (const change of ordered) {
    if (seen.has(change.before.path)) continue;
    seen.add(change.before.path);
    snapshots.push(change.before);
  }
  return snapshots;
}

function parseState(value: unknown, sessionId: string, cwd: string): PersistedState {
  if (!value || typeof value !== "object") throw new Error("state file is not an object");
  const state = value as Partial<PersistedState>;
  if (state.version !== STATE_VERSION) throw new Error(`unsupported state version: ${String(state.version)}`);
  if (state.sessionId !== sessionId) throw new Error("state file belongs to a different session");
  if (!Array.isArray(state.changes) || !Array.isArray(state.recoveries)) {
    throw new Error("state file is missing record arrays");
  }

  const maxSequence = state.changes.reduce((max, change) => Math.max(max, change.sequence ?? 0), 0);
  return {
    version: STATE_VERSION,
    sessionId,
    cwd: typeof state.cwd === "string" ? state.cwd : cwd,
    nextSequence: Math.max(state.nextSequence ?? 1, maxSequence + 1),
    changes: state.changes,
    recoveries: state.recoveries,
  };
}

export class UndoStore {
  readonly root: string;
  readonly blobDir: string;
  private readonly statePath: string;
  private state: PersistedState;

  private constructor(root: string, state: PersistedState) {
    this.root = root;
    this.blobDir = join(root, "blobs");
    this.statePath = join(root, "state.json");
    this.state = state;
  }

  static async open(root: string, sessionId: string, cwd: string): Promise<UndoStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    let state: PersistedState;

    try {
      state = parseState(JSON.parse(await readFile(join(root, "state.json"), "utf8")), sessionId, cwd);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot load pi-undo state: ${message}`, { cause: error });
      }
      state = {
        version: STATE_VERSION,
        sessionId,
        cwd,
        nextSequence: 1,
        changes: [],
        recoveries: [],
      };
    }

    const store = new UndoStore(root, state);
    const hadPending = store.state.changes.some((change) => change.status === "pending");
    // If pi stopped between a tool call and its result, assume the mutation may
    // have happened. A conservative extra restore is safer than losing undo data.
    for (const change of store.state.changes) {
      if (change.status === "pending") change.status = "applied";
    }
    if (hadPending || !(await store.stateFileExists())) await store.save();
    return store;
  }

  private async stateFileExists(): Promise<boolean> {
    try {
      await lstat(this.statePath);
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  async save(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.root, `.state-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }

  async beginChange(toolCallId: string, userEntryId: string, path: string): Promise<void> {
    if (this.state.changes.some((change) => change.toolCallId === toolCallId)) return;
    const before = await capturePath(path, this.blobDir);
    this.state.changes.push({
      toolCallId,
      userEntryId,
      sequence: this.state.nextSequence++,
      before,
      status: "pending",
      createdAt: new Date().toISOString(),
    });
    await this.save();
  }

  async completeChange(toolCallId: string, toolSucceeded: boolean): Promise<void> {
    const index = this.state.changes.findIndex((change) => change.toolCallId === toolCallId);
    if (index < 0) return;

    const change = this.state.changes[index]!;
    let applied = toolSucceeded;
    if (!toolSucceeded) {
      try {
        // edit/write can mutate successfully and then report an abort. Keep the
        // checkpoint whenever the path no longer matches its pre-call state.
        applied = !(await snapshotMatchesCurrent(change.before, this.blobDir));
      } catch {
        // If comparison itself fails, retain the checkpoint conservatively.
        applied = true;
      }
    }

    if (applied) change.status = "applied";
    else this.state.changes.splice(index, 1);
    await this.save();
  }

  getChanges(): readonly ChangeRecord[] {
    return this.state.changes;
  }

  async capture(path: string): Promise<PathSnapshot> {
    return capturePath(path, this.blobDir);
  }

  async restore(snapshots: readonly PathSnapshot[]): Promise<RestoreFailure[]> {
    const failures: RestoreFailure[] = [];
    // Apply later file checkpoints first. This also lets the earliest snapshot
    // remove parent directories after newer sibling files have been removed.
    for (const snapshot of [...snapshots].reverse()) {
      try {
        await restorePath(snapshot, this.blobDir);
      } catch (error) {
        failures.push({
          snapshot,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    return failures;
  }

  async addRecovery(
    recovery: Omit<RecoveryRecord, "id" | "createdAt">,
  ): Promise<RecoveryRecord> {
    const record: RecoveryRecord = {
      ...recovery,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.state.recoveries.push(record);
    await this.save();
    return record;
  }

  getRecoveries(): readonly RecoveryRecord[] {
    return this.state.recoveries;
  }

  async updateRecovery(id: string, patch: Partial<Omit<RecoveryRecord, "id">>): Promise<RecoveryRecord> {
    const recovery = this.state.recoveries.find((candidate) => candidate.id === id);
    if (!recovery) throw new Error(`Unknown recovery record: ${id}`);
    Object.assign(recovery, patch);
    await this.save();
    return recovery;
  }
}
