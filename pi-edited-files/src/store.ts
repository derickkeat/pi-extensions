import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const STORE_VERSION = 1;

export type BaselineSnapshot =
  | { kind: "missing" }
  | { kind: "file"; blob: string };

interface BaselineRecord {
  path: string;
  snapshot: BaselineSnapshot;
}

interface PersistedStoreState {
  version: 1;
  sessionId: string;
  baselines: BaselineRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseSnapshot(value: unknown): BaselineSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "missing") return { kind: "missing" };
  if (value.kind === "file" && typeof value.blob === "string" && /^[a-f0-9]{64}$/.test(value.blob)) {
    return { kind: "file", blob: value.blob };
  }
  return undefined;
}

function parseState(value: unknown, sessionId: string): PersistedStoreState {
  if (!isRecord(value) || value.version !== STORE_VERSION || value.sessionId !== sessionId) {
    throw new Error("state file does not match this session or store version");
  }
  if (!Array.isArray(value.baselines)) throw new Error("state file is missing baselines");

  const baselines: BaselineRecord[] = [];
  const paths = new Set<string>();
  for (const candidate of value.baselines) {
    if (!isRecord(candidate) || typeof candidate.path !== "string" || paths.has(candidate.path)) {
      throw new Error("state file contains an invalid baseline path");
    }
    const snapshot = parseSnapshot(candidate.snapshot);
    if (!snapshot) throw new Error(`state file contains an invalid snapshot for ${candidate.path}`);
    paths.add(candidate.path);
    baselines.push({ path: candidate.path, snapshot });
  }

  return { version: STORE_VERSION, sessionId, baselines };
}

async function writeBlob(blobDirectory: string, content: Buffer): Promise<string> {
  const hash = createHash("sha256").update(content).digest("hex");
  const path = join(blobDirectory, hash);
  await mkdir(blobDirectory, { recursive: true, mode: 0o700 });
  await chmod(blobDirectory, 0o700);

  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  return hash;
}

async function readBlob(blobDirectory: string, hash: string): Promise<Buffer> {
  const content = await readFile(join(blobDirectory, hash));
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== hash) throw new Error(`baseline blob ${hash} is corrupt`);
  return content;
}

export class BaselineStore {
  private readonly statePath: string;
  private readonly blobDirectory: string;
  private readonly baselines: Map<string, BaselineSnapshot>;
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly sessionId: string,
    records: readonly BaselineRecord[],
  ) {
    this.statePath = join(root, "state.json");
    this.blobDirectory = join(root, "blobs");
    this.baselines = new Map(records.map((record) => [record.path, record.snapshot]));
  }

  static async open(root: string, sessionId: string): Promise<BaselineStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);

    let records: BaselineRecord[] = [];
    try {
      const state = parseState(JSON.parse(await readFile(join(root, "state.json"), "utf8")), sessionId);
      records = state.baselines;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot load pi-edited-files state: ${message}`, { cause: error });
      }
    }

    return new BaselineStore(root, sessionId, records);
  }

  get(path: string): BaselineSnapshot | undefined {
    return this.baselines.get(path);
  }

  async capture(path: string): Promise<BaselineSnapshot> {
    try {
      const content = await readFile(path);
      return { kind: "file", blob: await writeBlob(this.blobDirectory, content) };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { kind: "missing" };
      throw error;
    }
  }

  async ensure(path: string, snapshot: BaselineSnapshot): Promise<BaselineSnapshot> {
    return this.enqueue(async () => {
      const existing = this.baselines.get(path);
      if (existing) return existing;

      this.baselines.set(path, snapshot);
      try {
        await this.save();
      } catch (error) {
        this.baselines.delete(path);
        throw error;
      }
      return snapshot;
    });
  }

  async read(snapshot: BaselineSnapshot): Promise<string> {
    if (snapshot.kind === "missing") return "";
    return (await readBlob(this.blobDirectory, snapshot.blob)).toString("utf8");
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async save(): Promise<void> {
    const state: PersistedStoreState = {
      version: STORE_VERSION,
      sessionId: this.sessionId,
      baselines: [...this.baselines].map(([path, snapshot]) => ({ path, snapshot })),
    };
    const temporaryPath = join(this.root, `.state-${process.pid}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.statePath);
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
  }
}
