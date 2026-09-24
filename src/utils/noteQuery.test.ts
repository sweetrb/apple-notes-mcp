/**
 * Tests for the query-notes tokenizer, parser, and evaluator.
 *
 * The module is pure, so these assert the parsed AST directly (a grammar bug
 * cannot hide behind a mocked database) and evaluate against in-memory notes.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateNoteQuery,
  needsContent,
  needsTags,
  normalizeForMatch,
  NoteQueryError,
  parseNoteQuery,
  matchLocations,
  positiveTextPredicates,
  positiveTextTerms,
  QUERY_LIMITS,
  tokenize,
  type Facet,
  type NoteContent,
  type QueryableNote,
} from "./noteQuery.js";

const text = (value: string, field: "any" | "title" | "body" = "any") => ({
  type: "text",
  field,
  value,
});

describe("parseNoteQuery — terms", () => {
  it("parses a bare word as a title-or-body text term", () => {
    expect(parseNoteQuery("budget")).toEqual(text("budget"));
  });

  it("parses a quoted phrase as one text term", () => {
    expect(parseNoteQuery('"quarterly budget"')).toEqual(text("quarterly budget"));
  });

  it("supports escaped quotes and backslashes inside a phrase", () => {
    expect(parseNoteQuery('"say \\"hi\\" \\\\ bye"')).toEqual(text('say "hi" \\ bye'));
  });

  it("parses title:, body:, and text: fields", () => {
    expect(parseNoteQuery("title:invoice")).toEqual(text("invoice", "title"));
    expect(parseNoteQuery("body:agenda")).toEqual(text("agenda", "body"));
    expect(parseNoteQuery("text:agenda")).toEqual(text("agenda"));
  });

  it("accepts a quoted field value and case-insensitive field names", () => {
    expect(parseNoteQuery('FOLDER:"Work Projects"')).toEqual({
      type: "folder",
      value: "Work Projects",
    });
    expect(parseNoteQuery('Account:"On My Mac"')).toEqual({
      type: "account",
      value: "On My Mac",
    });
  });

  it("keeps a path value intact, including an escaped slash", () => {
    expect(parseNoteQuery("folder:Work/Clients")).toEqual({
      type: "folder",
      value: "Work/Clients",
    });
    expect(parseNoteQuery('folder:"Travel/Spain\\\\/Portugal"')).toEqual({
      type: "folder",
      value: "Travel/Spain\\/Portugal",
    });
  });

  it("strips a leading # from tag:", () => {
    expect(parseNoteQuery("tag:#finance")).toEqual({ type: "tag", value: "finance" });
    expect(parseNoteQuery("tag:finance")).toEqual({ type: "tag", value: "finance" });
  });

  it("parses every has: facet case-insensitively", () => {
    for (const facet of [
      "link",
      "attachment",
      "checklist",
      "drawing",
      "image",
      "video",
      "audio",
      "pdf",
      "table",
      "scan",
      "tag",
    ]) {
      expect(parseNoteQuery(`has:${facet.toUpperCase()}`)).toEqual({ type: "has", facet });
    }
  });

  it("parses checklist:open and checklist:done", () => {
    expect(parseNoteQuery("checklist:open")).toEqual({ type: "checklist", state: "open" });
    expect(parseNoteQuery("checklist:DONE")).toEqual({ type: "checklist", state: "done" });
  });

  it("parses bare and is: flags, and a quoted flag word as literal text", () => {
    expect(parseNoteQuery("pinned")).toEqual({ type: "flag", flag: "pinned" });
    expect(parseNoteQuery("LOCKED")).toEqual({ type: "flag", flag: "locked" });
    expect(parseNoteQuery("is:shared")).toEqual({ type: "flag", flag: "shared" });
    expect(parseNoteQuery('"pinned"')).toEqual(text("pinned"));
  });

  it("parses words: with every comparison operator", () => {
    expect(parseNoteQuery("words:>250")).toEqual({ type: "words", op: ">", value: 250 });
    expect(parseNoteQuery("words:>=250")).toEqual({ type: "words", op: ">=", value: 250 });
    expect(parseNoteQuery("words:<10")).toEqual({ type: "words", op: "<", value: 10 });
    expect(parseNoteQuery("words:<=10")).toEqual({ type: "words", op: "<=", value: 10 });
    expect(parseNoteQuery("words:=0")).toEqual({ type: "words", op: "=", value: 0 });
    expect(parseNoteQuery("words:42")).toEqual({ type: "words", op: "=", value: 42 });
  });

  it("parses created:/modified: dates as local-midnight bounds", () => {
    const node = parseNoteQuery("created:>=2026-07-01");
    expect(node).toEqual({
      type: "date",
      field: "created",
      op: ">=",
      date: "2026-07-01",
      start: new Date(2026, 6, 1).getTime(),
      end: new Date(2026, 6, 2).getTime(),
    });
    expect(parseNoteQuery("modified:<2026-09-01")).toMatchObject({
      field: "modified",
      op: "<",
      start: new Date(2026, 8, 1).getTime(),
    });
  });

  it("treats URLs and clock times as plain words", () => {
    expect(parseNoteQuery("https://example.com/x")).toEqual(text("https://example.com/x"));
    expect(parseNoteQuery("10:30")).toEqual(text("10:30"));
  });

  it("keeps a hyphen inside a word", () => {
    expect(parseNoteQuery("e-mail")).toEqual(text("e-mail"));
  });
});

describe("parseNoteQuery — operators", () => {
  it("joins adjacent terms with an implicit AND", () => {
    expect(parseNoteQuery("a b")).toEqual({ type: "and", children: [text("a"), text("b")] });
  });

  it("gives AND higher precedence than OR", () => {
    expect(parseNoteQuery("a OR b c")).toEqual({
      type: "or",
      children: [text("a"), { type: "and", children: [text("b"), text("c")] }],
    });
    expect(parseNoteQuery("a b OR c")).toEqual({
      type: "or",
      children: [{ type: "and", children: [text("a"), text("b")] }, text("c")],
    });
  });

  it("treats operators case-insensitively", () => {
    expect(parseNoteQuery("a or b")).toEqual({ type: "or", children: [text("a"), text("b")] });
    expect(parseNoteQuery("a And b")).toEqual({ type: "and", children: [text("a"), text("b")] });
    expect(parseNoteQuery("not a")).toEqual({ type: "not", child: text("a") });
  });

  it("searches a quoted operator word literally", () => {
    expect(parseNoteQuery('"and"')).toEqual(text("and"));
    expect(parseNoteQuery('a "OR" b')).toEqual({
      type: "and",
      children: [text("a"), text("OR"), text("b")],
    });
  });

  it("parses NOT and a leading minus as negation", () => {
    expect(parseNoteQuery("-a")).toEqual({ type: "not", child: text("a") });
    expect(parseNoteQuery("a -b")).toEqual({
      type: "and",
      children: [text("a"), { type: "not", child: text("b") }],
    });
    expect(parseNoteQuery("a NOT b")).toEqual({
      type: "and",
      children: [text("a"), { type: "not", child: text("b") }],
    });
    expect(parseNoteQuery('-"x y"')).toEqual({ type: "not", child: text("x y") });
    expect(parseNoteQuery("-has:link")).toEqual({
      type: "not",
      child: { type: "has", facet: "link" },
    });
    expect(parseNoteQuery("NOT NOT a")).toEqual({
      type: "not",
      child: { type: "not", child: text("a") },
    });
  });

  it("groups with parentheses", () => {
    expect(parseNoteQuery("(a OR b) c")).toEqual({
      type: "and",
      children: [{ type: "or", children: [text("a"), text("b")] }, text("c")],
    });
    expect(parseNoteQuery("-(a b)")).toEqual({
      type: "not",
      child: { type: "and", children: [text("a"), text("b")] },
    });
    expect(parseNoteQuery("((a))")).toEqual(text("a"));
  });

  it("treats a lone hyphen as a literal word", () => {
    expect(parseNoteQuery("a - b")).toEqual({
      type: "and",
      children: [text("a"), text("-"), text("b")],
    });
  });

  it("parses the documented examples", () => {
    expect(() =>
      parseNoteQuery('folder:"Work Projects" has:checklist -checklist:done')
    ).not.toThrow();
    expect(() =>
      parseNoteQuery("(title:invoice OR tag:finance) modified:>=2026-07-01")
    ).not.toThrow();
    expect(() => parseNoteQuery("pinned words:>250")).not.toThrow();
  });
});

describe("parseNoteQuery — errors", () => {
  const cases: Array<[string, RegExp]> = [
    ["", /empty/i],
    ["   ", /empty/i],
    ['"unterminated', /Unterminated/],
    ['""', /Empty quoted phrase/],
    ["title:", /needs a value/],
    ['folder:""', /needs a value/],
    ["tag:#", /needs a tag name/],
    ["has:bananas", /Unknown facet/],
    ["is:archived", /Unknown flag/],
    ["checklist:maybe", /open or done/],
    ["words:many", /whole number/],
    ["words:>-5", /whole number/],
    ["created:yesterday", /YYYY-MM-DD/],
    ["created:2026-02-30", /not a valid calendar date/],
    ["modified:>2026-13-01", /not a valid calendar date/],
    ["titel:x", /Unknown field "titel:"/],
    ["AND a", /AND needs a search term before it/],
    ["a OR", /OR needs a search term after it/],
    ["a AND", /AND needs a search term after it/],
    ["a OR OR b", /OR needs a search term after it/],
    ["a AND OR b", /AND needs a search term after it/],
    ["NOT", /NOT needs a search term after it/],
    ["a NOT", /NOT needs a search term after it/],
    ["(", /\( needs a search term after it/],
    ["(a", /Missing closing parenthesis/],
    ["a)", /Unmatched closing parenthesis/],
    ["()", /Empty parentheses/],
    [")", /Unexpected closing parenthesis/],
  ];

  for (const [input, message] of cases) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      expect(() => parseNoteQuery(input)).toThrow(NoteQueryError);
      expect(() => parseNoteQuery(input)).toThrow(message);
    });
  }

  it("reports a 1-based position", () => {
    try {
      parseNoteQuery("a b titel:x");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NoteQueryError);
      expect((error as NoteQueryError).position).toBe(4);
      expect((error as Error).message).toMatch(/at position 5/);
    }
  });

  it("caps the token count", () => {
    const atCap = Array.from({ length: QUERY_LIMITS.MAX_TOKENS }, (_, i) => `w${i}`).join(" ");
    expect(() => parseNoteQuery(atCap)).not.toThrow();
    expect(() => parseNoteQuery(`${atCap} one-more`)).toThrow(/more than 256 tokens/);
    expect(() => tokenize("( ".repeat(300))).toThrow(/more than 256 tokens/);
  });

  it("caps the nesting depth for parentheses and NOT chains", () => {
    const nested = (depth: number) => `${"(".repeat(depth)}a${")".repeat(depth)}`;
    expect(() => parseNoteQuery(nested(QUERY_LIMITS.MAX_DEPTH))).not.toThrow();
    expect(() => parseNoteQuery(nested(QUERY_LIMITS.MAX_DEPTH + 1))).toThrow(/deeper than 64/);
    const nots = (depth: number) => `${"NOT ".repeat(depth)}a`;
    expect(() => parseNoteQuery(nots(QUERY_LIMITS.MAX_DEPTH))).not.toThrow();
    expect(() => parseNoteQuery(nots(QUERY_LIMITS.MAX_DEPTH + 1))).toThrow(/deeper than 64/);
    expect(() => parseNoteQuery(`${"-(".repeat(40)}a${")".repeat(40)}`)).toThrow(/deeper than 64/);
  });
});

// =============================================================================
// Evaluation
// =============================================================================

interface Fixture {
  title?: string;
  body?: string;
  folder?: string[];
  account?: string;
  pinned?: boolean;
  locked?: boolean;
  shared?: boolean;
  created?: Date;
  modified?: Date;
  facets?: Facet[];
  checklist?: { total: number; open: number };
  tags?: string[];
}

function makeNote(f: Fixture): QueryableNote & { contentCalls: number } {
  const title = f.title ?? "Untitled";
  const full = `${title}\n${f.body ?? ""}`;
  const note = {
    contentCalls: 0,
    titleLower: normalizeForMatch(title),
    folderKeys: (f.folder ?? []).map(normalizeForMatch),
    accountLower: f.account ? normalizeForMatch(f.account) : undefined,
    pinned: f.pinned ?? false,
    locked: f.locked ?? false,
    shared: f.shared ?? false,
    created: f.created?.getTime(),
    modified: f.modified?.getTime(),
    content(): NoteContent | null {
      note.contentCalls++;
      if (f.locked) return null;
      return {
        textLower: normalizeForMatch(full),
        bodyLower: normalizeForMatch(f.body ?? ""),
        words: full.split(/\s+/).filter(Boolean).length,
        facets: new Set(f.facets ?? []),
        checklist: f.checklist ?? { total: 0, open: 0 },
        tags: (f.tags ?? []).map(normalizeForMatch),
      };
    },
  };
  return note;
}

const matches = (query: string, fixture: Fixture) =>
  evaluateNoteQuery(parseNoteQuery(query), makeNote(fixture));

describe("evaluateNoteQuery", () => {
  it("matches bare words against title or body, case-insensitively", () => {
    expect(matches("BUDGET", { title: "Budget 2026" })).toBe(true);
    expect(matches("budget", { title: "Plan", body: "the Budget review" })).toBe(true);
    expect(matches("budget", { title: "Plan", body: "nothing" })).toBe(false);
  });

  it("restricts title: and body: to their part of the note", () => {
    const note = { title: "Invoice", body: "agenda" };
    expect(matches("title:invoice", note)).toBe(true);
    expect(matches("title:agenda", note)).toBe(false);
    expect(matches("body:agenda", note)).toBe(true);
    expect(matches("body:invoice", note)).toBe(false);
  });

  it("matches a phrase as a contiguous substring", () => {
    expect(matches('"review the budget"', { body: "please review the budget" })).toBe(true);
    expect(matches('"review budget"', { body: "please review the budget" })).toBe(false);
  });

  it("normalizes composed and decomposed accents alike", () => {
    expect(matches("café", { body: "café au lait" })).toBe(true);
  });

  it("matches folder by name or full path, case-insensitively", () => {
    const note = { folder: ["Clients", "Work/Clients", "Work/Clients"] };
    expect(matches("folder:clients", note)).toBe(true);
    expect(matches('folder:"work/clients"', note)).toBe(true);
    expect(matches("folder:work", note)).toBe(false);
  });

  it("matches account exactly, case-insensitively", () => {
    expect(matches("account:icloud", { account: "iCloud" })).toBe(true);
    expect(matches("account:ic", { account: "iCloud" })).toBe(false);
    expect(matches("account:icloud", {})).toBe(false);
  });

  it("matches tags and facets from content", () => {
    const note = { facets: ["link", "table"] as Facet[], tags: ["Finance"] };
    expect(matches("tag:finance", note)).toBe(true);
    expect(matches("tag:#FINANCE", note)).toBe(true);
    expect(matches("tag:fin", note)).toBe(false);
    expect(matches("has:link has:table", note)).toBe(true);
    expect(matches("has:image", note)).toBe(false);
  });

  it("distinguishes checklist:open from checklist:done", () => {
    expect(matches("checklist:open", { checklist: { total: 3, open: 1 } })).toBe(true);
    expect(matches("checklist:done", { checklist: { total: 3, open: 1 } })).toBe(false);
    expect(matches("checklist:done", { checklist: { total: 3, open: 0 } })).toBe(true);
    expect(matches("checklist:open", { checklist: { total: 3, open: 0 } })).toBe(false);
    expect(matches("checklist:done", {})).toBe(false);
    expect(matches("checklist:open", {})).toBe(false);
  });

  it("evaluates flags", () => {
    expect(matches("pinned", { pinned: true })).toBe(true);
    expect(matches("pinned", {})).toBe(false);
    expect(matches("is:shared", { shared: true })).toBe(true);
    expect(matches("-locked", { locked: true })).toBe(false);
  });

  it("compares word counts", () => {
    const note = { title: "One", body: "two three four" }; // 4 words
    expect(matches("words:4", note)).toBe(true);
    expect(matches("words:>3", note)).toBe(true);
    expect(matches("words:>4", note)).toBe(false);
    expect(matches("words:>=4", note)).toBe(true);
    expect(matches("words:<5", note)).toBe(true);
    expect(matches("words:<4", note)).toBe(false);
    expect(matches("words:<=4", note)).toBe(true);
  });

  it("compares dates at local-day granularity", () => {
    const note = { created: new Date(2026, 6, 1, 23, 59), modified: new Date(2026, 8, 1, 0, 0) };
    expect(matches("created:2026-07-01", note)).toBe(true);
    expect(matches("created:>=2026-07-01", note)).toBe(true);
    expect(matches("created:>2026-07-01", note)).toBe(false);
    expect(matches("created:<2026-07-01", note)).toBe(false);
    expect(matches("created:<=2026-07-01", note)).toBe(true);
    expect(matches("created:<2026-07-02", note)).toBe(true);
    expect(matches("modified:<2026-09-01", note)).toBe(false);
    expect(matches("modified:>=2026-09-01", note)).toBe(true);
    expect(matches("modified:>2026-08-31", note)).toBe(true);
    expect(matches("created:2026-07-01", {})).toBe(false);
  });

  it("combines AND, OR, NOT, and parentheses", () => {
    const note = { title: "Invoice", body: "paid", pinned: true };
    expect(matches("invoice paid", note)).toBe(true);
    expect(matches("invoice unpaid", note)).toBe(false);
    expect(matches("unpaid OR paid", note)).toBe(true);
    expect(matches("invoice -paid", note)).toBe(false);
    expect(matches("(receipt OR invoice) pinned", note)).toBe(true);
    expect(matches("-(receipt OR invoice)", note)).toBe(false);
    expect(matches("NOT NOT invoice", note)).toBe(true);
  });

  it("treats a quoted operator as a literal word", () => {
    expect(matches('"and"', { body: "salt and pepper" })).toBe(true);
    expect(matches('"and"', { body: "salt, pepper" })).toBe(false);
  });

  describe("locked notes", () => {
    const locked = { title: "Bank budget", locked: true, pinned: true, folder: ["Finance"] };

    it("still match on title and metadata", () => {
      expect(matches("budget", locked)).toBe(true);
      expect(matches("title:bank", locked)).toBe(true);
      expect(matches("pinned folder:finance locked", locked)).toBe(true);
    });

    it("never match a body predicate, so its negation matches", () => {
      expect(matches("body:budget", locked)).toBe(false);
      expect(matches("has:link", locked)).toBe(false);
      expect(matches("checklist:open", locked)).toBe(false);
      expect(matches("words:>=0", locked)).toBe(false);
      expect(matches("tag:x", locked)).toBe(false);
      expect(matches("-body:budget", locked)).toBe(true);
    });
  });

  it("tries metadata predicates before decoding the body", () => {
    const note = makeNote({ title: "x", body: "hello", pinned: false });
    expect(evaluateNoteQuery(parseNoteQuery("body:hello pinned"), note)).toBe(false);
    expect(note.contentCalls).toBe(0);
    const shortCircuitOr = makeNote({ title: "x", pinned: true });
    expect(evaluateNoteQuery(parseNoteQuery("has:link OR pinned"), shortCircuitOr)).toBe(true);
    expect(shortCircuitOr.contentCalls).toBe(0);
  });

  it("does not decode the body for a title match on a bare word", () => {
    const note = makeNote({ title: "Budget", body: "irrelevant" });
    expect(evaluateNoteQuery(parseNoteQuery("budget"), note)).toBe(true);
    expect(note.contentCalls).toBe(0);
  });
});

describe("query analysis helpers", () => {
  it("needsContent is false for metadata-only queries", () => {
    expect(needsContent(parseNoteQuery("pinned folder:x account:y modified:>2026-01-01"))).toBe(
      false
    );
    expect(needsContent(parseNoteQuery("title:x -locked"))).toBe(false);
    expect(needsContent(parseNoteQuery("x"))).toBe(true);
    expect(needsContent(parseNoteQuery("pinned OR has:link"))).toBe(true);
    expect(needsContent(parseNoteQuery("-words:>3"))).toBe(true);
  });

  it("needsTags only for tag: and has:tag", () => {
    expect(needsTags(parseNoteQuery("x has:link"))).toBe(false);
    expect(needsTags(parseNoteQuery("x OR -tag:y"))).toBe(true);
    expect(needsTags(parseNoteQuery("has:tag"))).toBe(true);
  });

  it("positiveTextTerms skips negated terms", () => {
    expect(positiveTextTerms(parseNoteQuery("a -b title:c body:d (e OR NOT f) -(-g)"))).toEqual([
      "a",
      "c",
      "d",
      "e",
      "g",
    ]);
  });

  it("positiveTextPredicates keeps each term's field", () => {
    expect(positiveTextPredicates(parseNoteQuery("a -b title:c body:d pinned -(-g)"))).toEqual([
      { field: "any", value: "a" },
      { field: "title", value: "c" },
      { field: "body", value: "d" },
      { field: "any", value: "g" },
    ]);
  });
});

describe("matchLocations", () => {
  const where = (query: string, title: string, noteText: string | null) =>
    matchLocations(positiveTextPredicates(parseNoteQuery(query)), title, noteText);

  it("reports title, body, or both for a bare word, case- and accent-form-insensitively", () => {
    expect(where("budget", "Budget 2026", "Budget 2026\nrent and food")).toEqual(["title"]);
    expect(where("rent", "Budget 2026", "Budget 2026\nRENT and food")).toEqual(["body"]);
    expect(where("budget", "Budget", "Budget\nthe budget line")).toEqual(["title", "body"]);
    // NFD input matches NFC text.
    expect(where("café", "Menu", "Menu\ncafé list")).toEqual(["body"]);
  });

  it("looks for a field term only where its field points", () => {
    expect(where("title:plan", "Plan", "Plan\nplan b")).toEqual(["title"]);
    expect(where("body:plan", "Plan", "Plan\nplan b")).toEqual(["body"]);
    expect(where("body:plan", "Plan", "Plan\nnothing")).toEqual([]);
  });

  it("treats the first text line as the title when the stored title differs", () => {
    expect(where("draft", "", "Draft ideas\nmore")).toEqual(["title"]);
  });

  it("combines several terms across locations", () => {
    expect(where("alpha beta", "Alpha", "Alpha\nbeta")).toEqual(["title", "body"]);
    expect(where("alpha OR zzz", "Alpha", "Alpha\n")).toEqual(["title"]);
  });

  it("returns an empty list when a note matched only through a metadata branch", () => {
    expect(where("pinned OR zzz", "Groceries", "Groceries\nmilk")).toEqual([]);
  });

  it("is undefined without a positive text term", () => {
    expect(where("pinned", "A", "A\nb")).toBeUndefined();
    expect(where("-secret", "A", "A\nb")).toBeUndefined();
  });

  it("is undefined when a body-capable term needs text that is unavailable", () => {
    expect(where("budget", "Budget", null)).toBeUndefined();
    expect(where("title:budget body:x", "Budget", null)).toBeUndefined();
    // A title-only query does not need the body.
    expect(where("title:budget", "Budget", null)).toEqual(["title"]);
    expect(where("title:zzz OR pinned", "Budget", null)).toEqual([]);
  });

  it("handles a one-line note, which has no body", () => {
    expect(where("solo", "Solo", "Solo")).toEqual(["title"]);
    expect(where("body:solo", "Solo", "Solo")).toEqual([]);
  });
});
