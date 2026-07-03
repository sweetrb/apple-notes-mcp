import { describe, it, expect } from "vitest";
import { parseHashtags } from "../utils/hashtags.js";
describe("parseHashtags", () => {
    it("returns [] for empty / nullish input", () => {
        expect(parseHashtags("")).toEqual([]);
        expect(parseHashtags(null)).toEqual([]);
        expect(parseHashtags(undefined)).toEqual([]);
        expect(parseHashtags("no tags here")).toEqual([]);
    });
    it("extracts a single tag", () => {
        expect(parseHashtags("Buy milk #groceries")).toEqual(["groceries"]);
    });
    it("extracts multiple tags in document order", () => {
        expect(parseHashtags("#work then #home then #travel")).toEqual(["work", "home", "travel"]);
    });
    it("strips the leading # and not the rest", () => {
        expect(parseHashtags("#project_alpha")).toEqual(["project_alpha"]);
    });
    it("finds tags inside HTML bodies", () => {
        expect(parseHashtags("<div>Plan <b>#q3</b> launch</div>")).toEqual(["q3"]);
    });
    it("de-duplicates case-insensitively, keeping first-seen casing", () => {
        expect(parseHashtags("#Work and #work and #WORK")).toEqual(["Work"]);
    });
    it("ignores purely numeric tokens (matches Notes behaviour)", () => {
        expect(parseHashtags("ticket #123 and #4you")).toEqual(["4you"]);
    });
    it("does not match mid-word or URL fragments", () => {
        expect(parseHashtags("foo#bar")).toEqual([]);
        expect(parseHashtags("see page.html#section for details")).toEqual([]);
    });
    it("does not treat numeric HTML entities as tags", () => {
        // &#8217; is a right single quote entity, not a #8217 tag
        expect(parseHashtags("It&#8217;s a #plan")).toEqual(["plan"]);
    });
    it("matches a tag at the very start of the body", () => {
        expect(parseHashtags("#start of note")).toEqual(["start"]);
    });
    it("handles tags terminated by punctuation", () => {
        expect(parseHashtags("done: #alpha, #beta; #gamma.")).toEqual(["alpha", "beta", "gamma"]);
    });
    it("supports unicode letters in tags", () => {
        expect(parseHashtags("café trip #café")).toEqual(["café"]);
    });
});
