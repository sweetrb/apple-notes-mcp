/**
 * Synthetic export notes for renderer tests. Builds decoded blocks directly,
 * so each case states the block model it exercises. No real note content.
 */
import { summarize, type InlineRun, type NoteBlock } from "../noteBlocks.js";
import { classifyUti, type ExportAttachment, type ExportNote } from "../noteExportData.js";

/** Inline run attributes, without offsets (filled in by `block`). */
export type RunSpec = Omit<InlineRun, "start" | "length">;

/** A paragraph. `runs` defaults to one plain run of `text`. */
export function block(
  text: string,
  style: NoteBlock["style"] = "body",
  extra: Partial<Omit<NoteBlock, "runs">> = {},
  runs: RunSpec[] = [{ text }]
): NoteBlock {
  return {
    index: 0,
    start: 0,
    length: text.length,
    text,
    style,
    styleType: null,
    indent: 0,
    alignment: "left",
    blockQuote: false,
    ...extra,
    runs: runs.map((run) => ({ start: 0, length: run.text.length, ...run })),
    attachments: [],
  };
}

/** A run holding one attachment character. */
export const attachmentRun = (id: string, uti = "public.jpeg"): RunSpec => ({
  text: "\ufffc",
  attachment: { id, uti },
});

/** An attachment row. */
export function attachment(
  id: string,
  uti: string,
  extra: Partial<ExportAttachment> = {}
): ExportAttachment {
  return { id, pk: 0, uti, kind: classifyUti(uti), children: [], ...extra };
}

/** Assemble a note: indexes blocks, derives markers, and keys attachments. */
export function exportNote(
  blocks: NoteBlock[],
  attachments: ExportAttachment[] = [],
  title = blocks[0]?.text ?? ""
): ExportNote {
  let offset = 0;
  const indexed = blocks.map((b, index) => {
    const start = offset;
    offset += b.length + 1;
    let at = start;
    const runs = b.runs.map((run) => {
      const shifted = { ...run, start: at };
      at += run.length;
      return shifted;
    });
    const markers = runs.flatMap((run) =>
      run.attachment ? [{ ...run.attachment, start: run.start, blockIndex: index }] : []
    );
    return { ...b, index, start, runs, attachments: markers };
  });
  const markers = indexed.flatMap((b) => b.attachments);
  const all = attachments.flatMap((a) => [a, ...a.children]);
  return {
    id: "x-coredata://FIXTURE/ICNote/p1",
    title,
    doc: {
      text: indexed.map((b) => b.text).join("\n"),
      textLength: offset,
      blocks: indexed,
      attachments: markers,
      undecodedFields: { attributeRun: {}, paragraphStyle: {} },
      summary: summarize(indexed, markers),
    },
    attachments: new Map(all.map((a) => [a.id, a])),
    ordered: attachments.map((a, pk) => ({ ...a, pk })),
  };
}
