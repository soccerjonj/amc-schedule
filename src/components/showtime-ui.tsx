"use client";

// Shared types, helpers, and presentational components used by the calendar
// (src/app/page.tsx) and the movie/series detail pages. Keeping them here avoids
// divergence between the day-grid cards and the detail views.

import { useState } from "react";
import type { ReactNode } from "react";
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

// "7:00 PM" -> "7p", "7:30 PM" -> "7:30p", "11:30 AM" -> "11:30a".
export function compactTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return t;
  const [, h, min, ap] = m;
  const suffix = ap.toLowerCase();
  return min === "00" ? `${h}${suffix}` : `${h}:${min}${suffix}`;
}

// AMC's format strings are messy ("IMAX with Laser at AMC", "PRIME at AMC",
// "RealD 3D", language/caption variants), so match by substring.
export function formatTag(format: string | null): string | null {
  if (!format) return null;
  const f = format.toLowerCase();
  if (f.includes("imax")) return "IMAX";
  if (f.includes("dolby")) return "Dolby";
  if (f.includes("prime")) return "Prime";
  if (f.includes("laser")) return "Laser";
  if (f.includes("3d")) return "3D";
  return null;
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
  groups.sort((a, b) => (a.shows[0].startsAt < b.shows[0].startsAt ? -1 : 1));
  return groups;
}

export function FilmIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </svg>
  );
}

function LetterboxdMark() {
  // The Letterboxd three-dot mark — shown when a film has a page but no rating yet.
  return (
    <svg viewBox="0 0 26 10" className="h-2.5 w-auto" aria-hidden="true">
      <circle cx="5" cy="5" r="4.6" fill="#ff8000" />
      <circle cx="13" cy="5" r="4.6" fill="#00e054" />
      <circle cx="21" cy="5" r="4.6" fill="#40bcf4" />
    </svg>
  );
}

export function RatingBadge({ movie }: { movie: Movie }) {
  const hasRating = movie.letterboxdRating != null;
  if (!hasRating && !movie.letterboxdUrl) return null;
  const cls =
    "inline-flex flex-none items-center gap-0.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-bold text-lb ring-1 ring-lb/30";
  const content = hasRating ? <>★ {movie.letterboxdRating!.toFixed(1)}</> : <LetterboxdMark />;
  const aria = hasRating
    ? `Letterboxd rating ${movie.letterboxdRating!.toFixed(1)} out of 5`
    : "View on Letterboxd — not yet rated";
  return movie.letterboxdUrl ? (
    <a
      href={movie.letterboxdUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${aria} — opens in a new tab`}
      className={`${cls} transition hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lb`}
    >
      {content}
    </a>
  ) : (
    <span aria-label={aria} className={cls}>
      {content}
    </span>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: "classic" | "special" | "indie" | "foreign" | "rare";
  children: ReactNode;
}) {
  const map = {
    classic: "bg-classic/15 text-classic ring-classic/25",
    special: "bg-special/15 text-special ring-special/25",
    indie: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/25",
    foreign: "bg-orange-500/15 text-orange-300 ring-orange-400/25",
    rare: "bg-rare/15 text-rare ring-rare/25",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em] ring-1 ${map[tone]}`}>
      {children}
    </span>
  );
}

// Poster slot for FIFA World Cup broadcasts (no film poster on TMDB).
export function WorldCupPoster({ sizeCls = "w-10" }: { sizeCls?: string }) {
  const [imgOk, setImgOk] = useState(true);
  return (
    <div
      aria-hidden="true"
      className={`relative flex aspect-[2/3] ${sizeCls} flex-none self-start items-center justify-center overflow-hidden rounded bg-gradient-to-br from-emerald-700 to-sky-800`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5 text-white/85" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8.2l3.4 2.5-1.3 4H9.9l-1.3-4L12 8.2z" fill="currentColor" stroke="none" />
        <path d="M12 3.2v3M20.6 11.2l-3.1.4M17.1 18.8l-1.6-2.9M8.5 18.8l1.6-2.9M3.4 11.2l3.1.4" />
      </svg>
      {imgOk && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src="/world-cup.png"
          alt=""
          loading="lazy"
          onError={() => setImgOk(false)}
          className="absolute inset-0 h-full w-full bg-white object-cover object-top"
        />
      )}
    </div>
  );
}

// Shared poster slot: World Cup tile, TMDB art, or a film-glyph placeholder.
// `sizeCls` sets the width (e.g. "w-10" in day cards, "w-16" in the Upcoming feed).
export function Poster({ movie, sizeCls = "w-10" }: { movie: Movie; sizeCls?: string }) {
  if (isWorldCup(movie.title)) return <WorldCupPoster sizeCls={sizeCls} />;
  return (
    <div className={`relative aspect-[2/3] ${sizeCls} flex-none self-start overflow-hidden rounded bg-surface-3`}>
      {movie.posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={posterSrc(movie.posterUrl)}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <FilmIcon className="h-4 w-4 text-ink-3" />
        </div>
      )}
    </div>
  );
}

export function TimeChip({
  s,
  movieTitle,
  dayLabel,
}: {
  s: ApiShowtime;
  movieTitle: string;
  dayLabel: string;
}) {
  const tag = formatTag(s.format);
  const label = `Buy tickets for ${movieTitle} at ${s.theatre.name}, ${dayLabel} ${s.time}${
    tag ? `, ${tag}` : ""
  } — opens AMC in a new tab`;
  return (
    <a
      href={s.ticketUrl}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="inline-flex items-center rounded border border-line bg-surface-3 px-1.5 py-1 text-[11px] font-medium tabular-nums leading-none text-ink transition hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {compactTime(s.time)}
    </a>
  );
}
