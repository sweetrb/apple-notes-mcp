/**
 * Built-in sample notes for previewing a Markdown template.
 *
 * The template editor renders these instead of real notes, so a preview never
 * reads the Notes library unless the user names a note explicitly. Each sample
 * is a synthetic block model that exercises a group of template rules:
 * block styles, inline formats, and attachments. None of it is real content.
 *
 * @module utils/templateSamples
 */
import { summarize, type InlineRun, type NoteBlock } from "./noteBlocks.js";
import { classifyUti, type ExportAttachment, type ExportNote } from "./noteExportData.js";
import type { NoteTemplateMeta } from "./templateRender.js";

type SampleRunSpec = Omit<InlineRun, "start" | "length">;

function sampleBlock(
  text: string,
  style: NoteBlock["style"] = "body",
  extra: Partial<Omit<NoteBlock, "runs">> = {},
  runs: SampleRunSpec[] = [{ text }]
): NoteBlock {
  return {
    index: 0,
    start: 0,
    length: runs.reduce((sum, run) => sum + run.text.length, 0),
    text: runs.map((run) => run.text).join(""),
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

const sampleAttachmentRun = (id: string, uti: string): SampleRunSpec => ({
  text: "￼",
  attachment: { id, uti },
});

function sampleAttachment(
  id: string,
  uti: string,
  extra: Partial<ExportAttachment> = {}
): ExportAttachment {
  return { id, pk: 0, uti, kind: classifyUti(uti), children: [], ...extra };
}

/** Index blocks, derive attachment markers and key attachments by id. */
function sampleNote(
  pk: number,
  blocks: NoteBlock[],
  attachments: ExportAttachment[] = []
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
  return {
    id: `x-coredata://SAMPLE/ICNote/p${pk}`,
    title: indexed[0]?.text ?? "",
    doc: {
      text: indexed.map((b) => b.text).join("\n"),
      textLength: offset,
      blocks: indexed,
      attachments: markers,
      undecodedFields: { attributeRun: {}, paragraphStyle: {} },
      summary: summarize(indexed, markers),
    },
    attachments: new Map(attachments.map((a) => [a.id, a])),
    ordered: attachments.map((a, i) => ({ ...a, pk: i + 1 })),
  };
}

/** One sample note with the metadata its placeholders use. */
export interface TemplateSample {
  /** Stable id used by the editor (`?sample=`). */
  id: string;
  label: string;
  note: ExportNote;
  meta: NoteTemplateMeta;
}

function sampleMeta(uuid: string): NoteTemplateMeta {
  return {
    uuid,
    created: "2026-01-05T14:30:00.000Z",
    modified: "2026-02-10T09:15:00.000Z",
    folder: "Sample Folder",
    account: "iCloud",
  };
}

/** Every built-in sample, in display order. Fresh objects on each call. */
export function templateSamples(): TemplateSample[] {
  return [
    {
      id: "structure",
      label: "Headings, lists and checklists",
      meta: sampleMeta("00000000-0000-4000-8000-000000000001"),
      note: sampleNote(1, [
        sampleBlock("Weekly Plan", "title"),
        sampleBlock("Goals", "heading"),
        sampleBlock("Details", "subheading"),
        sampleBlock("A plain paragraph with *characters* that need escaping."),
        sampleBlock("First step", "numbered"),
        sampleBlock("Second step", "numbered"),
        sampleBlock("Nested step", "numbered", { indent: 1 }),
        sampleBlock("A bullet", "bulleted"),
        sampleBlock("A dash", "dashed"),
        sampleBlock("Nested bullet", "bulleted", { indent: 1 }),
        sampleBlock("Done task", "checklist", { checklist: { id: "sample-a", done: true } }),
        sampleBlock("Open task", "checklist", { checklist: { id: "sample-b", done: false } }),
        sampleBlock("A quoted line", "body", { blockQuote: true }),
        sampleBlock("const answer = 42;", "monospaced"),
        sampleBlock('console.log("sample");', "monospaced"),
      ]),
    },
    {
      id: "inline",
      label: "Inline formatting and links",
      meta: sampleMeta("00000000-0000-4000-8000-000000000002"),
      note: sampleNote(2, [
        sampleBlock("Formatting Sample", "title"),
        sampleBlock("", "body", {}, [
          { text: "Bold", bold: true },
          { text: ", " },
          { text: "italic", italic: true },
          { text: ", " },
          { text: "both", bold: true, italic: true },
          { text: ", " },
          { text: "struck", strikethrough: true },
          { text: ", " },
          { text: "underlined", underline: true },
          { text: "." },
        ]),
        sampleBlock("", "body", {}, [
          { text: "Highlighted", highlight: "purple" },
          { text: ", x" },
          { text: "2", superscript: true },
          { text: ", H" },
          { text: "2", subscript: true },
          { text: "O, and " },
          { text: "red text", color: "#FF3B30" },
          { text: "." },
        ]),
        sampleBlock("", "body", {}, [
          { text: "A " },
          { text: "web link", link: "https://example.com/page", linkSafe: true },
          { text: " and a " },
          { text: "bold link", link: "https://example.com/bold", linkSafe: true, bold: true },
          { text: "." },
        ]),
      ]),
    },
    {
      id: "attachments",
      label: "Attachments and tags",
      meta: sampleMeta("00000000-0000-4000-8000-000000000003"),
      note: sampleNote(
        3,
        [
          sampleBlock("Trip Notes", "title"),
          sampleBlock("", "body", {}, [
            { text: "Tagged " },
            sampleAttachmentRun("SAMPLE-TAG", "com.apple.notes.inlinetextattachment.hashtag"),
            { text: " for later." },
          ]),
          sampleBlock("", "body", {}, [sampleAttachmentRun("SAMPLE-IMG", "public.jpeg")]),
          sampleBlock("", "body", {}, [sampleAttachmentRun("SAMPLE-PDF", "com.adobe.pdf")]),
          sampleBlock("", "body", {}, [
            sampleAttachmentRun("SAMPLE-DIV", "com.apple.notes.inlinetextattachment.dividerline"),
          ]),
          sampleBlock("", "body", {}, [sampleAttachmentRun("SAMPLE-URL", "public.url")]),
          sampleBlock("", "body", {}, [sampleAttachmentRun("SAMPLE-IMGURL", "public.url")]),
        ],
        [
          sampleAttachment("SAMPLE-TAG", "com.apple.notes.inlinetextattachment.hashtag", {
            altText: "#travel",
          }),
          sampleAttachment("SAMPLE-IMG", "public.jpeg", { title: "harbor.jpg" }),
          sampleAttachment("SAMPLE-PDF", "com.adobe.pdf", { title: "itinerary.pdf" }),
          sampleAttachment("SAMPLE-DIV", "com.apple.notes.inlinetextattachment.dividerline"),
          sampleAttachment("SAMPLE-URL", "public.url", {
            title: "Example Domain",
            url: "https://example.com/",
          }),
          sampleAttachment("SAMPLE-IMGURL", "public.url", {
            title: "Harbor at dusk",
            url: "https://example.com/photos/harbor.jpg",
          }),
        ]
      ),
    },
  ];
}
