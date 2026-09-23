/**
 * Boolean query language for `query-notes`.
 *
 * A small hand-written pipeline with no I/O: a tokenizer turns the expression
 * into tokens, a recursive-descent parser builds an AST, and an evaluator tests
 * one note against that AST. The database reader lives in ./noteQueryStore.ts;
 * keeping this module pure lets the grammar be tested exhaustively without a
 * NoteStore.
 *
 * Grammar (operators are case-insensitive; AND is implicit between terms):
 *
 *   query   := or EOF
 *   or      := and ( "OR" and )*
 *   and     := unary ( ["AND"] unary )*
 *   unary   := ( "NOT" | "-" ) unary | primary
 *   primary := "(" or ")" | term
 *   term    := field ":" value | word | "quoted phrase"
 *
 * Quoting a word ("and", "pinned") always searches it literally.
 *
 * @module utils/noteQuery
 */

/** Hard bounds that keep a hostile or runaway expression cheap to reject. */
export const QUERY_LIMITS = {
  /** Maximum number of tokens (terms, operators, parentheses). */
  MAX_TOKENS: 256,
  /** Maximum nesting depth of parentheses and NOT operators combined. */
  MAX_DEPTH: 64,
} as const;

/** Content facets accepted by `has:`. */
export const FACETS = [
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
] as const;
export type Facet = (typeof FACETS)[number];

/** Metadata flags accepted bare (`pinned`) or as `is:pinned`. */
export const FLAGS = ["pinned", "locked", "shared"] as const;
export type Flag = (typeof FLAGS)[number];

export type CompareOp = "=" | ">" | ">=" | "<" | "<=";

/** Parsed query node. */
export type QueryNode =
  | { type: "and"; children: QueryNode[] }
  | { type: "or"; children: QueryNode[] }
  | { type: "not"; child: QueryNode }
  | { type: "text"; field: "any" | "title" | "body"; value: string }
  | { type: "folder"; value: string }
  | { type: "account"; value: string }
  | { type: "tag"; value: string }
  | { type: "has"; facet: Facet }
  | { type: "checklist"; state: "open" | "done" }
  | { type: "flag"; flag: Flag }
  | { type: "words"; op: CompareOp; value: number }
  | {
      type: "date";
      field: "created" | "modified";
      op: CompareOp;
      /** The ISO date as written (YYYY-MM-DD). */
      date: string;
      /** Local midnight at the start of `date`, in epoch milliseconds. */
      start: number;
      /** Local midnight at the start of the following day, in epoch milliseconds. */
      end: number;
    };

/** A query that could not be tokenized or parsed. `position` is a 0-based offset. */
export class NoteQueryError extends Error {
  constructor(
    message: string,
    public readonly position?: number
  ) {
    super(position === undefined ? message : `${message} (at position ${position + 1})`);
    this.name = "NoteQueryError";
  }
}

const FIELDS = new Set([
  "title",
  "body",
  "text",
  "folder",
  "account",
  "tag",
  "has",
  "is",
  "checklist",
  "words",
  "created",
  "modified",
]);

type Token =
  | { kind: "lparen" | "rparen" | "and" | "or" | "not"; pos: number }
  | { kind: "term"; pos: number; field?: string; value: string; quoted: boolean };

/** Reads a double-quoted string starting at `start` (which must be `"`). */
function readQuoted(input: string, start: number): [string, number] {
  let value = "";
  let i = start + 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && (input[i + 1] === '"' || input[i + 1] === "\\")) {
      value += input[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') return [value, i + 1];
    value += ch;
    i++;
  }
  throw new NoteQueryError("Unterminated quoted phrase", start);
}

const isSpace = (ch: string) => /\s/u.test(ch);

/** Splits an expression into tokens, enforcing the token cap as it goes. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const push = (token: Token) => {
    if (tokens.length >= QUERY_LIMITS.MAX_TOKENS) {
      throw new NoteQueryError(
        `Query has more than ${QUERY_LIMITS.MAX_TOKENS} tokens; simplify it`,
        token.pos
      );
    }
    tokens.push(token);
  };
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      push({ kind: ch === "(" ? "lparen" : "rparen", pos: i });
      i++;
      continue;
    }
    if (ch === '"') {
      const [value, next] = readQuoted(input, i);
      push({ kind: "term", pos: i, value, quoted: true });
      i = next;
      continue;
    }
    if (ch === "-" && i + 1 < input.length && !isSpace(input[i + 1]) && input[i + 1] !== ")") {
      push({ kind: "not", pos: i });
      i++;
      continue;
    }
    let j = i;
    while (j < input.length && !isSpace(input[j]) && !'()"'.includes(input[j])) j++;
    const word = input.slice(i, j);
    const colon = word.indexOf(":");
    if (colon > 0) {
      const prefix = word.slice(0, colon);
      const field = prefix.toLowerCase();
      let value = word.slice(colon + 1);
      if (FIELDS.has(field)) {
        let quoted = false;
        if (value === "" && input[j] === '"') {
          [value, j] = readQuoted(input, j);
          quoted = true;
        }
        push({ kind: "term", pos: i, field, value, quoted });
        i = j;
        continue;
      }
      // An identifier-shaped prefix that is not a field is almost always a typo
      // (`titel:x`). Refuse it rather than silently searching the literal text;
      // URLs (`https://…`) and times (`10:30`) fall through as plain words.
      if (/^[a-z]+$/i.test(prefix) && !value.startsWith("//")) {
        throw new NoteQueryError(
          `Unknown field "${prefix}:". Known fields: ${[...FIELDS].join(", ")}. ` +
            `Quote the term to search it literally`,
          i
        );
      }
    }
    const upper = word.toUpperCase();
    if (upper === "AND" || upper === "OR" || upper === "NOT") {
      push({ kind: upper.toLowerCase() as "and" | "or" | "not", pos: i });
    } else {
      push({ kind: "term", pos: i, value: word, quoted: false });
    }
    i = j;
  }
  return tokens;
}

const COMPARE_RE = /^(>=|<=|>|<|=)?(.*)$/s;

function splitComparison(value: string): [CompareOp, string] {
  const match = COMPARE_RE.exec(value)!;
  return [(match[1] as CompareOp | undefined) ?? "=", match[2]];
}

/** Parses `YYYY-MM-DD` as a real calendar date and returns local-midnight bounds. */
function parseLocalDate(text: string, pos: number): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new NoteQueryError(`Expected a date as YYYY-MM-DD, got "${text}"`, pos);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw new NoteQueryError(`"${text}" is not a valid calendar date`, pos);
  }
  return { start: start.getTime(), end: new Date(year, month - 1, day + 1).getTime() };
}

function termNode(token: Extract<Token, { kind: "term" }>): QueryNode {
  const { field, value, quoted, pos } = token;
  if (field === undefined) {
    if (value === "") throw new NoteQueryError("Empty quoted phrase", pos);
    const lower = value.toLowerCase();
    if (!quoted && (FLAGS as readonly string[]).includes(lower)) {
      return { type: "flag", flag: lower as Flag };
    }
    return { type: "text", field: "any", value };
  }
  if (value === "") throw new NoteQueryError(`"${field}:" needs a value`, pos);
  const lower = value.toLowerCase();
  switch (field) {
    case "title":
    case "body":
      return { type: "text", field, value };
    case "text":
      return { type: "text", field: "any", value };
    case "folder":
    case "account":
      return { type: field, value };
    case "tag": {
      const tag = value.replace(/^#/, "");
      if (!tag) throw new NoteQueryError(`"tag:" needs a tag name`, pos);
      return { type: "tag", value: tag };
    }
    case "has":
      if (!(FACETS as readonly string[]).includes(lower)) {
        throw new NoteQueryError(
          `Unknown facet "has:${value}". Supported: ${FACETS.map((f) => `has:${f}`).join(", ")}`,
          pos
        );
      }
      return { type: "has", facet: lower as Facet };
    case "is":
      if (!(FLAGS as readonly string[]).includes(lower)) {
        throw new NoteQueryError(`Unknown flag "is:${value}". Supported: ${FLAGS.join(", ")}`, pos);
      }
      return { type: "flag", flag: lower as Flag };
    case "checklist":
      if (lower !== "open" && lower !== "done") {
        throw new NoteQueryError(`"checklist:" accepts open or done, got "${value}"`, pos);
      }
      return { type: "checklist", state: lower };
    case "words": {
      const [op, number] = splitComparison(value);
      if (!/^\d{1,9}$/.test(number)) {
        throw new NoteQueryError(`"words:" needs a whole number, e.g. words:>250`, pos);
      }
      return { type: "words", op, value: Number(number) };
    }
    case "created":
    case "modified": {
      const [op, date] = splitComparison(value);
      return { type: "date", field, op, date, ...parseLocalDate(date, pos) };
    }
  }
  /* c8 ignore next */
  throw new NoteQueryError(`Unknown field "${field}:"`, pos);
}

class Parser {
  private index = 0;
  private depth = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly length: number
  ) {}

  parse(): QueryNode {
    if (this.tokens.length === 0) throw new NoteQueryError("Query is empty");
    const node = this.parseOr();
    const extra = this.peek();
    if (extra) {
      throw new NoteQueryError(
        extra.kind === "rparen" ? "Unmatched closing parenthesis" : "Unexpected token",
        extra.pos
      );
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private enter(pos: number) {
    this.depth++;
    if (this.depth > QUERY_LIMITS.MAX_DEPTH) {
      throw new NoteQueryError(
        `Query nests deeper than ${QUERY_LIMITS.MAX_DEPTH} levels; simplify it`,
        pos
      );
    }
  }

  private missingOperand(after: string): never {
    const next = this.peek();
    throw new NoteQueryError(`${after} needs a search term after it`, next?.pos ?? this.length);
  }

  private parseOr(): QueryNode {
    const children = [this.parseAnd()];
    while (this.peek()?.kind === "or") {
      this.index++;
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0] : { type: "or", children };
  }

  private parseAnd(): QueryNode {
    const children = [this.parseUnary()];
    for (;;) {
      const next = this.peek();
      if (next?.kind === "and") {
        this.index++;
        children.push(this.parseUnary());
      } else if (next && (next.kind === "term" || next.kind === "not" || next.kind === "lparen")) {
        children.push(this.parseUnary());
      } else {
        break;
      }
    }
    return children.length === 1 ? children[0] : { type: "and", children };
  }

  private parseUnary(): QueryNode {
    const token = this.peek();
    if (token?.kind === "not") {
      this.index++;
      this.enter(token.pos);
      const child = this.parseUnary();
      this.depth--;
      return { type: "not", child };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): QueryNode {
    const token = this.peek();
    if (!token) {
      const previous = this.tokens[this.index - 1];
      this.missingOperand(previous ? previous.kind.toUpperCase().replace("LPAREN", "(") : "Query");
    }
    if (token.kind === "lparen") {
      this.index++;
      this.enter(token.pos);
      if (this.peek()?.kind === "rparen") {
        throw new NoteQueryError("Empty parentheses", token.pos);
      }
      const node = this.parseOr();
      if (this.peek()?.kind !== "rparen") {
        throw new NoteQueryError("Missing closing parenthesis", token.pos);
      }
      this.index++;
      this.depth--;
      return node;
    }
    if (token.kind === "term") {
      this.index++;
      return termNode(token);
    }
    if (token.kind === "rparen") {
      throw new NoteQueryError("Unexpected closing parenthesis", token.pos);
    }
    // A binary operator where a term was expected: `AND x`, `x OR OR y`, `x OR`.
    const previous = this.tokens[this.index - 1];
    if (!previous || previous.kind === "lparen") {
      throw new NoteQueryError(
        `${token.kind.toUpperCase()} needs a search term before it`,
        token.pos
      );
    }
    this.missingOperand(previous.kind === "term" ? "Operator" : previous.kind.toUpperCase());
  }
}

/**
 * Parses a query expression into an AST.
 *
 * @throws NoteQueryError when the expression is empty, malformed, or exceeds
 *   {@link QUERY_LIMITS}
 */
export function parseNoteQuery(input: string): QueryNode {
  return new Parser(tokenize(input), input.length).parse();
}

// =============================================================================
// Evaluation
// =============================================================================

/** Decoded body-derived facts for one note. Absent for locked or unreadable notes. */
export interface NoteContent {
  /** Full note text (title line included), lower-cased and normalized for matching. */
  textLower: string;
  /** Text after the first line, lower-cased and normalized for matching. */
  bodyLower: string;
  /** Whitespace-delimited words that contain a letter or digit. */
  words: number;
  /** Content facets present in the note body. */
  facets: ReadonlySet<Facet>;
  /** Checklist items (deduplicated) and how many are still unchecked. */
  checklist: { total: number; open: number };
  /** Native tag names, lower-cased, without the leading `#`. */
  tags: readonly string[];
}

/** The metadata-level view of one note that the evaluator reads. */
export interface QueryableNote {
  titleLower: string;
  /** Lower-cased folder name and full-path spellings that `folder:` accepts. */
  folderKeys: readonly string[];
  accountLower?: string;
  pinned: boolean;
  locked: boolean;
  shared: boolean;
  created?: number;
  modified?: number;
  /** Lazily decoded content; returns null when the body cannot be read. */
  content(): NoteContent | null;
}

/** Normalizes text for case-insensitive substring matching. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\ufffc\u00a0]/gu, " ")
    .toLowerCase();
}

/** Whether evaluating this node requires the decoded note body. */
export function needsContent(node: QueryNode): boolean {
  switch (node.type) {
    case "and":
    case "or":
      return node.children.some(needsContent);
    case "not":
      return needsContent(node.child);
    case "text":
      return node.field !== "title";
    case "tag":
    case "has":
    case "checklist":
    case "words":
      return true;
    default:
      return false;
  }
}

/** Whether evaluating this node requires native tag rows from the database. */
export function needsTags(node: QueryNode): boolean {
  switch (node.type) {
    case "and":
    case "or":
      return node.children.some(needsTags);
    case "not":
      return needsTags(node.child);
    case "tag":
      return true;
    case "has":
      return node.facet === "tag";
    default:
      return false;
  }
}

function compare(actual: number, op: CompareOp, expected: number): boolean {
  switch (op) {
    case "=":
      return actual === expected;
    case ">":
      return actual > expected;
    case ">=":
      return actual >= expected;
    case "<":
      return actual < expected;
    case "<=":
      return actual <= expected;
  }
}

function compareDate(
  actual: number | undefined,
  node: Extract<QueryNode, { type: "date" }>
): boolean {
  if (actual === undefined) return false;
  switch (node.op) {
    case "=":
      return actual >= node.start && actual < node.end;
    case ">":
      return actual >= node.end;
    case ">=":
      return actual >= node.start;
    case "<":
      return actual < node.start;
    case "<=":
      return actual < node.end;
  }
}

// Cheap (metadata) children are tried before ones that decode the body, so
// `pinned AND body:x` never decompresses an unpinned note. Pure predicates make
// the reordering invisible to the result.
const orderCache = new WeakMap<QueryNode[], QueryNode[]>();
function cheapFirst(children: QueryNode[]): QueryNode[] {
  let ordered = orderCache.get(children);
  if (!ordered) {
    ordered = [...children].sort((a, b) => Number(needsContent(a)) - Number(needsContent(b)));
    orderCache.set(children, ordered);
  }
  return ordered;
}

/** Tests one note against a parsed query. */
export function evaluateNoteQuery(node: QueryNode, note: QueryableNote): boolean {
  switch (node.type) {
    case "and":
      return cheapFirst(node.children).every((child) => evaluateNoteQuery(child, note));
    case "or":
      return cheapFirst(node.children).some((child) => evaluateNoteQuery(child, note));
    case "not":
      return !evaluateNoteQuery(node.child, note);
    case "text": {
      const needle = normalizeForMatch(node.value);
      if (node.field === "title") return note.titleLower.includes(needle);
      if (node.field === "any" && note.titleLower.includes(needle)) return true;
      const content = note.content();
      if (!content) return false;
      return (node.field === "body" ? content.bodyLower : content.textLower).includes(needle);
    }
    case "folder":
      return note.folderKeys.includes(normalizeForMatch(node.value));
    case "account":
      return note.accountLower === normalizeForMatch(node.value);
    case "flag":
      return note[node.flag];
    case "date":
      return compareDate(node.field === "created" ? note.created : note.modified, node);
    case "tag": {
      const content = note.content();
      return Boolean(content?.tags.includes(normalizeForMatch(node.value)));
    }
    case "has":
      return Boolean(note.content()?.facets.has(node.facet));
    case "checklist": {
      const content = note.content();
      if (!content || content.checklist.total === 0) return false;
      return node.state === "open" ? content.checklist.open > 0 : content.checklist.open === 0;
    }
    case "words": {
      const content = note.content();
      return content ? compare(content.words, node.op, node.value) : false;
    }
  }
}

/** One positive text predicate: the phrase and the part of the note it targets. */
export interface TextPredicate {
  field: "any" | "title" | "body";
  value: string;
}

/**
 * Collects the text predicates that a matching note is expected to satisfy
 * (predicates under an odd number of NOTs are skipped).
 */
export function positiveTextPredicates(node: QueryNode, negated = false): TextPredicate[] {
  switch (node.type) {
    case "and":
    case "or":
      return node.children.flatMap((child) => positiveTextPredicates(child, negated));
    case "not":
      return positiveTextPredicates(node.child, !negated);
    case "text":
      return negated ? [] : [{ field: node.field, value: node.value }];
    default:
      return [];
  }
}

/**
 * Collects the text terms that a matching note is expected to contain (terms
 * under an odd number of NOTs are skipped), used to centre result snippets.
 */
export function positiveTextTerms(node: QueryNode, negated = false): string[] {
  return positiveTextPredicates(node, negated).map((predicate) => predicate.value);
}

/** A part of a note where a search phrase was found. */
export type MatchLocation = "title" | "body";

/**
 * Reports where a matched note contains its positive text predicates: in the
 * title, in the body (the text after the first line), or both.
 *
 * Each predicate is only looked for where its field points: `title:` only in
 * the title, `body:` only in the body, a bare word in both. The title is the
 * stored title or the first line of the text, since Notes derives one from the
 * other and a query matches either.
 *
 * Returns undefined when there is nothing to report or it cannot be known:
 * the query has no positive text predicate, or a predicate can match the body
 * and the body text is unavailable (a locked or undecodable note). It returns
 * an empty array when the text is known and no predicate occurs in it, which
 * happens when a note matched through a metadata branch such as `pinned OR x`.
 *
 * @param predicates - from {@link positiveTextPredicates}
 * @param title - the note's stored title
 * @param text - the note's full decoded text, title line included; null when unavailable
 */
export function matchLocations(
  predicates: TextPredicate[],
  title: string,
  text: string | null
): MatchLocation[] | undefined {
  if (predicates.length === 0) return undefined;
  if (text === null && predicates.some((p) => p.field !== "title")) return undefined;
  const firstBreak = text === null ? -1 : text.indexOf("\n");
  const titleLower = normalizeForMatch(title);
  const firstLineLower =
    text === null ? "" : normalizeForMatch(firstBreak === -1 ? text : text.slice(0, firstBreak));
  const bodyLower =
    text === null || firstBreak === -1 ? "" : normalizeForMatch(text.slice(firstBreak + 1));
  let inTitle = false;
  let inBody = false;
  for (const predicate of predicates) {
    const needle = normalizeForMatch(predicate.value);
    if (predicate.field !== "body" && !inTitle) {
      inTitle = titleLower.includes(needle) || firstLineLower.includes(needle);
    }
    if (predicate.field !== "title" && !inBody) inBody = bodyLower.includes(needle);
  }
  const locations: MatchLocation[] = [];
  if (inTitle) locations.push("title");
  if (inBody) locations.push("body");
  return locations;
}
