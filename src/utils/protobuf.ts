/**
 * Minimal Protobuf Wire Format Decoder
 *
 * Decodes raw protobuf binary data without requiring a .proto schema file.
 * Only implements the subset of wire types needed for reading Apple Notes
 * checklist state from the NoteStore protobuf format.
 *
 * Wire types supported:
 * - 0: Varint (integers, booleans)
 * - 2: Length-delimited (strings, bytes, embedded messages)
 *
 * @module utils/protobuf
 */

/**
 * Protobuf wire types used in Apple Notes data.
 */
export const WIRE_TYPE = {
  VARINT: 0,
  LENGTH_DELIMITED: 2,
} as const;

/**
 * A decoded protobuf field.
 */
export interface ProtoField {
  /** Field number from the protobuf tag */
  fieldNumber: number;
  /** Wire type (0 = varint, 2 = length-delimited) */
  wireType: number;
  /** Decoded value: number for varints, Uint8Array for length-delimited */
  value: number | Uint8Array;
}

/**
 * Decodes a varint from the buffer at the given offset.
 *
 * Varints use 7 bits per byte with the high bit as a continuation flag.
 * Supports up to 64-bit values (though we only need small integers).
 *
 * @param buf - The protobuf binary data
 * @param offset - Starting byte position
 * @returns Tuple of [decoded value, new offset after the varint]
 */
export function decodeVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;

  while (pos < buf.length) {
    const byte = buf[pos];
    result |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) {
      return [result, pos];
    }
    shift += 7;
    if (shift > 35) {
      // For our use case (small field numbers, small integers),
      // values requiring more than 35 bits are unexpected
      throw new Error(`Varint too long at offset ${offset}`);
    }
  }

  throw new Error(`Unexpected end of buffer reading varint at offset ${offset}`);
}

/**
 * Decodes all fields from a protobuf message buffer.
 *
 * Iterates through the buffer, decoding tag-value pairs. Unknown wire types
 * cause parsing to stop (returns fields decoded so far).
 *
 * Fixed-width fields (wire types 1 and 5) are skipped unless `keepFixed` is
 * set, in which case their raw little-endian bytes are kept as the value (read
 * a 64-bit float with {@link fixed64Double}).
 *
 * @param buf - The protobuf binary data
 * @param options - `keepFixed` keeps 32/64-bit fixed fields instead of skipping them
 * @returns Array of decoded fields in order
 */
export function decodeMessage(
  buf: Uint8Array,
  options: { keepFixed?: boolean } = {}
): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  while (offset < buf.length) {
    let tag: number;
    [tag, offset] = decodeVarint(buf, offset);

    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === WIRE_TYPE.VARINT) {
      let value: number;
      [value, offset] = decodeVarint(buf, offset);
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === WIRE_TYPE.LENGTH_DELIMITED) {
      let length: number;
      [length, offset] = decodeVarint(buf, offset);
      if (offset + length > buf.length) {
        break; // Truncated data, return what we have
      }
      const value = buf.slice(offset, offset + length);
      fields.push({ fieldNumber, wireType, value });
      offset += length;
    } else if (wireType === 5 || wireType === 1) {
      // 32-bit (wire 5) or 64-bit (wire 1) fixed width
      const width = wireType === 5 ? 4 : 8;
      if (offset + width > buf.length) break; // Truncated data
      if (options.keepFixed) {
        fields.push({ fieldNumber, wireType, value: buf.slice(offset, offset + width) });
      }
      offset += width;
    } else {
      // Unknown wire type — stop parsing
      break;
    }
  }

  return fields;
}

/**
 * Gets all fields with a specific field number from decoded message fields.
 *
 * @param fields - Decoded protobuf fields
 * @param fieldNumber - The field number to filter for
 * @returns Matching fields
 */
export function getFields(fields: ProtoField[], fieldNumber: number): ProtoField[] {
  return fields.filter((f) => f.fieldNumber === fieldNumber);
}

/**
 * Gets the first field with a specific field number.
 *
 * @param fields - Decoded protobuf fields
 * @param fieldNumber - The field number to find
 * @returns The first matching field, or undefined
 */
export function getField(fields: ProtoField[], fieldNumber: number): ProtoField | undefined {
  return fields.find((f) => f.fieldNumber === fieldNumber);
}

/**
 * Extracts the varint value from a field, returning undefined if not a varint.
 */
export function varintValue(field: ProtoField | undefined): number | undefined {
  if (!field || typeof field.value !== "number") return undefined;
  return field.value;
}

/**
 * Extracts the bytes value from a field, returning undefined if not length-delimited.
 */
export function bytesValue(field: ProtoField | undefined): Uint8Array | undefined {
  if (!field || !(field.value instanceof Uint8Array)) return undefined;
  return field.value;
}

/**
 * Decodes a length-delimited field as a UTF-8 string.
 */
export function stringValue(field: ProtoField | undefined): string | undefined {
  const bytes = bytesValue(field);
  if (!bytes) return undefined;
  return new TextDecoder().decode(bytes);
}

/**
 * Decodes a length-delimited field as an embedded message.
 */
export function embeddedMessage(field: ProtoField | undefined): ProtoField[] | undefined {
  const bytes = bytesValue(field);
  if (!bytes) return undefined;
  return decodeMessage(bytes);
}

/**
 * Reads a 64-bit fixed field (wire type 1, kept via `keepFixed`) as a
 * little-endian IEEE 754 double. Returns undefined for any other field shape.
 */
export function fixed64Double(field: ProtoField | undefined): number | undefined {
  if (!field || field.wireType !== 1 || !(field.value instanceof Uint8Array)) return undefined;
  if (field.value.length !== 8) return undefined;
  return new DataView(field.value.buffer, field.value.byteOffset, 8).getFloat64(0, true);
}

/**
 * A protobuf field decoded losslessly by {@link decodeWireFields}.
 *
 * Unlike {@link ProtoField}, fixed-width values are kept (Apple Notes stores
 * colors and font sizes as 32-bit floats) and varints are read as full 64-bit
 * values, so negative int32/int64 values (10-byte varints, such as a subscript
 * offset of -1) decode instead of throwing.
 */
export interface WireField {
  fieldNumber: number;
  /** 0 = varint, 1 = fixed64, 2 = length-delimited, 5 = fixed32 */
  wireType: 0 | 1 | 2 | 5;
  /** Unsigned 64-bit value for wire type 0. */
  varint?: bigint;
  /** Raw bytes for wire types 1, 2 and 5 (little-endian for fixed widths). */
  bytes?: Uint8Array;
}

/** Thrown by {@link decodeWireFields} for truncated or malformed input. */
export class ProtobufDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtobufDecodeError";
  }
}

/** Decode one varint of up to 10 bytes (64 bits) as an unsigned bigint. */
export function decodeVarint64(buf: Uint8Array, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [BigInt.asUintN(64, result), pos];
    shift += 7n;
    if (shift >= 70n) throw new ProtobufDecodeError(`Varint too long at offset ${offset}`);
  }
  throw new ProtobufDecodeError(`Unexpected end of buffer reading varint at offset ${offset}`);
}

/**
 * Decode every field of one message without dropping any wire type.
 *
 * Strict: truncated fields, group wire types (3, 4) or unknown wire types, and
 * field number 0 throw {@link ProtobufDecodeError} instead of returning a
 * partial result. The legacy {@link decodeMessage} is deliberately left
 * unchanged, because existing revision and style signatures depend on its
 * exact output.
 */
export function decodeWireFields(buf: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const [tag, afterTag] = decodeVarint64(buf, offset);
    offset = afterTag;
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber === 0 || fieldNumber > 0x1fffffff)
      throw new ProtobufDecodeError("Invalid field number");
    if (wireType === 0) {
      const [value, next] = decodeVarint64(buf, offset);
      offset = next;
      fields.push({ fieldNumber, wireType, varint: value });
      continue;
    }
    let length: number;
    if (wireType === 1) length = 8;
    else if (wireType === 5) length = 4;
    else if (wireType === 2) {
      const [value, next] = decodeVarint64(buf, offset);
      if (value > BigInt(buf.length)) throw new ProtobufDecodeError("Truncated field");
      length = Number(value);
      offset = next;
    } else throw new ProtobufDecodeError(`Unsupported wire type ${wireType}`);
    if (offset + length > buf.length) throw new ProtobufDecodeError("Truncated field");
    fields.push({
      fieldNumber,
      wireType: wireType as 1 | 2 | 5,
      bytes: buf.subarray(offset, offset + length),
    });
    offset += length;
  }
  return fields;
}

/** Reinterpret an unsigned 64-bit varint as a signed two's-complement number. */
export function signedVarint(value: bigint): number {
  return Number(BigInt.asIntN(64, value));
}

/** Read a little-endian IEEE-754 float from a fixed32 field. */
export function fixed32Float(field: WireField | undefined): number | undefined {
  if (!field || field.wireType !== 5 || !field.bytes || field.bytes.length !== 4) return undefined;
  const bytes = field.bytes;
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
}
