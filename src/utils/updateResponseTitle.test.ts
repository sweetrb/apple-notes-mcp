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

  it("treats an unclosed style block as running to end of input, like a browser", () => {
    // Truncated/pasted HTML routinely loses the closing tag. Without an
    // end-of-input branch the block is left in place and its CSS becomes the
    // reported title.
    expect(
      resolveUpdateResponseTitle("Old title", undefined, "html", "<style>h1{color:red}Actual title")
    ).toBe("Old title");
  });

  it("resolves many unclosed blocks in linear time", () => {
    // Regression guard for quadratic backtracking: each unclosed block used to
    // scan to end-of-input, fail, and backtrack, then the fixpoint loop
    // repeated it. 844 KB took ~1s before; the ceiling on accepted content is
    // 5 MiB. A generous bound keeps this from being timing-flaky in CI.
    const html = "<div>Real title</div>" + "<script>x".repeat(8000);
    const started = Date.now();
    expect(resolveUpdateResponseTitle("Old title", undefined, "html", html)).toBe("Real title");
    expect(Date.now() - started).toBeLessThan(500);
  });
});
