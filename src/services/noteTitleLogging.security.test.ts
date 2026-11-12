/**
 * Security regression: note titles and folder names must not reach stderr
 * (audit finding 3).
 *
 * MCP hosts persist a server's stderr (Claude Desktop writes it to
 * `~/Library/Logs/Claude/mcp-server-*.log`), so a title logged on a failure
 * path leaks private note data into a plain log file outside Notes. Each test
 * forces the failure path and asserts the log line carries no title or name.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

vi.mock("@/utils/applescript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/applescript.js")>();
  return { ...actual, executeAppleScript: vi.fn() };
});

vi.mock("@/utils/smartFolders.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/smartFolders.js")>()),
  readSmartFolders: vi.fn(() => ({ folders: [] })),
}));

import { executeAppleScript } from "@/utils/applescript.js";
import { AppleNotesManager } from "./appleNotesManager.js";

const mockExecuteAppleScript = vi.mocked(executeAppleScript);

const SECRET_TITLE = "Cancer diagnosis - John Doe - SSN 123-45-6789";
const SECRET_FOLDER = "Medical records/John Doe";
const NOTES_FAILURE = { success: false, error: "Notes got an error: Can't get note." };

let errorSpy: MockInstance<typeof console.error>;

beforeEach(() => {
  mockExecuteAppleScript.mockReset();
  mockExecuteAppleScript.mockReturnValue(NOTES_FAILURE);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

function stderrText(): string {
  return errorSpy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
}

function expectFailureLoggedWithout(secret: string): void {
  expect(errorSpy).toHaveBeenCalled();
  const logged = stderrText();
  expect(logged).not.toContain(secret);
  for (const part of secret.split("/")) expect(logged).not.toContain(part);
}

describe("finding 3: failure logs leak note titles and folder names", () => {
  it("createNote does not log the title", () => {
    expect(new AppleNotesManager().createNote(SECRET_TITLE, "body")).toBeNull();
    expectFailureLoggedWithout(SECRET_TITLE);
  });

  it("getNoteContent does not log the title", () => {
    expect(new AppleNotesManager().getNoteContent(SECRET_TITLE)).toBe("");
    expectFailureLoggedWithout(SECRET_TITLE);
  });

  it("getNotePlaintext does not log the title", () => {
    expect(new AppleNotesManager().getNotePlaintext(SECRET_TITLE)).toBe("");
    expectFailureLoggedWithout(SECRET_TITLE);
  });

  it("getNoteDetails does not log the title", () => {
    expect(new AppleNotesManager().getNoteDetails(SECRET_TITLE)).toBeNull();
    expectFailureLoggedWithout(SECRET_TITLE);
  });

  it("createFolder does not log the folder path", () => {
    expect(new AppleNotesManager().createFolder(SECRET_FOLDER)).toBeNull();
    expectFailureLoggedWithout(SECRET_FOLDER);
  });
});
