import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkSignature, type RichNote } from "../utils/noteRichText.js";

export const NATIVE_TAGS_SHORTCUT = "Apple Notes MCP - Native Tags";

/** Normalize, validate, and deduplicate native tag names supplied by a client. */
export function normalizeNativeTags(tags: string[]): string[] {
  if (!tags.length || tags.length > 100) throw new Error("Provide between 1 and 100 tags");
  return [
    ...new Set(
      tags.map((value) => {
        const tag = value.normalize("NFC").replace(/^#/, "");
        if (tag.length > 100 || !/^(?=.*\p{L})[\p{L}\p{N}_-]+$/u.test(tag))
          throw new Error(
            "Tags must contain a letter and only letters, digits, hyphens or underscores"
          );
        return tag;
      })
    ),
  ];
}

export interface NativeTagRequest {
  id: string;
  expectedContentHash: string;
  title: string;
  scopeText: string;
  tags: string[];
}

export interface NativeTagSnapshot {
  contentHash: string;
  title: string;
  plaintext: string;
  rich: RichNote;
}

export interface NativeTagDependencies {
  read: (id: string) => NativeTagSnapshot;
  candidates: (title: string, scopeText: string) => string[];
  run: (input: { title: string; scopeText: string; tags: string[] }) => void;
}

/** The installed Shortcut repeats the scoped search and refuses non-unique results. */
export function addNativeTags(request: NativeTagRequest, deps: NativeTagDependencies) {
  if (!/^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p\d+$/i.test(request.id))
    throw new Error("An exact CoreData note ID is required");
  if (
    request.scopeText.length < 12 ||
    request.scopeText.length > 500 ||
    /[\r\n\0]/u.test(request.scopeText)
  )
    throw new Error("scopeText must be a stable, single-line project marker of 12–500 characters");
  const tags = normalizeNativeTags(request.tags);
  const before = deps.read(request.id);
  if (before.contentHash !== request.expectedContentHash)
    throw new Error("Note revision changed; read it again");
  if (before.title !== request.title || !before.plaintext.includes(request.scopeText))
    throw new Error("The exact note does not match the title and project marker");
  const missing = tags.filter((tag) => !before.rich.nativeTags.includes(tag));
  if (!missing.length)
    return { nativeTags: before.rich.nativeTags, added: [], contentHash: before.contentHash };
  const candidates = deps.candidates(request.title, request.scopeText);
  if (candidates.length !== 1 || candidates[0] !== request.id)
    throw new Error(
      "Shortcuts selection is ambiguous or points to a different note; nothing was changed"
    );
  if (deps.read(request.id).contentHash !== request.expectedContentHash)
    throw new Error("Note revision changed during preflight; nothing was changed");
  let transportWarning: string | undefined;
  try {
    deps.run({ title: request.title, scopeText: request.scopeText, tags: missing });
  } catch (error) {
    transportWarning =
      error instanceof Error ? error.message : "Shortcuts completion was uncertain";
  }
  const after = deps.read(request.id);
  const allTags = [...new Set([...before.rich.nativeTags, ...tags])];
  const textWithoutTags = (text: string) => {
    for (const tag of [...allTags].sort((a, b) => b.length - a.length)) {
      const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`#${escaped}(?![\\p{L}\\p{N}_-])`, "gu"), "");
    }
    return text.replace(/[\s\ufffc]/gu, "");
  };
  if (
    after.title !== before.title ||
    allTags.some((tag) => !after.rich.nativeTags.includes(tag)) ||
    textWithoutTags(before.rich.text) !== textWithoutTags(after.rich.text) ||
    linkSignature(before.rich.links) !== linkSignature(after.rich.links) ||
    before.rich.nativeObjectIds.some((id) => !after.rich.nativeObjectIds.includes(id)) ||
    before.rich.hasChecklist !== after.rich.hasChecklist
  ) {
    throw new Error(
      "Shortcuts ran, but exact-ID tags/text/links readback was not verified. Read the note before any retry"
    );
  }
  return {
    nativeTags: after.rich.nativeTags,
    added: missing,
    contentHash: after.contentHash,
    ...(transportWarning
      ? {
          transportWarning:
            "Shortcuts completion was uncertain, but all requested native tags and preserved content were verified by exact ID.",
        }
      : {}),
  };
}

/** Resolve exactly one installed Native Tags Shortcut by name or UUID. */
export function nativeTagsStatus(
  shortcut = process.env.APPLE_NOTES_MCP_TAGS_SHORTCUT || NATIVE_TAGS_SHORTCUT
) {
  const lines = execFileSync("/usr/bin/shortcuts", ["list", "--show-identifiers"], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).split(/\r?\n/u);
  const matches = lines.flatMap((line) => {
    const match = /^(.*) \(([0-9A-Fa-f-]{36})\)$/.exec(line);
    return match && (match[1] === shortcut || match[2].toLowerCase() === shortcut.toLowerCase())
      ? [{ name: match[1], identifier: match[2] }]
      : [];
  });
  return {
    shortcut,
    installed: matches.length === 1,
    identifier: matches.length === 1 ? matches[0].identifier : undefined,
  };
}

/** Invoke the installed Native Tags bridge with a private temporary request. */
export function runNativeTagsShortcut(input: { title: string; scopeText: string; tags: string[] }) {
  const status = nativeTagsStatus();
  if (!status.installed)
    throw new Error(`Import the supplied ${status.shortcut}.shortcut in Shortcuts first`);
  const directory = mkdtempSync(join(tmpdir(), "apple-notes-native-tags-"));
  try {
    const path = join(directory, "request.json");
    writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
    execFileSync("/usr/bin/shortcuts", ["run", status.identifier!, "--input-path", path], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // CLI output may be empty even after the Notes actions complete. Success is
    // established by the caller's exact-ID native metadata/content readback.
  } catch {
    throw new Error(
      "Native tag operation did not complete cleanly (possibly waiting for macOS permission). Do not retry automatically; read the exact note and check Shortcuts"
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
