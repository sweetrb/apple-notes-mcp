/**
 * The paragraph anchor registry: one JSON file of recorded anchors.
 *
 * The file is `~/Library/Application Support/apple-notes-mcp/paragraph-anchors.json`,
 * or the absolute path in `APPLE_NOTES_MCP_ANCHOR_FILE`. Its directory is
 * created with mode 0700 and the file with mode 0600. It holds the normalized
 * text of every anchored paragraph, so it is as private as the notes.
 *
 * Every change takes a lock file beside the registry, re-reads the file,
 * writes a temporary file and renames it into place, so a reader never sees a
 * half-written registry and two writers do not lose each other's anchors. A
 * symlinked or non-regular registry file is refused, and a file that does not
 * parse is reported, never overwritten.
 *
 * Only this file is ever written. The Notes library is never touched.
 *
 * @module services/anchorRegistry
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CodedError, type ErrorCode } from "../utils/errorCodes.js";
import { ANCHOR_ID_PATTERN, type ParagraphAnchor } from "../utils/paragraphAnchors.js";

/** Most anchors one registry holds. */
export const MAX_ANCHORS = 20000;
/** Largest registry file read. */
export const MAX_REGISTRY_BYTES = 32 * 1024 * 1024;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 30000;

/** Stable failure codes. */
export type AnchorRegistryErrorCode =
  | "unsafe-path"
  | "corrupt-registry"
  | "registry-full"
  | "registry-busy"
  | "anchor-not-found"
  | "invalid-anchor-id";

const ENVELOPE: Record<AnchorRegistryErrorCode, ErrorCode> = {
  "unsafe-path": "validation_error",
  "corrupt-registry": "operation_failed",
  "registry-full": "validation_error",
  "registry-busy": "operation_failed",
  "anchor-not-found": "not_found",
  "invalid-anchor-id": "validation_error",
};

export class AnchorRegistryError extends CodedError {
  constructor(
    readonly reason: AnchorRegistryErrorCode,
    message: string
  ) {
    super(message, { code: ENVELOPE[reason], reason });
    this.name = "AnchorRegistryError";
  }
}

/** The registry file for this environment. */
export function anchorRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.APPLE_NOTES_MCP_ANCHOR_FILE?.trim();
  if (override) {
    if (!isAbsolute(override))
      throw new AnchorRegistryError(
        "unsafe-path",
        "APPLE_NOTES_MCP_ANCHOR_FILE must be an absolute path."
      );
    return resolve(override);
  }
  return join(homedir(), "Library/Application Support/apple-notes-mcp/paragraph-anchors.json");
}

const STRING_OR_NULL = (v: unknown) => v === null || typeof v === "string";

/** True when a parsed record has every field an anchor needs, with the right types. */
function isAnchor(v: unknown): v is ParagraphAnchor {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.anchorId === "string" &&
    ANCHOR_ID_PATTERN.test(a.anchorId) &&
    typeof a.noteIdentifier === "string" &&
    STRING_OR_NULL(a.noteId) &&
    STRING_OR_NULL(a.paragraphId) &&
    ["unique", "shared", "missing"].includes(a.paragraphIdStatus as string) &&
    typeof a.text === "string" &&
    typeof a.fingerprint === "string" &&
    STRING_OR_NULL(a.prevFingerprint) &&
    STRING_OR_NULL(a.nextFingerprint) &&
    Number.isInteger(a.blockIndex) &&
    typeof a.style === "string" &&
    typeof a.createdAt === "string" &&
    (a.updatedAt === undefined || typeof a.updatedAt === "string")
  );
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The anchor registry stored at one path. */
export class AnchorRegistry {
  constructor(
    readonly path: string = anchorRegistryPath(),
    private readonly lockWaitMs = LOCK_WAIT_MS
  ) {}

  /** A new random anchor id. */
  static newId(): string {
    return `pa_${randomBytes(12).toString("hex")}`;
  }

  private ensureDir(): void {
    const dir = dirname(this.path);
    try {
      if (!lstatSync(dir).isDirectory())
        throw new AnchorRegistryError(
          "unsafe-path",
          `${dir} is not a directory (symlinks are refused).`
        );
    } catch (error) {
      if (error instanceof AnchorRegistryError) throw error;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Every anchor in the file, in the order recorded. A missing file is an empty registry. */
  load(): ParagraphAnchor[] {
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new AnchorRegistryError(
        "unsafe-path",
        `Refusing to read ${this.path}: not a regular file.`
      );
    }
    let text: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile())
        throw new AnchorRegistryError(
          "unsafe-path",
          `Refusing to read ${this.path}: not a regular file.`
        );
      if (stat.size > MAX_REGISTRY_BYTES)
        throw new AnchorRegistryError(
          "corrupt-registry",
          `${this.path} is ${stat.size} bytes; the limit is ${MAX_REGISTRY_BYTES}.`
        );
      const data = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const n = readSync(fd, data, read, stat.size - read, read);
        if (n <= 0) break;
        read += n;
      }
      text = data.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
    // An empty file (for example one made with `touch`) is an empty
    // registry, not a corrupt one; the next write replaces it atomically.
    if (text.trim() === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AnchorRegistryError(
        "corrupt-registry",
        `${this.path} is not valid JSON; it was left unchanged. Move it aside to start a new registry.`
      );
    }
    const anchors = (parsed as { anchors?: unknown })?.anchors;
    if (
      (parsed as { version?: unknown })?.version !== 1 ||
      !Array.isArray(anchors) ||
      !anchors.every(isAnchor)
    )
      throw new AnchorRegistryError(
        "corrupt-registry",
        `${this.path} is not a version 1 anchor registry; it was left unchanged.`
      );
    return anchors;
  }

  /** One anchor, or an `anchor-not-found` error. */
  get(anchorId: string): ParagraphAnchor {
    if (!ANCHOR_ID_PATTERN.test(anchorId))
      throw new AnchorRegistryError(
        "invalid-anchor-id",
        `Invalid anchor id "${anchorId}": expected pa_ and 24 hex digits.`
      );
    const anchor = this.load().find((a) => a.anchorId === anchorId);
    if (!anchor) throw new AnchorRegistryError("anchor-not-found", `No anchor ${anchorId}.`);
    return anchor;
  }

  /**
   * Apply `change` to the current anchors under the lock and save the result.
   * Returns what `change` returns.
   */
  update<T>(change: (anchors: ParagraphAnchor[]) => { anchors: ParagraphAnchor[]; result: T }): T {
    this.ensureDir();
    const release = this.lock();
    try {
      const { anchors, result } = change(this.load());
      if (anchors.length > MAX_ANCHORS)
        throw new AnchorRegistryError(
          "registry-full",
          `The registry holds at most ${MAX_ANCHORS} anchors; prune stale anchors first.`
        );
      this.write(anchors);
      return result;
    } finally {
      release();
    }
  }

  private write(anchors: ParagraphAnchor[]): void {
    try {
      if (!lstatSync(this.path).isFile())
        throw new AnchorRegistryError(
          "unsafe-path",
          `Refusing to replace ${this.path}: it is not a regular file.`
        );
    } catch (error) {
      if (error instanceof AnchorRegistryError) throw error;
    }
    const temp = join(
      dirname(this.path),
      `.paragraph-anchors.${randomBytes(6).toString("hex")}.tmp`
    );
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const data = Buffer.from(JSON.stringify({ version: 1, anchors }, null, 1) + "\n", "utf8");
      let written = 0;
      while (written < data.length) written += writeSync(fd, data, written);
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      unlinkSync(temp);
      throw error;
    }
    closeSync(fd);
    try {
      renameSync(temp, this.path);
    } catch (error) {
      unlinkSync(temp);
      throw error;
    }
  }

  /** Take the lock file, waiting briefly; a lock older than 30 s is treated as abandoned. */
  private lock(): () => void {
    const lockPath = `${this.path}.lock`;
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        const fd = openSync(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return () => {
          try {
            unlinkSync(lockPath);
          } catch {
            // Already gone: nothing to release.
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline)
        throw new AnchorRegistryError(
          "registry-busy",
          `Another process holds ${lockPath}; try again shortly.`
        );
      sleep(25);
    }
  }

  /**
   * Record anchors, reusing an existing anchor for the same note, paragraph ID,
   * text and block index. Each new anchor gets a fresh id (a candidate's own
   * anchorId is ignored). Returns each anchor with whether it was new.
   */
  record(candidates: ParagraphAnchor[]): Array<{ anchor: ParagraphAnchor; created: boolean }> {
    return this.update((anchors) => {
      const out: Array<{ anchor: ParagraphAnchor; created: boolean }> = [];
      const next = [...anchors];
      for (const candidate of candidates) {
        const existing = next.find(
          (a) =>
            a.noteIdentifier === candidate.noteIdentifier &&
            a.paragraphId === candidate.paragraphId &&
            a.fingerprint === candidate.fingerprint &&
            a.blockIndex === candidate.blockIndex
        );
        if (existing) {
          out.push({ anchor: existing, created: false });
          continue;
        }
        const anchor = { ...candidate, anchorId: AnchorRegistry.newId() };
        next.push(anchor);
        out.push({ anchor, created: true });
      }
      return { anchors: next, result: out };
    });
  }

  /** Replace one anchor's fields (not its id or creation time). */
  replace(anchor: ParagraphAnchor): ParagraphAnchor {
    return this.update((anchors) => {
      const i = anchors.findIndex((a) => a.anchorId === anchor.anchorId);
      if (i < 0) throw new AnchorRegistryError("anchor-not-found", `No anchor ${anchor.anchorId}.`);
      const saved = { ...anchor, createdAt: anchors[i].createdAt };
      const next = [...anchors];
      next[i] = saved;
      return { anchors: next, result: saved };
    });
  }

  /** Remove anchors by id; returns the ids that were present. */
  remove(anchorIds: string[]): string[] {
    const wanted = new Set(anchorIds);
    return this.update((anchors) => ({
      anchors: anchors.filter((a) => !wanted.has(a.anchorId)),
      result: anchors.filter((a) => wanted.has(a.anchorId)).map((a) => a.anchorId),
    }));
  }
}
