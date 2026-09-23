import { describe, expect, it } from "vitest";
import { parseColor, parsePaint } from "./svgColor.js";

const close = (actual: number[] | null, expected: number[]) => {
  expect(actual).not.toBeNull();
  actual!.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 3));
};

describe("parseColor", () => {
  it("reads named colors case-insensitively", () => {
    close(parseColor("Red"), [1, 0, 0, 1]);
    close(parseColor("rebeccapurple"), [0x66 / 255, 0x33 / 255, 0x99 / 255, 1]);
    close(parseColor(" transparent "), [0, 0, 0, 0]);
  });
  it("reads every hex length", () => {
    close(parseColor("#f00"), [1, 0, 0, 1]);
    close(parseColor("#f008"), [1, 0, 0, 0x88 / 255]);
    close(parseColor("#00ff00"), [0, 1, 0, 1]);
    close(parseColor("#0000ff80"), [0, 0, 1, 0x80 / 255]);
    for (const bad of ["#ff", "#fffff", "#ggg", "#"]) expect(parseColor(bad)).toBeNull();
  });
  it("reads rgb() and rgba() in comma and space syntax", () => {
    close(parseColor("rgb(255, 128, 0)"), [1, 128 / 255, 0, 1]);
    close(parseColor("rgba(100%,0%,50%,0.5)"), [1, 0, 0.5, 0.5]);
    close(parseColor("rgb(0 0 255 / 25%)"), [0, 0, 1, 0.25]);
    close(parseColor("rgb(300,-5,0)"), [1, 0, 0, 1]);
  });
  it("reads hsl() and hsla()", () => {
    close(parseColor("hsl(120, 100%, 50%)"), [0, 1, 0, 1]);
    close(parseColor("hsla(240deg 100% 50% / 0.5)"), [0, 0, 1, 0.5]);
    close(parseColor("hsl(-120, 100%, 50%)"), [0, 0, 1, 1]);
  });
  it("rejects malformed functional colors", () => {
    for (const bad of [
      "rgb(1,2)",
      "rgb(1,2,3,4,5)",
      "rgb(a,b,c)",
      "rgb(1,2,3,x)",
      "rgb(1,,3)",
      "hsl(1, 2, 3)",
      "hsl(x, 50%, 50%)",
      "cmyk(1,2,3,4)",
      "notacolor",
    ])
      expect(parseColor(bad)).toBeNull();
  });
});

describe("parsePaint", () => {
  it("classifies every paint form", () => {
    expect(parsePaint("none")).toEqual({ kind: "none" });
    expect(parsePaint("currentColor")).toEqual({ kind: "current" });
    expect(parsePaint("url(#grad) red")).toEqual({ kind: "url", target: "#grad" });
    expect(parsePaint("url('#g')")).toEqual({ kind: "url", target: "#g" });
    expect(parsePaint("blue")).toEqual({ kind: "color", rgba: [0, 0, 1, 1] });
    expect(parsePaint("bogus")).toEqual({ kind: "invalid" });
  });
});
