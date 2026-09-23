/**
 * Tests for the attachment-asset manager methods behind list-attachments
 * (includePaths / firstImage) and export-attachments. The reader and exporter
 * are exercised against real fixtures in utils/attachmentAssets.test.ts; here
 * they are mocked to check that the manager wires them together.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/attachmentAssets.js", () => ({
  readNoteAttachmentRows: vi.fn(),
  assembleAttachmentAssets: vi.fn(),
  selectFirstImage: vi.fn(),
  exportAttachmentAssets: vi.fn(),
}));

import { AppleNotesManager } from "@/services/appleNotesManager.js";
import {
  assembleAttachmentAssets,
  exportAttachmentAssets,
  readNoteAttachmentRows,
  selectFirstImage,
} from "@/utils/attachmentAssets.js";

const NOTE = "x-coredata://ABC/ICNote/p1";
const assets = { orderSource: "body" as const, attachments: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readNoteAttachmentRows).mockReturnValue({ rows: [], bodyOrder: ["X"] });
  vi.mocked(assembleAttachmentAssets).mockReturnValue(assets);
});

describe("attachment asset manager methods", () => {
  it("reads rows and assembles them in body order", () => {
    const manager = new AppleNotesManager();
    expect(manager.getAttachmentAssetsById(NOTE)).toBe(assets);
    expect(readNoteAttachmentRows).toHaveBeenCalledWith(NOTE);
    expect(assembleAttachmentAssets).toHaveBeenCalledWith([], ["X"]);
  });

  it("selects the first image from the assembled attachments", () => {
    vi.mocked(selectFirstImage).mockReturnValue(null);
    expect(new AppleNotesManager().getFirstImageById(NOTE)).toBeNull();
    expect(selectFirstImage).toHaveBeenCalledWith(assets);
  });

  it("passes the export directory and first-image flag through", () => {
    const result = { exportDir: "/tmp/x", results: [] };
    vi.mocked(exportAttachmentAssets).mockReturnValue(result);
    const manager = new AppleNotesManager();
    expect(manager.exportAttachmentsById(NOTE, "/tmp/x")).toBe(result);
    expect(exportAttachmentAssets).toHaveBeenCalledWith(assets, "/tmp/x", {
      firstImageOnly: false,
    });
    manager.exportAttachmentsById(NOTE, "/tmp/x", true);
    expect(exportAttachmentAssets).toHaveBeenLastCalledWith(assets, "/tmp/x", {
      firstImageOnly: true,
    });
  });
});
