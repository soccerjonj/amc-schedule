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
];

const CLASSIC_KEYWORDS = [
  "amc classics",
  "flashback",
  "repertory",
  "throwback cinema",
  "fan fave",
  "anniversary", // anniversary screenings are old-film re-releases, not "events"
];

// AMC exposes these as showtime attribute labels (verified in the live data).
const INDIE_ATTR = "amc artisan films";
const FOREIGN_ATTR = "international films";

// A film is "old enough" to be a repertory/Fan Faves screening rather than a
// current release if it came out at least this many years before now. AMC's
// Fan Faves program isn't exposed in the showtime data, so release age is the
// reliable proxy (Call Me By Your Name 2017, Moonlight 2016, Milk 2008…).
const REPERTORY_AGE_YEARS = 2;

function matchesAny(haystack: string, keywords: string[]): boolean {
  const h = haystack.toLowerCase();
  return keywords.some((k) => h.includes(k));
}

export interface Classification {
  isClassic: boolean;
  isSpecialEvent: boolean;
  isIndie: boolean;
  isForeign: boolean;
}

export function classify(signals: {
  title?: string;
  attributes: string[];
  releaseYear?: number | null;
}): Classification {
  const blob = [signals.title ?? "", ...signals.attributes].join(" | ");
  const nowYear = new Date().getFullYear();
  const oldFilm =
    signals.releaseYear != null && signals.releaseYear <= nowYear - REPERTORY_AGE_YEARS;
  return {
    isClassic: oldFilm || matchesAny(blob, CLASSIC_KEYWORDS),
    isSpecialEvent: matchesAny(blob, SPECIAL_EVENT_KEYWORDS),
    isIndie: matchesAny(blob, [INDIE_ATTR]),
    isForeign: matchesAny(blob, [FOREIGN_ATTR]),
  };
}

// Titles that aren't public screenings and should never appear on the site
// (e.g. AMC private theatre rentals — a booking, not a showtime anyone can attend).
const HIDDEN_TITLE = /\bprivate\s+theat(re|er)\s+rental\b/i;

export function isHiddenTitle(title: string): boolean {
  return HIDDEN_TITLE.test(title);
}
