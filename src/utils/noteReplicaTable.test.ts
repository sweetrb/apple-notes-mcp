import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import {
  describeProtoShape,
  formatUuid,
  parseNoteReplicaTable,
  parseNoteReplicaTableFromPlain,
} from "./noteReplicaTable.js";

// Synthetic protobuf builders. Every byte below is constructed here; no real
// note data is used.
const varint = (value: number): number[] => {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
};
const tag = (n: number, wire: number) => varint((n << 3) | wire);
const num = (n: number, value: number): number[] => [...tag(n, 0), ...varint(value)];
const bytes = (n: number, data: ArrayLike<number>): number[] => [
  ...tag(n, 2),
  ...varint(data.length),
  ...Array.from(data),
];
const text = (n: number, value: string): number[] => bytes(n, Buffer.from(value, "utf8"));

const uuid = (seed: number): number[] => Array.from({ length: 16 }, (_, i) => (seed + i) & 0xff);

interface SubstringSpec {
  replica: number;
  clock: number;
  length: number;
  tombstone?: boolean;
}
const substring = (s: SubstringSpec): number[] =>
  bytes(3, [
    ...bytes(1, [...num(1, s.replica), ...num(2, s.clock)]),
    ...num(2, s.length),
    ...(s.tombstone ? num(4, 1) : []),
  ]);
const clockEntry = (seed: number, subClocks: number[]): number[] =>
  bytes(1, [
    ...bytes(1, uuid(seed)),
    ...subClocks.flatMap((c) => bytes(2, [...num(1, 0), ...num(2, c)])),
  ]);

function document(options: {
  body: string;
  substrings: SubstringSpec[];
  clocks: Array<{ seed: number; subClocks: number[] }>;
}): Uint8Array {
  const string = [
    ...text(2, options.body),
    ...options.substrings.flatMap(substring),
    ...bytes(
      4,
      options.clocks.flatMap((c) => clockEntry(c.seed, c.subClocks))
    ),
    ...bytes(5, num(1, options.body.length)),
  ];
  return Uint8Array.from(bytes(2, [...num(1, 0), ...bytes(3, string)]));
}

describe("formatUuid", () => {
  it("formats 16 bytes as an upper-case dashed UUID", () => {
    expect(formatUuid(Uint8Array.from(uuid(0)))).toBe("00010203-0405-0607-0809-0A0B0C0D0E0F");
  });
});

describe("parseNoteReplicaTable", () => {
  const plain = document({
    body: "hello world",
    clocks: [
      { seed: 0x10, subClocks: [7, 3] },
      { seed: 0x20, subClocks: [12] },
      { seed: 0x30, subClocks: [] },
    ],
    substrings: [
      { replica: 0, clock: 1, length: 5 },
      { replica: 1, clock: 1, length: 6 },
      { replica: 1, clock: 7, length: 4, tombstone: true },
    ],
  });

  it("lists each replica with its clock and the characters it owns", () => {
    const table = parseNoteReplicaTableFromPlain(plain);
    expect(table.replicas.map((r) => r.uuid)).toEqual([
      "10111213-1415-1617-1819-1A1B1C1D1E1F",
      "20212223-2425-2627-2829-2A2B2C2D2E2F",
      "30313233-3435-3637-3839-3A3B3C3D3E3F",
    ]);
    expect(table.replicas.map((r) => r.clock)).toEqual([7, 12, 0]);
    expect(table.replicas[0].subClocks).toEqual([7, 3]);
    expect(table.replicas.map((r) => r.chars)).toEqual([5, 10, 0]);
    expect(table.replicas.map((r) => r.liveChars)).toEqual([5, 6, 0]);
    expect(table.replicas.map((r) => r.substrings)).toEqual([1, 2, 0]);
    expect(table.substrings).toBe(3);
  });

  it("reports passing self-checks for a consistent layout", () => {
    const { layout } = parseNoteReplicaTableFromPlain(plain);
    expect(layout).toMatchObject({
      liveChars: 11,
      textUtf16: 11,
      lengthsMatchText: true,
      indexBase: 0,
      unmappedReplicaIds: [],
      warnings: [],
    });
  });

  it("decodes the gzipped ZDATA form", () => {
    const table = parseNoteReplicaTable(gzipSync(plain));
    expect(table.replicas).toHaveLength(3);
  });

  it("detects replica IDs counted from 1", () => {
    const oneBased = document({
      body: "ab",
      clocks: [
        { seed: 1, subClocks: [1] },
        { seed: 2, subClocks: [1] },
      ],
      substrings: [
        { replica: 1, clock: 1, length: 1 },
        { replica: 2, clock: 1, length: 1 },
      ],
    });
    const table = parseNoteReplicaTableFromPlain(oneBased);
    expect(table.layout.indexBase).toBe(1);
    expect(table.replicas.map((r) => r.chars)).toEqual([1, 1]);
    expect(table.layout.warnings).toEqual([]);
  });

  it("does not treat paired start/end sentinels as zero-based replica owners", () => {
    const table = parseNoteReplicaTableFromPlain(
      document({
        body: "abc",
        clocks: [{ seed: 1, subClocks: [5] }],
        substrings: [
          { replica: 0, clock: 0, length: 0 },
          { replica: 1, clock: 2, length: 3 },
          { replica: 1, clock: 0, length: 2, tombstone: true },
          { replica: 0, clock: 0xffffffff, length: 0 },
        ],
      })
    );
    expect(table.layout).toMatchObject({
      indexBase: 1,
      lengthsMatchText: true,
      unmappedReplicaIds: [],
      warnings: [],
    });
    expect(table.replicas[0]).toMatchObject({ chars: 5, liveChars: 3, substrings: 2 });
    expect(table.substrings).toBe(4); // Includes the structural boundary records.
  });

  it("attributes every live and tombstoned character across replicas with boundary sentinels", () => {
    // Constructed from the numeric shape of disposable test notes, with
    // generated UUIDs and replacement text; no saved Notes payload is used.
    const table = parseNoteReplicaTableFromPlain(
      document({
        body: "x".repeat(140),
        clocks: [1, 2, 3, 4].map((seed) => ({ seed, subClocks: [200] })),
        substrings: [
          { replica: 0, clock: 0, length: 0 },
          { replica: 4, clock: 0, length: 99 },
          { replica: 4, clock: 99, length: 17, tombstone: true },
          { replica: 1, clock: 116, length: 17 },
          { replica: 3, clock: 132, length: 22 },
          { replica: 2, clock: 154, length: 2 },
          { replica: 0, clock: 0xffffffff, length: 0 },
        ],
      })
    );
    expect(table.layout).toMatchObject({
      indexBase: 1,
      lengthsMatchText: true,
      unmappedReplicaIds: [],
      warnings: [],
    });
    expect(table.replicas.map((r) => r.chars)).toEqual([17, 2, 22, 116]);
    expect(table.replicas.map((r) => r.liveChars)).toEqual([17, 2, 22, 99]);
    expect(table.replicas.reduce((sum, r) => sum + r.liveChars, 0)).toBe(table.layout.textUtf16);
  });

  it("still accepts real zero-based owners between structural sentinels", () => {
    const table = parseNoteReplicaTableFromPlain(
      document({
        body: "a",
        clocks: [{ seed: 1, subClocks: [1] }],
        substrings: [
          { replica: 0, clock: 0, length: 0 },
          { replica: 0, clock: 1, length: 1 },
          { replica: 0, clock: 0xffffffff, length: 0 },
        ],
      })
    );
    expect(table.layout.indexBase).toBe(0);
    expect(table.replicas[0]).toMatchObject({ chars: 1, substrings: 1 });
    expect(table.layout.warnings).toEqual([]);
  });

  it("does not hide an arbitrary zero-length replica record as a sentinel", () => {
    const table = parseNoteReplicaTableFromPlain(
      document({
        body: "a",
        clocks: [{ seed: 1, subClocks: [1] }],
        substrings: [
          { replica: 0, clock: 7, length: 0 },
          { replica: 1, clock: 1, length: 1 },
          { replica: 0, clock: 0xffffffff, length: 0 },
        ],
      })
    );
    expect(table.layout.indexBase).toBe(0);
    expect(table.layout.unmappedReplicaIds).toEqual([1]);
  });

  it("leaves the index base open when no substring settles it", () => {
    const table = parseNoteReplicaTableFromPlain(
      document({
        body: "ab",
        clocks: [
          { seed: 1, subClocks: [1] },
          { seed: 2, subClocks: [1] },
        ],
        substrings: [{ replica: 1, clock: 1, length: 2 }],
      })
    );
    expect(table.layout.indexBase).toBeNull();
    expect(table.replicas.map((r) => r.chars)).toEqual([0, 2]);
  });

  it("warns when substring lengths do not add up to the text", () => {
    const table = parseNoteReplicaTableFromPlain(
      document({
        body: "abcd",
        clocks: [{ seed: 1, subClocks: [1] }],
        substrings: [{ replica: 0, clock: 1, length: 3 }],
      })
    );
    expect(table.layout.lengthsMatchText).toBe(false);
    expect(table.layout.warnings[0]).toMatch(/sum to 3 .* 4 UTF-16/);
  });

  it("counts UTF-16 units, not code points, for the text length", () => {
    const table = parseNoteReplicaTableFromPlain(
      document({
        body: "a😀",
        clocks: [{ seed: 1, subClocks: [1] }],
        substrings: [{ replica: 0, clock: 1, length: 3 }],
      })
    );
    expect(table.layout.lengthsMatchText).toBe(true);
  });

  it("warns about references to a replica with no clock entry", () => {
    const table = parseNoteReplicaTableFromPlain(
      document({
        body: "ab",
        clocks: [{ seed: 1, subClocks: [1] }],
        substrings: [
          { replica: 0, clock: 1, length: 1 },
          { replica: 5, clock: 1, length: 1 },
          { replica: 3, clock: 1, length: 0 },
        ],
      })
    );
    expect(table.layout.unmappedReplicaIds).toEqual([3, 5]);
    expect(table.layout.warnings.join(" ")).toMatch(/replica IDs with no clock entry: 3,5/);
  });

  it("warns when a note has no substring records", () => {
    const table = parseNoteReplicaTableFromPlain(
      document({ body: "", clocks: [{ seed: 1, subClocks: [1] }], substrings: [] })
    );
    expect(table.layout.warnings).toEqual(["The note has no substring records"]);
  });

  it("keeps every varint of a sub-clock that has no field 2", () => {
    const entry = bytes(1, [...bytes(1, uuid(9)), ...bytes(2, [...num(1, 4), ...num(3, 8)])]);
    const plain = Uint8Array.from(
      bytes(
        2,
        bytes(3, [
          ...text(2, ""),
          ...bytes(4, entry),
          ...substring({ replica: 0, clock: 1, length: 0 }),
        ])
      )
    );
    const table = parseNoteReplicaTableFromPlain(plain);
    expect(table.replicas[0].subClocks).toEqual([4, 8]);
    expect(table.replicas[0].clock).toBe(8);
  });

  it("refuses a document that is not a note body", () => {
    expect(() => parseNoteReplicaTableFromPlain(Uint8Array.from(num(1, 1)))).toThrow(
      /Unsupported Notes document structure/
    );
  });

  it("refuses a note without a vector timestamp", () => {
    const noClocks = Uint8Array.from(bytes(2, bytes(3, text(2, "x"))));
    expect(() => parseNoteReplicaTableFromPlain(noClocks)).toThrow(/no vector timestamp/);
  });

  it("refuses a clock whose replica UUID is not 16 bytes", () => {
    const bad = Uint8Array.from(
      bytes(2, bytes(3, [...text(2, "x"), ...bytes(4, bytes(1, bytes(1, [1, 2, 3])))]))
    );
    expect(() => parseNoteReplicaTableFromPlain(bad)).toThrow(/16-byte replica UUID/);
  });
});

describe("describeProtoShape", () => {
  it("prints field paths, wire types and counts without the text", () => {
    const lines = describeProtoShape(
      document({
        body: "secret body",
        clocks: [{ seed: 1, subClocks: [1] }],
        substrings: [
          { replica: 0, clock: 1, length: 5 },
          { replica: 0, clock: 6, length: 6 },
        ],
      })
    );
    expect(lines.find((l) => l.startsWith("2.3.3 "))).toMatch(
      /^2\.3\.3 wire=2 count=2 bytes=\d+ message$/
    );
    expect(lines.find((l) => l.startsWith("2.3.2 "))).toMatch(/^2\.3\.2 wire=2 count=1 bytes=\d+$/);
    expect(lines.find((l) => l.startsWith("2.3.3.2 "))).toBe("2.3.3.2 wire=0 count=2");
    expect(lines.join("\n")).not.toContain("secret");
  });

  it("stops descending at the depth limit", () => {
    const lines = describeProtoShape(
      document({
        body: "x",
        clocks: [{ seed: 1, subClocks: [1] }],
        substrings: [{ replica: 0, clock: 1, length: 1 }],
      }),
      1
    );
    expect(lines.some((l) => l.startsWith("2.3.3.2 "))).toBe(false);
  });
});
