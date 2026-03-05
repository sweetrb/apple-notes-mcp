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
 * @param buf - The protobuf binary data
 * @returns Array of decoded fields in order
 */
export function decodeMessage(buf: Uint8Array): ProtoField[] {
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
    } else if (wireType === 5) {
      // 32-bit fixed — skip 4 bytes
      offset += 4;
    } else if (wireType === 1) {
      // 64-bit fixed — skip 8 bytes
      offset += 8;
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
