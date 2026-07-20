import { describe, expect, it } from "vitest";
import { resolveUpdateResponseTitle } from "./updateResponseTitle.js";

describe("resolveUpdateResponseTitle", () => {
  it("reports the requested title for plaintext updates", () => {
    expect(resolveUpdateResponseTitle("Old title", "New title", "plaintext", "Body")).toBe(
      "New title"
    );
  });

  it("keeps the current title when a plaintext update does not rename the note", () => {
    expect(resolveUpdateResponseTitle("Current title", undefined, "plaintext", "Body")).toBe(
      "Current title"
    );
  });

  it("uses the first visible HTML line instead of the ignored newTitle", () => {
    expect(
      resolveUpdateResponseTitle(
        "Old title",
        " ",
        "html",
        "<h1>New &amp; Improved</h1><div>Body</div>"
      )
    ).toBe("New & Improved");
  });

  it("skips leading spacer blocks and preserves inline title text", () => {
    expect(
      resolveUpdateResponseTitle(
        "Old title",
        undefined,
        "html",
        "<div><br></div><h1><b>Actual</b> title</h1><div>Body</div>"
      )
    ).toBe("Actual title");
  });

  it("falls back to the current title when HTML has no visible text", () => {
    expect(resolveUpdateResponseTitle("Current title", " ", "html", "<div><br></div>")).toBe(
      "Current title"
    );
  });

  it("does not decode entity-like text or throw on an invalid numeric entity", () => {
    expect(
      resolveUpdateResponseTitle("Old title", undefined, "html", "<h1>&amplifier &#999999999;</h1>")
    ).toBe("&amplifier &#999999999;");
  });

  it("removes malformed nested tags without leaving a recognizable tag in the title", () => {
    expect(
      resolveUpdateResponseTitle("Old title", undefined, "html", "<h1>A<<b>>title</h1>")
    ).not.toMatch(/<[^>]*>/);
  });

  it("ignores script and style contents before resolving the visible title", () => {
    expect(
      resolveUpdateResponseTitle(
        "Old title",
        undefined,
        "html",
        "<script>Hidden</script><style>Also hidden</style><h1>Actual title</h1>"
      )
    ).toBe("Actual title");
  });
});
