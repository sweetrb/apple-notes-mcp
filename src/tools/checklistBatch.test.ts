import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppleNotesManager } from "../services/appleNotesManager.js";
import type { BackgroundDependencies, BackgroundSnapshot } from "../services/backgroundNotes.js";
import type { RichNote } from "../utils/noteRichText.js";
import {
  appendChecklistItems,
  MAX_CHECKLIST_BATCH,
  nativeToolResult,
  registerNativeOperations,
} from "./nativeOperations.js";

const id = "x-coredata://ABC/ICNote/p1";
const scopeText = "existing scope phrase";

/** A simulated note whose checklist grows by one item per bridge run. */
function simulatedNote(
  options: {
    initial?: string[];
    onRun?: (
      text: string,
      run: number
    ) => "append" | "skip" | "double" | "throw" | "appendThenThrow";
  } = {}
) {
  let items = (options.initial ?? []).map((text, i) => ({ id: `old-${i}`, text, done: false }));
  let revision = 0;
  let runs = 0;
  const rich = (): RichNote =>
    ({
      text: `Title\n${scopeText}\n${items.map((item) => item.text).join("\n")}`,
      links: [],
      nativeTags: [],
      nativeObjectIds: [],
      hasNativeObjects: items.length > 0,
      hasChecklist: items.length > 0,
      revision: `r${revision}`,
      objects: [],
      checklistItems: items.map((item, i) => ({ ...item, start: 100 + i * 10 })),
      styleRuns: [],
      objectData: [],
    }) as unknown as RichNote;
  const snapshot = (): BackgroundSnapshot => ({
    id,
    title: "Title",
    hash: `sha256:${String(revision).padStart(64, "0")}`,
    html: "",
    rich: rich(),
    checklist: items.map(({ text, done }) => ({ text, done })),
  });
  const append = (text: string) => {
    items = [...items, { id: `new-${runs}-${items.length}`, text, done: false }];
    revision++;
  };
  const deps: BackgroundDependencies = {
    read: () => snapshot(),
    candidates: () => [id],
    run: vi.fn((input: Record<string, string>) => {
      runs++;
      const action = options.onRun?.(input.text, runs) ?? "append";
      if (action === "throw") throw new Error("Shortcuts failed");
      if (action === "skip") return;
      append(input.text);
      if (action === "double") append(input.text);
      if (action === "appendThenThrow") throw new Error("Shortcuts reported a failure");
    }),
  };
  return { deps, readRich: () => rich(), snapshot, runs: () => runs };
}

describe("appendChecklistItems", () => {
  it("appends every item in order and reports each native identity", () => {
    const note = simulatedNote({ initial: ["kept"] });
    const result = appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["one", "two", "one"] },
      note.deps,
      note.readRich
    );
    expect(result).toMatchObject({ ok: true, orderVerified: true });
    expect((result.items as Array<{ text: string; id: string }>).map((i) => i.text)).toEqual([
      "one",
      "two",
      "one",
    ]);
    // Duplicate text still gets two distinct identities.
    const ids = (result.items as Array<{ id: string }>).map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
    expect(result.contentHash).toBe(note.snapshot().hash);
    expect(note.runs()).toBe(3);
  });

  it("chains each verified revision into the next run", () => {
    const note = simulatedNote();
    const run = vi.mocked(note.deps.run);
    appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["a", "b"] },
      note.deps,
      note.readRich
    );
    expect(run.mock.calls.map((call) => call[0].operation)).toEqual([
      "create-checklist-item",
      "create-checklist-item",
    ]);
    expect(run.mock.calls.map((call) => call[0].text)).toEqual(["a", "b"]);
  });

  it("stops at the first item that did not land and reports what did", () => {
    const note = simulatedNote({ onRun: (_text, run) => (run === 2 ? "skip" : "append") });
    const result = appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["a", "b", "c"] },
      note.deps,
      note.readRich
    );
    expect(result).toMatchObject({
      ok: false,
      stoppedAt: { index: 1, text: "b", outcome: "uncertain" },
      notAttempted: ["c"],
    });
    expect((result.landed as Array<{ text: string }>).map((i) => i.text)).toEqual(["a"]);
    expect(note.runs()).toBe(2);
    expect(result.message).toMatch(/Stopped at item 2 of 3; 1 item\(s\) landed/);
  });

  it("stops when one run adds two items", () => {
    const note = simulatedNote({ onRun: () => "double" });
    const result = appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["a", "b"] },
      note.deps,
      note.readRich
    );
    expect(result).toMatchObject({ ok: false, landed: [], stoppedAt: { index: 0 } });
    expect(note.runs()).toBe(1);
  });

  it("reports a stale revision as not written without running the bridge", () => {
    const note = simulatedNote();
    const result = appendChecklistItems(
      { id, expectedContentHash: `sha256:${"f".repeat(64)}`, scopeText, items: ["a"] },
      note.deps,
      note.readRich
    );
    expect(result).toMatchObject({
      ok: false,
      stoppedAt: { index: 0, outcome: "not-written", error: expect.stringMatching(/revision/) },
    });
    expect(note.runs()).toBe(0);
  });

  it("accepts a transport error when readback proves the item landed", () => {
    // The bridge writes the item and then reports a failure.
    const note = simulatedNote({ onRun: () => "appendThenThrow" });
    const result = appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["a", "b"] },
      note.deps,
      note.readRich
    );
    expect(result).toMatchObject({ ok: true, orderVerified: true });
    expect(note.runs()).toBe(2);
  });

  it("stops when the bridge fails without writing", () => {
    const note = simulatedNote({ onRun: () => "throw" });
    const result = appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["a", "b"] },
      note.deps,
      note.readRich
    );
    expect(result).toMatchObject({
      ok: false,
      landed: [],
      stoppedAt: {
        index: 0,
        outcome: "uncertain",
        error: expect.stringMatching(/Shortcuts failed/),
      },
      notAttempted: ["b"],
    });
  });

  // #248 — a bridge refusal, or a Shortcut that exits with its own error, with
  // the note unchanged is definitively not written, not uncertain.
  it.each([
    [
      "refused",
      Object.assign(new Error("refused the request without running it"), { refused: true }),
    ],
    [
      "exited with an error",
      Object.assign(new Error("Find Notes could not run"), { status: 1, signal: null }),
    ],
  ])("reports not-written when the bridge %s and the note is unchanged", (_label, failure) => {
    const note = simulatedNote();
    note.deps.run = vi.fn(() => {
      throw failure;
    });
    const result = appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["a", "b"] },
      note.deps,
      note.readRich
    );
    expect(result).toMatchObject({
      ok: false,
      landed: [],
      stoppedAt: {
        index: 0,
        outcome: "not-written",
        error: expect.stringMatching(/nothing was written/),
      },
      notAttempted: ["b"],
    });
  });
});

describe("appendChecklistItems outcome reporting (#201)", () => {
  it("reports a readback that throws after the bridge ran as uncertain", () => {
    const note = simulatedNote();
    const read = note.deps.read;
    note.deps.read = (noteId) => {
      if (note.runs() > 0) throw new Error("database is locked");
      return read(noteId);
    };
    const result = appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["a", "b"] },
      note.deps,
      note.readRich
    );
    expect(result).toMatchObject({
      ok: false,
      code: "verification_failed",
      indeterminate: true,
      landed: [],
      stoppedAt: { index: 0, outcome: "uncertain", error: expect.stringMatching(/locked/) },
      notAttempted: ["b"],
    });
    // The pre-run revision is stale once the bridge may have written.
    expect(result).not.toHaveProperty("contentHash");
    expect(nativeToolResult(result).isError).toBe(true);
  });

  it("keeps contentHash and committed: false when nothing was attempted", () => {
    const note = simulatedNote();
    const result = appendChecklistItems(
      { id, expectedContentHash: `sha256:${"f".repeat(64)}`, scopeText, items: ["a"] },
      note.deps,
      note.readRich
    );
    expect(result).toMatchObject({
      ok: false,
      code: "revision_conflict",
      committed: false,
      indeterminate: false,
      contentHash: `sha256:${"f".repeat(64)}`,
    });
  });

  it("includes landed and an error code when the final order check fails", () => {
    const note = simulatedNote({ initial: ["kept"] });
    let calls = 0;
    // The last read (the order check) sees the new items moved before the old one.
    const readRich = () => {
      const rich = note.readRich();
      if (++calls === 4)
        rich.checklistItems = rich.checklistItems!.map((item) => ({
          ...item,
          start: item.id.startsWith("old") ? 1000 : item.start,
        }));
      return rich;
    };
    const result = appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["a", "b"] },
      note.deps,
      readRich
    );
    expect(result).toMatchObject({
      ok: false,
      orderVerified: false,
      code: "verification_failed",
      committed: true,
    });
    expect((result.landed as Array<{ text: string }>).map((i) => i.text)).toEqual(["a", "b"]);
    expect(nativeToolResult(result).isError).toBe(true);
  });

  it("does not mark a successful batch as an error", () => {
    const note = simulatedNote();
    const result = appendChecklistItems(
      { id, expectedContentHash: note.snapshot().hash, scopeText, items: ["a"] },
      note.deps,
      note.readRich
    );
    expect(result.ok).toBe(true);
    expect(nativeToolResult(result)).not.toHaveProperty("isError");
  });
});

describe("create-checklist-items schema", () => {
  const schema = () => {
    const registerTool = vi.fn();
    registerNativeOperations({ registerTool } as unknown as McpServer, {} as AppleNotesManager);
    return registerTool.mock.calls.find((c) => c[0] === "create-checklist-items")![1]
      .inputSchema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
  };

  it("bounds the batch and refuses multi-line items", () => {
    const { items } = schema();
    expect(items.safeParse(["a"]).success).toBe(true);
    expect(items.safeParse([]).success).toBe(false);
    expect(items.safeParse(Array(MAX_CHECKLIST_BATCH + 1).fill("a")).success).toBe(false);
    expect(items.safeParse(["a\nb"]).success).toBe(false);
    expect(items.safeParse([""]).success).toBe(false);
  });
});
