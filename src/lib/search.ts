import type { SearchAlgorithm, Track } from "../types";

export interface SearchAlgorithmInfo {
  id: SearchAlgorithm;
  label: string;
  description: string;
}

/** Every matcher the settings panel offers, in the order it lists them. */
export const SEARCH_ALGORITHMS: SearchAlgorithmInfo[] = [
  {
    id: "exact",
    label: "Exact match",
    description: "Only a whole title, artist or album matches the query.",
  },
  {
    id: "substring",
    label: "Substring match",
    description: "The default. Any part of the text contains the query.",
  },
  {
    id: "prefix",
    label: "Prefix match",
    description: "Every word in the query has to start a word in the text.",
  },
  {
    id: "fuzzy",
    label: "Fuzzy match",
    description: "Characters have to appear in order, gaps allowed, so typos still land.",
  },
  {
    id: "ngram",
    label: "N-gram and token similarity",
    description: "Compares character pairs and shared words, so near misses still rank.",
  },
  {
    id: "indexed",
    label: "Indexed full-text",
    description: "Tokenises the library into an inverted index and ranks by how much it covers.",
  },
  {
    id: "phonetic",
    label: "Phonetic match",
    description: 'Compares names by sound, so "beetles" finds "Beatles".',
  },
];

export interface Scored<T> {
  item: T;
  score: number;
}

/** The text a single item is matched on. Empty entries are ignored. */
export type FieldsOf<T> = (item: T) => readonly (string | null | undefined)[];

/** Splits on anything that is not a letter or a digit. */
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

/** The runs of letters and digits themselves, so a word can be found in place. */
const WORD_SPLIT = /[\p{L}\p{N}]+/gu;

/** Lowercased, with accents folded away so `Bjork` matches `Björk`. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function words(text: string): string[] {
  return text.split(TOKEN_SPLIT).filter(Boolean);
}

function fieldsOfItem<T>(item: T, fieldsOf: FieldsOf<T>): string[] {
  return fieldsOf(item)
    .filter((field): field is string => typeof field === "string")
    .map(normalise)
    .filter(Boolean);
}

export function scoreItems<T>(
  items: readonly T[],
  query: string,
  algorithm: SearchAlgorithm,
  fieldsOf: FieldsOf<T>,
  cacheKey?: object,
): Scored<T>[] {
  const needle = normalise(query);
  if (!needle) {
    return items.map((item) => ({ item, score: 0 }));
  }

  const index = algorithm === "indexed" ? tokenIndexFor(items, fieldsOf, cacheKey) : null;
  const indexed = index ? indexedScores(index, needle) : null;

  const scored: { item: T; score: number; position: number }[] = [];
  items.forEach((item, position) => {
    const score = indexed
      ? (indexed.get(position) ?? null)
      : scoreFields(fieldsOfItem(item, fieldsOf), needle, algorithm);

    if (score !== null) {
      scored.push({ item, score, position });
    }
  });

  return scored
    .sort((left, right) => right.score - left.score || left.position - right.position)
    .map((entry) => ({ item: entry.item, score: entry.score }));
}

/** The text a track is matched on: its tags plus the file name. */
export function trackFields(track: Track): readonly (string | null)[] {
  return [track.title, track.artist, track.album, track.genre, track.fileName];
}

/** Ranked track matches, so the caller can cap the list without losing hits. */
export function searchTracks(
  tracks: readonly Track[],
  query: string,
  algorithm: SearchAlgorithm,
): Track[] {
  return scoreItems(tracks, query, algorithm, trackFields, tracks).map((entry) => entry.item);
}

function scoreFields(fields: string[], needle: string, algorithm: SearchAlgorithm): number | null {
  switch (algorithm) {
    case "exact":
      return exactScore(fields, needle);
    case "substring":
      return substringScore(fields, needle);
    case "prefix":
      return prefixScore(fields, needle);
    case "fuzzy":
      return fuzzyScore(fields, needle);
    case "ngram":
      return ngramScore(fields, needle);
    case "phonetic":
      return phoneticScore(fields, needle);
    case "indexed":
      // Only reached when the corpus is empty; the index handles the rest.
      return substringScore(fields, needle);
  }
}

function exactScore(fields: string[], needle: string): number | null {
  return fields.some((field) => field === needle) ? 1 : null;
}

/** Earlier matches rank above later ones, so the score falls off with the index. */
function positionScore(index: number): number {
  return 1 - index / (index + 10);
}

function substringScore(fields: string[], needle: string): number | null {
  let best: number | null = null;
  for (const field of fields) {
    const index = field.indexOf(needle);
    if (index < 0) {
      continue;
    }
    const score = positionScore(index);
    best = best === null ? score : Math.max(best, score);
  }
  return best;
}

function prefixScore(fields: string[], needle: string): number | null {
  const wanted = words(needle);
  if (wanted.length === 0) {
    return null;
  }

  let total = 0;
  for (const token of wanted) {
    let best: number | null = null;
    for (const field of fields) {
      const index = words(field).findIndex((word) => word.startsWith(token));
      if (index < 0) {
        continue;
      }
      const score = positionScore(index);
      best = best === null ? score : Math.max(best, score);
    }
    if (best === null) {
      return null;
    }
    total += best;
  }
  return total / wanted.length;
}

function fuzzyScore(fields: string[], needle: string): number | null {
  const wanted = needle.replace(/\s+/g, "");
  if (wanted.length < 2) {
    return substringScore(fields, needle);
  }

  let best: number | null = null;
  for (const field of fields) {
    const span = tightSpan(field.replace(/\s+/g, ""), wanted);
    if (span === null) {
      continue;
    }
    // Dense matches rank above scattered ones, and a leading match above all.
    const score = wanted.length / span + (field.startsWith(needle) ? 0.5 : 0);
    best = best === null ? score : Math.max(best, score);
  }
  return best;
}

function tightSpan(text: string, needle: string): number | null {
  let end = -1;
  let at = 0;
  for (let index = 0; index < text.length && at < needle.length; index += 1) {
    if (text[index] === needle[at]) {
      at += 1;
      end = index;
    }
  }
  if (at < needle.length) {
    return null;
  }

  let start = end;
  at = needle.length - 1;
  for (let index = end; index >= 0 && at >= 0; index -= 1) {
    if (text[index] === needle[at]) {
      at -= 1;
      start = index;
    }
  }
  return end - start + 1;
}

/** Below this, a near miss is noise rather than a match. */
const NGRAM_FLOOR = 0.3;

function ngramScore(fields: string[], needle: string): number | null {
  const wanted = words(needle);
  const wantedPairs = wanted.map(bigrams);
  if (wantedPairs.every((pairs) => pairs.size === 0)) {
    return substringScore(fields, needle);
  }

  let best: number | null = null;
  for (const field of fields) {
    const fieldWords = words(field);
    const shared = wanted.filter((token) => fieldWords.includes(token)).length;
    const overlap = shared / wanted.length;

    let similarity = 0;
    for (const pairs of wantedPairs) {
      for (const word of fieldWords) {
        similarity = Math.max(similarity, diceCoefficient(pairs, bigrams(word)));
      }
    }

    const score = Math.max(overlap, similarity);
    if (score < NGRAM_FLOOR) {
      continue;
    }
    best = best === null ? score : Math.max(best, score);
  }
  return best;
}

function bigrams(text: string): Set<string> {
  const pairs = new Set<string>();
  for (let index = 0; index + 1 < text.length; index += 1) {
    pairs.add(text.slice(index, index + 2));
  }
  return pairs;
}

/** Sorensen-Dice over two pair sets. */
function diceCoefficient(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const pair of left) {
    if (right.has(pair)) {
      shared += 1;
    }
  }
  return (2 * shared) / (left.size + right.size);
}

function phoneticScore(fields: string[], needle: string): number | null {
  const wanted = words(needle).filter((token) => token.length > 1);
  if (wanted.length === 0) {
    return substringScore(fields, needle);
  }

  let best: number | null = null;
  for (const field of fields) {
    const sounds = new Set(words(field).map(soundex));
    const shared = wanted.filter((token) => sounds.has(soundex(token))).length;
    if (shared === 0) {
      continue;
    }
    const score = shared / wanted.length;
    best = best === null ? score : Math.max(best, score);
  }
  return best;
}

/** American Soundex: a four character code for how a word sounds. */
function soundex(word: string): string {
  const letters = word.replace(/[^a-z]/g, "");
  if (!letters) {
    return "";
  }

  const first = letters[0];
  let code = "";
  let previous = DIGITS[first] ?? "";

  for (const letter of letters.slice(1)) {
    const digit = DIGITS[letter] ?? "";
    if (digit && digit !== previous) {
      code += digit;
    }
    // `h` and `w` leave the previous digit standing; the other letters reset it.
    previous = digit || (letter === "h" || letter === "w" ? previous : "");
  }

  return `${first}${code}000`.slice(0, 4);
}

const DIGITS: Record<string, string> = {
  b: "1",
  f: "1",
  p: "1",
  v: "1",
  c: "2",
  g: "2",
  j: "2",
  k: "2",
  q: "2",
  s: "2",
  x: "2",
  z: "2",
  d: "3",
  t: "3",
  l: "4",
  m: "5",
  n: "5",
  r: "6",
};

interface TokenIndex {
  /** Token -> the positions it appears at. */
  postings: Map<string, number[]>;
  /** Every token, sorted, so a prefix can be resolved to a range. */
  sorted: string[];
  /** Position -> its tokens in first-seen order, for the phrase bonus. */
  perItem: string[][];
}

/** One index per corpus. `source` guards against a stale reuse. */
const indexCache = new WeakMap<object, { source: readonly unknown[]; index: TokenIndex }>();

function tokenIndexFor<T>(
  items: readonly T[],
  fieldsOf: FieldsOf<T>,
  cacheKey?: object,
): TokenIndex {
  const key: object = cacheKey ?? items;
  const cached = indexCache.get(key);
  if (cached && cached.source === items) {
    return cached.index;
  }

  const index = buildTokenIndex(items, fieldsOf);
  indexCache.set(key, { source: items, index });
  return index;
}

function buildTokenIndex<T>(items: readonly T[], fieldsOf: FieldsOf<T>): TokenIndex {
  const postings = new Map<string, number[]>();
  const perItem: string[][] = [];

  items.forEach((item, position) => {
    const seen = new Set<string>();
    for (const field of fieldsOfItem(item, fieldsOf)) {
      for (const token of words(field)) {
        seen.add(token);
      }
    }

    const ordered = [...seen];
    perItem.push(ordered);
    for (const token of ordered) {
      const list = postings.get(token);
      if (list) {
        list.push(position);
      } else {
        postings.set(token, [position]);
      }
    }
  });

  return { postings, sorted: [...postings.keys()].sort(), perItem };
}

function indexedScores(index: TokenIndex, needle: string): Map<number, number> {
  const scores = new Map<number, number>();
  const wanted = words(needle);
  if (wanted.length === 0) {
    return scores;
  }

  // Every query token has to land somewhere, so this is an AND across tokens.
  const coverage = new Map<number, number>();
  for (const token of wanted) {
    const found = prefixPostings(index, token);
    if (found.size === 0) {
      return scores;
    }
    for (const position of found) {
      coverage.set(position, (coverage.get(position) ?? 0) + 1);
    }
  }

  for (const [position, hits] of coverage) {
    const phrase = containsPhrase(index.perItem[position], wanted) ? 0.5 : 0;
    scores.set(position, hits / wanted.length + phrase);
  }
  return scores;
}

/** The positions holding any indexed token that starts with `token`. */
function prefixPostings(index: TokenIndex, token: string): Set<number> {
  const found = new Set<number>();
  for (let at = lowerBound(index.sorted, token); at < index.sorted.length; at += 1) {
    const candidate = index.sorted[at];
    if (!candidate.startsWith(token)) {
      break;
    }
    for (const position of index.postings.get(candidate) ?? []) {
      found.add(position);
    }
  }
  return found;
}

function lowerBound(sorted: string[], value: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function containsPhrase(tokens: string[], wanted: string[]): boolean {
  if (wanted.length < 2 || tokens.length < wanted.length) {
    return false;
  }
  for (let start = 0; start + wanted.length <= tokens.length; start += 1) {
    if (wanted.every((token, offset) => tokens[start + offset].startsWith(token))) {
      return true;
    }
  }
  return false;
}

/** A slice of a result's text, as offsets into the original string. */
export interface MatchRange {
  start: number;
  end: number;
}

export function matchRanges(text: string, query: string, algorithm: SearchAlgorithm): MatchRange[] {
  const needle = normalise(query);
  if (!needle || !text) {
    return [];
  }

  const folded = fold(text);
  return mergeRanges(
    foldedRanges(folded.text, needle, algorithm).map((range) => ({
      start: folded.origin[range.start],
      end: folded.origin[range.end - 1] + 1,
    })),
  );
}

/** The lowercased, accent-folded text, plus where each character came from. */
function fold(text: string): { text: string; origin: number[] } {
  let folded = "";
  const origin: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    for (const character of foldCharacter(text[index])) {
      folded += character;
      origin.push(index);
    }
  }
  return { text: folded, origin };
}

/** One character, folded the way `normalise` folds a whole string. */
function foldCharacter(character: string): string {
  return character.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function foldedRanges(text: string, needle: string, algorithm: SearchAlgorithm): MatchRange[] {
  switch (algorithm) {
    case "exact":
      return text === needle ? [{ start: 0, end: text.length }] : [];
    case "substring":
      return substringRanges(text, needle);
    case "prefix":
    case "indexed":
      // Both rank on the tokens of the text starting with a query token.
      return tokenPrefixRanges(text, needle);
    case "fuzzy":
      return subsequenceRanges(text, needle);
    case "ngram":
      return ngramRanges(text, needle);
    case "phonetic":
      return phoneticRanges(text, needle);
  }
}

/** Every occurrence of the whole query. */
function substringRanges(text: string, needle: string): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
    ranges.push({ start: at, end: at + needle.length });
  }
  return ranges;
}

/** The leading part of every word a query token starts. */
function tokenPrefixRanges(text: string, needle: string): MatchRange[] {
  const wanted = words(needle);
  const ranges: MatchRange[] = [];

  for (const span of wordSpans(text)) {
    for (const token of wanted) {
      if (span.word.startsWith(token)) {
        ranges.push({ start: span.start, end: span.start + token.length });
      }
    }
  }
  return ranges;
}

/** The characters a query's letters land on, in order, gaps and all. */
function subsequenceRanges(text: string, needle: string): MatchRange[] {
  const wanted = needle.replace(/\s+/g, "");
  if (wanted.length === 0) {
    return [];
  }

  const ranges: MatchRange[] = [];
  let at = 0;
  for (let index = 0; index < text.length && at < wanted.length; index += 1) {
    if (text[index] === wanted[at]) {
      ranges.push({ start: index, end: index + 1 });
      at += 1;
    }
  }
  return at === wanted.length ? ranges : [];
}

/** The words close enough to a query token, plus any literal hit. */
function ngramRanges(text: string, needle: string): MatchRange[] {
  const wanted = words(needle);
  const wantedPairs = wanted.map(bigrams);
  const ranges = substringRanges(text, needle);

  for (const span of wordSpans(text)) {
    const pairs = bigrams(span.word);
    const close = wanted.some(
      (token, index) =>
        span.word === token ||
        (wantedPairs[index].size > 0 &&
          diceCoefficient(wantedPairs[index], pairs) >= NGRAM_FLOOR),
    );
    if (close) {
      ranges.push({ start: span.start, end: span.end });
    }
  }
  return ranges;
}

/** The words that sound like a query token, plus any literal hit. */
function phoneticRanges(text: string, needle: string): MatchRange[] {
  const ranges = substringRanges(text, needle);
  const wanted = words(needle).filter((token) => token.length > 1);
  if (wanted.length === 0) {
    return ranges;
  }

  const sounds = new Set(wanted.map(soundex));
  for (const span of wordSpans(text)) {
    if (sounds.has(soundex(span.word))) {
      ranges.push({ start: span.start, end: span.end });
    }
  }
  return ranges;
}

interface WordSpan {
  word: string;
  start: number;
  end: number;
}

/** The runs of letters and digits in the text, with their offsets. */
function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  const pattern = new RegExp(WORD_SPLIT.source, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    spans.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/** Sorts the ranges and fuses the ones that touch, so nothing is drawn twice. */
function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length < 2) {
    return ranges;
  }

  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: MatchRange[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
