/**
 * Stable, machine-readable codes for tool error results (`isError: true`).
 *
 * Every error result keeps its human-readable text unchanged and gains
 * `structuredContent: { code, committed?, indeterminate? }`. Agents branch on
 * `code` instead of parsing prose, and on `indeterminate` before retrying a
 * write.
 *
 * Classification is centralized here and driven by the error text the server
 * already produces, so existing messages stay the contract and every tool
 * wrapper gets codes from one place. Double-quoted segments are removed before
 * matching because they hold caller data such as note titles. A thrown {@link CodedError} overrides the
 * text rules for a site that knows its outcome exactly.
 *
 * Output-schema safety: the MCP TypeScript client validates `structuredContent`
 * against the tool's advertised `outputSchema` even on error results. Every
 * outputSchema here is permissive (no required fields, undeclared keys
 * allowed), and none declares `code`, `committed`, or `indeterminate`, so the
 * envelope validates against all of them. `src/utils/errorCodes.test.ts`
 * checks this against the built server's advertised schemas.
 *
 * @module utils/errorCodes
 */
import { isPermissionDenied, stripQuoted } from "./applescript.js";
import { identifierFailureIn } from "./noteIdentifiers.js";

export { stripQuoted };

/** The documented error-code vocabulary. Keys are the codes; values describe them. */
export const ERROR_CODES = {
  not_found: "The note, folder, account, attachment, or checklist does not exist",
  ambiguous: "More than one item matched; use an exact id",
  permission_denied: "macOS refused Automation access to Notes.app",
  full_disk_access_missing: "The Notes database is not readable; grant Full Disk Access",
  shortcut_not_installed: "A native-write bridge Shortcut is not installed exactly once",
  timeout_indeterminate:
    "The operation timed out; for a write, the outcome is unknown, so read before retrying",
  verification_failed:
    "The write ran but exact-ID readback did not confirm it; read before retrying",
  revision_conflict: "The note changed since it was read; read it again before retrying",
  validation_error: "The request was rejected before anything ran; fix the arguments",
  unsupported:
    "The operation is not supported for this note or in this mode (for example a locked note)",
  notes_unavailable: "Notes.app is not running, busy, or not responding",
  operation_failed: "The operation failed for a reason the server did not classify",
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** The `structuredContent` attached to every error result. */
export interface ErrorEnvelope {
  [key: string]: unknown;
  code: ErrorCode;
  /** true: the write took effect. false: nothing was written. Absent: unknown. */
  committed?: boolean;
  /** true: the outcome is uncertain; read the target before any retry. */
  indeterminate?: boolean;
}

/** An Error that carries its own envelope, for sites that know the outcome exactly. */
export class CodedError extends Error {
  readonly envelope: ErrorEnvelope;
  constructor(message: string, envelope: ErrorEnvelope) {
    super(message);
    this.name = "CodedError";
    this.envelope = envelope;
  }
}

/** Ordered text rules: the first match wins. */
const RULES: Array<{ code: ErrorCode; pattern: RegExp }> = [
  { code: "timeout_indeterminate", pattern: /timed out|\bETIMEDOUT\b/i },
  {
    code: "verification_failed",
    pattern:
      /\buncertain\b|may have (?:been|succeeded)|\baccepted (?:the|an) \w+, but|\bnot verified\b|Do not retry automatically|before any retry|read (?:the )?(?:exact )?(?:note|ID)\b[^.]*before retr/i,
  },
  {
    code: "revision_conflict",
    pattern:
      /changed after it was read|revision changed|(?:pinned|note) state changed|changed during (?:read|preflight)|changed; read (?:it|the note) again|rich text do not match/i,
  },
  { code: "full_disk_access_missing", pattern: /Full Disk Access/i },
  {
    code: "shortcut_not_installed",
    pattern: /(?:Install|Import) the supplied|no such shortcut|Run apple-notes-mcp setup/i,
  },
  {
    code: "not_found",
    pattern:
      /not found|does not exist|\bNo \w+ found\b|does not contain any checklist items|Can[’']t get (?:note|folder|account|attachment)|Cannot find note|Scope is absent/i,
  },
  { code: "ambiguous", pattern: /ambiguous|more than one|exactly once|Duplicate note IDs/i },
  {
    code: "notes_unavailable",
    pattern: /Notes\.app is (?:not responding|busy)|Lost connection to Notes|isn't running/i,
  },
  {
    code: "unsupported",
    pattern:
      /password-protected|Locked notes|unsupported|not supported|is blocked|blocked because|has not passed live|refuses to sign|No (?:supported )?background|only one where|Real Notes link unavailable/i,
  },
  {
    code: "validation_error",
    pattern:
      /\bis required\b|required\b|\bInvalid\b|\bmust\b|\bProvide\b|No (?:note IDs|reviewed notes) provided|response limit|Refusing to write|cannot be resolved|at most \d|between \d+ and \d+|supports the (?:end|default)|Use a distinctive|Use create-table|too large|equal cell counts|Folder path is empty/i,
  },
];

/** Messages that state nothing was written. */
const NOTHING_WRITTEN =
  /nothing (?:was )?(?:changed|created|written)|no replacement started|No content was (?:replaced|appended)|Nothing was created/i;
/** Messages that state the write took effect even though readback failed. */
const WRITE_ACCEPTED = /\baccepted (?:the|an) \w+, but/i;

/** Classify an error message (and optional thrown cause) into an envelope. Pure. */
export function classifyError(message: string, cause?: unknown): ErrorEnvelope {
  if (cause instanceof CodedError) return { ...cause.envelope };
  const text = stripQuoted(
    cause instanceof Error && cause.message && !message.includes(cause.message)
      ? `${message}\n${cause.message}`
      : message
  );
  const timeoutCause =
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "ETIMEDOUT";

  let code: ErrorCode = "operation_failed";
  if (timeoutCause) code = "timeout_indeterminate";
  else if (isPermissionDenied(text)) code = "permission_denied";
  else code = RULES.find((rule) => rule.pattern.test(text))?.code ?? "operation_failed";

  const envelope: ErrorEnvelope = { code };
  if (code === "timeout_indeterminate" || code === "verification_failed") {
    envelope.indeterminate = true;
    if (WRITE_ACCEPTED.test(text)) envelope.committed = true;
  } else if (code === "revision_conflict" || NOTHING_WRITTEN.test(text)) {
    envelope.committed = false;
    envelope.indeterminate = false;
  }
  return envelope;
}

/** The MCP result shape every tool wrapper returns on failure. */
export interface ErrorResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: ErrorEnvelope;
  isError: true;
}

/**
 * Build an error result: the text is `message`, unchanged, and
 * `structuredContent` carries the classified envelope.
 */
export function errorResult(message: string, cause?: unknown): ErrorResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: classifyError(message, cause),
    isError: true,
  };
}

/**
 * The envelope for a write tool's error. When Notes.app stopped answering
 * (`notes_unavailable`) the write may already have landed, so the outcome is
 * indeterminate unless the error already says what happened.
 */
export function unavailableWriteEnvelope(envelope: ErrorEnvelope): ErrorEnvelope {
  if (
    envelope.code !== "notes_unavailable" ||
    envelope.indeterminate !== undefined ||
    envelope.committed !== undefined
  )
    return envelope;
  return { ...envelope, indeterminate: true };
}

/**
 * How the MCP SDK words a call its input schema rejected. The McpError it
 * throws adds its own "MCP error -32602: " prefix.
 */
const INPUT_VALIDATION = /^(?:MCP error -?\d+: )?Input validation error:/;

/**
 * The envelope for a call the input schema rejected. The handler never ran,
 * so nothing was written. Note, folder and account ids given as a Notes UUID
 * or numeric key are resolved inside the schema, so a failed resolution
 * arrives here too and keeps its own code.
 */
export function inputValidationEnvelope(message: string): ErrorEnvelope {
  const failure = identifierFailureIn(message);
  const code: ErrorCode =
    failure === "no_fda"
      ? "full_disk_access_missing"
      : failure === "not_found"
        ? "not_found"
        : failure === "query_error"
          ? "operation_failed"
          : "validation_error";
  return { code, committed: false, indeterminate: false };
}

/**
 * The error result for a failure the MCP SDK reports itself: an input-schema
 * rejection, or an exception a handler did not catch.
 */
export function sdkToolError(message: string): ErrorResult {
  return INPUT_VALIDATION.test(message)
    ? errorResult(message, new CodedError(message, inputValidationEnvelope(message)))
    : errorResult(message);
}

/**
 * Give the MCP SDK's own error results a code. McpServer builds them in its
 * `createToolError` method, which it does not expose, so this replaces that
 * method on one server instance. `errorCodes.test.ts` calls the built server
 * with rejected input and fails if an SDK update stops routing through it.
 */
export function installSdkErrorCodes(server: object): void {
  const target = server as { createToolError?: (message: string) => unknown };
  if (typeof target.createToolError === "function") target.createToolError = sdkToolError;
}
