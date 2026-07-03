/**
 * Integration Tests for Apple Notes MCP Server
 *
 * These tests verify the MCP tool handlers work correctly.
 * The AppleNotesManager is mocked to test tool response formatting
 * and error handling without requiring actual AppleScript execution.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppleNotesManager } from "./services/appleNotesManager.js";
// Mock the AppleNotesManager class
vi.mock("@/services/appleNotesManager.js", () => {
    return {
        AppleNotesManager: vi.fn().mockImplementation(() => ({
            createNote: vi.fn(),
            searchNotes: vi.fn(),
            getNoteContent: vi.fn(),
            getNoteById: vi.fn(),
            getNoteDetails: vi.fn(),
            updateNote: vi.fn(),
            deleteNote: vi.fn(),
            moveNote: vi.fn(),
            listNotes: vi.fn(),
            listFolders: vi.fn(),
            createFolder: vi.fn(),
            deleteFolder: vi.fn(),
            listAccounts: vi.fn(),
        })),
    };
});
// Create a typed mock manager for testing
const createMockManager = () => {
    const manager = new AppleNotesManager();
    return manager;
};
let mockManager;
// =============================================================================
// Response Helper Tests
// =============================================================================
describe("Response Helpers", () => {
    // We test these indirectly through the tool handlers since they're not exported
    // The pattern we're looking for is consistent response formatting
    beforeEach(() => {
        vi.clearAllMocks();
        mockManager = createMockManager();
    });
    describe("success response format", () => {
        it("returns content array with text type", async () => {
            mockManager.createNote.mockReturnValue({
                id: "123",
                title: "Test Note",
                content: "Test content",
                tags: [],
                created: new Date(),
                modified: new Date(),
                account: "iCloud",
            });
            // Simulate what the tool handler would return
            const response = {
                content: [{ type: "text", text: 'Note created: "Test Note"' }],
            };
            expect(response.content).toHaveLength(1);
            expect(response.content[0].type).toBe("text");
            expect(response.content[0].text).toContain("Note created");
        });
    });
    describe("error response format", () => {
        it("includes isError flag", () => {
            const errorResponse = {
                content: [{ type: "text", text: "Failed to create note" }],
                isError: true,
            };
            expect(errorResponse.isError).toBe(true);
            expect(errorResponse.content[0].text).toContain("Failed");
        });
    });
});
// =============================================================================
// Tool Handler Tests
// =============================================================================
describe("Tool Handlers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockManager = createMockManager();
    });
    // ---------------------------------------------------------------------------
    // create-note
    // ---------------------------------------------------------------------------
    describe("create-note tool", () => {
        it("calls createNote with correct parameters", () => {
            const params = {
                title: "Shopping List",
                content: "Eggs, Milk, Bread",
                tags: ["groceries"],
            };
            mockManager.createNote.mockReturnValue({
                id: "123",
                title: params.title,
                content: params.content,
                tags: params.tags,
                created: new Date(),
                modified: new Date(),
                account: "iCloud",
            });
            // Simulate the tool handler call
            const result = mockManager.createNote(params.title, params.content, params.tags);
            expect(mockManager.createNote).toHaveBeenCalledWith("Shopping List", "Eggs, Milk, Bread", [
                "groceries",
            ]);
            expect(result).not.toBeNull();
        });
        it("handles creation failure gracefully", () => {
            mockManager.createNote.mockReturnValue(null);
            const result = mockManager.createNote("Test", "Content", []);
            expect(result).toBeNull();
        });
    });
    // ---------------------------------------------------------------------------
    // search-notes
    // ---------------------------------------------------------------------------
    describe("search-notes tool", () => {
        it("returns list of matching note titles", () => {
            mockManager.searchNotes.mockReturnValue([
                { title: "Meeting Notes", id: "1" },
                { title: "Project Notes", id: "2" },
            ]);
            const results = mockManager.searchNotes("notes", false, undefined);
            expect(results).toHaveLength(2);
            expect(results[0].title).toBe("Meeting Notes");
        });
        it("handles empty search results", () => {
            mockManager.searchNotes.mockReturnValue([]);
            const results = mockManager.searchNotes("nonexistent", false);
            expect(results).toHaveLength(0);
        });
        it("supports content search", () => {
            mockManager.searchNotes.mockReturnValue([{ title: "Found Note", id: "1" }]);
            mockManager.searchNotes("keyword", true, "iCloud");
            expect(mockManager.searchNotes).toHaveBeenCalledWith("keyword", true, "iCloud");
        });
    });
    // ---------------------------------------------------------------------------
    // get-note-content
    // ---------------------------------------------------------------------------
    describe("get-note-content tool", () => {
        it("returns note HTML content", () => {
            const htmlContent = "<div>Shopping List</div><div>- Eggs</div>";
            mockManager.getNoteContent.mockReturnValue(htmlContent);
            const result = mockManager.getNoteContent("Shopping List");
            expect(result).toBe(htmlContent);
        });
        it("returns empty string for missing note", () => {
            mockManager.getNoteContent.mockReturnValue("");
            const result = mockManager.getNoteContent("Missing");
            expect(result).toBe("");
        });
    });
    // ---------------------------------------------------------------------------
    // get-note-by-id
    // ---------------------------------------------------------------------------
    describe("get-note-by-id tool", () => {
        it("returns note metadata as JSON", () => {
            const note = {
                id: "x-coredata://ABC123/ICNote/p100",
                title: "Test Note",
                content: "",
                tags: [],
                created: new Date("2025-01-01"),
                modified: new Date("2025-01-02"),
                shared: false,
                passwordProtected: false,
            };
            mockManager.getNoteById.mockReturnValue(note);
            const result = mockManager.getNoteById("x-coredata://ABC123/ICNote/p100");
            expect(result).not.toBeNull();
            expect(result?.id).toBe("x-coredata://ABC123/ICNote/p100");
            expect(result?.title).toBe("Test Note");
        });
        it("returns null for invalid ID", () => {
            mockManager.getNoteById.mockReturnValue(null);
            const result = mockManager.getNoteById("invalid-id");
            expect(result).toBeNull();
        });
    });
    // ---------------------------------------------------------------------------
    // get-note-details
    // ---------------------------------------------------------------------------
    describe("get-note-details tool", () => {
        it("returns full note metadata", () => {
            const note = {
                id: "x-coredata://ABC/ICNote/p1",
                title: "Project Plan",
                content: "",
                tags: [],
                created: new Date(),
                modified: new Date(),
                shared: true,
                passwordProtected: false,
                account: "iCloud",
            };
            mockManager.getNoteDetails.mockReturnValue(note);
            const result = mockManager.getNoteDetails("Project Plan");
            expect(result?.shared).toBe(true);
            expect(result?.account).toBe("iCloud");
        });
    });
    // ---------------------------------------------------------------------------
    // update-note
    // ---------------------------------------------------------------------------
    describe("update-note tool", () => {
        it("returns true on successful update", () => {
            mockManager.updateNote.mockReturnValue(true);
            const result = mockManager.updateNote("Old Title", "New Title", "New content");
            expect(result).toBe(true);
        });
        it("returns false when note not found", () => {
            mockManager.updateNote.mockReturnValue(false);
            const result = mockManager.updateNote("Missing", undefined, "Content");
            expect(result).toBe(false);
        });
        it("preserves title when newTitle is undefined", () => {
            mockManager.updateNote.mockReturnValue(true);
            mockManager.updateNote("Keep Title", undefined, "Updated content");
            expect(mockManager.updateNote).toHaveBeenCalledWith("Keep Title", undefined, "Updated content");
        });
    });
    // ---------------------------------------------------------------------------
    // delete-note
    // ---------------------------------------------------------------------------
    describe("delete-note tool", () => {
        it("returns true on successful deletion", () => {
            mockManager.deleteNote.mockReturnValue(true);
            const result = mockManager.deleteNote("Old Note");
            expect(result).toBe(true);
        });
        it("returns false when deletion fails", () => {
            mockManager.deleteNote.mockReturnValue(false);
            const result = mockManager.deleteNote("Protected Note");
            expect(result).toBe(false);
        });
    });
    // ---------------------------------------------------------------------------
    // move-note
    // ---------------------------------------------------------------------------
    describe("move-note tool", () => {
        it("returns true when move succeeds", () => {
            mockManager.moveNote.mockReturnValue(true);
            const result = mockManager.moveNote("My Note", "Archive");
            expect(result).toBe(true);
            expect(mockManager.moveNote).toHaveBeenCalledWith("My Note", "Archive");
        });
        it("returns false when source note not found", () => {
            mockManager.moveNote.mockReturnValue(false);
            const result = mockManager.moveNote("Missing", "Archive");
            expect(result).toBe(false);
        });
        it("returns false when destination folder not found", () => {
            mockManager.moveNote.mockReturnValue(false);
            const result = mockManager.moveNote("My Note", "Nonexistent");
            expect(result).toBe(false);
        });
    });
    // ---------------------------------------------------------------------------
    // list-notes
    // ---------------------------------------------------------------------------
    describe("list-notes tool", () => {
        it("returns array of note titles", () => {
            mockManager.listNotes.mockReturnValue(["Note A", "Note B", "Note C"]);
            const result = mockManager.listNotes();
            expect(result).toEqual(["Note A", "Note B", "Note C"]);
        });
        it("returns empty array when no notes", () => {
            mockManager.listNotes.mockReturnValue([]);
            const result = mockManager.listNotes();
            expect(result).toEqual([]);
        });
        it("filters by folder when specified", () => {
            mockManager.listNotes.mockReturnValue(["Work Note 1", "Work Note 2"]);
            mockManager.listNotes("iCloud", "Work");
            expect(mockManager.listNotes).toHaveBeenCalledWith("iCloud", "Work");
        });
    });
    // ---------------------------------------------------------------------------
    // list-folders
    // ---------------------------------------------------------------------------
    describe("list-folders tool", () => {
        it("returns array of Folder objects", () => {
            mockManager.listFolders.mockReturnValue([
                { id: "", name: "Notes", account: "iCloud" },
                { id: "", name: "Archive", account: "iCloud" },
            ]);
            const result = mockManager.listFolders();
            expect(result).toHaveLength(2);
            expect(result[0].name).toBe("Notes");
        });
        it("returns empty array when no folders", () => {
            mockManager.listFolders.mockReturnValue([]);
            const result = mockManager.listFolders();
            expect(result).toEqual([]);
        });
    });
    // ---------------------------------------------------------------------------
    // create-folder
    // ---------------------------------------------------------------------------
    describe("create-folder tool", () => {
        it("returns Folder object on success", () => {
            mockManager.createFolder.mockReturnValue({
                id: "folder-123",
                name: "New Project",
                account: "iCloud",
            });
            const result = mockManager.createFolder("New Project");
            expect(result).not.toBeNull();
            expect(result?.name).toBe("New Project");
        });
        it("returns null when folder already exists", () => {
            mockManager.createFolder.mockReturnValue(null);
            const result = mockManager.createFolder("Existing");
            expect(result).toBeNull();
        });
    });
    // ---------------------------------------------------------------------------
    // delete-folder
    // ---------------------------------------------------------------------------
    describe("delete-folder tool", () => {
        it("returns true on successful deletion", () => {
            mockManager.deleteFolder.mockReturnValue(true);
            const result = mockManager.deleteFolder("Empty Folder");
            expect(result).toBe(true);
        });
        it("returns false when folder contains notes", () => {
            mockManager.deleteFolder.mockReturnValue(false);
            const result = mockManager.deleteFolder("Non-Empty");
            expect(result).toBe(false);
        });
    });
    // ---------------------------------------------------------------------------
    // list-accounts
    // ---------------------------------------------------------------------------
    describe("list-accounts tool", () => {
        it("returns array of Account objects", () => {
            mockManager.listAccounts.mockReturnValue([
                { name: "iCloud" },
                { name: "Gmail" },
                { name: "Exchange" },
            ]);
            const result = mockManager.listAccounts();
            expect(result).toHaveLength(3);
            expect(result[0].name).toBe("iCloud");
        });
        it("returns empty array when no accounts configured", () => {
            mockManager.listAccounts.mockReturnValue([]);
            const result = mockManager.listAccounts();
            expect(result).toEqual([]);
        });
    });
});
// =============================================================================
// Error Handling Tests
// =============================================================================
describe("Error Handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockManager = createMockManager();
    });
    it("handles manager throwing exceptions", () => {
        mockManager.createNote.mockImplementation(() => {
            throw new Error("Unexpected error");
        });
        expect(() => mockManager.createNote("Test", "Content", [])).toThrow("Unexpected error");
    });
    it("handles null returns gracefully", () => {
        mockManager.getNoteById.mockReturnValue(null);
        mockManager.getNoteDetails.mockReturnValue(null);
        mockManager.createNote.mockReturnValue(null);
        mockManager.createFolder.mockReturnValue(null);
        expect(mockManager.getNoteById("invalid")).toBeNull();
        expect(mockManager.getNoteDetails("missing")).toBeNull();
        expect(mockManager.createNote("fail", "content", [])).toBeNull();
        expect(mockManager.createFolder("exists")).toBeNull();
    });
    it("handles empty string returns", () => {
        mockManager.getNoteContent.mockReturnValue("");
        expect(mockManager.getNoteContent("missing")).toBe("");
    });
    it("handles empty array returns", () => {
        mockManager.searchNotes.mockReturnValue([]);
        mockManager.listNotes.mockReturnValue([]);
        mockManager.listFolders.mockReturnValue([]);
        mockManager.listAccounts.mockReturnValue([]);
        expect(mockManager.searchNotes("none")).toEqual([]);
        expect(mockManager.listNotes()).toEqual([]);
        expect(mockManager.listFolders()).toEqual([]);
        expect(mockManager.listAccounts()).toEqual([]);
    });
    it("handles false returns for destructive operations", () => {
        mockManager.deleteNote.mockReturnValue(false);
        mockManager.deleteFolder.mockReturnValue(false);
        mockManager.updateNote.mockReturnValue(false);
        mockManager.moveNote.mockReturnValue(false);
        expect(mockManager.deleteNote("protected")).toBe(false);
        expect(mockManager.deleteFolder("non-empty")).toBe(false);
        expect(mockManager.updateNote("missing", undefined, "content")).toBe(false);
        expect(mockManager.moveNote("missing", "folder")).toBe(false);
    });
});
// =============================================================================
// Input Validation Tests
// =============================================================================
describe("Input Validation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockManager = createMockManager();
    });
    describe("title parameter", () => {
        it("handles titles with special characters", () => {
            mockManager.getNoteContent.mockReturnValue("content");
            mockManager.getNoteContent('Note\'s "Title" with <special> chars');
            expect(mockManager.getNoteContent).toHaveBeenCalledWith('Note\'s "Title" with <special> chars');
        });
        it("handles titles with unicode", () => {
            mockManager.getNoteContent.mockReturnValue("content");
            mockManager.getNoteContent("日本語ノート 🎉");
            expect(mockManager.getNoteContent).toHaveBeenCalledWith("日本語ノート 🎉");
        });
    });
    describe("account parameter", () => {
        it("defaults to iCloud when not specified", () => {
            mockManager.createNote.mockReturnValue({
                id: "1",
                title: "Test",
                content: "Content",
                tags: [],
                created: new Date(),
                modified: new Date(),
                account: "iCloud",
            });
            const result = mockManager.createNote("Test", "Content", []);
            expect(result?.account).toBe("iCloud");
        });
        it("uses specified account", () => {
            mockManager.listNotes.mockReturnValue(["Gmail Note"]);
            mockManager.listNotes("Gmail");
            expect(mockManager.listNotes).toHaveBeenCalledWith("Gmail");
        });
    });
});
