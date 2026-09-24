/**
 * The saved Markdown template library.
 *
 * Templates live as `<slug>.json` in one directory, by default
 * `~/Library/Application Support/apple-notes-mcp/templates`, or the absolute
 * path in `APPLE_NOTES_MCP_TEMPLATE_DIR`. The directory is created with mode
 * 0700 and each file with mode 0600. A symlinked library root, symlinked
 * template files and non-regular files are refused.
 *
 * Saving validates first and writes a temporary file that is then linked
 * (create-only) or renamed (`force`) into place, so a reader never sees a
 * half-written template and an existing template changes only with `force`.
 * Built-in template names are reserved: they cannot be saved over or deleted.
 * Listing skips unreadable, invalid or unsafe entries and counts them.
 *
 * Only this directory is ever written. The Notes library is never touched.
 *
 * @module services/templateStore
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  BUILTIN_TEMPLATE_NAMES,
  isBuiltinTemplate,
  MAX_TEMPLATE_BYTES,
  parseTemplate,
  TemplateValidationError,
  type PortableTemplate,
} from "../utils/markdownTemplate.js";

/** A saved template's storage name. */
export const TEMPLATE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Stable failure codes. */
export type TemplateStoreErrorCode =
  | "invalid-name"
  | "reserved-name"
  | "template-not-found"
  | "template-exists"
  | "invalid-template"
  | "unsafe-path";

export class TemplateStoreError extends Error {
  constructor(
    readonly code: TemplateStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TemplateStoreError";
  }
}

/** The library directory for this environment. */
export function templateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.APPLE_NOTES_MCP_TEMPLATE_DIR?.trim();
  if (override) {
    if (!isAbsolute(override))
      throw new TemplateStoreError(
        "unsafe-path",
        "APPLE_NOTES_MCP_TEMPLATE_DIR must be an absolute path."
      );
    return resolve(override);
  }
  return join(homedir(), "Library/Application Support/apple-notes-mcp/templates");
}

/** One saved template in a listing. */
export interface SavedTemplateSummary {
  /** Storage name (slug); use it as `template` in export-notes-markdown. */
  name: string;
  /** The `name` field inside the template, when it differs from the slug. */
  displayName?: string;
  description?: string;
  extends?: string;
  bytes: number;
  modified: string;
}

function checkName(name: string, action: "save" | "delete" | "read"): void {
  if (isBuiltinTemplate(name) && action !== "read")
    throw new TemplateStoreError(
      "reserved-name",
      `"${name}" is a built-in template and cannot be ${action === "save" ? "saved over" : "deleted"}.`
    );
  if (!TEMPLATE_SLUG.test(name))
    throw new TemplateStoreError(
      "invalid-name",
      `Template names are 1-64 characters of a-z, 0-9, "-" and "_", starting with a letter or digit; got "${name}".`
    );
}

/** A template library rooted at one directory. */
export class TemplateStore {
  constructor(readonly dir: string = templateDir()) {}

  /** The library root, which must be a real directory (not a symlink) when it exists. */
  private root(create: boolean): string | undefined {
    let stat;
    try {
      stat = lstatSync(this.dir);
    } catch {
      if (!create) return undefined;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      stat = lstatSync(this.dir);
    }
    if (!stat.isDirectory())
      throw new TemplateStoreError(
        "unsafe-path",
        `The template library ${this.dir} is not a directory (symlinks are refused).`
      );
    return this.dir;
  }

  private file(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  /** Read a saved template's text, refusing symlinks and non-regular files. */
  private readText(path: string): { text: string; bytes: number; mtime: Date } | undefined {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new TemplateStoreError("unsafe-path", `Refusing to read ${path}: not a regular file.`);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile())
        throw new TemplateStoreError(
          "unsafe-path",
          `Refusing to read ${path}: not a regular file.`
        );
      if (stat.size > MAX_TEMPLATE_BYTES)
        throw new TemplateValidationError([
          {
            path: "$",
            message: `template is ${stat.size} bytes; the limit is ${MAX_TEMPLATE_BYTES}`,
          },
        ]);
      const data = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const n = readSync(fd, data, read, stat.size - read, read);
        if (n <= 0) break;
        read += n;
      }
      return { text: data.subarray(0, read).toString("utf8"), bytes: read, mtime: stat.mtime };
    } finally {
      closeSync(fd);
    }
  }

  /** Saved templates in name order; `skipped` counts entries that are not usable. */
  list(): { templates: SavedTemplateSummary[]; skipped: number; dir: string } {
    const templates: SavedTemplateSummary[] = [];
    let skipped = 0;
    if (!this.root(false)) return { templates, skipped, dir: this.dir };
    for (const entry of readdirSync(this.dir).sort()) {
      if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
      const name = entry.slice(0, -5);
      if (!TEMPLATE_SLUG.test(name) || isBuiltinTemplate(name)) {
        skipped++;
        continue;
      }
      try {
        const read = this.readText(this.file(name));
        if (!read) continue;
        const template = parseTemplate(read.text);
        templates.push({
          name,
          ...(template.name && template.name !== name ? { displayName: template.name } : {}),
          ...(template.description ? { description: template.description } : {}),
          ...(template.extends ? { extends: template.extends } : {}),
          bytes: read.bytes,
          modified: read.mtime.toISOString(),
        });
      } catch {
        skipped++;
      }
    }
    return { templates, skipped, dir: this.dir };
  }

  /**
   * A saved template in its portable (as stored) form, or undefined when
   * there is none. Throws {@link TemplateValidationError} for a corrupt file.
   */
  find(name: string): PortableTemplate | undefined {
    checkName(name, "read");
    if (!this.root(false)) return undefined;
    const read = this.readText(this.file(name));
    return read ? parseTemplate(read.text) : undefined;
  }

  /** Like {@link find}, but a missing template is an error. */
  get(name: string): PortableTemplate {
    const template = this.find(name);
    if (!template)
      throw new TemplateStoreError(
        "template-not-found",
        `No saved template named "${name}". Built-in templates: ${BUILTIN_TEMPLATE_NAMES.join(", ")}.`
      );
    return template;
  }

  /**
   * Validate and save a template under `name`. Create-only unless `force`.
   * Returns the file path and whether an existing template was replaced.
   */
  save(
    name: string,
    text: string,
    { force = false }: { force?: boolean } = {}
  ): { path: string; replaced: boolean; bytes: number; template: PortableTemplate } {
    checkName(name, "save");
    const template = parseTemplate(text);
    const body = JSON.stringify(template, null, 2) + "\n";
    this.root(true);
    const path = this.file(name);
    let exists = false;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile())
        throw new TemplateStoreError(
          "unsafe-path",
          `Refusing to replace ${path}: it is not a regular file.`
        );
      exists = true;
    } catch (error) {
      if (error instanceof TemplateStoreError) throw error;
    }
    if (exists && !force)
      throw new TemplateStoreError(
        "template-exists",
        `A template named "${name}" already exists. Pass force: true to replace it.`
      );
    const temp = join(this.dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const data = Buffer.from(body, "utf8");
      let written = 0;
      while (written < data.length) written += writeSync(fd, data, written);
    } finally {
      closeSync(fd);
    }
    try {
      if (force) renameSync(temp, path);
      else {
        try {
          linkSync(temp, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new TemplateStoreError(
              "template-exists",
              `A template named "${name}" already exists. Pass force: true to replace it.`
            );
          throw error;
        }
      }
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* renamed away */
      }
    }
    return { path, replaced: exists, bytes: Buffer.byteLength(body), template };
  }

  /** Delete a saved template. Built-ins cannot be deleted. */
  delete(name: string): { path: string } {
    checkName(name, "delete");
    const path = this.file(name);
    let stat;
    try {
      if (!this.root(false)) throw new Error("absent");
      stat = lstatSync(path);
    } catch (error) {
      if (error instanceof TemplateStoreError) throw error;
      throw new TemplateStoreError("template-not-found", `No saved template named "${name}".`);
    }
    if (!stat.isFile())
      throw new TemplateStoreError(
        "unsafe-path",
        `Refusing to delete ${path}: not a regular file.`
      );
    unlinkSync(path);
    return { path };
  }
}
