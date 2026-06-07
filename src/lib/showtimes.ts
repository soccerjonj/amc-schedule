// Pure (server-safe, no JSX / no "use client") types and helpers shared by the
// API route, the calendar, and the detail pages. The presentational components
// live in src/components/showtime-ui.tsx, which re-exports everything here.

import { DateTime } from "luxon";

export const TZ = "America/Chicago";

export interface Movie {
  id: string;
  title: string;
  slug: string;
  isClassic: boolean;
  isSpecialEvent: boolean;
  isIndie: boolean;
  isForeign: boolean;
  isRare: boolean;
  releaseDate: string | null; // TMDB theatrical date (YYYY-MM-DD); premiere vs re-screening
  rating: string | null; // MPAA rating, e.g. "PG-13"
  runtimeMinutes: number | null;
  posterUrl: string | null;
  letterboxdRating: number | null;
  letterboxdUrl: string | null;
}

export interface ApiShowtime {
  id: string;
  startsAt: string;
  dateKey: string;
  time: string;
  format: string | null;
  ticketUrl: string;
  movie: Movie;
  theatre: { slug: string; name: string };
  isGem: boolean;
}

export interface ApiResponse {
  start: string;
  days: number;
  dayKeys: string[];
  theatres: { slug: string; name: string }[];
  showtimes: ApiShowtime[];
  total: number;
}

export function todayISO() {
  return DateTime.now().setZone(TZ).startOf("day").toISODate()!;
}

const THEATRE_LABEL: Record<string, string> = {
  "amc-river-east-21": "River East",
  "amc-600-north-michigan-9": "600 N Mich",
  "amc-newcity-14": "NewCity",
  "amc-dine-in-block-37": "Block 37",
  "amc-roosevelt-collection-16": "Roosevelt",
};

export function theatreLabel(slug: string, fallback: string): string {
  return THEATRE_LABEL[slug] ?? fallback;
}

// Fixed display order for theatre groups within a card (River East first, etc.).
const THEATRE_ORDER = [
  "amc-river-east-21",
  "amc-600-north-michigan-9",
  "amc-dine-in-block-37",
  "amc-roosevelt-collection-16",
  "amc-newcity-14",
];

function theatreRank(slug: string): number {
  const i = THEATRE_ORDER.indexOf(slug);
  return i === -1 ? THEATRE_ORDER.length : i; // unknown theatres sort last
}

// "7:00 PM" -> "7p", "7:30 PM" -> "7:30p", "11:30 AM" -> "11:30a".
export function compactTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return t;
  const [, h, min, ap] = m;
  const suffix = ap.toLowerCase();
  return min === "00" ? `${h}${suffix}` : `${h}:${min}${suffix}`;
}

// Premium presentation formats get a highlighted tag; accessibility / language
// variants get a muted tag that sorts last (see groupShowtimes); plain
// "Digital"/"Dine-In…" stay untagged (standard). Match by substring — AMC's
// strings are messy ("IMAX with Laser at AMC", "PRIME at AMC", "70mm"…).
export function formatTag(format: string | null): string | null {
  if (!format) return null;
  const f = format.toLowerCase();
  if (f.includes("imax")) return "IMAX";
  if (f.includes("70mm")) return "70mm";
  if (f.includes("dolby")) return "Dolby";
  if (f.includes("prime")) return "Prime";
  if (f.includes("laser")) return "Laser";
  if (/\bxl\b/.test(f)) return "XL";
  if (f.includes("3d")) return "3D";
  if (f.includes("open caption")) return "Open Caption";
  if (f.includes("subtitle")) return "Subtitled";
  if (f.includes("dubbed")) return "Dubbed";
  return null;
}

// Premium format tags, in display order — the set offered as filter chips.
export const PREMIUM_FORMATS = ["IMAX", "70mm", "Dolby", "Prime", "Laser", "XL", "3D"] as const;

const CAPTION_TAGS = new Set(["Open Caption", "Subtitled", "Dubbed"]);

// Caption/subtitle/dubbed variants are accessibility/language presentations: we
// label them but render them muted and push them after the regular showtimes.
export function isCaptionTag(tag: string | null): boolean {
  return tag != null && CAPTION_TAGS.has(tag);
}

// Posters render small; w185 is plenty and far lighter than the stored w342.
export function posterSrc(url: string): string {
  return url.replace(/\/w\d+\//, "/w185/");
}

export const WORLD_CUP_RE = /copa mundial de la fifa|fifa world cup/i;

export function isWorldCup(title: string): boolean {
  return WORLD_CUP_RE.test(title);
}

// FIFA broadcasts come as "México vs. Sudáfrica - Telemundo presenta la Copa
// Mundial de la FIFA 2026" — trim to just the matchup before the " - " separator.
export function displayTitle(title: string): string {
  if (isWorldCup(title)) return title.split(/\s+[-–—]\s+/)[0].trim() || title;
  return title;
}

// Recurring broadcast/festival programs that collapse into one feed/detail entry.
export const SERIES_PATTERNS: { key: string; label: string; re: RegExp }[] = [
  { key: "fifa-world-cup", label: "FIFA World Cup 2026", re: WORLD_CUP_RE },
  { key: "ghibli-fest", label: "Studio Ghibli Fest", re: /ghibli fest/i },
  { key: "met-opera", label: "The Met: Live in HD", re: /met opera|the met: live/i },
];

export function seriesOf(title: string): { key: string; label: string } | null {
  for (const p of SERIES_PATTERNS) if (p.re.test(title)) return { key: p.key, label: p.label };
  return null;
}

export function seriesByKey(key: string): { key: string; label: string } | null {
  const p = SERIES_PATTERNS.find((s) => s.key === key);
  return p ? { key: p.key, label: p.label } : null;
}

export interface ShowGroup {
  key: string;
  theatre: { slug: string; name: string };
  tag: string | null; // shared format tag, shown once in the label
  shows: ApiShowtime[];
}

// Group a movie's showtimes by theatre + format so the format label appears once
// and each time renders as a tiny bare pill (several fit per row).
export function groupShowtimes(shows: ApiShowtime[]): ShowGroup[] {
  const map = new Map<string, ShowGroup>();
  for (const s of shows) {
    const tag = formatTag(s.format);
    const key = `${s.theatre.slug}|${tag ?? ""}`;
    const g = map.get(key) ?? { key, theatre: s.theatre, tag, shows: [] };
    g.shows.push(s);
    map.set(key, g);
  }
  const groups = [...map.values()];
  for (const g of groups) g.shows.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  groups.sort((a, b) => {
    // Caption/subtitle/dubbed groups always come after the regular ones.
    const ca = isCaptionTag(a.tag) ? 1 : 0;
    const cb = isCaptionTag(b.tag) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    // Then a fixed theatre order (River East, 600 N Mich, Block 37, Roosevelt, NewCity).
    const ra = theatreRank(a.theatre.slug);
    const rb = theatreRank(b.theatre.slug);
    if (ra !== rb) return ra - rb;
    // Within the same theatre, earliest showtime first.
    return a.shows[0].startsAt < b.shows[0].startsAt ? -1 : 1;
  });
  return groups;
}

// Plain-English glosses for the gem/category badges (shown as tooltips + legend).
export const BADGE_GLOSS: Record<string, string> = {
  Throwback: "Classic or older film back on the big screen",
  Special: "Opera, concert, anniversary or one-off event",
  Indie: "AMC Artisan / independent film",
  Foreign: "International film",
  Rare: "Only a couple of showtimes — easy to miss",
  Gem: "An easy-to-miss screening worth catching",
};
