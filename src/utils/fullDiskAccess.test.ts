import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// Every reader reaches a synthetic permission denial; never open the live store.
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFileSync: vi.fn(() => {
    throw new Error("authorization denied");
  }),
}));
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: vi.fn(() => true),
}));

import { fdaRemediation } from "@/utils/fullDiskAccess.js";
import { FULL_DISK_ACCESS_GUIDE_URL } from "@/utils/docsUrls.js";
import { runReadOnlySql } from "@/utils/noteStoreSql.js";
import { queryNotes } from "@/utils/noteQueryStore.js";
import { getNoteMetadata } from "@/utils/noteMetadata.js";
import { readSmartFolders } from "@/utils/smartFolders.js";
import { identifierFailureIn, resolveIdentifiers } from "@/utils/noteIdentifiers.js";
import { getChecklistItems } from "@/utils/checklistParser.js";
import { readNoteAttachmentRows } from "@/utils/attachmentAssets.js";
import { readDrawingRows } from "@/utils/paperAttachments.js";
import { readAudioTranscripts } from "@/utils/audioTranscripts.js";
import { readFolderStoreFacts } from "@/utils/folderStore.js";
import { contentSearchFailureHint } from "@/utils/searchContentDb.js";

const ID = "x-coredata://ABCDEF01-2345-6789-ABCD-EF0123456789/ICNote/p1";
const BROKER_APP = "/Users/test/Applications/Custom Broker.app";
const DB = "/synthetic/NoteStore.sqlite";

afterEach(() => vi.unstubAllEnvs());

function permissionFailure(run: () => unknown): { message?: string; code?: string } {
  let failure: unknown;
  try {
    failure = run();
  } catch (error) {
    failure = error;
  }
  const value = failure as {
    message?: string;
    kind?: string;
    code?: string;
    error?: string;
    reason?: string;
  };
  return {
    message: value?.message,
    code: value?.kind ?? value?.code ?? value?.error ?? value?.reason,
  };
}

describe("Full Disk Access guidance", () => {
  it("uses the default app path when a brokered process lacks the installed path", () => {
    const message = fdaRemediation("/unused/node", { APPLE_NOTES_MCP_BROKERED: "1" });
    expect(message).toContain(join(homedir(), "Applications", "Apple Notes MCP Broker.app"));
    expect(message).not.toContain("/unused/node");
  });

  it("does not attribute a direct session to a merely configured broker app", () => {
    const message = fdaRemediation("/exact/runtime/node", {
      APPLE_NOTES_MCP_BROKERED: "0",
      APPLE_NOTES_MCP_BROKER_APP: BROKER_APP,
    });
    expect(message).toContain("/exact/runtime/node");
    expect(message).not.toContain(BROKER_APP);
    expect(message).toContain("doctor");
    expect(message).toContain(FULL_DISK_ACCESS_GUIDE_URL);
  });

  describe.each(["direct", "brokered"] as const)("%s database errors", (mode) => {
    const readers: Array<[string, () => unknown]> = [
      ["shared NoteStore reads", () => runReadOnlySql(DB, "SELECT 1")],
      ["query-notes", () => queryNotes("example", { dbPath: DB })],
      ["note metadata", () => getNoteMetadata(ID)],
      ["smart folders", () => readSmartFolders(DB)],
      ["identifier resolution", () => resolveIdentifiers(["1"], "ICNote", DB)],
      ["checklist state", () => getChecklistItems(ID)],
      ["attachment paths", () => readNoteAttachmentRows(ID, DB)],
      ["drawing attachments", () => readDrawingRows(ID, DB)],
      ["stored transcripts", () => readAudioTranscripts(ID, { dbPath: DB })],
      ["folder-delete verification", () => readFolderStoreFacts(1, DB)],
    ];

    it.each(readers)("names the current responsible process for %s", (_name, run) => {
      // Modules were imported before this change: no message may capture the old env.
      vi.stubEnv("APPLE_NOTES_MCP_BROKERED", mode === "brokered" ? "1" : "0");
      vi.stubEnv("APPLE_NOTES_MCP_BROKER_APP", BROKER_APP);
      const failure = permissionFailure(run);
      expect(failure.code).toBe("no_fda");
      expect(failure.message).toContain("Full Disk Access");
      expect(failure.message).toContain("doctor");
      expect(failure.message).toContain(FULL_DISK_ACCESS_GUIDE_URL);
      if (mode === "brokered") {
        expect(failure.message).toContain(BROKER_APP);
        expect(failure.message).not.toContain(process.execPath);
      } else {
        expect(failure.message).toContain(process.execPath);
        expect(failure.message).not.toContain(BROKER_APP);
      }
    });

    it("keeps schema-level identifier failures classifiable", () => {
      vi.stubEnv("APPLE_NOTES_MCP_BROKERED", mode === "brokered" ? "1" : "0");
      const failure = permissionFailure(() => resolveIdentifiers(["1"], "ICNote", DB));
      expect(identifierFailureIn(`Invalid arguments: ${failure.message}`)).toBe("no_fda");
    });
  });

  it("points a brokered search timeout at the broker without changing unrelated failures", () => {
    vi.stubEnv("APPLE_NOTES_MCP_BROKERED", "1");
    vi.stubEnv("APPLE_NOTES_MCP_BROKER_APP", BROKER_APP);
    const message = contentSearchFailureHint("Operation timed out", "no_fda");
    expect(message).toContain(BROKER_APP);
    expect(message).not.toContain(process.execPath);
    expect(contentSearchFailureHint("Other error", "no_fda")).toBe("Other error");
    expect(contentSearchFailureHint("Operation timed out", "schema")).not.toContain(BROKER_APP);
  });
});
