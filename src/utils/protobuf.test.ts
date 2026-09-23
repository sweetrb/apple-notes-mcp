/**
 * Tests for the minimal protobuf wire format decoder.
 */

import { describe, it, expect } from "vitest";
import {
  decodeVarint,
  decodeMessage,
  getField,
  getFields,
  varintValue,
  bytesValue,
  stringValue,
  embeddedMessage,
  fixed64Double,
  WIRE_TYPE,
  decodeVarint64,
  decodeWireFields,
  fixed32Float,
  ProtobufDecodeError,
  signedVarint,
} from "./protobuf.js";

describe("decodeVarint", () => {
  it("decodes single-byte varint", () => {
    // 0x08 = field 1, varint; 0x05 = value 5
    const [value, offset] = decodeVarint(new Uint8Array([5]), 0);
    expect(value).toBe(5);
    expect(offset).toBe(1);
  });

  it("decodes multi-byte varint", () => {
    // 300 = 0xAC 0x02
    const [value, offset] = decodeVarint(new Uint8Array([0xac, 0x02]), 0);
    expect(value).toBe(300);
    expect(offset).toBe(2);
  });

  it("decodes varint at non-zero offset", () => {
    const [value, offset] = decodeVarint(new Uint8Array([0xff, 0x03]), 1);
    expect(value).toBe(3);
    expect(offset).toBe(2);
  });

  it("decodes zero", () => {
    const [value, offset] = decodeVarint(new Uint8Array([0x00]), 0);
    expect(value).toBe(0);
    expect(offset).toBe(1);
  });

  it("throws on truncated varint", () => {
    expect(() => decodeVarint(new Uint8Array([0x80]), 0)).toThrow("Unexpected end of buffer");
  });
});

describe("decodeMessage", () => {
  it("decodes a message with a varint field", () => {
    // Field 1, wire type 0 (varint), value 150
    // Tag: (1 << 3) | 0 = 0x08
    // Value: 150 = 0x96 0x01
    const buf = new Uint8Array([0x08, 0x96, 0x01]);
    const fields = decodeMessage(buf);

    expect(fields).toHaveLength(1);
    expect(fields[0].fieldNumber).toBe(1);
    expect(fields[0].wireType).toBe(WIRE_TYPE.VARINT);
    expect(fields[0].value).toBe(150);
  });

  it("decodes a message with a length-delimited field", () => {
    // Field 2, wire type 2 (length-delimited), value "hi"
    // Tag: (2 << 3) | 2 = 0x12
    // Length: 2
    // Data: 0x68 0x69 = "hi"
    const buf = new Uint8Array([0x12, 0x02, 0x68, 0x69]);
    const fields = decodeMessage(buf);

    expect(fields).toHaveLength(1);
    expect(fields[0].fieldNumber).toBe(2);
    expect(fields[0].wireType).toBe(WIRE_TYPE.LENGTH_DELIMITED);
    expect(fields[0].value).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(fields[0].value as Uint8Array)).toBe("hi");
  });

  it("decodes multiple fields", () => {
    // Field 1 varint=1, Field 2 varint=2
    const buf = new Uint8Array([0x08, 0x01, 0x10, 0x02]);
    const fields = decodeMessage(buf);

    expect(fields).toHaveLength(2);
    expect(fields[0].fieldNumber).toBe(1);
    expect(fields[0].value).toBe(1);
    expect(fields[1].fieldNumber).toBe(2);
    expect(fields[1].value).toBe(2);
  });

  it("handles empty buffer", () => {
    const fields = decodeMessage(new Uint8Array([]));
    expect(fields).toHaveLength(0);
  });

  it("handles truncated length-delimited field gracefully", () => {
    // Tag for field 2 length-delimited, length=10, but only 2 bytes of data
    const buf = new Uint8Array([0x12, 0x0a, 0x68, 0x69]);
    const fields = decodeMessage(buf);
    // Should stop parsing rather than crash
    expect(fields).toHaveLength(0);
  });
});

describe("field accessors", () => {
  // Build a test message with: field 1 = varint 42, field 2 = "hello", field 2 = "world"
  const buf = new Uint8Array([
    0x08,
    0x2a, // field 1, varint, value 42
    0x12,
    0x05,
    0x68,
    0x65,
    0x6c,
    0x6c,
    0x6f, // field 2, "hello"
    0x12,
    0x05,
    0x77,
    0x6f,
    0x72,
    0x6c,
    0x64, // field 2, "world"
  ]);
  const fields = decodeMessage(buf);

  it("getField returns first matching field", () => {
    const f = getField(fields, 2);
    expect(f).toBeDefined();
    expect(new TextDecoder().decode(f!.value as Uint8Array)).toBe("hello");
  });

  it("getFields returns all matching fields", () => {
    const matches = getFields(fields, 2);
    expect(matches).toHaveLength(2);
  });

  it("getField returns undefined for missing field", () => {
    expect(getField(fields, 99)).toBeUndefined();
  });

  it("varintValue extracts number", () => {
    expect(varintValue(getField(fields, 1))).toBe(42);
  });

  it("varintValue returns undefined for non-varint", () => {
    expect(varintValue(getField(fields, 2))).toBeUndefined();
  });

  it("bytesValue extracts Uint8Array", () => {
    const bytes = bytesValue(getField(fields, 2));
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes!.length).toBe(5);
  });

  it("stringValue decodes UTF-8", () => {
    expect(stringValue(getField(fields, 2))).toBe("hello");
  });

  it("embeddedMessage decodes nested message", () => {
    // Create a field 1 containing an embedded message with field 1 = varint 7
    const inner = new Uint8Array([0x08, 0x07]); // field 1, varint 7
    // Wrap as field 1, length-delimited
    const outer = new Uint8Array([0x0a, 0x02, ...inner]);
    const outerFields = decodeMessage(outer);
    const nested = embeddedMessage(getField(outerFields, 1));

    expect(nested).toBeDefined();
    expect(nested!).toHaveLength(1);
    expect(varintValue(getField(nested!, 1))).toBe(7);
  });
});

describe("fixed-width fields", () => {
  // field 1 = fixed64 double 1.5, field 2 = fixed32, field 3 = varint 9
  const double = Buffer.alloc(8);
  double.writeDoubleLE(1.5);
  const buf = new Uint8Array([0x09, ...double, 0x15, 1, 2, 3, 4, 0x18, 0x09]);

  it("skips fixed fields by default, as before", () => {
    const fields = decodeMessage(buf);
    expect(fields.map((f) => f.fieldNumber)).toEqual([3]);
  });

  it("keeps fixed fields with keepFixed and reads a double", () => {
    const fields = decodeMessage(buf, { keepFixed: true });
    expect(fields.map((f) => [f.fieldNumber, f.wireType])).toEqual([
      [1, 1],
      [2, 5],
      [3, 0],
    ]);
    expect(fixed64Double(getField(fields, 1))).toBe(1.5);
    expect(fixed64Double(getField(fields, 2))).toBeUndefined();
    expect(fixed64Double(getField(fields, 3))).toBeUndefined();
  });

  it("stops at a truncated fixed field", () => {
    expect(decodeMessage(new Uint8Array([0x18, 0x01, 0x09, 1, 2]), { keepFixed: true })).toEqual([
      { fieldNumber: 3, wireType: 0, value: 1 },
    ]);
  });
});

describe("decodeVarint beyond 28 bits (#188)", () => {
  it("decodes 5-byte values as unsigned, not as a wrapped int32", () => {
    // 2^31 = 0x80 0x80 0x80 0x80 0x08; the old 32-bit shift wrapped it negative.
    expect(decodeVarint(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x08]), 0)).toEqual([2 ** 31, 5]);
    expect(decodeVarint(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f]), 0)).toEqual([
      2 ** 32 - 1,
      5,
    ]);
  });

  it("decodes a negative int32 (-2) and keeps a hard stop at 10 bytes", () => {
    const minusTwo = [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
    expect(decodeVarint(new Uint8Array(minusTwo), 0)).toEqual([-2, 10]);
    expect(() => decodeVarint(new Uint8Array(11).fill(0xff), 0)).toThrow(/too long/);
    expect(() => decodeVarint(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), 0)).toThrow(
      "Unexpected end of buffer"
    );
  });

  it("decodes a message holding a subscript baseline of -1", () => {
    const buf = new Uint8Array([0x40, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    expect(decodeMessage(buf)).toEqual([{ fieldNumber: 8, wireType: 0, value: -1 }]);
  });

  it("stops at a negative length instead of reading backwards", () => {
    const minusOne = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
    const buf = new Uint8Array([0x18, 0x01, 0x0a, ...minusOne, 0x01]);
    expect(decodeMessage(buf)).toEqual([{ fieldNumber: 3, wireType: 0, value: 1 }]);
  });
});

describe("decodeWireFields (lossless)", () => {
  const minusOne = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];

  it("reads 10-byte varints in both decoders (#188)", () => {
    expect(decodeVarint(new Uint8Array(minusOne), 0)).toEqual([-1, 10]);
    const [value, offset] = decodeVarint64(new Uint8Array(minusOne), 0);
    expect(offset).toBe(10);
    expect(signedVarint(value)).toBe(-1);
  });

  it("keeps fixed32 and fixed64 fields that decodeMessage skips", () => {
    const float = Buffer.alloc(4);
    float.writeFloatLE(0.5);
    const buf = new Uint8Array([0x0d, ...float, 0x11, 1, 2, 3, 4, 5, 6, 7, 8, 0x18, ...minusOne]);
    const fields = decodeWireFields(buf);
    expect(fields.map((f) => [f.fieldNumber, f.wireType])).toEqual([
      [1, 5],
      [2, 1],
      [3, 0],
    ]);
    expect(fixed32Float(fields[0])).toBe(0.5);
    expect(fields[1].bytes).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(signedVarint(fields[2].varint!)).toBe(-1);
    // The legacy decoder drops both fixed-width fields.
    expect(decodeMessage(buf.subarray(0, 14))).toEqual([]);
  });

  it("throws instead of returning partial results on malformed input", () => {
    expect(() => decodeWireFields(new Uint8Array([0x0a, 0x05, 0x01]))).toThrow(ProtobufDecodeError);
    expect(() => decodeWireFields(new Uint8Array([0x0d, 0x01]))).toThrow(ProtobufDecodeError);
    expect(() => decodeWireFields(new Uint8Array([0x0b]))).toThrow(/wire type 3/);
    expect(() => decodeWireFields(new Uint8Array([0x00, 0x01]))).toThrow(/field number/);
    expect(() => decodeVarint64(new Uint8Array(11).fill(0xff), 0)).toThrow(/too long/);
  });
});
