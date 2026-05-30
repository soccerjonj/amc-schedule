// Tags movies as classic / special-event from AMC's own attribute labels and
// format headings. These keyword lists are intentionally easy to tune as we
// learn AMC's taxonomy. "Rare" (few showtimes) is computed at query time, not
// here, since it depends on the visible window.

// Matched against the movie title and AMC's own attribute labels — but NOT the
// marketing/format headings, which produce false positives like "Fan First
// Premiere" on wide releases.
const SPECIAL_EVENT_KEYWORDS = [
  "fathom",
  "special event",
  "event cinema",
  "met opera",
  "the metropolitan opera",
  "wwe",
  "ufc",
  "in concert",
  ": live",
  "encore",
  "marathon",
  "sing-along",
  "sing along",
  "double feature",
  "anniversary",
];

const CLASSIC_KEYWORDS = [
  "amc classics",
  "flashback",
  "repertory",
  "throwback cinema",
];

function matchesAny(haystack: string, keywords: string[]): boolean {
  const h = haystack.toLowerCase();
  return keywords.some((k) => h.includes(k));
}

export interface Classification {
  isClassic: boolean;
  isSpecialEvent: boolean;
}

export function classify(signals: { title?: string; attributes: string[] }): Classification {
  const blob = [signals.title ?? "", ...signals.attributes].join(" | ");
  return {
    isSpecialEvent: matchesAny(blob, SPECIAL_EVENT_KEYWORDS),
    isClassic: matchesAny(blob, CLASSIC_KEYWORDS),
  };
}
