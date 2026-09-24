/**
 * One word count for every tool that reports or filters on words.
 *
 * A word is a whitespace-separated run that holds a letter or digit. Chinese,
 * Japanese, Thai, Lao, Khmer and Myanmar text does not put spaces between
 * words, so a run holding those scripts is split with Intl.Segmenter's word
 * boundaries instead of counting as a single word.
 *
 * @module utils/wordCount
 */

/** Scripts written without spaces between words. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

let segmenter: Intl.Segmenter | undefined;

/** Counts words in note text; attachment placeholders (U+FFFC) separate words. */
export function countWords(text: string): number {
  let count = 0;
  for (const run of text.replace(/￼/gu, " ").split(/\s+/u)) {
    if (!/[\p{L}\p{N}]/u.test(run)) continue;
    if (!UNSPACED_SCRIPT.test(run)) {
      count++;
      continue;
    }
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
    let words = 0;
    for (const segment of segmenter.segment(run)) if (segment.isWordLike) words++;
    count += Math.max(1, words);
  }
  return count;
}
