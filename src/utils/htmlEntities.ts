/**
 * HTML character-reference decoding shared by the visible-text verifiers.
 *
 * Notes decodes every character reference in HTML it imports (AppleScript
 * `body`, and the Background Operations bridge's Get Rich Text from HTML step)
 * and reads the result back as the bare character: `&mdash;` is saved as "—"
 * and returned by `body` as "—". A verifier that decoded only amp/lt/gt/quot/
 * nbsp/apos kept `&mdash;` literal on the expected side, so a complete write
 * read back as "visible text did not match" / "Appended text not verified"
 * (#283).
 *
 * Named references: the 252 HTML 4 names plus `apos`, at their HTML5 code
 * points (HTML5 moved `lang`/`rang` to U+27E8/U+27E9). That is every name in
 * common hand- and machine-written HTML. A name outside this set is left as
 * literal text, so a verifier comparing it fails closed (an uncertain outcome)
 * instead of guessing.
 */

/** HTML 4 named character references (plus `apos`), as HTML5 code points. */
export const NAMED_CHARACTER_REFERENCES: Record<string, number> = {
  Aacute: 0xc1,
  aacute: 0xe1,
  Acirc: 0xc2,
  acirc: 0xe2,
  acute: 0xb4,
  AElig: 0xc6,
  aelig: 0xe6,
  Agrave: 0xc0,
  agrave: 0xe0,
  alefsym: 0x2135,
  Alpha: 0x391,
  alpha: 0x3b1,
  amp: 0x26,
  and: 0x2227,
  ang: 0x2220,
  apos: 0x27,
  Aring: 0xc5,
  aring: 0xe5,
  asymp: 0x2248,
  Atilde: 0xc3,
  atilde: 0xe3,
  Auml: 0xc4,
  auml: 0xe4,
  bdquo: 0x201e,
  Beta: 0x392,
  beta: 0x3b2,
  brvbar: 0xa6,
  bull: 0x2022,
  cap: 0x2229,
  Ccedil: 0xc7,
  ccedil: 0xe7,
  cedil: 0xb8,
  cent: 0xa2,
  Chi: 0x3a7,
  chi: 0x3c7,
  circ: 0x2c6,
  clubs: 0x2663,
  cong: 0x2245,
  copy: 0xa9,
  crarr: 0x21b5,
  cup: 0x222a,
  curren: 0xa4,
  Dagger: 0x2021,
  dagger: 0x2020,
  dArr: 0x21d3,
  darr: 0x2193,
  deg: 0xb0,
  Delta: 0x394,
  delta: 0x3b4,
  diams: 0x2666,
  divide: 0xf7,
  Eacute: 0xc9,
  eacute: 0xe9,
  Ecirc: 0xca,
  ecirc: 0xea,
  Egrave: 0xc8,
  egrave: 0xe8,
  empty: 0x2205,
  emsp: 0x2003,
  ensp: 0x2002,
  Epsilon: 0x395,
  epsilon: 0x3b5,
  equiv: 0x2261,
  Eta: 0x397,
  eta: 0x3b7,
  ETH: 0xd0,
  eth: 0xf0,
  Euml: 0xcb,
  euml: 0xeb,
  euro: 0x20ac,
  exist: 0x2203,
  fnof: 0x192,
  forall: 0x2200,
  frac12: 0xbd,
  frac14: 0xbc,
  frac34: 0xbe,
  frasl: 0x2044,
  Gamma: 0x393,
  gamma: 0x3b3,
  ge: 0x2265,
  gt: 0x3e,
  hArr: 0x21d4,
  harr: 0x2194,
  hearts: 0x2665,
  hellip: 0x2026,
  Iacute: 0xcd,
  iacute: 0xed,
  Icirc: 0xce,
  icirc: 0xee,
  iexcl: 0xa1,
  Igrave: 0xcc,
  igrave: 0xec,
  image: 0x2111,
  infin: 0x221e,
  int: 0x222b,
  Iota: 0x399,
  iota: 0x3b9,
  iquest: 0xbf,
  isin: 0x2208,
  Iuml: 0xcf,
  iuml: 0xef,
  Kappa: 0x39a,
  kappa: 0x3ba,
  Lambda: 0x39b,
  lambda: 0x3bb,
  lang: 0x27e8,
  laquo: 0xab,
  lArr: 0x21d0,
  larr: 0x2190,
  lceil: 0x2308,
  ldquo: 0x201c,
  le: 0x2264,
  lfloor: 0x230a,
  lowast: 0x2217,
  loz: 0x25ca,
  lrm: 0x200e,
  lsaquo: 0x2039,
  lsquo: 0x2018,
  lt: 0x3c,
  macr: 0xaf,
  mdash: 0x2014,
  micro: 0xb5,
  middot: 0xb7,
  minus: 0x2212,
  Mu: 0x39c,
  mu: 0x3bc,
  nabla: 0x2207,
  nbsp: 0xa0,
  ndash: 0x2013,
  ne: 0x2260,
  ni: 0x220b,
  not: 0xac,
  notin: 0x2209,
  nsub: 0x2284,
  Ntilde: 0xd1,
  ntilde: 0xf1,
  Nu: 0x39d,
  nu: 0x3bd,
  Oacute: 0xd3,
  oacute: 0xf3,
  Ocirc: 0xd4,
  ocirc: 0xf4,
  OElig: 0x152,
  oelig: 0x153,
  Ograve: 0xd2,
  ograve: 0xf2,
  oline: 0x203e,
  Omega: 0x3a9,
  omega: 0x3c9,
  Omicron: 0x39f,
  omicron: 0x3bf,
  oplus: 0x2295,
  or: 0x2228,
  ordf: 0xaa,
  ordm: 0xba,
  Oslash: 0xd8,
  oslash: 0xf8,
  Otilde: 0xd5,
  otilde: 0xf5,
  otimes: 0x2297,
  Ouml: 0xd6,
  ouml: 0xf6,
  para: 0xb6,
  part: 0x2202,
  permil: 0x2030,
  perp: 0x22a5,
  Phi: 0x3a6,
  phi: 0x3c6,
  Pi: 0x3a0,
  pi: 0x3c0,
  piv: 0x3d6,
  plusmn: 0xb1,
  pound: 0xa3,
  Prime: 0x2033,
  prime: 0x2032,
  prod: 0x220f,
  prop: 0x221d,
  Psi: 0x3a8,
  psi: 0x3c8,
  quot: 0x22,
  radic: 0x221a,
  rang: 0x27e9,
  raquo: 0xbb,
  rArr: 0x21d2,
  rarr: 0x2192,
  rceil: 0x2309,
  rdquo: 0x201d,
  real: 0x211c,
  reg: 0xae,
  rfloor: 0x230b,
  Rho: 0x3a1,
  rho: 0x3c1,
  rlm: 0x200f,
  rsaquo: 0x203a,
  rsquo: 0x2019,
  sbquo: 0x201a,
  Scaron: 0x160,
  scaron: 0x161,
  sdot: 0x22c5,
  sect: 0xa7,
  shy: 0xad,
  Sigma: 0x3a3,
  sigma: 0x3c3,
  sigmaf: 0x3c2,
  sim: 0x223c,
  spades: 0x2660,
  sub: 0x2282,
  sube: 0x2286,
  sum: 0x2211,
  sup: 0x2283,
  sup1: 0xb9,
  sup2: 0xb2,
  sup3: 0xb3,
  supe: 0x2287,
  szlig: 0xdf,
  Tau: 0x3a4,
  tau: 0x3c4,
  there4: 0x2234,
  Theta: 0x398,
  theta: 0x3b8,
  thetasym: 0x3d1,
  thinsp: 0x2009,
  THORN: 0xde,
  thorn: 0xfe,
  tilde: 0x2dc,
  times: 0xd7,
  trade: 0x2122,
  Uacute: 0xda,
  uacute: 0xfa,
  uArr: 0x21d1,
  uarr: 0x2191,
  Ucirc: 0xdb,
  ucirc: 0xfb,
  Ugrave: 0xd9,
  ugrave: 0xf9,
  uml: 0xa8,
  upsih: 0x3d2,
  Upsilon: 0x3a5,
  upsilon: 0x3c5,
  Uuml: 0xdc,
  uuml: 0xfc,
  weierp: 0x2118,
  Xi: 0x39e,
  xi: 0x3be,
  Yacute: 0xdd,
  yacute: 0xfd,
  yen: 0xa5,
  Yuml: 0x178,
  yuml: 0xff,
  Zeta: 0x396,
  zeta: 0x3b6,
  zwj: 0x200d,
  zwnj: 0x200c,
};

/** HTML5 "legacy" references: decoded with or without the semicolon. */
const LEGACY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: "\u00a0" };

/** HTML5's replacements for numeric references to C1 controls (Windows-1252). */
const C1_REPLACEMENTS: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x2c6,
  0x89: 0x2030,
  0x8a: 0x160,
  0x8b: 0x2039,
  0x8c: 0x152,
  0x8e: 0x17d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x2dc,
  0x99: 0x2122,
  0x9a: 0x161,
  0x9b: 0x203a,
  0x9c: 0x153,
  0x9e: 0x17e,
  0x9f: 0x178,
};

/**
 * The character a numeric reference denotes, as an HTML parser decodes it:
 * zero, surrogates and anything past U+10FFFF become U+FFFD (String.fromCodePoint
 * would throw past U+10FFFF and turn a committed write into an error), and
 * C1 controls map to their Windows-1252 characters.
 */
export function numericReferenceText(value: number): string {
  if (!Number.isSafeInteger(value) || value === 0 || value > 0x10ffff) return "\ufffd";
  if (value >= 0xd800 && value <= 0xdfff) return "\ufffd";
  return String.fromCodePoint(C1_REPLACEMENTS[value] ?? value);
}

/** A named reference with its semicolon, or undefined when it is not in the table. */
export function namedReferenceText(name: string): string | undefined {
  return Object.hasOwn(NAMED_CHARACTER_REFERENCES, name)
    ? String.fromCodePoint(NAMED_CHARACTER_REFERENCES[name])
    : undefined;
}

/**
 * Decode character references in HTML text content in ONE pass, so `&amp;lt;`
 * stays the literal text `&lt;`. Numeric references may omit the semicolon,
 * as in browsers. A named reference needs its semicolon, except the legacy
 * amp/lt/gt/quot/nbsp, which decode as a prefix whatever follows: Notes'
 * AppleScript HTML writes `a=1&ampb=2` for the text `a=1&b=2` and `&quothi`
 * for `"hi` (#166). Unknown names stay literal.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g,
    (
      match: string,
      dec: string | undefined,
      hex: string | undefined,
      name: string | undefined,
      semicolon: string
    ) => {
      if (dec !== undefined) return numericReferenceText(Number(dec));
      if (hex !== undefined) return numericReferenceText(Number.parseInt(hex, 16));
      const named = semicolon ? namedReferenceText(name!) : undefined;
      if (named !== undefined) return named;
      const legacy = /^(?:amp|lt|gt|quot|nbsp)/i.exec(name!);
      if (!legacy) return match;
      const rest = name!.slice(legacy[0].length);
      return LEGACY[legacy[0].toLowerCase()] + rest + (rest ? semicolon : "");
    }
  );
}
