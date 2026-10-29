/**
 * contacts/posting.ts
 * Reads a posting for the two things that say who to look for: the title
 * the role reports to ("Reporting to the Director of Product Management,
 * Pricing") and the team or product it sits on. Then turns them into at
 * most three LinkedIn searches -- the per-click budget the owner agreed to.
 *
 * Plain patterns rather than a model call: postings say this in a handful
 * of stock phrasings, and a miss only means the searches fall back to the
 * generic "head of product at <company>" ones.
 */

export interface PostingHints {
  reportsTo: string | null;
  team: string | null;
}

export interface PlannedSearch {
  kind: "people" | "posts";
  keywords: string;
  why: string;
}

// The phrase, then the title up to where the sentence moves on. Ordered by
// how reliable each phrasing is.
const REPORTS_TO = [
  /\breporting\s+(?:directly\s+)?(?:in)?to\s*:?\s+(?:the\s+|our\s+|a\s+)?([^.;:\n(]{3,90})/i,
  /\breports?\s+(?:directly\s+)?(?:in)?to\s*:?\s+(?:the\s+|our\s+|a\s+)?([^.;:\n(]{3,90})/i,
  /\breporting\s+line\s*:?\s+([^.;:\n(]{3,90})/i,
];

// What a reporting line has to mention to be a person, not "reports to
// stakeholders" or the false friend "reporting for programmatic buyers".
const LEADER_WORD =
  /\b(director|head|vp|vice president|chief|cpo|cto|ceo|coo|gm|general manager|manager|lead|founder|president|svp|evp)\b/i;

// Where the title stops and the sentence carries on.
const TITLE_END =
  /\s*(?:,\s*(?:you|this|the|and|alongside|working|where|who|with|as|in order|set|sit|lead|drive|own|help|partner)\b|\s+(?:based|located|total compensation|compensation|salary)\b|\s+(?:and|alongside|you|this|who|will|while|within|working|as part|to help|in our|on our|and work|,?\s+we)\b|\s+-\s+|\s+—\s+|\s+–\s+).*$/i;

export function reportsToFrom(description: string): string | null {
  for (const pattern of REPORTS_TO) {
    for (const match of description.matchAll(new RegExp(pattern, "gi"))) {
      let title = match[1].replace(TITLE_END, "").replace(/\s+/g, " ").trim();
      title = title.replace(/^(?:the|our|a)\s+/i, "").replace(/[,\s]+$/, "");
      if (!LEADER_WORD.test(title)) continue;
      if (title.split(" ").length > 12) continue;
      return title;
    }
  }
  return null;
}

// "Senior Product Manager, Pricing" / "Product Manager - Payments" /
// "PM (Growth)": the part after the separator is the team.
export function teamFromTitle(title: string): string | null {
  const m =
    title.match(/(?:,|\s[-–—|]\s|:)\s*([^,(]+?)\s*(?:\(.*\))?$/) ?? title.match(/\(([^)]+)\)\s*$/);
  if (!m) return null;
  const team = m[1].trim();
  // Locations and levels aren't teams.
  if (/^(remote|hybrid|us|usa|united states|new york|nyc|sf|san francisco|seattle|austin|[A-Z]{2}|i{1,3}|iv|v|\d+)$/i.test(team)) return null;
  if (/^(senior|staff|principal|lead|associate|sr\.?|group)$/i.test(team)) return null;
  if (/\b(product manager|product management)\b/i.test(team) && team.split(" ").length <= 3) return null;
  return team.length <= 60 ? team : null;
}

export function hintsFor(title: string, description: string | null, team: string | null): PostingHints {
  return {
    reportsTo: description ? reportsToFrom(description) : null,
    team: team?.trim() || teamFromTitle(title),
  };
}

// LinkedIn treats quotes as exact-phrase; anything else that LinkedIn
// reads as an operator is dropped so a stray "OR" in a team name can't
// change the query.
function clean(s: string): string {
  return s.replace(/["()&]/g, " ").replace(/\b(AND|OR|NOT)\b/g, " ").replace(/\s+/g, " ").trim();
}

// "Training Infrastructure - Weights & Biases" -> "Training Infrastructure":
// LinkedIn ANDs every word, so a long team name finds no one.
function shortTeam(team: string): string {
  return clean(team.split(/\s[-–—|]\s|,|\//)[0].replace(/&/g, " ")).split(" ").slice(0, 4).join(" ");
}

/**
 * At most three searches. People searches look for the manager -- by the
 * title the posting names, else by the team -- then product people on the
 * team; the posts search looks for someone announcing the opening, which
 * is the best possible find, since it names the hiring manager outright.
 */
export function planSearches(company: string, roleTitle: string, hints: PostingHints): PlannedSearch[] {
  const co = clean(company);
  // "Google Search" at Google is just "Search": the company is in every query already.
  const team = hints.team ? shortTeam(hints.team).replace(new RegExp(`\\b${co.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "").trim() || null : null;
  // Senior titles get a VP-level manager; everything else a director or
  // head of product. Small companies answer "head of product" either way.
  const senior = /\b(director|head|vp|vice president|group|principal)\b/i.test(roleTitle);
  const searches: PlannedSearch[] = [];

  if (hints.reportsTo) {
    searches.push({ kind: "people", keywords: `${clean(hints.reportsTo)} ${co}`, why: `the posting says it reports to the ${hints.reportsTo}` });
  } else if (team) {
    searches.push({ kind: "people", keywords: `${senior ? "VP" : "director"} product ${team} ${co}`, why: `product leaders over ${team}` });
  } else {
    searches.push({ kind: "people", keywords: `head of product ${co}`, why: "product leaders at the company" });
  }

  if (team) {
    searches.push({ kind: "people", keywords: `product manager ${team} ${co}`, why: `product people on ${team}` });
  } else {
    searches.push({ kind: "people", keywords: `${senior ? "VP product" : "director of product"} ${co}`, why: "product leaders at the company" });
  }

  searches.push({
    kind: "posts",
    // Company only: LinkedIn's post search ANDs the words, and adding the
    // team found nothing even where the hiring posts existed (Oura).
    keywords: `hiring "product manager" ${co}`,
    why: "posts announcing the opening",
  });
  return searches;
}
