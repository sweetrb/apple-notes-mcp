import { describe, expect, it, vi } from "vitest";
import { addNativeTags, normalizeNativeTags, type NativeTagSnapshot } from "./nativeTags.js";

const id = "x-coredata://ABCDEF/ICNote/p12";
const request = {
  id,
  expectedContentHash: "before",
  title: "Идеи",
  scopeText: "Project Shamaal",
  tags: ["shamaal", "дроп"],
};
const snapshot = (): NativeTagSnapshot => ({
  title: "Идеи",
  contentHash: "before",
  plaintext: "Идеи Project Shamaal #shamaal",
  rich: {
    text: "Идеи Project Shamaal #shamaal",
    links: [{ start: 0, length: 4, text: "Идеи", url: "notes://showNote?identifier=ABC" }],
    nativeTags: [],
    nativeObjectIds: [],
    hasNativeObjects: false,
    hasChecklist: false,
    revision: "r1",
  },
});
function fixture() {
  const before = snapshot();
  const after = structuredClone(before);
  after.contentHash = "after";
  after.rich.nativeTags = ["shamaal", "дроп"];
  after.rich.text += "\n\ufffc \ufffc";
  after.rich.nativeObjectIds = ["a", "b"];
  after.rich.hasNativeObjects = true;
  const deps = {
    read: vi.fn().mockReturnValueOnce(before).mockReturnValueOnce(before).mockReturnValue(after),
    candidates: vi.fn(() => [id]),
    run: vi.fn(),
  };
  return { before, after, deps };
}
describe("native Notes tags", () => {
  it("normalizes Cyrillic and deduplicates tags without accepting commands or whitespace", () => {
    expect(normalizeNativeTags(["#дроп", "дроп", "project_1"])).toEqual(["дроп", "project_1"]);
    for (const tags of [[], ["$(cmd)"], ["a b"], ["123"], ["x\n"]])
      expect(() => normalizeNativeTags(tags)).toThrow();
  });
  it("verifies native tags, original text and real link destinations", () => {
    const { deps } = fixture();
    expect(addNativeTags(request, deps)).toMatchObject({
      added: ["shamaal", "дроп"],
      contentHash: "after",
    });
    expect(deps.run).toHaveBeenCalledWith({
      title: "Идеи",
      scopeText: "Project Shamaal",
      tags: ["shamaal", "дроп"],
    });
  });
  it("rejects stale revisions before invoking Shortcuts", () => {
    const { deps } = fixture();
    expect(() => addNativeTags({ ...request, expectedContentHash: "stale" }, deps)).toThrow(
      /revision/
    );
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("rejects same-titled candidates in other projects and wrong exact IDs", () => {
    for (const candidates of [[id, "other"], ["other"], []]) {
      const { deps } = fixture();
      deps.candidates.mockReturnValue(candidates);
      expect(() => addNativeTags(request, deps)).toThrow(/ambiguous/);
      expect(deps.run).not.toHaveBeenCalled();
    }
  });
  it("rechecks the revision after resolving the target", () => {
    const { deps, before } = fixture();
    deps.read
      .mockReset()
      .mockReturnValueOnce(before)
      .mockReturnValue({ ...before, contentHash: "changed" });
    expect(() => addNativeTags(request, deps)).toThrow(/during preflight/);
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("is idempotent when all native tags already exist", () => {
    const { deps, before } = fixture();
    before.rich.nativeTags = request.tags;
    expect(addNativeTags(request, deps).added).toEqual([]);
    expect(deps.run).not.toHaveBeenCalled();
  });
  it("does not mistake plain hashtags or a successful process for native tags", () => {
    const { deps, after } = fixture();
    after.rich.nativeTags = [];
    expect(() => addNativeTags(request, deps)).toThrow(/not verified/);
  });
  it("verifies an uncertain transport outcome without repeating the write", () => {
    const { deps } = fixture();
    deps.run.mockImplementation(() => {
      throw new Error("timeout");
    });
    expect(addNativeTags(request, deps)).toMatchObject({
      added: request.tags,
      transportWarning: expect.any(String),
    });
    expect(deps.run).toHaveBeenCalledTimes(1);
    const failed = fixture();
    failed.deps.run.mockImplementation(() => {
      throw new Error("timeout");
    });
    failed.after.rich.nativeTags = [];
    expect(() => addNativeTags(request, failed.deps)).toThrow(/not verified/);
  });
  it("detects lost links, lost original objects and changed non-tag text", () => {
    const one = fixture();
    one.after.rich.links = [];
    const two = fixture();
    two.before.rich.nativeObjectIds = ["existing"];
    const three = fixture();
    three.after.rich.text = "different text";
    for (const f of [one, two, three])
      expect(() => addNativeTags(request, f.deps)).toThrow(/not verified/);
  });
  it("refuses missing project markers and malformed IDs", () => {
    for (const change of [
      { id: "title-only" },
      { scopeText: "missing project" },
      { scopeText: "tiny" },
      { title: "Other" },
    ]) {
      const { deps } = fixture();
      expect(() => addNativeTags({ ...request, ...change }, deps)).toThrow();
      expect(deps.run).not.toHaveBeenCalled();
    }
  });
});
