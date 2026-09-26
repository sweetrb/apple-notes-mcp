import { describe, expect, it, vi } from "vitest";
import {
  installStructuredText,
  MAX_MIRROR_CHARS,
  SHOWN_ABOVE,
  STRUCTURED_TEXT_PREFIX,
  structuredTextLine,
  withStructuredText,
} from "./structuredText.js";
import { installSdkErrorCodes } from "./errorCodes.js";

const parse = (line: string) =>
  JSON.parse(line.slice(STRUCTURED_TEXT_PREFIX.length)) as Record<string, unknown>;

describe("withStructuredText", () => {
  it("appends one mirrored block and leaves the original content and structuredContent alone", () => {
    const structured = { id: "n1", contentHash: `sha256:${"c".repeat(64)}`, writable: false };
    const r = withStructuredText({
      content: [{ type: "text" as const, text: "Done" }],
      structuredContent: structured,
    });
    expect(r.content[0]).toEqual({ type: "text", text: "Done" });
    expect(r.content).toHaveLength(2);
    expect(parse(r.content[1].text)).toEqual(structured);
    expect(r.structuredContent).toBe(structured);
  });

  it("leaves results without structuredContent unchanged", () => {
    const r = { content: [{ type: "text", text: "hi" }] };
    expect(withStructuredText(r)).toBe(r);
  });

  it("skips a result whose text already is the JSON (compact or pretty)", () => {
    const s = { a: 1, b: "x", c: undefined };
    for (const text of [JSON.stringify(s), JSON.stringify(s, null, 2)]) {
      const r = { content: [{ type: "text", text }], structuredContent: s };
      expect(withStructuredText(r)).toBe(r);
    }
  });

  it("keeps non-text content (images) and still appends the block", () => {
    const r = withStructuredText({
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      structuredContent: { name: "a.png" },
    });
    expect(r.content).toHaveLength(2);
    expect(r.content[1]).toEqual({ type: "text", text: 'structuredContent: {"name":"a.png"}' });
  });
});

describe("structuredTextLine size bounds", () => {
  it("elides a long string the text already shows, at any depth", () => {
    const body = "x".repeat(500);
    const m = parse(structuredTextLine({ content: body, nested: [{ body }], hash: "h" }, body));
    expect(m).toEqual({ content: SHOWN_ABOVE, nested: [{ body: SHOWN_ABOVE }], hash: "h" });
  });

  it("keeps short strings even when the text contains them", () => {
    expect(parse(structuredTextLine({ id: "n1" }, "id n1"))).toEqual({ id: "n1" });
  });

  it("over budget, drops only large top-level fields and names them", () => {
    const notes = Array.from({ length: 2000 }, (_, i) => ({ id: `note-${i}`, title: "T" }));
    const line = structuredTextLine(
      { notes, count: 2000, page: { hasMore: true, nextOffset: 50 }, contentHash: "sha256:x" },
      ""
    );
    expect(line.length).toBeLessThan(MAX_MIRROR_CHARS);
    expect(parse(line)).toEqual({
      count: 2000,
      page: { hasMore: true, nextOffset: 50 },
      contentHash: "sha256:x",
      _omitted: ["notes"],
    });
  });
});

describe("installStructuredText", () => {
  it("wraps registerTool callbacks, sync or async, with or without args", async () => {
    const calls: Array<(...a: unknown[]) => Promise<unknown>> = [];
    const server = {
      registerTool: vi.fn((_n: string, _c: unknown, cb: (...a: unknown[]) => Promise<unknown>) => {
        calls.push(cb);
        return "registered";
      }),
    };
    installStructuredText(server);
    const result = { content: [{ type: "text", text: "ok" }], structuredContent: { k: "v" } };
    expect(server.registerTool("a", {}, (args: unknown) => ({ ...result, args }))).toBe(
      "registered"
    );
    server.registerTool("b", {}, async () => result);
    const a = (await calls[0]({ x: 1 })) as { content: unknown[]; args: unknown };
    expect(a.args).toEqual({ x: 1 });
    expect(a.content).toHaveLength(2);
    expect(((await calls[1]()) as { content: unknown[] }).content).toHaveLength(2);
  });

  it("mirrors the SDK's own error results (input validation) with their code", () => {
    const server = {
      createToolError: (m: string) => ({ content: [{ type: "text", text: m }], isError: true }),
    };
    installSdkErrorCodes(server);
    installStructuredText(server);
    const r = server.createToolError(
      "Input validation error: Invalid arguments for tool update-note: bad"
    ) as { content: Array<{ text: string }> };
    expect(parse(r.content[1].text)).toMatchObject({ code: "validation_error", committed: false });
  });
});
