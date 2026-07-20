import { describe, expect, it } from "vitest";
import { resolveUpdateResponseTitle } from "./updateResponseTitle.js";

describe("resolveUpdateResponseTitle", () => {
  it("reports the requested title for plaintext updates", () => {
    expect(resolveUpdateResponseTitle("Old title", "New title", "plaintext")).toBe("New title");
  });

  it("keeps the current title when a plaintext update does not rename the note", () => {
    expect(resolveUpdateResponseTitle("Current title", undefined, "plaintext")).toBe(
      "Current title"
    );
  });

  it("does not report newTitle for HTML updates because the manager ignores it", () => {
    expect(resolveUpdateResponseTitle("Visible title", " ", "html")).toBe("Visible title");
  });
});
