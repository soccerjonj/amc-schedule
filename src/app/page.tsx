"use client";

import { Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DateTime } from "luxon";

const TZ = "America/Chicago";

interface Movie {
  id: string;
  title: string;
  slug: string;
  isClassic: boolean;
  isSpecialEvent: boolean;
  isIndie: boolean;
  isForeign: boolean;
  isRare: boolean;
  posterUrl: string | null;
  letterboxdRating: number | null;
  letterboxdUrl: string | null;
}

interface ApiShowtime {
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

interface ApiResponse {
  start: string;
  days: number;
  dayKeys: string[];
  theatres: { slug: string; name: string }[];
  showtimes: ApiShowtime[];
  total: number;
}

type Category = "all" | "gems" | "classic" | "special";
type Density = "compact" | "list";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "all", label: "All" },
  { value: "gems", label: "Gems" },
  { value: "classic", label: "Classics" },
  { value: "special", label: "Special" },
];

const THEATRE_LABEL: Record<string, string> = {
  "amc-river-east-21": "River East",
  "amc-600-north-michigan-9": "600 N Mich",
  "amc-newcity-14": "NewCity",
  "amc-dine-in-block-37": "Block 37",
  "amc-roosevelt-collection-16": "Roosevelt",
};

const CHIP_LIMIT = 7; // collapse long showtime lists behind a "+N" toggle
const HIDDEN_KEY = "amc:hidden";

function todayISO() {
  return DateTime.now().setZone(TZ).startOf("day").toISODate()!;
}

function loadHidden(): Map<string, string> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return new Map(Array.isArray(raw) ? (raw as [string, string][]) : []);
  } catch {
    return new Map();
  }
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Calendar />
    </Suspense>
  );
}

function Calendar() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [weekStart, setWeekStart] = useState<string>(() => params.get("d") || todayISO());
  const [category, setCategory] = useState<Category>(() => asCategory(params.get("cat")));
  const [selectedTheatres, setSelectedTheatres] = useState<string[]>(
    () => params.get("th")?.split(",").filter(Boolean) ?? [],
  );
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [density, setDensity] = useState<Density>(() => (params.get("view") === "list" ? "list" : "compact"));
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [hidden, setHidden] = useState<Map<string, string>>(() => new Map());
  const [showHidden, setShowHidden] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // Load the dismissed-movie list once on the client (avoids SSR hydration mismatch).
  useEffect(() => setHidden(loadHidden()), []);

  const hideMovie = useCallback((id: string, title: string) => {
    setHidden((prev) => {
      const next = new Map(prev).set(id, title);
      window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next.entries()]));
      return next;
    });
  }, []);

  const restoreMovie = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Map(prev);
      next.delete(id);
      window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next.entries()]));
      return next;
    });
  }, []);

  function clearHidden() {
    setHidden(new Map());
    window.localStorage.removeItem(HIDDEN_KEY);
  }

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Reflect state in the URL so views are shareable/bookmarkable and survive reload.
  useEffect(() => {
    const p = new URLSearchParams();
    if (weekStart !== todayISO()) p.set("d", weekStart);
    if (category !== "all") p.set("cat", category);
    if (selectedTheatres.length) p.set("th", selectedTheatres.join(","));
    if (debouncedQuery) p.set("q", debouncedQuery);
    if (density !== "compact") p.set("view", density);
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [weekStart, category, selectedTheatres, debouncedQuery, density, pathname, router]);

  useEffect(() => {
    const p = new URLSearchParams({ start: weekStart, days: "7", category });
    if (selectedTheatres.length) p.set("theatres", selectedTheatres.join(","));
    if (debouncedQuery) p.set("q", debouncedQuery);
    const ac = new AbortController();
    setLoading(true);
    setError(false);
    fetch(`/api/showtimes?${p.toString()}`, { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: ApiResponse) => setData(d))
      .catch((e: unknown) => {
        if ((e as Error).name !== "AbortError") setError(true);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [weekStart, category, selectedTheatres, debouncedQuery, reloadKey]);

  // Pin day headers just below the (variable-height) sticky bar.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--bar-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visibleShowtimes = useMemo(
    () => (data?.showtimes ?? []).filter((s) => !hidden.has(s.movie.id)),
    [data, hidden],
  );
  const byDay = useMemo(() => groupByDay(visibleShowtimes), [visibleShowtimes]);
  const theatres = data?.theatres ?? [];
  const movieCount = useMemo(
    () => new Set(visibleShowtimes.map((s) => s.movie.id)).size,
    [visibleShowtimes],
  );

  function toggleTheatre(slug: string) {
    setSelectedTheatres((cur) =>
      cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug],
    );
  }

  const navBtn =
    "rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 transition hover:border-line-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <>
      <header ref={barRef} className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-2.5 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="font-display text-xl font-semibold tracking-wide text-ink">
              AMC <span className="text-accent">Showtimes</span>
            </h1>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setWeekStart(todayISO())} className={navBtn}>
                Today
              </button>
              <button onClick={() => setWeekStart(shift(weekStart, -7))} aria-label="Previous week" className={navBtn}>
                ←
              </button>
              <button onClick={() => setWeekStart(shift(weekStart, 7))} aria-label="Next week" className={navBtn}>
                →
              </button>
              <span className="ml-1 text-sm font-medium text-ink-2">{formatRange(weekStart)}</span>
            </div>

            <div className="ml-auto flex items-center gap-2.5">
              <span className="text-xs text-ink-3" aria-live="polite">
                {loading ? (
                  "updating…"
                ) : error ? (
                  <span className="text-rose-300">failed to load</span>
                ) : data ? (
                  `${movieCount} ${movieCount === 1 ? "movie" : "movies"} · ${visibleShowtimes.length} showtimes`
                ) : (
                  ""
                )}
              </span>
              {hidden.size > 0 && (
                <button
                  onClick={() => setShowHidden((v) => !v)}
                  aria-expanded={showHidden}
                  className="rounded-full border border-line px-2.5 py-1 text-xs font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {hidden.size} hidden
                </button>
              )}
              <DensityToggle value={density} onChange={setDensity} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <div role="group" aria-label="Category" className="flex items-center gap-1.5">
              {CATEGORIES.map((c) => {
                const active = category === c.value;
                const activeCls = c.value === "gems" ? "bg-gem text-black" : "bg-accent text-black";
                return (
                  <button
                    key={c.value}
                    aria-pressed={active}
                    onClick={() => setCategory(c.value)}
                    className={`rounded-full px-3 py-1 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      active ? activeCls : "border border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink"
                    }`}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>

            <span className="mx-1 hidden h-5 w-px bg-line-2 sm:block" aria-hidden="true" />

            {theatres.map((t) => {
              const selected = selectedTheatres.includes(t.slug);
              const dimmed = selectedTheatres.length > 0 && !selected;
              return (
                <button
                  key={t.slug}
                  aria-pressed={selected}
                  title={t.name}
                  onClick={() => toggleTheatre(t.slug)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    selected
                      ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                      : dimmed
                        ? "border border-line text-ink-3"
                        : "border border-line-2 text-ink-2 hover:text-ink"
                  }`}
                >
                  {theatreLabel(t.slug, t.name)}
                </button>
              );
            })}
            {selectedTheatres.length > 0 && (
              <button onClick={() => setSelectedTheatres([])} className="text-xs text-accent hover:underline">
                clear
              </button>
            )}

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search movies by title"
              placeholder="Search movie…"
              className="ml-auto w-40 rounded-full border border-line bg-surface px-3 py-1 text-sm text-ink outline-none transition placeholder:text-ink-3 focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent sm:w-56"
            />
          </div>

          {showHidden && hidden.size > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                Hidden
              </span>
              {[...hidden.entries()].map(([id, title]) => (
                <button
                  key={id}
                  onClick={() => restoreMovie(id)}
                  title={`Restore ${title}`}
                  className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs text-ink-2 transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="max-w-[12rem] truncate">{title}</span>
                  <span aria-hidden="true" className="text-ink-3">＋</span>
                </button>
              ))}
              <button
                onClick={clearHidden}
                className="ml-1 text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Restore all
              </button>
            </div>
          )}

          {data && data.dayKeys.length > 0 && (
            <nav aria-label="Jump to day" className="flex gap-1 overflow-x-auto">
              {data.dayKeys.map((day) => {
                const dt = DateTime.fromISO(day, { zone: TZ });
                const isToday = day === todayISO();
                return (
                  <button
                    key={day}
                    onClick={() =>
                      document.getElementById(`day-${day}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                    className={`flex-none rounded-full px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      isToday
                        ? "bg-accent/15 text-accent ring-1 ring-accent/30"
                        : "border border-line text-ink-2 hover:bg-surface-2 hover:text-ink"
                    }`}
                  >
                    {dt.toFormat("ccc d")}
                  </button>
                );
              })}
            </nav>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1500px] flex-1 px-4 py-4">
        {error && !data ? (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <p className="text-sm text-ink-2">Couldn&apos;t load showtimes.</p>
            <button
              onClick={() => setReloadKey((k) => k + 1)}
              className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-black"
            >
              Retry
            </button>
          </div>
        ) : (
          <div role="list" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            {(data?.dayKeys ?? []).map((day) => (
              <DayColumn key={day} day={day} groups={byDay[day] ?? []} density={density} onHide={hideMovie} />
            ))}
          </div>
        )}

        {data && data.total === 0 && !error && (
          <p className="mt-10 text-center text-sm text-ink-3">
            {debouncedQuery
              ? `No movies match “${debouncedQuery}” this week.`
              : "No showtimes match these filters this week."}
          </p>
        )}
      </main>
    </>
  );
}

function DensityToggle({ value, onChange }: { value: Density; onChange: (d: Density) => void }) {
  const opts: { v: Density; label: string }[] = [
    { v: "compact", label: "Compact" },
    { v: "list", label: "List" },
  ];
  return (
    <div role="group" aria-label="Density" className="flex items-center rounded-full border border-line p-0.5">
      {opts.map((o) => (
        <button
          key={o.v}
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={`rounded-full px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            value === o.v ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface MovieGroup {
  movie: Movie;
  isGem: boolean;
  earliest: string;
  shows: ApiShowtime[];
}

function groupByDay(shows: ApiShowtime[]): Record<string, MovieGroup[]> {
  const days: Record<string, Map<string, MovieGroup>> = {};
  for (const s of shows) {
    const day = s.dateKey;
    if (!day) continue;
    days[day] ??= new Map();
    const g =
      days[day].get(s.movie.id) ?? {
        movie: s.movie,
        isGem: s.isGem,
        earliest: s.startsAt,
        shows: [],
      };
    g.shows.push(s);
    if (s.startsAt < g.earliest) g.earliest = s.startsAt;
    days[day].set(s.movie.id, g);
  }
  const out: Record<string, MovieGroup[]> = {};
  for (const [day, map] of Object.entries(days)) {
    out[day] = [...map.values()].sort((a, b) => {
      if (a.isGem !== b.isGem) return a.isGem ? -1 : 1;
      return a.earliest < b.earliest ? -1 : 1;
    });
  }
  return out;
}

const DayColumn = memo(function DayColumn({
  day,
  groups,
  density,
  onHide,
}: {
  day: string;
  groups: MovieGroup[];
  density: Density;
  onHide: (id: string, title: string) => void;
}) {
  const dt = DateTime.fromISO(day, { zone: TZ });
  const isToday = day === todayISO();
  const dayLabel = dt.toFormat("ccc, LLL d");
  return (
    <section
      id={`day-${day}`}
      role="listitem"
      aria-label={dt.toFormat("cccc, LLLL d")}
      className={`flex scroll-mt-[calc(var(--bar-h)+0.5rem)] flex-col rounded-xl border bg-surface ${
        isToday ? "border-accent/40 ring-1 ring-accent/20" : "border-line"
      }`}
    >
      <h2
        className={`sticky top-[var(--bar-h)] z-10 flex items-baseline justify-between gap-2 rounded-t-xl border-b border-line px-2.5 py-2 ${
          isToday ? "bg-surface-2" : "bg-surface"
        }`}
      >
        <span
          className={`font-display text-sm font-semibold uppercase tracking-[0.12em] ${
            isToday ? "text-accent" : "text-ink-2"
          }`}
        >
          {dt.toFormat("ccc")}
        </span>
        <span className={`text-sm font-semibold ${isToday ? "text-accent" : "text-ink"}`}>
          {dt.toFormat("LLL d")}
        </span>
      </h2>
      <div className="flex flex-col gap-1.5 p-1.5">
        {groups.length === 0 ? (
          <p className="py-6 text-center text-xs text-ink-3">No showtimes</p>
        ) : (
          groups.map((g) => (
            <MovieCard key={g.movie.id} group={g} density={density} dayLabel={dayLabel} onHide={onHide} />
          ))
        )}
      </div>
    </section>
  );
});

const MovieCard = memo(function MovieCard({
  group,
  density,
  dayLabel,
  onHide,
}: {
  group: MovieGroup;
  density: Density;
  dayLabel: string;
  onHide: (id: string, title: string) => void;
}) {
  const { movie } = group;
  const [expanded, setExpanded] = useState(false);
  const groups = useMemo(() => groupShowtimes(group.shows), [group.shows]);
  const total = group.shows.length;
  const showGroups = expanded || total <= CHIP_LIMIT ? groups : trimGroups(groups, CHIP_LIMIT);
  const hidden = total - countShows(showGroups);
  const worldCup = isWorldCup(movie.title);
  const title = displayTitle(movie.title);

  return (
    <article
      className={`group flex gap-2 rounded-lg border p-1.5 transition ${
        group.isGem
          ? "border-gem/40 bg-gem/[0.04] ring-1 ring-gem/15 hover:bg-gem/[0.07]"
          : "border-line hover:bg-surface-2"
      }`}
    >
      {density !== "list" &&
        (worldCup ? (
          <WorldCupPoster />
        ) : (
          <div className="relative aspect-[2/3] w-10 flex-none self-start overflow-hidden rounded bg-surface-3">
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
        ))}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-1.5">
          <h3 className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-tight text-ink">
            {title}
          </h3>
          {(movie.letterboxdRating != null || movie.letterboxdUrl) && <RatingBadge movie={movie} />}
          <button
            onClick={() => onHide(movie.id, title)}
            aria-label={`Hide ${title} from all days`}
            title="Hide this movie"
            className="-mr-0.5 -mt-0.5 flex-none rounded p-0.5 text-ink-3 opacity-60 transition hover:bg-surface-3 hover:text-rose-300 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {(movie.isClassic ||
          movie.isSpecialEvent ||
          movie.isIndie ||
          movie.isForeign ||
          movie.isRare) && (
          <div className="flex flex-wrap gap-1">
            {movie.isClassic && <Badge tone="classic">Classic</Badge>}
            {movie.isSpecialEvent && <Badge tone="special">Special</Badge>}
            {movie.isIndie && <Badge tone="indie">Indie</Badge>}
            {movie.isForeign && <Badge tone="foreign">Foreign</Badge>}
            {movie.isRare && <Badge tone="rare">Rare</Badge>}
          </div>
        )}

        <div className="flex flex-col gap-1">
          {showGroups.map((g) => (
            <div key={g.key} className="flex flex-wrap items-center gap-1">
              <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-[0.03em] text-ink-3">
                {theatreLabel(g.theatre.slug, g.theatre.name)}
                {g.tag && <span className="text-accent"> {g.tag}</span>}
              </span>
              {g.shows.map((s) => (
                <TimeChip key={s.id} s={s} movieTitle={title} dayLabel={dayLabel} />
              ))}
            </div>
          ))}
          {hidden > 0 && (
            <button
              onClick={() => setExpanded(true)}
              className="self-start rounded-md py-0.5 text-[11px] font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              +{hidden} more
            </button>
          )}
        </div>
      </div>
    </article>
  );
});

function TimeChip({ s, movieTitle, dayLabel }: { s: ApiShowtime; movieTitle: string; dayLabel: string }) {
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

function LetterboxdMark() {
  // The Letterboxd three-dot mark (orange / green / blue) — shown when a film has
  // a page but no average rating yet (e.g. unreleased).
  return (
    <svg viewBox="0 0 26 10" className="h-2.5 w-auto" aria-hidden="true">
      <circle cx="5" cy="5" r="4.6" fill="#ff8000" />
      <circle cx="13" cy="5" r="4.6" fill="#00e054" />
      <circle cx="21" cy="5" r="4.6" fill="#40bcf4" />
    </svg>
  );
}

function RatingBadge({ movie }: { movie: Movie }) {
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

function Badge({
  tone,
  children,
}: {
  tone: "classic" | "special" | "indie" | "foreign" | "rare";
  children: React.ReactNode;
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

function FilmIcon({ className }: { className?: string }) {
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

interface ShowGroup {
  key: string;
  theatre: { slug: string; name: string };
  tag: string | null; // shared format tag, shown once in the label
  shows: ApiShowtime[];
}

// Group a movie's showtimes by theatre + format so the format label appears once
// and each time renders as a tiny bare pill (several fit per row).
function groupShowtimes(shows: ApiShowtime[]): ShowGroup[] {
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

function trimGroups(groups: ShowGroup[], limit: number): ShowGroup[] {
  const out: ShowGroup[] = [];
  let n = 0;
  for (const g of groups) {
    if (n >= limit) break;
    const take = g.shows.slice(0, limit - n);
    out.push({ ...g, shows: take });
    n += take.length;
  }
  return out;
}

function countShows(groups: ShowGroup[]): number {
  return groups.reduce((n, g) => n + g.shows.length, 0);
}

// "7:00 PM" -> "7p", "7:30 PM" -> "7:30p", "11:30 AM" -> "11:30a".
function compactTime(t: string): string {
  const m = t.match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
  if (!m) return t;
  const [, h, min, ap] = m;
  const suffix = ap.toLowerCase();
  return min === "00" ? `${h}${suffix}` : `${h}:${min}${suffix}`;
}

function theatreLabel(slug: string, fallback: string): string {
  return THEATRE_LABEL[slug] ?? fallback;
}

const WORLD_CUP_RE = /copa mundial de la fifa|fifa world cup/i;

function isWorldCup(title: string): boolean {
  return WORLD_CUP_RE.test(title);
}

// FIFA broadcasts come as "México vs. Sudáfrica - Telemundo presenta la Copa
// Mundial de la FIFA 2026" — trim to just the matchup before the " - " separator.
function displayTitle(title: string): string {
  if (isWorldCup(title)) return title.split(/\s+[-–—]\s+/)[0].trim() || title;
  return title;
}

// Poster slot for FIFA World Cup broadcasts (no film poster on TMDB). Uses the
// bundled World Cup image cropped to its emblem (object-top, since the artwork
// puts the emblem up top and text below); falls back to a soccer-ball tile if the
// image isn't present.
function WorldCupPoster() {
  const [imgOk, setImgOk] = useState(true);
  return (
    <div
      aria-hidden="true"
      className="relative flex aspect-[2/3] w-10 flex-none self-start items-center justify-center overflow-hidden rounded bg-gradient-to-br from-emerald-700 to-sky-800"
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

function asCategory(v: string | null): Category {
  return v === "gems" || v === "classic" || v === "special" ? v : "all";
}

// AMC's format strings are messy ("IMAX with Laser at AMC", "PRIME at AMC",
// "RealD 3D", language/caption variants), so match by substring.
function formatTag(format: string | null): string | null {
  if (!format) return null;
  const f = format.toLowerCase();
  if (f.includes("imax")) return "IMAX";
  if (f.includes("dolby")) return "Dolby";
  if (f.includes("prime")) return "Prime";
  if (f.includes("laser")) return "Laser";
  if (f.includes("3d")) return "3D";
  return null;
}

// Posters render as ~48px thumbnails; w185 is plenty and far lighter than the stored w342.
function posterSrc(url: string): string {
  return url.replace(/\/w\d+\//, "/w185/");
}

function shift(iso: string, days: number): string {
  return DateTime.fromISO(iso, { zone: TZ }).plus({ days }).toISODate()!;
}

function formatRange(startISO: string): string {
  const start = DateTime.fromISO(startISO, { zone: TZ });
  const end = start.plus({ days: 6 });
  return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d")}`;
}
