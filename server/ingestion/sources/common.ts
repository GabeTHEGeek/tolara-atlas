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
