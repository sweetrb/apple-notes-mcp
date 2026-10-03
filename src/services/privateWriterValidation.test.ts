import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WRITER_VALIDATION_FEATURES,
  WRITER_VALIDATION_KEYS,
  WRITER_VALIDATION_RECORDS,
  writerFeatureIsValidated,
  writerUnverifiedEnv,
  type WriterValidationRecord,
} from "./privateWriterValidation.js";
import { packageRoot } from "./privateHelper.js";
import { WRITER_SOURCE_RELATIVE } from "./privateWriter.js";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("writer validation evidence", () => {
  it("keeps every feature unvalidated until an evidence artifact is recorded", () => {
    for (const feature of WRITER_VALIDATION_FEATURES) {
      expect(WRITER_VALIDATION_RECORDS[feature], feature).toBeNull();
      expect(writerFeatureIsValidated(feature), feature).toBe(false);
    }
  });

  it("requires any future evidence record to pin a real artifact and this writer source", () => {
    for (const record of Object.values(WRITER_VALIDATION_RECORDS)) {
      if (record === null) continue;
      const root = packageRoot(__dirname);
      expect(record.artifact).toMatch(/^docs\/private-writer-validation\/[a-z0-9-]+\.md$/);
      expect(sha256(readFileSync(join(root, record.artifact)))).toBe(record.artifactSha256);
      expect(sha256(readFileSync(join(root, WRITER_SOURCE_RELATIVE)))).toBe(
        record.writerSourceSha256
      );
    }
  });

  it("rejects incomplete or malformed evidence records", () => {
    const valid: WriterValidationRecord = {
      artifact: "docs/private-writer-validation/append-2026-10-02.md",
      artifactSha256: "a".repeat(64),
      writerSourceSha256: "b".repeat(64),
      validatedAt: "2026-10-02",
    };
    const withRecord = (record: WriterValidationRecord) => ({
      ...WRITER_VALIDATION_RECORDS,
      APPEND: record,
    });
    expect(writerFeatureIsValidated("APPEND", withRecord(valid))).toBe(true);
    for (const patch of [
      { artifact: "../../outside.md" },
      { artifactSha256: "" },
      { writerSourceSha256: "not-a-hash" },
      { validatedAt: "yesterday" },
    ])
      expect(writerFeatureIsValidated("APPEND", withRecord({ ...valid, ...patch }))).toBe(false);
  });

  it("maps only known feature keys and never returns the blanket native-operation switch", () => {
    for (const [key, feature] of Object.entries(WRITER_VALIDATION_KEYS)) {
      expect(writerUnverifiedEnv(key)).toBe(`APPLE_NOTES_MCP_ALLOW_UNVERIFIED_${feature}`);
    }
    expect(writerUnverifiedEnv("new-unregistered-tool")).toBeUndefined();
    expect(writerUnverifiedEnv("constructor")).toBeUndefined();
    expect(writerUnverifiedEnv("toString")).toBeUndefined();
  });
});
