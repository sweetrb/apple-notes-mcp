/**
 * Tests for the content-warning detectors.
 */
import { describe, it, expect } from "vitest";
import { detectChecklistAttempt } from "./contentWarnings.js";
describe("detectChecklistAttempt", () => {
    it("returns null for plain text without checklist syntax", () => {
        expect(detectChecklistAttempt("Just a regular note.")).toBeNull();
    });
    it("returns null for empty content", () => {
        expect(detectChecklistAttempt("")).toBeNull();
    });
    it("returns null for HTML lists that are not checklists", () => {
        expect(detectChecklistAttempt("<ul><li>Apple</li><li>Banana</li></ul>")).toBeNull();
    });
    it('warns on <input type="checkbox"> (double-quoted)', () => {
        const w = detectChecklistAttempt('<input type="checkbox"> Buy milk');
        expect(w).not.toBeNull();
        expect(w).toContain("⚠️");
        expect(w).toContain("⇧⌘L");
    });
    it("warns on <input type='checkbox'> (single-quoted)", () => {
        expect(detectChecklistAttempt("<input type='checkbox'> Buy milk")).not.toBeNull();
    });
    it("warns on <input> with extra attributes before type", () => {
        expect(detectChecklistAttempt('<input id="x" type="checkbox"> Item')).not.toBeNull();
    });
    it('warns on <INPUT TYPE="CHECKBOX"> (case-insensitive)', () => {
        expect(detectChecklistAttempt('<INPUT TYPE="CHECKBOX"> Item')).not.toBeNull();
    });
    it("warns on markdown `- [ ]` syntax", () => {
        expect(detectChecklistAttempt("- [ ] todo 1\n- [x] done 1")).not.toBeNull();
    });
    it("warns on markdown `* [ ]` syntax", () => {
        expect(detectChecklistAttempt("* [ ] todo 1")).not.toBeNull();
    });
    it("warns on markdown checklist with leading whitespace", () => {
        expect(detectChecklistAttempt("  - [ ] indented todo")).not.toBeNull();
    });
    it('warns on <ul class="checklist">', () => {
        expect(detectChecklistAttempt('<ul class="checklist"><li>a</li></ul>')).not.toBeNull();
    });
    it('warns on <li class="todo">', () => {
        expect(detectChecklistAttempt('<ul><li class="todo">a</li></ul>')).not.toBeNull();
    });
    it("does not warn on the word 'checklist' in prose", () => {
        expect(detectChecklistAttempt("My checklist of things to do tomorrow.")).toBeNull();
    });
    it("does not warn on a literal `[ ]` not at start of a list line", () => {
        expect(detectChecklistAttempt("The brackets [ ] are not a checklist.")).toBeNull();
    });
});
