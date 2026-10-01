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
  type MovieDetail,
  type ShowGroup,
  TZ,
  todayISO,
  theatreLabel,
  theatreRank,
  displayTitle,
  groupShowtimes,
  isCaptionTag,
  formatTag,
  seriesByKey,
  seriesOf,
  Poster,
  RatingBadge,
  Badge,
  TimeChip,
} from "./showtime-ui";
import { useTheatreOrder } from "./use-theatre-order";
import { AListOnlyContext, useAListOnly } from "./use-alist-only";

function detailRuntime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

export function DetailPage({ kind, param }: { kind: "movie" | "series"; param: string }) {
  const router = useRouter();
  const [allShows, setShows] = useState<ApiShowtime[] | null>(null);
  const [error, setError] = useState(false);
  const [detail, setDetail] = useState<MovieDetail | null>(null);
  const { order: theatreOrder } = useTheatreOrder();
  const { aListOnly, setAListOnly } = useAListOnly();
  // With "A-List only" on, drop showings AMC excludes from A-List.
  const shows = useMemo(
    () => (allShows && aListOnly ? allShows.filter((s) => !s.aListExcluded) : allShows),
    [allShows, aListOnly],
  );
  const aListHidden = (allShows?.length ?? 0) - (shows?.length ?? 0);

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
    setDetail(null);
    fetch(`/api/showtimes?${qs}`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: ApiResponse) => {
        const all = d.showtimes;
        setDetail(d.movie ?? null);
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

  // The film's own record (with synopsis, cast…) when we have it; else the first showtime's.
  const rep: Movie | null = (kind === "movie" ? detail : null) ?? (shows && shows.length ? shows[0].movie : null);
  const upcomingRelease =
    detail?.amcReleaseDate && detail.amcReleaseDate >= todayISO() ? detail.amcReleaseDate : null;
  const distinctMovies = useMemo(() => new Set((shows ?? []).map((s) => s.movie.id)).size, [shows]);
  const title = series ? series.label : rep ? displayTitle(rep.title) : "";
  const releaseYear = rep?.releaseDate ? rep.releaseDate.slice(0, 4) : null;

  // At-a-glance summary derived from the showtimes (theatres, premium formats, next show).
  const theatresList = [...new Map((shows ?? []).map((s) => [s.theatre.slug, s.theatre])).values()].sort(
    (a, b) => theatreRank(a.slug, theatreOrder) - theatreRank(b.slug, theatreOrder),
  );
  const premiumFormats = [
    ...new Set((shows ?? []).map((s) => formatTag(s.format)).filter((t): t is string => !!t && !isCaptionTag(t))),
  ];
  const nowIso = new Date().toISOString();
  const nextShow = (shows ?? []).find((s) => s.startsAt >= nowIso) ?? null;

  const metaParts: string[] = [];
  if (kind === "series") {
    metaParts.push(`${distinctMovies} ${distinctMovies === 1 ? "title" : "titles"}`);
  } else {
    if (releaseYear) metaParts.push(releaseYear);
    if (rep?.rating) metaParts.push(rep.rating);
    if (rep?.runtimeMinutes) metaParts.push(detailRuntime(rep.runtimeMinutes));
  }
  if (shows && shows.length) metaParts.push(`${shows.length} showtime${shows.length === 1 ? "" : "s"} · ${days.length} day${days.length === 1 ? "" : "s"}`);

  return (
    <AListOnlyContext.Provider value={aListOnly}>
    <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-4">
      <button
        onClick={() => (typeof window !== "undefined" && window.history.length > 1 ? router.back() : router.push("/"))}
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
      ) : shows.length === 0 && !rep ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <p className="text-sm text-ink-3">
            {aListHidden > 0
              ? `All ${aListHidden} upcoming showings are excluded from A-List.`
              : `No upcoming showtimes for this ${kind}.`}
          </p>
          {aListHidden > 0 && (
            <button onClick={() => setAListOnly(false)} className="text-sm font-medium text-accent hover:underline">
              Show them anyway
            </button>
          )}
          <Link href="/" className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-black">
            Back to calendar
          </Link>
        </div>
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
                  {detail?.genre && (
                    <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-ink-2">
                      {detail.genre}
                    </span>
                  )}
                </div>
              )}
              {metaParts.length > 0 && <p className="text-sm text-ink-3">{metaParts.join(" · ")}</p>}
              {aListHidden > 0 && (
                <p className="text-xs text-ink-3">
                  A-List only: {aListHidden} excluded showing{aListHidden === 1 ? "" : "s"} hidden ·{" "}
                  <button onClick={() => setAListOnly(false)} className="font-medium text-accent hover:underline">
                    show all
                  </button>
                </p>
              )}

              {theatresList.length > 0 && (
                <p className="text-xs text-ink-2">
                  Playing at{" "}
                  <span className="text-ink">
                    {theatresList.map((t) => theatreLabel(t.slug, t.name)).join(" · ")}
                  </span>
                </p>
              )}

              {premiumFormats.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  {premiumFormats.map((f) => (
                    <span
                      key={f}
                      className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.03em] text-accent"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              )}

              {nextShow && (
                <a
                  href={nextShow.ticketUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 inline-flex w-fit items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-sm font-semibold text-black transition hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Next: {DateTime.fromISO(nextShow.startsAt, { zone: TZ }).toFormat("ccc LLL d, h:mm a")}
                </a>
              )}
            </div>
          </header>

          {kind === "movie" && detail && <MovieInfo detail={detail} />}

          {shows.length === 0 && (
            <div className="flex flex-col items-start gap-2 rounded-xl border border-line bg-surface px-4 py-5">
              <p className="text-sm text-ink-2">
                {aListHidden > 0
                  ? `All ${aListHidden} upcoming showings are excluded from A-List.`
                  : upcomingRelease
                    ? `Announced for ${DateTime.fromISO(upcomingRelease).toFormat("cccc, LLL d")} — AMC hasn't posted showtimes yet.`
                    : "No upcoming showtimes at these theatres."}
              </p>
              {aListHidden > 0 && (
                <button onClick={() => setAListOnly(false)} className="text-sm font-medium text-accent hover:underline">
                  Show them anyway
                </button>
              )}
            </div>
          )}

          {/* Day-card grid — mirrors the website's week view: one bordered column
              per playing date, with the showtimes (theatre + format + chips) inside. */}
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-7">
            {days.map(([day, dayShows]) => (
              <DayCard
                key={day}
                day={day}
                shows={dayShows}
                bySeries={kind === "series"}
                theatreOrder={theatreOrder}
              />
            ))}
          </div>
        </>
      )}
    </main>
    </AListOnlyContext.Provider>
  );
}

// Synopsis, viewer advisory, cast, director and trailer from AMC.
function MovieInfo({ detail }: { detail: MovieDetail }) {
  const [expanded, setExpanded] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const long = (detail.synopsis?.length ?? 0) > 320;
  if (!detail.synopsis && !detail.cast && !detail.directors && !detail.trailerUrl && !detail.advisory) return null;
  return (
    <section aria-label="About this film" className="mb-4 flex max-w-3xl flex-col gap-2">
      {detail.advisory && (
        <p className="flex gap-1.5 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-1.5 text-xs text-amber-200/90">
          <span aria-hidden="true">⚠︎</span>
          <span>{detail.advisory}</span>
        </p>
      )}
      {detail.synopsis && (
        <div>
          <p className={`text-sm leading-relaxed text-ink-2 ${long && !expanded ? "line-clamp-4" : ""}`}>{detail.synopsis}</p>
          {long && (
            <button onClick={() => setExpanded((v) => !v)} className="mt-0.5 text-xs font-medium text-accent hover:underline">
              {expanded ? "Less" : "More"}
            </button>
          )}
        </div>
      )}
      {(detail.cast || detail.directors) && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
          {detail.cast && (
            <>
              <dt className="text-ink-3">Starring</dt>
              <dd className="text-ink-2">{detail.cast}</dd>
            </>
          )}
          {detail.directors && (
            <>
              <dt className="text-ink-3">Directed by</dt>
              <dd className="text-ink-2">{detail.directors}</dd>
            </>
          )}
        </dl>
      )}
      {detail.trailerUrl &&
        (showTrailer ? (
          <div className="aspect-video w-full overflow-hidden rounded-lg border border-line bg-black">
            <iframe
              src={detail.trailerUrl}
              title={`${detail.title} trailer`}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              allowFullScreen
              className="h-full w-full"
            />
          </div>
        ) : (
          <button
            onClick={() => setShowTrailer(true)}
            className="inline-flex w-fit items-center gap-1.5 rounded-full border border-line-2 px-3 py-1.5 text-sm text-ink-2 transition hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            ▶ Watch trailer
          </button>
        ))}
    </section>
  );
}

// A single day column, styled like the week view's DayColumn.
function DayCard({
  day,
  shows,
  bySeries,
  theatreOrder,
}: {
  day: string;
  shows: ApiShowtime[];
  bySeries: boolean;
  theatreOrder: readonly string[];
}) {
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
        {bySeries ? (
          <SeriesDay shows={shows} dt={dt} theatreOrder={theatreOrder} />
        ) : (
          <MovieDay shows={shows} dt={dt} theatreOrder={theatreOrder} />
        )}
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
        {g.tag && <span className={isCaptionTag(g.tag) ? "" : "text-accent"}> {g.tag}</span>}
      </span>
      {g.shows.map((s) => (
        <TimeChip key={s.id} s={s} movieTitle={title} dayLabel={dayLabel} />
      ))}
    </div>
  );
}

// Single-movie day: a theatre row per theatre/format.
function MovieDay({ shows, dt, theatreOrder }: { shows: ApiShowtime[]; dt: DateTime; theatreOrder: readonly string[] }) {
  const title = displayTitle(shows[0].movie.title);
  const dayLabel = dt.toFormat("ccc, LLL d");
  return (
    <div className="flex flex-col gap-1">
      {groupShowtimes(shows, theatreOrder).map((g) => (
        <TheatreTimes key={g.key} g={g} title={title} dayLabel={dayLabel} />
      ))}
    </div>
  );
}

// Series day: each film that screens that day, with its own theatre rows.
function SeriesDay({ shows, dt, theatreOrder }: { shows: ApiShowtime[]; dt: DateTime; theatreOrder: readonly string[] }) {
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
            {groupShowtimes(filmShows, theatreOrder).map((g) => (
              <TheatreTimes key={g.key} g={g} title={title} dayLabel={dayLabel} />
            ))}
          </div>
        );
      })}
    </>
  );
}
