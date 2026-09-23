import { z } from "zod";
import { exactIdInput, NOTE_ID_MESSAGE } from "../utils/noteIdentifiers.js";
import { errorResult } from "../utils/errorCodes.js";
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import {
  appendNative,
  backgroundDependencies,
  backgroundStatus,
  markdownNoteStatus,
  nativeTagBridgeStatus,
  readBackgroundSnapshot,
  mutateBackground,
  assertPreserved,
  setNativeTag,
  NATIVE_APPEND_HTML_SUBSET,
  type BackgroundDependencies,
} from "../services/backgroundNotes.js";
import { normalizeNativeTags } from "../services/nativeTags.js";
import { getCapabilityMatrix } from "../services/capabilityMatrix.js";
import { parseNoteTable } from "../utils/noteTables.js";
import { readRichNote, type RichNote } from "../utils/noteRichText.js";

// Enabled only after a live exact-ID preservation test on this build.
export const VERIFIED_BACKGROUND = new Set<string>([
  "append-native",
  "create-checklist-item",
  "create-table",
  "insert-note-link",
  "set-note-pinned",
  "remove-native-tags",
  "replace-native-tag",
  "create-note-markdown",
  "create-note-markdown-blocks",
]);
const LIVE_VALIDATION_BLOCKERS: Record<string, string> = {};
const signingRefusal =
  "Installed Shortcuts refuses to sign this Notes action (unsupported features); no background fallback is enabled";
export const UNAVAILABLE = {
  "set-checklist-item": signingRefusal,
  "delete-checklist-item": signingRefusal,
  "set-attachment-size": signingRefusal,
  "insert-mention": signingRefusal,
  "update-table-cells":
    "No background cell-editing action; replacing a table would change its identity and position",
  "edit-rich-note":
    "Native text replacement needs current UI selection; full-body rewriting is protected",
  "smart-folders": "No supported background interface for Smart Folder rules",
  "rename-tag-globally":
    "Cannot update Smart Folder references in background; use replace-native-tag on explicit notes",
  "sharing-permissions": "No supported background interface for sharing invitations or permissions",
  "note-lock": "Notes lock actions require the foreground and may require user authentication",
  "record-audio": "Recording requires the Notes UI",
  "transcribe-audio": "No supported background Notes transcription action",
  "scan-and-markup": "No supported background scanning or graphical markup action",
};
/** Refuse a native operation that has not passed live validation, unless explicitly allowed. */
export function requireValidated(name: string) {
  if (!VERIFIED_BACKGROUND.has(name) && process.env.APPLE_NOTES_MCP_ALLOW_UNVERIFIED !== "1")
    throw new Error(
      (UNAVAILABLE as Record<string, string>)[name] ||
        LIVE_VALIDATION_BLOCKERS[name] ||
        `${name} has not passed live background validation in this build; see get-capabilities`
    );
}
// Accepts the x-coredata id as before, plus the note's Notes UUID or numeric
// Core Data key, resolved to the x-coredata id before the handler runs.
const id = exactIdInput("ICNote", /^x-coredata:\/\/[0-9a-f-]+\/ICNote\/p\d+$/i, NOTE_ID_MESSAGE);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const common = {
  id,
  expectedContentHash: revision,
  scopeText: z
    .string()
    .min(12)
    .max(500)
    .describe(
      "Distinctive existing phrase used by Notes search. Prefer plain words without punctuation, hashtags, or paths."
    ),
};
/**
 * Cells for create-table when rows is omitted: an empty 2 x 2 table, matching
 * what Format > Table inserts in Notes on Mac
 * (https://support.apple.com/guide/notes/add-a-table-apd0a136b9cc/mac).
 */
export const EMPTY_TABLE_ROWS: readonly string[][] = [
  ["", ""],
  ["", ""],
];
const htmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Most items create-checklist-items appends in one call. Each item is one
 * synchronous Shortcuts bridge run of a few seconds, so the cap keeps a full
 * call well inside common MCP client request timeouts: a client that times out
 * and retries the whole batch never sees the landed/stoppedAt report and would
 * append duplicates.
 */
export const MAX_CHECKLIST_BATCH = 20;

type ChecklistItem = NonNullable<RichNote["checklistItems"]>[number];
const byPosition = (items: ChecklistItem[] = []) => [...items].sort((a, b) => a.start - b.start);

/**
 * Append checklist items one bridge run at a time, verifying after every run
 * that exactly one new unchecked item with the requested text and a new native
 * identity appeared and that every earlier item kept its identity and text.
 * The first uncertain result stops the batch; the report says which items
 * landed, which one is uncertain, and which were never attempted.
 */
export function appendChecklistItems(
  args: { id: string; expectedContentHash: string; scopeText: string; items: string[] },
  deps: BackgroundDependencies,
  readRich: (id: string) => RichNote
): Record<string, unknown> {
  const existing = new Set(byPosition(readRich(args.id).checklistItems).map((item) => item.id));
  const landed: Array<{ index: number; id: string; text: string }> = [];
  let contentHash = args.expectedContentHash;
  for (const [index, text] of args.items.entries()) {
    let wrote = false;
    try {
      const result = mutateBackground(
        { ...args, expectedContentHash: contentHash },
        "create-checklist-item",
        { text },
        (before, after) => {
          wrote = true;
          assertPreserved(before, after, { append: true });
          const added = after.checklist.slice(before.checklist.length);
          if (added.length !== 1 || added[0].text !== text || added[0].done)
            throw new Error("Native checklist item not verified");
        },
        deps
      );
      const items = byPosition(readRich(args.id).checklistItems);
      const fresh = items.filter(
        (item) => !existing.has(item.id) && !landed.some((done) => done.id === item.id)
      );
      if (fresh.length !== 1 || fresh[0].text !== text || fresh[0].done)
        throw new Error("Native checklist identity not verified");
      for (const done of landed) {
        const current = items.find((item) => item.id === done.id);
        if (!current || current.text !== done.text || current.done)
          throw new Error("An earlier appended item changed identity or text");
      }
      landed.push({ index, id: fresh[0].id, text });
      contentHash = result.contentHash;
    } catch (error) {
      return {
        ok: false,
        id: args.id,
        landed,
        stoppedAt: {
          index,
          text,
          outcome: wrote ? "uncertain" : "not-written",
          error: error instanceof Error ? error.message : String(error),
        },
        notAttempted: args.items.slice(index + 1),
        contentHash,
        message: `Stopped at item ${index + 1} of ${args.items.length}; ${landed.length} item(s) landed and were verified. Read the exact note before retrying, and retry only items that are not present.`,
      };
    }
  }
  const finalItems = byPosition(readRich(args.id).checklistItems);
  const tail = finalItems.slice(finalItems.length - landed.length);
  const orderVerified =
    tail.length === landed.length &&
    tail.every((item, i) => item.id === landed[i].id && item.text === landed[i].text);
  return {
    ok: orderVerified,
    id: args.id,
    contentHash,
    items: landed,
    orderVerified,
    ...(orderVerified
      ? {}
      : {
          message:
            "Every item landed and was verified, but they are not the note's last checklist items in the requested order. Read the note before editing it further.",
        }),
  };
}

/** Register verified native editing and capability tools on the MCP server. */
export function registerNativeOperations(server: McpServer, manager: AppleNotesManager) {
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    input: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Record<string, unknown>,
    readOnly = false
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: input,
        outputSchema: z.object({ ok: z.boolean().optional() }).passthrough(),
        annotations: { readOnlyHint: readOnly },
      },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          const result = handler(args as z.infer<z.ZodObject<S>>);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : "Operation failed", error);
        }
      }) as unknown as ToolCallback<S>
    );
  }
  tool(
    "get-capabilities",
    "Use when: checking native background-edit support or which feature groups this Mac supports before calling a tool.\nReturns: bridge installation, implementation, verification, availability, and specific limitations per operation; plus runtimeOS and an OS-version-aware features matrix (available, osSupported, minimumMacOSVersion, requirements, missing, unverified, machine reason code) per feature group.\nDo not use when: checking only the Native Tags bridge (native-tags-status).\nSafety: read-only; does not open Notes or run a mutation.",
    {},
    () => {
      let bridge: { installed: boolean; shortcut: string; identifier?: string; error?: string };
      try {
        bridge = backgroundStatus();
      } catch {
        bridge = {
          installed: false,
          shortcut: "Apple Notes MCP - Background Operations v5",
          error: "Shortcuts helper unavailable",
        };
      }
      const native = [
        "append-native",
        "create-checklist-item",
        "create-table",
        "set-note-pinned",
        "remove-native-tags",
        "replace-native-tag",
        "insert-note-link",
        "create-note-markdown",
        "create-note-markdown-blocks",
      ];
      let tagBridgeInstalled = false;
      try {
        tagBridgeInstalled = nativeTagBridgeStatus().installed;
      } catch {
        /* Report unavailable without opening UI. */
      }
      let markdownBridgeInstalled = false;
      try {
        markdownBridgeInstalled = markdownNoteStatus().installed;
      } catch {
        /* Report unavailable without opening UI. */
      }
      // create-note's Markdown format runs on its own bridge; the rest share Background Operations.
      const installed = (name: string) =>
        name.startsWith("create-note-markdown") ? markdownBridgeInstalled : bridge.installed;
      return {
        bridge,
        nativeTagBridgeInstalled: tagBridgeInstalled,
        markdownNoteBridgeInstalled: markdownBridgeInstalled,
        mode: "background-only",
        operations: Object.fromEntries(
          native.map((name) => [
            name,
            {
              implemented: true,
              verified: VERIFIED_BACKGROUND.has(name),
              available:
                VERIFIED_BACKGROUND.has(name) &&
                installed(name) &&
                (name !== "replace-native-tag" || tagBridgeInstalled),
              reason: !VERIFIED_BACKGROUND.has(name)
                ? (UNAVAILABLE as Record<string, string>)[name] ||
                  LIVE_VALIDATION_BLOCKERS[name] ||
                  "Live validation pending; install the shortcut and complete the isolated acceptance tests"
                : !installed(name)
                  ? "Run apple-notes-mcp setup and approve Add Shortcut in macOS"
                  : name === "replace-native-tag" && !tagBridgeInstalled
                    ? "Run apple-notes-mcp setup to install the Native Tags bridge for the addition phase"
                    : undefined,
            },
          ])
        ),
        unavailable: UNAVAILABLE,
        ...getCapabilityMatrix(),
      };
    },
    true
  );
  tool(
    "append-native",
    "Use when: appending formatted content to a native-object note without replacing its body.\nReturns: exact-ID preservation and appended-content readback.\nDo not use when: the existing note can be safely handled by append-to-note or the scope phrase is ambiguous.\nSafety: requires a fresh revision and unique existing scope phrase of plain words; avoid punctuation, hashtags, and paths because Notes search may not resolve them literally. Supports bounded plaintext, semantic HTML, and Markdown without external fetching or automatic retries.\nHTML subset: " +
      NATIVE_APPEND_HTML_SUBSET,
    {
      ...common,
      content: z
        .string()
        .min(1)
        .max(1024 * 1024),
      format: z.enum(["plaintext", "html", "markdown"]).default("plaintext"),
    },
    (args) => {
      requireValidated("append-native");
      return appendNative(manager, args);
    }
  );
  tool(
    "create-checklist-item",
    "Use when: appending one real unchecked Notes checklist item.\nReturns: the created checklist identity after exact-note readback.\nDo not use when: plain text is sufficient or more than one item is requested.\nSafety: preserves existing text, links, native objects, checklist identities, and formatting.",
    {
      ...common,
      text: z
        .string()
        .min(1)
        .max(10000)
        .refine((s) => !/[\r\n\0]/u.test(s), "One line per checklist item"),
    },
    (args) => {
      requireValidated("create-checklist-item");
      const result = mutateBackground(
        args,
        "create-checklist-item",
        { text: args.text },
        (before, after) => {
          assertPreserved(before, after, { append: true });
          const added = after.checklist.slice(before.checklist.length);
          if (added.length !== 1 || added[0].text !== args.text || added[0].done)
            throw new Error("Native checklist item not verified");
        },
        backgroundDependencies(manager)
      );
      return { ...result, items: readRichNote(args.id).checklistItems };
    }
  );
  tool(
    "create-checklist-items",
    "Use when: appending several real unchecked Notes checklist items to one note, in order.\nReturns: each landed item's native identity and text, the final order check, and the new revision; on a stop, which items landed, the item whose outcome is uncertain, and the items not attempted.\nDo not use when: one item is enough (create-checklist-item) or plain text is sufficient.\nSafety: runs the verified single-item bridge once per item, chaining each verified revision into the next; checks after every item that exactly one new unchecked item with that text and a new identity appeared and that earlier items kept theirs, and stops at the first uncertain result without retrying. Each item takes a few seconds, so a full batch can run about a minute; if the call times out on the client side, read the note before retrying and send only items that are not present.",
    {
      ...common,
      items: z
        .array(
          z
            .string()
            .min(1)
            .max(10000)
            .refine((s) => !/[\r\n\0]/u.test(s), "One line per checklist item")
        )
        .min(1)
        .max(MAX_CHECKLIST_BATCH)
        .describe(`Item texts in the order they should appear (1-${MAX_CHECKLIST_BATCH})`),
    },
    (args) => {
      requireValidated("create-checklist-item");
      return appendChecklistItems(args, backgroundDependencies(manager), readRichNote);
    }
  );
  tool(
    "create-table",
    "Use when: appending one native Notes table from a rectangular array of strings, or an empty table when rows is omitted.\nReturns: the native table identity and decoded cells after readback.\nDo not use when: a text table is acceptable or the rows are not rectangular.\nSafety: never substitutes text; preserves existing rich content and reports failure unless the native table is verified.",
    {
      ...common,
      rows: z
        .array(z.array(z.string().max(10000)).min(1).max(100))
        .min(1)
        .max(1000)
        .optional()
        .describe(
          "Cell text, row by row. Omit for an empty 2 x 2 table, the size Notes itself inserts."
        ),
    },
    (input) => {
      requireValidated("create-table");
      const args = { ...input, rows: input.rows ?? EMPTY_TABLE_ROWS };
      if (args.rows.some((row) => row.length !== args.rows[0].length))
        throw new Error("Table rows must have equal cell counts");
      const before = readRichNote(args.id);
      const content =
        "<table>" +
        args.rows
          .map(
            (row) => "<tr>" + row.map((v) => "<td>" + htmlEscape(v) + "</td>").join("") + "</tr>"
          )
          .join("") +
        "</table>";
      const result = mutateBackground(
        args,
        "append-html",
        { text: "<div><br></div>" + content },
        (oldNote, newNote) => {
          assertPreserved(oldNote, newNote, { append: true });
          const inserted =
            newNote.rich.objectData?.filter(
              (o) => o.type?.includes("table") && !oldNote.rich.nativeObjectIds.includes(o.id)
            ) || [];
          if (
            inserted.length !== 1 ||
            JSON.stringify(parseNoteTable(Buffer.from(inserted[0].mergeable, "hex")).rows) !==
              JSON.stringify(args.rows)
          )
            throw new Error("Native table cells not verified");
        },
        backgroundDependencies(manager)
      );
      const current = readRichNote(args.id);
      const added =
        current.objectData?.filter(
          (obj) => obj.type?.includes("table") && !before.nativeObjectIds.includes(obj.id)
        ) || [];
      if (added.length !== 1)
        throw new Error(
          "Table result uncertain; native table not verified. Read the note before retrying"
        );
      const table = parseNoteTable(Buffer.from(added[0].mergeable, "hex"));
      if (JSON.stringify(table.rows) !== JSON.stringify(args.rows))
        throw new Error("Native table cells not verified; read before retrying");
      return { ...result, table: { id: added[0].id, ...table } };
    }
  );
  tool(
    "set-note-pinned",
    "Use when: setting one exact note's pinned state.\nReturns: the verified requested state and new revision.\nDo not use when: only reading pinned metadata (get-note-metadata).\nSafety: checks expectedPinned and a fresh content revision before changing metadata; never rewrites the body.",
    { ...common, expectedPinned: z.boolean(), pinned: z.boolean() },
    (args) => {
      requireValidated("set-note-pinned");
      const deps = backgroundDependencies(manager);
      const s = deps.read(args.id);
      if (s.hash !== args.expectedContentHash || s.pinned !== args.expectedPinned)
        throw new Error("Note or pinned state changed; read it again");
      if (s.pinned === args.pinned)
        return { ok: true, id: args.id, pinned: s.pinned, contentHash: s.hash, changed: false };
      const run = deps.run;
      deps.run = (input) => {
        if (deps.read(args.id).pinned !== args.expectedPinned)
          throw new Error("Pinned state changed during preflight");
        run(input);
      };
      return {
        ...mutateBackground(
          args,
          "set-pinned",
          { change: args.pinned ? "add" : "remove" },
          (before, after) => {
            assertPreserved(before, after);
            if (after.pinned !== args.pinned) throw new Error("Pinned state not verified");
          },
          deps
        ),
        pinned: args.pinned,
      };
    }
  );
  tool(
    "remove-native-tags",
    "Use when: removing specified native tags from one exact note.\nReturns: verified remaining tags and new revision.\nDo not use when: deleting a global tag definition or changing Smart Folder rules.\nSafety: preserves unrelated tags and native objects and never retries an uncertain mutation.",
    { ...common, tags: z.array(z.string().min(1).max(101)).min(1).max(100) },
    (args) => {
      requireValidated("remove-native-tags");
      let hash = args.expectedContentHash;
      const completed: string[] = [];
      for (const tag of normalizeNativeTags(args.tags)) {
        try {
          const result = setNativeTag(manager, {
            ...args,
            expectedContentHash: hash,
            tag,
            present: false,
          });
          hash = result.contentHash;
          completed.push(tag);
        } catch (error) {
          throw new Error(
            `Stopped after tags ${JSON.stringify(completed)}; read exact note before retry: ${String(error)}`
          );
        }
      }
      return { ok: true, id: args.id, removed: completed, contentHash: hash };
    }
  );
  tool(
    "replace-native-tag",
    "Use when: replacing one native tag across an explicit list of freshly read notes.\nReturns: per-note results and remaining work after any failure.\nDo not use when: renaming global tag definitions or Smart Folder rules.\nSafety: adds and verifies the new tag before removing the old one and stops on the first uncertain result.",
    {
      notes: z.array(z.object(common)).min(1).max(100),
      oldTag: z.string().min(1).max(101),
      newTag: z.string().min(1).max(101),
    },
    (args) => {
      requireValidated("replace-native-tag");
      const [oldTag] = normalizeNativeTags([args.oldTag]);
      const [newTag] = normalizeNativeTags([args.newTag]);
      if (new Set(args.notes.map((n) => n.id)).size !== args.notes.length)
        throw new Error("Duplicate note IDs");
      for (const n of args.notes)
        if (readBackgroundSnapshot(manager, n.id).hash !== n.expectedContentHash)
          throw new Error("Note revision changed; no replacement started");
      const results: Record<string, unknown>[] = [];
      for (const n of args.notes) {
        try {
          const initial = readBackgroundSnapshot(manager, n.id);
          if (!initial.rich.nativeTags.includes(oldTag) || oldTag === newTag) {
            results.push({ id: n.id, changed: false });
            continue;
          }
          const added = setNativeTag(manager, { ...n, tag: newTag, present: true });
          const removed = setNativeTag(manager, {
            ...n,
            expectedContentHash: added.contentHash,
            tag: oldTag,
            present: false,
          });
          results.push(removed);
        } catch (error) {
          results.push({ id: n.id, ok: false, error: String(error) });
          return { ok: false, results, remaining: args.notes.length - results.length };
        }
      }
      return { ok: true, results };
    }
  );
  tool(
    "insert-note-link",
    "Use when: appending a real Notes deep link to a native-object note.\nReturns: verified link destination and label after exact-note readback.\nDo not use when: only retrieving a deep link (get-note-link).\nSafety: retrieves the real target URL, preserves existing rich content, and creates a static label rather than a dynamic-title object.",
    { ...common, linkedNoteId: id, label: z.string().min(1).max(2000).optional() },
    (args) => {
      requireValidated("insert-note-link");
      const link = manager.getNoteLinkById(args.linkedNoteId);
      if (!link) throw new Error("Real Notes link unavailable");
      const linked = manager.getNoteById(args.linkedNoteId);
      if (!linked) throw new Error("Linked note not found");
      const result = appendNative(manager, {
        ...args,
        content: `<div><a href="${htmlEscape(link)}">${htmlEscape(args.label || linked.title)}</a></div>`,
        format: "html",
      });
      if (
        !readRichNote(args.id).links.some(
          (l) => l.url === link && l.text === (args.label || linked.title)
        )
      )
        throw new Error("Link result uncertain; read note before retrying");
      return result;
    }
  );
}
