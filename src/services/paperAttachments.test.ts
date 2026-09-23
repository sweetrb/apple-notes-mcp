/**
 * Tests for the Paper manager methods behind list-paper-attachments and
 * export-paper-image. The reader and exporter run against real fixtures in
 * utils/paperAttachments.test.ts; here they are mocked to check the wiring.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/utils/paperAttachments.js", () => ({
  readDrawingRows: vi.fn(),
  describeDrawings: vi.fn(),
  selectDrawing: vi.fn(),
  exportDrawingRaster: vi.fn(),
}));

import { AppleNotesManager } from "@/services/appleNotesManager.js";
import {
  describeDrawings,
  exportDrawingRaster,
  readDrawingRows,
  selectDrawing,
  type DrawingAttachment,
} from "@/utils/paperAttachments.js";

const NOTE = "x-coredata://ABC/ICNote/p1";
const drawing = { pk: 5, identifier: "D" } as DrawingAttachment;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readDrawingRows).mockReturnValue([]);
  vi.mocked(describeDrawings).mockReturnValue([drawing]);
  vi.mocked(selectDrawing).mockReturnValue(drawing);
});

describe("Paper manager methods", () => {
  it("reads rows and describes their rasters", () => {
    expect(new AppleNotesManager().listPaperAttachmentsById(NOTE)).toEqual([drawing]);
    expect(readDrawingRows).toHaveBeenCalledWith(NOTE);
    expect(describeDrawings).toHaveBeenCalledWith([]);
  });

  it("selects one drawing and exports its raster", () => {
    const exported = {
      savedPath: "/tmp/p.png",
      bytes: 10,
      source: "fallback" as const,
      format: "png" as const,
      width: 1,
      height: 2,
    };
    vi.mocked(exportDrawingRaster).mockReturnValue(exported);
    const r = new AppleNotesManager().exportPaperImageById(NOTE, "/tmp/p.png", "D");
    expect(selectDrawing).toHaveBeenCalledWith([drawing], NOTE, "D");
    expect(exportDrawingRaster).toHaveBeenCalledWith(drawing, "/tmp/p.png");
    expect(r).toEqual({ drawing, ...exported });
  });
});
