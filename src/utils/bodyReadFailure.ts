/**
 * Explains a failed `body of note` read (#237).
 *
 * Notes.app returns images inside the HTML body as base64 `data:` URIs, so a
 * note holding a very large image produces a body tens of megabytes long.
 * Producing it can outlast the automation timeout, or overflow the output
 * buffer, and the read then fails every time. A bare "Failed to read content"
 * leaves the caller with nothing to act on, and it also blocks tools that need
 * a fresh contentHash, such as delete-note. This module turns the failure into
 * a message that names the likely cause and the remedy.
 *
 * @module utils/bodyReadFailure
 */

/** Attachments at or above this size are named as a likely cause. */
export const LARGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** An attachment as the NoteStore database reports it. */
export interface SizedAttachment {
  filename?: string;
  title?: string;
  fileSize?: number;
  children?: SizedAttachment[];
}

export type BodyReadFailureKind = "timeout" | "buffer" | "other";

/** Classify the automation error from a failed body read. */
export function classifyBodyReadError(error: string | undefined): BodyReadFailureKind {
  if (!error) return "other";
  if (/ENOBUFS|maxBuffer/i.test(error)) return "buffer";
  if (/timed out|timeout|-1712/i.test(error)) return "timeout";
  return "other";
}

/** Human-readable byte size, e.g. "36.0 MB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/** Attachments (children included) at or above the threshold, largest first. */
export function largeAttachments(
  attachments: readonly SizedAttachment[],
  threshold = LARGE_ATTACHMENT_BYTES
): { name: string; bytes: number }[] {
  const flat = attachments.flatMap((a) => [a, ...(a.children ?? [])]);
  return flat
    .filter((a) => typeof a.fileSize === "number" && a.fileSize >= threshold)
    .map((a) => ({ name: a.filename || a.title || "attachment", bytes: a.fileSize! }))
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * Build the error text for a failed body read.
 *
 * @param title - The note's title
 * @param error - The automation error, when the runner reported one
 * @param attachments - The note's attachments from the database, or undefined
 *   when they could not be read (no Full Disk Access, or a database error)
 */
export function describeBodyReadFailure(
  title: string,
  error: string | undefined,
  attachments: readonly SizedAttachment[] | undefined
): string {
  const base = `Failed to read content of note "${title}"${error ? `: ${error}` : ""}`;
  const kind = classifyBodyReadError(error);
  if (kind === "other") return base;

  const large = attachments ? largeAttachments(attachments) : [];
  const cause =
    large.length > 0
      ? `The note holds ${large.length === 1 ? "a large attachment" : "large attachments"} (${large
          .map((a) => `${a.name}, ${formatBytes(a.bytes)}`)
          .join(
            "; "
          )}). Notes.app returns images inside the note body as base64, so a large image makes the body too big to read in time.`
      : "Notes.app returns images inside the note body as base64, so a note with a very large image can take longer to read than the timeout allows.";
  const remedy =
    kind === "buffer"
      ? "Raise APPLE_NOTES_MCP_MAX_BUFFER (bytes) and retry, or remove the attachment in Notes.app."
      : "Retry with a longer timeoutSeconds (up to 120) or raise APPLE_NOTES_MCP_TIMEOUT_MS. If it still fails, delete or shrink the attachment in Notes.app; delete-note needs a successful read to verify the note first.";
  return `${base}\n\n${cause} ${remedy}`;
}
