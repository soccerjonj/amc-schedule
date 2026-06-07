"use client";

// Presentational components for showtimes. Pure helpers + types live in
// src/lib/showtimes.ts (server-safe); we re-export them here so existing imports
// from "@/components/showtime-ui" keep working unchanged.

import { useState } from "react";
import type { ReactNode } from "react";
import {
  type Movie,
  formatTag,
  isWorldCup,
  posterSrc,
  compactTime,
  type ApiShowtime,
} from "@/lib/showtimes";

export * from "@/lib/showtimes";

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
  title,
  children,
}: {
  tone: "classic" | "special" | "indie" | "foreign" | "rare";
  title?: string;
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
    <span
      title={title}
      className={`rounded px-1 py-px text-[9px] font-bold uppercase tracking-[0.03em] ring-1 ${map[tone]}`}
    >
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
