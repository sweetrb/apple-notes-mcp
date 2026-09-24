import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("@/utils/applescript.js", () => ({ executeAppleScript: vi.fn() }));
vi.mock("@/utils/noteRichText.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/noteRichText.js")>()),
  readRichNote: vi.fn(),
}));
import { executeAppleScript } from "../utils/applescript.js";
import { readRichNote } from "../utils/noteRichText.js";
import { AppleNotesManager } from "./appleNotesManager.js";

const exec = vi.mocked(executeAppleScript);
const read = vi.mocked(readRichNote);
const manager = new AppleNotesManager();
const id = "x-coredata://ABC/ICNote/p42";
const fixture = readFileSync(
  new URL("../utils/fixtures/background-probe-table.gz", import.meta.url)
).toString("hex");

beforeEach(() => vi.clearAllMocks());

describe("getNoteTablesById", () => {
  it("reads the exact note from the database only and returns tables in body order", () => {
    read.mockReturnValue({
      text: "",
      links: [],
      nativeTags: [],
      nativeObjectIds: ["T1"],
      hasNativeObjects: true,
      hasChecklist: false,
      revision: "r",
      objects: [{ id: "T1", type: "com.apple.notes.table", start: 3, length: 1 }],
      objectData: [
        { id: "T1", pk: 8, type: "com.apple.notes.table", mergeable: fixture, view: null },
      ],
    });
    const result = manager.getNoteTablesById(id);
    // Lenient: a tel: or sms: link elsewhere in the note must not hide its tables (#193).
    expect(read).toHaveBeenCalledWith(id, { skipUnsafeLinks: true });
    expect(exec).not.toHaveBeenCalled();
    expect(result.tableCellsComplete).toBe(true);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({
      index: 1,
      id: "T1",
      attachmentId: "x-coredata://ABC/ICAttachment/p8",
      rowCount: 2,
      columnCount: 2,
    });
    expect(result.markdown.split("\n")[1]).toBe("| --- | --- |");
  });

  it("propagates database read failures instead of returning an empty result", () => {
    read.mockImplementation(() => {
      throw new Error("No Notes document data");
    });
    expect(() => manager.getNoteTablesById(id)).toThrow("No Notes document data");
  });
});
