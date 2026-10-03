// Public fixture construction only. No saved Notes payload, device identifier,
// filesystem input, environment value, or private account state is used here.
// This encodes the complete small topotext graph, including character/attribute
// clocks and child indexes; the read-only decoder's minimal test graph is not
// sufficient evidence that NotesShared can edit a document.
import { gzipSync } from "node:zlib";

export const text =
  "PUBLIC SYNTHETIC WRITER FIXTURE\n" +
  "All contents and identifiers in this note are generated.\n" +
  "This note contains no user data or device identifiers.\n" +
  "For use in isolated fixture validation.\n";
export const replicaIdentifier = "11111111-1111-4111-8111-111111111111";
export const paragraphIdentifier = "22222222-2222-4222-8222-222222222222";
export const noteIdentifier = "33333333-3333-4333-8333-333333333333";

if (text.length !== 184 || Buffer.byteLength(text, "utf8") !== 184) {
  throw new Error("Synthetic text must cover exactly 184 ASCII/UTF-16 units");
}

function varint(value) {
  const bytes = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  return Buffer.from([...bytes, value]);
}
const concat = (...parts) => Buffer.concat(parts);
const number = (field, value) => concat(varint(field * 8), varint(value));
const bytes = (field, value) => concat(varint(field * 8 + 2), varint(value.length), value);
const uuid = (value) => Buffer.from(value.replaceAll("-", ""), "hex");
const clock = (replica, counter) => concat(number(1, replica), number(2, counter));

/** Return a fresh gzip document built entirely from public fixture constants. */
export function buildSyntheticNotePayload(...inputs) {
  if (inputs.length) throw new TypeError("Synthetic payload construction accepts no input");

  // owner, character counter, length, attribute owner/counter, child index.
  // Replica zero at the two boundaries is structural, not a clock-table owner.
  const topology = [
    [0, 0, 0, 0, 0, 1],
    [1, 0, 61, 1, 0, 2],
    [1, 61, 88, 1, 1, 3],
    [1, 150, 1, 1, 0, 4],
    [1, 151, 1, 1, 2, 5],
    [1, 152, 32, 1, 0, 6],
    [1, 149, 1, 1, 2, 7],
    [0, 0xffffffff, 0, 0, 0xffffffff, null],
  ];
  const substrings = topology.map(([owner, counter, length, attrOwner, attrCounter, child]) =>
    bytes(
      3,
      concat(
        bytes(1, clock(owner, counter)),
        number(2, length),
        bytes(3, clock(attrOwner, attrCounter)),
        child === null ? Buffer.alloc(0) : number(5, child)
      )
    )
  );
  const timestamp = bytes(
    4,
    bytes(
      1,
      concat(bytes(1, uuid(replicaIdentifier)), bytes(2, number(1, 184)), bytes(2, number(1, 3)))
    )
  );
  const pointSize = Buffer.alloc(4);
  pointSize.writeFloatLE(24);
  const font = concat(
    bytes(1, Buffer.from(".AppleSystemUIFontBold", "utf8")),
    varint(2 * 8 + 5),
    pointSize,
    number(3, 1)
  );
  const attributeRuns = [61, 88, 1, 7, 26, 1].map((length, index) => {
    const style = concat(
      index < 3 ? number(3, 1) : Buffer.alloc(0),
      bytes(9, uuid(paragraphIdentifier))
    );
    return bytes(
      5,
      concat(
        number(1, length),
        bytes(2, style),
        index === 0 ? concat(bytes(3, font), number(5, 1)) : Buffer.alloc(0),
        // Fixed fixture timestamps preserve ordering without recording a run's
        // wall-clock time. They are not taken from a Notes snapshot.
        index >= 2 && index <= 4
          ? number(13, index === 4 ? 1700000001 : 1700000000)
          : Buffer.alloc(0)
      )
    );
  });
  const string = concat(
    bytes(2, Buffer.from(text, "utf8")),
    ...substrings,
    timestamp,
    ...attributeRuns
  );
  const version = concat(number(1, 0), number(2, 0), bytes(3, string));
  // Node's gzip encoder emits zero mtime and no filename/comment. Normalize the
  // informational OS byte so the header carries no host platform information.
  const compressed = gzipSync(concat(number(1, 0), bytes(2, version)), { level: 9 });
  compressed[9] = 255;
  return compressed;
}
