/**
 * Folder scope guards on the private writer's write tools (#57): the shared
 * request fields, the tool schema fragment, and that every write service
 * forwards the guard to the writer. The writer is faked at the spawn level,
 * so no Notes data is touched; the writer-side check itself is covered by
 * the source contract test and scripts/test-private-writer-guards-copy-store.sh.
 */
import { describe, expect, it } from "vitest";
import type { spawnSync } from "node:child_process";
import { z } from "zod";
import { sha256Hex } from "./privateHelper.js";
import {
  PRIVATE_WRITER_PROTOCOL,
  PrivateWriteError,
  WRITER_MANIFEST_NAME,
  appendPlainText,
  defaultWriterDeps,
  editNote,
  type PrivateHelperDeps,
} from "./privateWriter.js";
import { scopeGuardFrom, writerScopeFields, writerScopeGuardInput } from "./privateWriterScope.js";
import { composeNote } from "./privateCompose.js";
import { setChecklistItem } from "./privateWriterChecklist.js";
import { setHighlight } from "./privateWriterHighlight.js";
import { addUrlCard } from "./privateWriterLinkCard.js";
import { setParagraphId } from "./privateWriterParagraphs.js";
import { addSectionLink } from "./privateWriterSectionLinks.js";
import {
  deleteTableRow,
  insertTableRow,
  pruneOrphanTable,
  setTableCell,
} from "./privateWriterTables.js";
import { addPaper } from "./privatePaperWriter.js";
import {
  createSmartFolder,
  deleteSmartFolder,
  updateSmartFolder,
} from "./privateWriterSmartFolders.js";
import { repairPurgeFlag } from "./privateWriterPurgeRepair.js";
import { writerEnvelopeCode } from "../tools/privateWriterTools.js";

const NOTE = "D629A948-0C61-43BA-8FDE-04CD6DED38C7";
const UUID2 = "6D246B17-0E48-47C4-BD1C-72D9F8AEAC0C";
const REV = `r1:${"a".repeat(64)}`;
const FREV = `f1:${"a".repeat(64)}`;
const DIGEST = `t1:${"b".repeat(64)}`;
const F1 = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICFolder/p10298";
const F2 = "x-coredata://8FA9FE0E-3B93-4057-AD95-A0EB6D4B5F06/ICFolder/p9246";
const GUARD = { ifFolderId: F1, ifAncestorFolderId: F2, forbiddenAncestorFolderIds: [F2] };

/** A writer that records each request and refuses it the way the scope check does. */
function refusingWriter(requests: Array<Record<string, unknown>>): PrivateHelperDeps {
  const manifest = JSON.stringify({
    schemaVersion: 1,
    protocolVersion: PRIVATE_WRITER_PROTOCOL,
    sourceSha256: sha256Hex("src"),
    binarySha256: sha256Hex("bin"),
    builtAt: "x",
    osVersion: "27.2",
    compiler: "clang",
  });
  const spawn = ((_bin: string, _args: string[], options: { input: string }) => {
    requests.push(JSON.parse(options.input));
    const refusal = {
      status: "error",
      code: "scope_conflict",
      message: "Scope guard failed: the note is inside a forbidden folder.",
      committed: false,
      scopeReason: "inside_forbidden_folder",
    };
    return { status: 1, stdout: JSON.stringify(refusal), stderr: "", signal: null };
  }) as unknown as typeof spawnSync;
  return defaultWriterDeps({
    env: {
      APPLE_NOTES_MCP_ENABLE_PRIVATE: "1",
      APPLE_NOTES_MCP_ENABLE_PRIVATE_WRITES: "1",
      APPLE_NOTES_MCP_ALLOW_UNVERIFIED: "1",
      APPLE_NOTES_MCP_PRIVATE_HELPER_DIR: "/fake",
    },
    platform: "darwin",
    sourcePath: "/fake/src.m",
    exists: () => true,
    readFile: (path) =>
      Buffer.from(
        path.endsWith(WRITER_MANIFEST_NAME) ? manifest : path.endsWith(".m") ? "src" : "bin"
      ),
    spawn,
  });
}

describe("writer scope guard fields", () => {
  it("sends only the guards that were given, validated", () => {
    expect(writerScopeFields(undefined)).toEqual({});
    expect(writerScopeFields({ forbiddenAncestorFolderIds: [] })).toEqual({});
    expect(writerScopeFields(GUARD)).toEqual(GUARD);
    expect(writerScopeFields({ ifFolderId: F1 })).toEqual({ ifFolderId: F1 });
    for (const bad of [
      { ifFolderId: "x-coredata://8FA9/ICNote/p1" },
      { forbiddenAncestorFolderIds: ['x" & (do shell script "id") & "'] },
      { forbiddenAncestorFolderIds: Array.from({ length: 51 }, () => F1) },
    ]) {
      let caught: unknown;
      try {
        writerScopeFields(bad);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PrivateWriteError);
      expect(caught).toMatchObject({ code: "invalid_request", committed: false });
    }
  });

  it("collects the guard from tool arguments", () => {
    expect(scopeGuardFrom({})).toBeUndefined();
    expect(scopeGuardFrom({ forbiddenAncestorFolderIds: [] })).toBeUndefined();
    expect(scopeGuardFrom({ ...GUARD, ...{ unrelated: 1 } } as never)).toEqual(GUARD);
  });

  it("offers the same three optional fields as the AppleScript tools", () => {
    const schema = z.object(writerScopeGuardInput());
    expect(Object.keys(schema.shape)).toEqual([
      "ifFolderId",
      "ifAncestorFolderId",
      "forbiddenAncestorFolderIds",
    ]);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse(GUARD).data).toEqual(GUARD);
    expect(schema.safeParse({ ifFolderId: "Notes" }).success).toBe(false);
    expect(
      schema.safeParse({ forbiddenAncestorFolderIds: Array.from({ length: 51 }, () => F1) }).success
    ).toBe(false);
    expect(
      String(writerScopeGuardInput("smart folder").forbiddenAncestorFolderIds.description)
    ).toMatch(/smart folder itself/);
  });

  it("maps the writer's scope refusals onto the shared error codes", () => {
    expect(writerEnvelopeCode("scope_conflict", "")).toBe("revision_conflict");
    expect(writerEnvelopeCode("scope_folder_not_found", "")).toBe("not_found");
  });
});

describe("every writer write forwards the scope guard", () => {
  const calls: Array<[string, (deps: PrivateHelperDeps) => unknown]> = [
    [
      "append_plain_text",
      (d) => appendPlainText({ identifier: NOTE, text: "x", ifRevision: REV, scope: GUARD }, d),
    ],
    [
      "plan_edit",
      (d) =>
        editNote(
          {
            identifier: NOTE,
            dryRun: true,
            operations: [{ op: "replace", selector: { text: "a" }, replacement: { text: "b" } }],
            scope: GUARD,
          },
          d
        ),
    ],
    [
      "edit_note",
      (d) =>
        editNote(
          {
            identifier: NOTE,
            dryRun: false,
            ifRevision: REV,
            operations: [{ op: "replace", selector: { text: "a" }, replacement: { text: "b" } }],
            scope: GUARD,
          },
          d
        ),
    ],
    [
      "compose_note",
      (d) =>
        composeNote(
          { identifier: NOTE, mode: "append", paragraphs: [], dryRun: true, scope: GUARD },
          d
        ),
    ],
    [
      "set_checklist_item",
      (d) =>
        setChecklistItem(
          {
            identifier: NOTE,
            todoIdentifier: "a".repeat(32),
            done: true,
            ifRevision: REV,
            scope: GUARD,
          },
          d
        ),
    ],
    [
      "set_highlight",
      (d) =>
        setHighlight(
          {
            identifier: NOTE,
            target: { scope: "note" },
            color: "mint",
            dryRun: true,
            scope: GUARD,
          },
          d
        ),
    ],
    [
      "add_url_card",
      (d) =>
        addUrlCard({ identifier: NOTE, url: "https://example.com", dryRun: true, scope: GUARD }, d),
    ],
    [
      "set_paragraph_id",
      (d) =>
        setParagraphId(
          { identifier: NOTE, blockIndex: 1, expectedText: "Intro", ifRevision: REV, scope: GUARD },
          d
        ),
    ],
    [
      "add_section_link",
      (d) =>
        addSectionLink({ identifier: NOTE, heading: "Intro", ifRevision: REV, scope: GUARD }, d),
    ],
    [
      "delete_table_row",
      (d) =>
        deleteTableRow(
          {
            identifier: NOTE,
            tableIdentifier: UUID2,
            rowIdentifier: UUID2,
            dryRun: true,
            scope: GUARD,
          },
          d
        ),
    ],
    [
      "insert_table_row",
      (d) =>
        insertTableRow(
          {
            identifier: NOTE,
            tableIdentifier: UUID2,
            ifRevision: REV,
            ifTableDigest: DIGEST,
            scope: GUARD,
          },
          d
        ),
    ],
    [
      "set_table_cell",
      (d) =>
        setTableCell(
          {
            identifier: NOTE,
            tableIdentifier: UUID2,
            rowIdentifier: UUID2,
            columnIdentifier: UUID2,
            text: "x",
            ifRevision: REV,
            ifTableDigest: DIGEST,
            scope: GUARD,
          },
          d
        ),
    ],
    [
      "prune_orphan_table",
      (d) =>
        pruneOrphanTable(
          { identifier: NOTE, tableIdentifier: UUID2, dryRun: true, scope: GUARD },
          d
        ),
    ],
    [
      "add_paper",
      (d) =>
        addPaper(
          {
            identifier: NOTE,
            ifRevision: REV,
            drawing: { strokes: [] } as never,
            dryRun: true,
            scope: GUARD,
          },
          d
        ),
    ],
    [
      "repair_purge_flag",
      (d) => repairPurgeFlag({ identifier: NOTE, dryRun: true, scope: GUARD }, d),
    ],
    [
      "create_smart_folder",
      (d) =>
        createSmartFolder(
          { title: "T", query: { entity: "note", type: { checklist: true } }, scope: GUARD },
          d
        ),
    ],
    [
      "update_smart_folder",
      (d) =>
        updateSmartFolder(
          {
            identifier: NOTE,
            query: { entity: "note", type: { checklist: true } },
            ifRevision: FREV,
            scope: GUARD,
          },
          d
        ),
    ],
    [
      "delete_smart_folder",
      (d) => deleteSmartFolder({ identifier: NOTE, dryRun: true, scope: GUARD }, d),
    ],
  ];

  it.each(calls)("%s", (action, call) => {
    const requests: Array<Record<string, unknown>> = [];
    let caught: unknown;
    try {
      call(refusingWriter(requests));
    } catch (error) {
      caught = error;
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action, ...GUARD });
    expect(caught).toMatchObject({ code: "scope_conflict" });
    // A refusal from the scope check never reads as a possible write.
    expect((caught as PrivateWriteError).committed).not.toBe(true);
    expect((caught as PrivateWriteError).committed).not.toBe("unknown");
  });

  it("sends no guard fields when none were given", () => {
    const requests: Array<Record<string, unknown>> = [];
    expect(() =>
      appendPlainText({ identifier: NOTE, text: "x", ifRevision: REV }, refusingWriter(requests))
    ).toThrow();
    expect(Object.keys(requests[0]).sort()).toEqual(
      ["action", "identifier", "ifRevision", "protocol", "text"].sort()
    );
  });
});
