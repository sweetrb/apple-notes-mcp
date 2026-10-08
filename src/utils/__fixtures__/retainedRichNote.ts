import { parseRichNote, type RichNote } from "../noteRichText.js";

const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
};
const bytes = (field: number, value: Buffer | string) => {
  const data = Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(data.length), data]);
};

/** Complete public-decoder snapshot, with no protected store or helper access. */
export function plainRichNote(text: string): RichNote {
  const run = Buffer.concat([varint(8), varint(text.length)]);
  const note = bytes(2, bytes(3, Buffer.concat([bytes(2, text), bytes(5, run)])));
  return {
    ...parseRichNote(note),
    nativeTagObjectIds: {},
    objectData: [],
    nativeObjectDataComplete: true,
  };
}

export const plainSemantics = () => ({
  complete: true,
  unknown: false,
  structuredParagraph: false,
  links: false,
  objects: [] as Array<{ id: string; type: string }>,
});

export function syntheticRichNote(
  text: string,
  options: {
    objects?: Array<NonNullable<RichNote["objects"]>[number] & { tag?: string }>;
    items?: NonNullable<RichNote["checklistItems"]>;
    links?: RichNote["links"];
  } = {}
): RichNote {
  const number = (field: number, value: number) =>
    Buffer.concat([varint(field * 8), varint(value)]);
  const objects = options.objects ?? [],
    items = options.items ?? [],
    links = options.links ?? [];
  const boundaries = [
    ...new Set([
      0,
      text.length,
      ...objects.flatMap(({ start, length }) => [start, start + length]),
      ...items.flatMap(({ start, text }) => [start, start + text.length]),
      ...links.flatMap(({ start, length }) => [start, start + length]),
    ]),
  ].sort((a, b) => a - b);
  const runs = boundaries.slice(1).map((end, index) => {
    const start = boundaries[index];
    const object = objects.find(
      (object) => start >= object.start && end <= object.start + object.length
    );
    const item = items.find((item) => start >= item.start && end <= item.start + item.text.length);
    const link = links.find((link) => start >= link.start && end <= link.start + link.length);
    return Buffer.concat([
      number(1, end - start),
      ...(object ? [bytes(12, Buffer.concat([bytes(1, object.id), bytes(2, object.type)]))] : []),
      ...(item
        ? [
            bytes(
              2,
              Buffer.concat([
                number(1, 103),
                bytes(
                  5,
                  Buffer.concat([
                    bytes(1, Buffer.from(item.id, "hex")),
                    number(2, Number(item.done)),
                  ])
                ),
              ])
            ),
          ]
        : []),
      ...(link ? [bytes(9, link.url)] : []),
    ]);
  });
  const rich = parseRichNote(
    bytes(2, bytes(3, Buffer.concat([bytes(2, text), ...runs.map((run) => bytes(5, run))])))
  );
  rich.nativeTagObjectIds = {};
  rich.nativeTags = [...new Set(objects.flatMap((object) => (object.tag ? [object.tag] : [])))];
  for (const tag of rich.nativeTags)
    rich.nativeTagObjectIds[tag] = objects
      .filter((object) => object.tag === tag)
      .map((object) => object.id);
  rich.objectData = objects.map((object, index) => ({
    id: object.id,
    pk: 100 + index,
    type: object.type,
    mergeable: "0102",
    view: 1,
    altText: object.tag ? `#${object.tag}` : null,
  }));
  rich.nativeObjectDataComplete = true;
  return rich;
}
