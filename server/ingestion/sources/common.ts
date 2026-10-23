/**
 * sources/common.ts
 * Tiny, pure helpers shared across every ATS adapter. Ported directly from
 * Maester's sources/_common.py — kept to exactly what's identical across
 * every vendor (HTML stripping and title normalization); the surrounding
 * fetch/parse logic differs meaningfully per vendor and lives in each
 * adapter file instead.
 */

export function stripHtml(html: string | null | undefined): string {
  const text = (html ?? "").replace(/<[^>]+>/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", amp: "&",
  mdash: "—", ndash: "–", hellip: "…", bull: "•", middot: "·",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", trade: "™", reg: "®", copy: "©",
};

/** One pass of HTML entity decoding: the common named ones plus numeric &#NNN; / &#xHH;. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/[\s-]+/g, "").trim();
}

// Crude suffix-stripping stemmer — just enough to bridge common word-form
// mismatches ("engineering" vs "engineer", "managers" vs "manager") without
// pulling in a real NLP dependency. Longest/most-specific suffixes checked
// first so "managers" strips via "ers" (-> "manag") rather than the shorter
// "s" catching it first and leaving "manager" unstemmed.
const STEM_SUFFIXES = ["ing", "ers", "er", "es", "s"];

function stem(word: string): string {
  for (const suffix of STEM_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, word.length - suffix.length);
    }
  }
  return word;
}

/**
 * True if `queryWord` (already lowercased) is a reasonable match against
 * `titleLower` (already lowercased). Checks the exact substring first, then
 * falls back to comparing STEMMED forms so a natural word-form mismatch
 * ("engineering" query vs "Software Engineer" title) doesn't silently
 * exclude a real listing. len>=3 stem-length guard keeps short/common
 * suffixes like "-s" from producing noisy accidental matches.
 */
export function titleMatchesQueryWord(queryWord: string, titleLower: string): boolean {
  if (titleLower.includes(queryWord)) return true;
  const stemmedQuery = stem(queryWord);
  if (stemmedQuery.length < 3) return false;
  return titleLower
    .split(/\s+/)
    .some((titleWord) => {
      const stemmedTitleWord = stem(titleWord);
      return stemmedQuery.includes(stemmedTitleWord) || stemmedTitleWord.includes(stemmedQuery);
    });
}
