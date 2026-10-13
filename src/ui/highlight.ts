import { escapeHtml } from "../lib/format";
import { matchRanges } from "../lib/search";
import type { SearchAlgorithm } from "../types";

/** Wraps whatever part of `text` earned the match in a themed highlight. */
export function highlightHtml(text: string, query: string, algorithm: SearchAlgorithm): string {
  const ranges = matchRanges(text, query, algorithm);
  if (ranges.length === 0) {
    return escapeHtml(text);
  }

  let html = "";
  let at = 0;
  for (const range of ranges) {
    html += escapeHtml(text.slice(at, range.start));
    html += `<mark class="hit">${escapeHtml(text.slice(range.start, range.end))}</mark>`;
    at = range.end;
  }
  return html + escapeHtml(text.slice(at));
}
