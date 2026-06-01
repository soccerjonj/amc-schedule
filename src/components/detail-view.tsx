"use client";

// Movie / series detail page: shows every day + showtime for a single film, or
// for a collapsed series (FIFA World Cup, Ghibli Fest…). Reached from any movie
// card on the calendar/Upcoming feed. Time chips link straight to AMC to buy.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { DateTime } from "luxon";
import {
  type ApiResponse,
  type ApiShowtime,
  type Movie,
  type ShowGroup,
  TZ,
  todayISO,
  theatreLabel,
  displayTitle,
  groupShowtimes,
  seriesByKey,
  seriesOf,
  Poster,
  RatingBadge,
  Badge,
  TimeChip,
} from "./showtime-ui";

export function DetailPage({ kind, param }: { kind: "movie" | "series"; param: string }) {
  const router = useRouter();
  const [shows, setShows] = useState<ApiShowtime[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    const start = todayISO();
    // Movie: server filters by id. Series: fetch the horizon and filter by pattern
    // (only a handful of series exist, and the payload matches the Upcoming feed).
    const qs =
      kind === "movie"
        ? `movieId=${encodeURIComponent(param)}&days=90&start=${start}`
        : `days=90&start=${start}`;
    setError(false);
    setShows(null);
    fetch(`/api/showtimes?${qs}`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: ApiResponse) => {
        const all = d.showtimes;
        setShows(kind === "series" ? all.filter((s) => seriesOf(s.movie.title)?.key === param) : all);
      })
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setError(true);
      });
    return () => ac.abort();
  }, [kind, param]);

  const series = kind === "series" ? seriesByKey(param) : null;

  // Days, ascending; for series each day is sub-grouped by film.
  const days = useMemo(() => {
    const m = new Map<string, ApiShowtime[]>();
    for (const s of shows ?? []) {
      if (!s.dateKey) continue;
      const arr = m.get(s.dateKey) ?? [];
      arr.push(s);
      m.set(s.dateKey, arr);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [shows]);

  const rep: Movie | null = shows && shows.length ? shows[0].movie : null;
  const distinctMovies = useMemo(() => new Set((shows ?? []).map((s) => s.movie.id)).size, [shows]);
  const title = series ? series.label : rep ? displayTitle(rep.title) : "";
  const releaseYear = rep?.releaseDate ? rep.releaseDate.slice(0, 4) : null;

  const metaParts: string[] = [];
  if (kind === "series") metaParts.push(`${distinctMovies} ${distinctMovies === 1 ? "title" : "titles"}`);
  else if (releaseYear) metaParts.push(releaseYear);
  if (shows) metaParts.push(`${shows.length} showtime${shows.length === 1 ? "" : "s"} · ${days.length} day${days.length === 1 ? "" : "s"}`);

  return (
    <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-4">
      <button
        onClick={() => router.back()}
        className="mb-3 inline-flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-sm text-ink-2 transition hover:border-line-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        ← Back
      </button>

      {error ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <p className="text-sm text-ink-2">Couldn&apos;t load showtimes.</p>
          <Link href="/" className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-black">
            Back to calendar
          </Link>
        </div>
      ) : !shows ? (
        <p className="py-20 text-center text-sm text-ink-3">Loading…</p>
      ) : shows.length === 0 ? (
        <p className="py-20 text-center text-sm text-ink-3">No upcoming showtimes for this {kind}.</p>
      ) : (
        <>
          <header className="mb-4 flex gap-3">
            {rep && <Poster movie={rep} sizeCls="w-16 sm:w-20" />}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-start gap-2">
                <h1 className="min-w-0 flex-1 font-display text-xl font-semibold leading-tight text-ink sm:text-2xl">
                  {title}
                </h1>
                {rep && (rep.letterboxdRating != null || rep.letterboxdUrl) && <RatingBadge movie={rep} />}
              </div>
              {rep && !series && (
                <div className="flex flex-wrap gap-1">
                  {rep.isClassic && <Badge tone="classic">Throwback</Badge>}
                  {rep.isSpecialEvent && <Badge tone="special">Special</Badge>}
                  {rep.isIndie && <Badge tone="indie">Indie</Badge>}
                  {rep.isForeign && <Badge tone="foreign">Foreign</Badge>}
                </div>
              )}
              {metaParts.length > 0 && <p className="text-sm text-ink-3">{metaParts.join(" · ")}</p>}
            </div>
          </header>

          {/* Day-card grid — mirrors the website's week view: one bordered column
              per playing date, with the showtimes (theatre + format + chips) inside. */}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7">
            {days.map(([day, dayShows]) => (
              <DayCard key={day} day={day} shows={dayShows} bySeries={kind === "series"} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

// A single day column, styled like the week view's DayColumn.
function DayCard({ day, shows, bySeries }: { day: string; shows: ApiShowtime[]; bySeries: boolean }) {
  const dt = DateTime.fromISO(day, { zone: TZ });
  const isToday = day === todayISO();
  return (
    <section
      className={`flex flex-col rounded-xl border bg-surface ${isToday ? "border-accent/40 ring-1 ring-accent/20" : "border-line"}`}
    >
      <h2
        className={`flex items-baseline justify-between gap-2 rounded-t-xl border-b border-line px-2 py-1.5 ${isToday ? "bg-surface-2" : ""}`}
      >
        <span className={`font-display text-[11px] font-semibold uppercase tracking-[0.1em] ${isToday ? "text-accent" : "text-ink-2"}`}>
          {dt.toFormat("ccc")}
        </span>
        <span className={`text-sm font-semibold ${isToday ? "text-accent" : "text-ink"}`}>{dt.toFormat("LLL d")}</span>
      </h2>
      <div className="flex flex-col gap-2 p-1.5">
        {bySeries ? <SeriesDay shows={shows} dt={dt} /> : <MovieDay shows={shows} dt={dt} />}
      </div>
    </section>
  );
}

// Theatre label above its row of time chips (matches the week view's MovieCard).
function TheatreTimes({ g, title, dayLabel }: { g: ShowGroup; title: string; dayLabel: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-[0.03em] text-ink-3">
        {theatreLabel(g.theatre.slug, g.theatre.name)}
        {g.tag && <span className="text-accent"> {g.tag}</span>}
      </span>
      {g.shows.map((s) => (
        <TimeChip key={s.id} s={s} movieTitle={title} dayLabel={dayLabel} />
      ))}
    </div>
  );
}

// Single-movie day: a theatre row per theatre/format.
function MovieDay({ shows, dt }: { shows: ApiShowtime[]; dt: DateTime }) {
  const title = displayTitle(shows[0].movie.title);
  const dayLabel = dt.toFormat("ccc, LLL d");
  return (
    <div className="flex flex-col gap-1">
      {groupShowtimes(shows).map((g) => (
        <TheatreTimes key={g.key} g={g} title={title} dayLabel={dayLabel} />
      ))}
    </div>
  );
}

// Series day: each film that screens that day, with its own theatre rows.
function SeriesDay({ shows, dt }: { shows: ApiShowtime[]; dt: DateTime }) {
  const dayLabel = dt.toFormat("ccc, LLL d");
  const byMovie = new Map<string, ApiShowtime[]>();
  for (const s of shows) {
    const arr = byMovie.get(s.movie.id) ?? [];
    arr.push(s);
    byMovie.set(s.movie.id, arr);
  }
  const films = [...byMovie.values()].sort((a, b) => (a[0].startsAt < b[0].startsAt ? -1 : 1));
  return (
    <>
      {films.map((filmShows) => {
        const title = displayTitle(filmShows[0].movie.title);
        return (
          <div key={filmShows[0].movie.id} className="flex flex-col gap-0.5">
            <h3 className="text-[12px] font-semibold leading-tight text-ink">{title}</h3>
            {groupShowtimes(filmShows).map((g) => (
              <TheatreTimes key={g.key} g={g} title={title} dayLabel={dayLabel} />
            ))}
          </div>
        );
      })}
    </>
  );
}
