/**
 * Solid color parsing for the SVG analyzer: CSS named colors, hex forms,
 * rgb()/rgba(), hsl()/hsla(), `transparent`, `currentColor` and `none`.
 * Colors are sRGB with channels 0..1.
 *
 * @module utils/svgColor
 */

export type Rgba = [number, number, number, number];

/** A parsed paint: a solid color, none, a paint server reference, or invalid. */
export type Paint =
  | { kind: "color"; rgba: Rgba }
  | { kind: "none" }
  | { kind: "url"; target: string }
  | { kind: "current" }
  | { kind: "invalid" };

/** CSS Color Module Level 4 named colors (sRGB hex). */
const NAMED: Record<string, string> = {
  aliceblue: "f0f8ff",
  antiquewhite: "faebd7",
  aqua: "00ffff",
  aquamarine: "7fffd4",
  azure: "f0ffff",
  beige: "f5f5dc",
  bisque: "ffe4c4",
  black: "000000",
  blanchedalmond: "ffebcd",
  blue: "0000ff",
  blueviolet: "8a2be2",
  brown: "a52a2a",
  burlywood: "deb887",
  cadetblue: "5f9ea0",
  chartreuse: "7fff00",
  chocolate: "d2691e",
  coral: "ff7f50",
  cornflowerblue: "6495ed",
  cornsilk: "fff8dc",
  crimson: "dc143c",
  cyan: "00ffff",
  darkblue: "00008b",
  darkcyan: "008b8b",
  darkgoldenrod: "b8860b",
  darkgray: "a9a9a9",
  darkgreen: "006400",
  darkgrey: "a9a9a9",
  darkkhaki: "bdb76b",
  darkmagenta: "8b008b",
  darkolivegreen: "556b2f",
  darkorange: "ff8c00",
  darkorchid: "9932cc",
  darkred: "8b0000",
  darksalmon: "e9967a",
  darkseagreen: "8fbc8f",
  darkslateblue: "483d8b",
  darkslategray: "2f4f4f",
  darkslategrey: "2f4f4f",
  darkturquoise: "00ced1",
  darkviolet: "9400d3",
  deeppink: "ff1493",
  deepskyblue: "00bfff",
  dimgray: "696969",
  dimgrey: "696969",
  dodgerblue: "1e90ff",
  firebrick: "b22222",
  floralwhite: "fffaf0",
  forestgreen: "228b22",
  fuchsia: "ff00ff",
  gainsboro: "dcdcdc",
  ghostwhite: "f8f8ff",
  gold: "ffd700",
  goldenrod: "daa520",
  gray: "808080",
  green: "008000",
  greenyellow: "adff2f",
  grey: "808080",
  honeydew: "f0fff0",
  hotpink: "ff69b4",
  indianred: "cd5c5c",
  indigo: "4b0082",
  ivory: "fffff0",
  khaki: "f0e68c",
  lavender: "e6e6fa",
  lavenderblush: "fff0f5",
  lawngreen: "7cfc00",
  lemonchiffon: "fffacd",
  lightblue: "add8e6",
  lightcoral: "f08080",
  lightcyan: "e0ffff",
  lightgoldenrodyellow: "fafad2",
  lightgray: "d3d3d3",
  lightgreen: "90ee90",
  lightgrey: "d3d3d3",
  lightpink: "ffb6c1",
  lightsalmon: "ffa07a",
  lightseagreen: "20b2aa",
  lightskyblue: "87cefa",
  lightslategray: "778899",
  lightslategrey: "778899",
  lightsteelblue: "b0c4de",
  lightyellow: "ffffe0",
  lime: "00ff00",
  limegreen: "32cd32",
  linen: "faf0e6",
  magenta: "ff00ff",
  maroon: "800000",
  mediumaquamarine: "66cdaa",
  mediumblue: "0000cd",
  mediumorchid: "ba55d3",
  mediumpurple: "9370db",
  mediumseagreen: "3cb371",
  mediumslateblue: "7b68ee",
  mediumspringgreen: "00fa9a",
  mediumturquoise: "48d1cc",
  mediumvioletred: "c71585",
  midnightblue: "191970",
  mintcream: "f5fffa",
  mistyrose: "ffe4e1",
  moccasin: "ffe4b5",
  navajowhite: "ffdead",
  navy: "000080",
  oldlace: "fdf5e6",
  olive: "808000",
  olivedrab: "6b8e23",
  orange: "ffa500",
  orangered: "ff4500",
  orchid: "da70d6",
  palegoldenrod: "eee8aa",
  palegreen: "98fb98",
  paleturquoise: "afeeee",
  palevioletred: "db7093",
  papayawhip: "ffefd5",
  peachpuff: "ffdab9",
  peru: "cd853f",
  pink: "ffc0cb",
  plum: "dda0dd",
  powderblue: "b0e0e6",
  purple: "800080",
  rebeccapurple: "663399",
  red: "ff0000",
  rosybrown: "bc8f8f",
  royalblue: "4169e1",
  saddlebrown: "8b4513",
  salmon: "fa8072",
  sandybrown: "f4a460",
  seagreen: "2e8b57",
  seashell: "fff5ee",
  sienna: "a0522d",
  silver: "c0c0c0",
  skyblue: "87ceeb",
  slateblue: "6a5acd",
  slategray: "708090",
  slategrey: "708090",
  snow: "fffafa",
  springgreen: "00ff7f",
  steelblue: "4682b4",
  tan: "d2b48c",
  teal: "008080",
  thistle: "d8bfd8",
  tomato: "ff6347",
  turquoise: "40e0d0",
  violet: "ee82ee",
  wheat: "f5deb3",
  white: "ffffff",
  whitesmoke: "f5f5f5",
  yellow: "ffff00",
  yellowgreen: "9acd32",
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function hexToRgba(hex: string): Rgba | null {
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const expand = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
  if (expand.length !== 6 && expand.length !== 8) return null;
  const byte = (i: number) => Number.parseInt(expand.slice(i, i + 2), 16) / 255;
  return [byte(0), byte(2), byte(4), expand.length === 8 ? byte(6) : 1];
}

/** A number or percentage; `scale` is what 100% equals. Null when malformed. */
function component(text: string, scale: number): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] ? (n / 100) * scale : n;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const f = (n: number) => {
    const k = (n + hue * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function functional(name: string, args: string[]): Rgba | null {
  if (args.length !== 3 && args.length !== 4) return null;
  const alpha = args.length === 4 ? component(args[3], 1) : 1;
  if (alpha === null) return null;
  if (name === "rgb" || name === "rgba") {
    const channels = args.slice(0, 3).map((a) => component(a, 255));
    if (channels.some((c) => c === null)) return null;
    const [r, g, b] = channels.map((c) => clamp01((c as number) / 255));
    return [r, g, b, clamp01(alpha)];
  }
  const h = component(args[0].replace(/deg$/i, ""), 360);
  const s = component(args[1], 1);
  const l = component(args[2], 1);
  if (h === null || s === null || l === null || !args[1].includes("%") || !args[2].includes("%"))
    return null;
  const [r, g, b] = hslToRgb(h, clamp01(s), clamp01(l));
  return [r, g, b, clamp01(alpha)];
}

/** Parse a solid color value, or null when it is not one. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  if (v.startsWith("#")) return hexToRgba(v.slice(1));
  if (v in NAMED) return hexToRgba(NAMED[v]);
  const fn = /^(rgba?|hsla?)\(\s*(.*?)\s*\)$/.exec(v);
  if (!fn) return null;
  const body = fn[2];
  // Legacy comma syntax or modern space syntax with an optional "/ alpha".
  const args = body.includes(",")
    ? body.split(",").map((a) => a.trim())
    : body
        .replace(/\s*\/\s*/, " ")
        .split(/\s+/)
        .filter(Boolean);
  if (args.some((a) => !a)) return null;
  return functional(fn[1], args);
}

/** Parse a `fill` or `stroke` value. */
export function parsePaint(value: string): Paint {
  const v = value.trim();
  if (/^none$/i.test(v)) return { kind: "none" };
  if (/^currentcolor$/i.test(v)) return { kind: "current" };
  const url = /^url\(\s*['"]?([^'")]*)['"]?\s*\)/i.exec(v);
  if (url) return { kind: "url", target: url[1].trim() };
  const rgba = parseColor(v);
  return rgba ? { kind: "color", rgba } : { kind: "invalid" };
}
