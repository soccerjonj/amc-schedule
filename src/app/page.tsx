"use client";

import { Suspense, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { DateTime } from "luxon";
import {
  type Movie,
  type ApiShowtime,
  type ApiResponse,
  type ShowGroup,
  TZ,
  todayISO,
  theatreLabel,
  displayTitle,
  seriesOf,
  groupShowtimes,
  isCaptionTag,
  formatTag,
  PREMIUM_FORMATS,
  BADGE_GLOSS,
  Poster,
  RatingBadge,
  Badge,
  TimeChip,
} from "@/components/showtime-ui";

type Category = "all" | "gems" | "classic" | "special";
type Density = "compact" | "list";

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "all", label: "All" },
  { value: "gems", label: "Gems" },
  { value: "classic", label: "Throwbacks" },
  { value: "special", label: "Special" },
];

const CHIP_LIMIT = 7; // collapse long showtime lists behind a "+N" toggle
const HIDDEN_KEY = "amc:hidden";
const MONTH_SPAN = 28; // days in the rolling month grid (4 rows of 7); keep a multiple of 7
const GEM_PREVIEW = 4; // gem titles shown per day cell before "+N more"
const UPCOMING_SPAN = 90; // days the Upcoming feed scans (the full scrape horizon)
const RARE_DAYS = 3; // ≤ this many distinct play-dates across the horizon ⇒ rare (window-stable)

type Mode = "week" | "month" | "upcoming";

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
  const [selectedFormats, setSelectedFormats] = useState<string[]>(
    () => params.get("fmt")?.split(",").filter(Boolean) ?? [],
  );
  const [density, setDensity] = useState<Density>(() => (params.get("view") === "list" ? "list" : "compact"));
  const [mode, setMode] = useState<Mode>(() => {
    const m = params.get("mode");
    return m === "month" || m === "upcoming" ? m : "week";
  });
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [hidden, setHidden] = useState<Map<string, string>>(() => new Map());
  const [showHidden, setShowHidden] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // Month grid is Sunday-aligned; the week view starts at the anchor as-is.
  const gridStart = useMemo(() => startOfSundayWeek(weekStart), [weekStart]);

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
    if (selectedFormats.length) p.set("fmt", selectedFormats.join(","));
    if (debouncedQuery) p.set("q", debouncedQuery);
    if (density !== "compact") p.set("view", density);
    if (mode !== "week") p.set("mode", mode);
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [weekStart, category, selectedTheatres, selectedFormats, debouncedQuery, density, mode, pathname, router]);

  useEffect(() => {
    // Upcoming is always anchored at today over the full horizon; week/month follow the anchor.
    const fetchStart = mode === "upcoming" ? todayISO() : mode === "month" ? gridStart : weekStart;
    const fetchDays =
      mode === "upcoming" ? String(UPCOMING_SPAN) : mode === "month" ? String(MONTH_SPAN) : "7";
    const p = new URLSearchParams({ start: fetchStart, days: fetchDays, category });
    if (selectedTheatres.length) p.set("theatres", selectedTheatres.join(","));
    if (selectedFormats.length) p.set("fmt", selectedFormats.join(","));
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
  }, [weekStart, gridStart, mode, category, selectedTheatres, debouncedQuery, reloadKey]);

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
  const upcomingBuckets = useMemo(
    () => (mode === "upcoming" ? aggregateUpcoming(visibleShowtimes) : EMPTY_UPCOMING),
    [mode, visibleShowtimes],
  );
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

  function toggleFormat(f: string) {
    setSelectedFormats((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]));
  }

  const anyFilter =
    category !== "all" || selectedTheatres.length > 0 || selectedFormats.length > 0 || debouncedQuery.length > 0;

  function clearFilters() {
    setCategory("all");
    setSelectedTheatres([]);
    setSelectedFormats([]);
    setQuery("");
  }

  const activeFilterSummary = [
    debouncedQuery ? `“${debouncedQuery}”` : "",
    category !== "all" ? CATEGORIES.find((c) => c.value === category)?.label ?? "" : "",
    selectedFormats.join("/"),
    selectedTheatres.map((s) => theatreLabel(s, s)).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");

  const navBtn =
    "rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 transition hover:border-line-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
  const step = mode === "month" ? MONTH_SPAN : 7;
  const rangeLabel = mode === "month" ? formatMonthRange(gridStart) : formatRange(weekStart);

  return (
    <>
      <header ref={barRef} className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-2.5 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="font-display text-xl font-semibold tracking-wide text-ink">
              AMC <span className="text-accent">Showtimes</span>
            </h1>
            {mode === "upcoming" ? (
              <span className="ml-1 text-sm font-medium text-ink-2">Next 90 days</span>
            ) : (
              <div className="flex items-center gap-1.5">
                <button onClick={() => setWeekStart(todayISO())} className={navBtn}>
                  Today
                </button>
                <button onClick={() => setWeekStart(upcomingFriday())} className={navBtn} title="Jump to this weekend">
                  Weekend
                </button>
                <button onClick={() => setWeekStart(shift(weekStart, -step))} aria-label="Previous" className={navBtn}>
                  ←
                </button>
                <button onClick={() => setWeekStart(shift(weekStart, step))} aria-label="Next" className={navBtn}>
                  →
                </button>
                <span className="ml-1 text-sm font-medium text-ink-2">{rangeLabel}</span>
              </div>
            )}

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
              {mode === "week" && <DensityToggle value={density} onChange={setDensity} />}
              <ModeToggle value={mode} onChange={setMode} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
            <div role="group" aria-label="Category" className="flex items-center gap-1.5">
              {CATEGORIES.map((c) => {
                const active = category === c.value;
                const activeCls = c.value === "gems" ? "bg-gem text-black" : "bg-accent text-black";
                const tip =
                  c.value === "gems"
                    ? BADGE_GLOSS.Gem
                    : c.value === "classic"
                      ? BADGE_GLOSS.Throwback
                      : c.value === "special"
                        ? BADGE_GLOSS.Special
                        : undefined;
                return (
                  <button
                    key={c.value}
                    aria-pressed={active}
                    title={tip}
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
              aria-label="Search by title, format, or series"
              placeholder="Search title or “70mm”…"
              className="ml-auto w-40 rounded-full border border-line bg-surface px-3 py-1 text-sm text-ink outline-none transition placeholder:text-ink-3 focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent sm:w-56"
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">Format</span>
            <div role="group" aria-label="Format" className="flex flex-wrap items-center gap-1.5">
              {PREMIUM_FORMATS.map((f) => {
                const selected = selectedFormats.includes(f);
                const dimmed = selectedFormats.length > 0 && !selected;
                return (
                  <button
                    key={f}
                    aria-pressed={selected}
                    onClick={() => toggleFormat(f)}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      selected
                        ? "bg-accent/20 text-accent ring-1 ring-accent/40"
                        : dimmed
                          ? "border border-line text-ink-3"
                          : "border border-line-2 text-ink-2 hover:text-ink"
                    }`}
                  >
                    {f}
                  </button>
                );
              })}
            </div>
            <p className="ml-1 hidden text-[11px] text-ink-3 sm:block">
              <span className="font-semibold text-gem">Gems</span> = easy-to-miss screenings (throwbacks, special
              events, rare & indie).
            </p>
            {anyFilter && (
              <button
                onClick={clearFilters}
                className="ml-auto rounded-full px-2 py-1 text-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Clear all
              </button>
            )}
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

          {mode === "week" && data && data.dayKeys.length > 0 && (
            <nav aria-label="Jump to day" className="flex gap-1 overflow-x-auto">
              {data.dayKeys.map((day) => {
                const dt = DateTime.fromISO(day, { zone: TZ });
                const isToday = day === todayISO();
                return (
                  <button
                    key={day}
                    aria-current={isToday ? "date" : undefined}
                    onClick={() => {
                      const reduce =
                        typeof window !== "undefined" &&
                        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                      document
                        .getElementById(`day-${day}`)
                        ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
                    }}
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
        ) : mode === "upcoming" ? (
          <UpcomingView
            buckets={upcomingBuckets}
            onHide={hideMovie}
            onClear={anyFilter ? clearFilters : undefined}
          />
        ) : mode === "month" ? (
          <MonthView
            dayKeys={data?.dayKeys ?? []}
            byDay={byDay}
            onJumpToDay={(day) => {
              setWeekStart(day);
              setMode("week");
            }}
          />
        ) : (
          <div role="list" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
            {(data?.dayKeys ?? []).map((day) => (
              <DayColumn key={day} day={day} groups={byDay[day] ?? []} density={density} onHide={hideMovie} />
            ))}
          </div>
        )}

        {data && data.total === 0 && !error && mode !== "upcoming" && (
          <div className="mt-10 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-ink-3">
              {activeFilterSummary
                ? `No showtimes for ${activeFilterSummary} ${mode === "month" ? "this month" : "this week"}.`
                : `No showtimes ${mode === "month" ? "this month" : "this week"}.`}
            </p>
            {anyFilter && (
              <button
                onClick={clearFilters}
                className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Clear filters
              </button>
            )}
          </div>
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

function ModeToggle({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const opts: { v: Mode; label: string }[] = [
    { v: "week", label: "Week" },
    { v: "month", label: "Month" },
    { v: "upcoming", label: "Upcoming" },
  ];
  return (
    <div role="group" aria-label="View span" className="flex items-center rounded-full border border-line p-0.5">
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

// Category encoding for a month-cell preview line (a colored dot per title).
type CellTone = "special" | "rare" | "classic" | "indie" | "foreign" | "series" | "plain";

const TONE_DOT: Record<CellTone, string> = {
  special: "bg-special",
  rare: "bg-rare",
  classic: "bg-classic",
  indie: "bg-emerald-400",
  foreign: "bg-orange-400",
  series: "bg-ink-3", // recurring-broadcast firehose (World Cup) — recessive
  plain: "bg-ink-3",
};

// Lower = more notable; drives which titles survive into the (tiny) cell preview.
const TONE_RANK: Record<CellTone, number> = {
  special: 0,
  rare: 1,
  classic: 2,
  indie: 3,
  foreign: 4,
  series: 5,
  plain: 6,
};

// Recurring series treated as background noise (matches dominate the schedule but
// aren't "gems" in the user's mind). Other series (Ghibli Fest, Met) stay gems.
const NOISE_SERIES = new Set(["fifa-world-cup"]);

function movieTone(m: Movie): CellTone {
  if (m.isSpecialEvent) return "special";
  if (m.isRare) return "rare";
  if (m.isClassic) return "classic";
  if (m.isIndie) return "indie";
  if (m.isForeign) return "foreign";
  return "plain";
}

interface PreviewItem {
  label: string;
  tone: CellTone;
  count?: number; // distinct matches/films when this line is a collapsed series
}

interface CellData {
  day: string;
  dt: DateTime;
  total: number; // distinct titles/series that day (series counted once)
  gemCount: number; // highlighted gems (collapsed series count once; World Cup excluded)
  hero: boolean; // a special-event one-off OR 2+ gems → the day glows
  preview: PreviewItem[];
  moreCount: number;
  isToday: boolean;
  isPast: boolean;
  empty: boolean;
}

function cellData(day: string, byDay: Record<string, MovieGroup[]>): CellData {
  const groups = byDay[day] ?? [];
  // Collapse recurring series (FIFA World Cup, Ghibli Fest…) into a single entry so a
  // soccer-heavy day doesn't bury real gems — mirrors the Upcoming feed.
  interface Entry {
    rep: MovieGroup;
    tone: CellTone;
    label: string;
    isGemShown: boolean; // gem AND not noise → counts/glows
    isSeries: boolean;
    count: number;
    earliest: string;
  }
  const map = new Map<string, Entry>();
  for (const g of groups) {
    const series = seriesOf(g.movie.title);
    const noise = series ? NOISE_SERIES.has(series.key) : false;
    const key = series ? series.key : g.movie.id;
    let e = map.get(key);
    if (!e) {
      e = {
        rep: g,
        tone: noise ? "series" : movieTone(g.movie),
        label: series ? series.label : displayTitle(g.movie.title),
        isGemShown: g.isGem && !noise,
        isSeries: !!series,
        count: 0,
        earliest: g.earliest,
      };
      map.set(key, e);
    }
    e.count++;
    e.isGemShown = e.isGemShown || (g.isGem && !noise);
    if (g.earliest < e.earliest) e.earliest = g.earliest;
  }
  const entries = [...map.values()];
  // Rank: shown-gems first, then by notability, then earliest.
  entries.sort((a, b) => {
    const ag = a.isGemShown ? 0 : 1;
    const bg = b.isGemShown ? 0 : 1;
    if (ag !== bg) return ag - bg;
    const ar = TONE_RANK[a.tone];
    const br = TONE_RANK[b.tone];
    if (ar !== br) return ar - br;
    return a.earliest < b.earliest ? -1 : 1;
  });
  const gems = entries.filter((e) => e.isGemShown);
  // "Hero" = a genuine special event / anniversary that day (these are the real
  // standouts). Plain gem days are common here, so 2+ gems would glow everywhere.
  const hasSpecial = gems.some((e) => e.rep.movie.isSpecialEvent);
  const today = todayISO();
  return {
    day,
    dt: DateTime.fromISO(day, { zone: TZ }),
    total: entries.length,
    gemCount: gems.length,
    hero: hasSpecial,
    preview: entries.slice(0, GEM_PREVIEW).map((e) => ({
      label: e.label,
      tone: e.tone,
      count: e.isSeries ? e.count : undefined,
    })),
    moreCount: Math.max(0, entries.length - GEM_PREVIEW),
    isToday: day === today,
    isPast: day < today,
    empty: groups.length === 0,
  };
}

function MonthView({
  dayKeys,
  byDay,
  onJumpToDay,
}: {
  dayKeys: string[];
  byDay: Record<string, MovieGroup[]>;
  onJumpToDay: (day: string) => void;
}) {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const cells = dayKeys.map((d) => cellData(d, byDay));
  return (
    <>
      {/* Desktop / tablet: weekday-aligned 7-col grid */}
      <div className="hidden sm:block">
        <div className="grid grid-cols-7 gap-1.5 pb-1.5">
          {weekdays.map((w) => (
            <div
              key={w}
              className="px-1 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-3"
            >
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1.5">
          {cells.map((c) => (
            <MonthCell key={c.day} c={c} onJump={onJumpToDay} variant="grid" />
          ))}
        </div>
      </div>
      {/* Mobile: scrollable agenda list */}
      <div className="flex flex-col gap-1.5 sm:hidden">
        {cells.map((c) => (
          <MonthCell key={c.day} c={c} onJump={onJumpToDay} variant="agenda" />
        ))}
      </div>
    </>
  );
}

function MonthCell({
  c,
  onJump,
  variant,
}: {
  c: CellData;
  onJump: (day: string) => void;
  variant: "grid" | "agenda";
}) {
  // Visual weight tracks gem density: notable days glow, noise/empty days recede.
  const stateCls = c.isToday
    ? "border-accent/40 bg-surface-2 ring-1 ring-accent/20"
    : c.empty
      ? "border-line bg-surface opacity-50"
      : c.hero
        ? "border-gem/50 bg-gem/[0.07] hover:bg-gem/[0.10]"
        : c.gemCount > 0
          ? "border-gem/30 bg-gem/[0.04] hover:bg-gem/[0.07]"
          : "border-line bg-surface opacity-75 hover:bg-surface-2 hover:opacity-100";
  const dateText = c.isToday ? "text-accent" : c.isPast ? "text-ink-3" : "text-ink";
  const aria = `${c.isToday ? "Today, " : ""}${c.dt.toFormat("cccc, LLLL d")}: ${c.total} ${
    c.total === 1 ? "title" : "titles"
  }${c.gemCount ? `, ${c.gemCount} gem${c.gemCount === 1 ? "" : "s"}` : ""} — open week view`;

  const countBadge =
    c.gemCount > 0 ? (
      <span className="inline-flex items-baseline gap-0.5 rounded-full bg-gem/20 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
        <span className="text-gem">{c.gemCount}</span>
        <span className="text-ink-3">/{c.total}</span>
      </span>
    ) : c.total > 0 ? (
      <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink-3">
        {c.total}
      </span>
    ) : null;

  const lines = (
    <>
      {c.preview.map((p, i) => (
        <span key={i} className="flex items-center gap-1 leading-tight">
          <span className={`h-1.5 w-1.5 flex-none rounded-full ${TONE_DOT[p.tone]}`} aria-hidden="true" />
          <span className="truncate text-ink-2">{p.count ? `${p.label} · ${p.count}` : p.label}</span>
        </span>
      ))}
      {c.moreCount > 0 && <span className="pl-2.5 text-[10px] font-medium text-ink-3">+{c.moreCount} more</span>}
    </>
  );

  if (variant === "grid") {
    return (
      <button
        type="button"
        onClick={() => onJump(c.day)}
        aria-label={aria}
        aria-current={c.isToday ? "date" : undefined}
        className={`flex min-h-[7.5rem] flex-col gap-1 rounded-lg border p-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${stateCls}`}
      >
        <div className="flex items-baseline justify-between gap-1">
          <span className={`flex items-baseline gap-0.5 text-sm font-semibold tabular-nums ${dateText}`}>
            {c.hero && <span className="text-gem" aria-hidden="true">✦</span>}
            {c.dt.toFormat("d")}
          </span>
          {countBadge}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 text-[11px]">{lines}</div>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onJump(c.day)}
      aria-label={aria}
      aria-current={c.isToday ? "date" : undefined}
      className={`flex flex-col gap-1.5 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${stateCls}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`flex items-baseline gap-0.5 text-sm font-semibold ${dateText}`}>
          {c.hero && <span className="text-gem" aria-hidden="true">✦</span>}
          {c.dt.toFormat("ccc, LLL d")}
        </span>
        {c.empty ? <span className="text-xs text-ink-3">No screenings</span> : countBadge}
      </div>
      {c.preview.length > 0 && <div className="flex flex-col gap-0.5 text-[12px]">{lines}</div>}
    </button>
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
            <MovieCard key={g.movie.id} group={g} day={day} density={density} dayLabel={dayLabel} onHide={onHide} />
          ))
        )}
      </div>
    </section>
  );
});

const MovieCard = memo(function MovieCard({
  group,
  day,
  density,
  dayLabel,
  onHide,
}: {
  group: MovieGroup;
  day: string;
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
  const title = displayTitle(movie.title);
  // Premiere flag: a screening within a week of (or before) the film's release date.
  const isNew = movie.releaseDate ? movie.releaseDate.slice(0, 10) >= shift(day, -7) : false;
  const metaBits = [movie.rating, movie.runtimeMinutes ? fmtRuntime(movie.runtimeMinutes) : null].filter(
    Boolean,
  ) as string[];

  const hasRating = movie.letterboxdRating != null || movie.letterboxdUrl;
  const hasMetaRow =
    hasRating || isNew || movie.isClassic || movie.isSpecialEvent || movie.isIndie || movie.isForeign || movie.isRare || metaBits.length > 0;

  return (
    <article
      className={`group relative flex gap-2 rounded-lg border p-1.5 transition ${
        group.isGem
          ? "border-gem/40 bg-gem/[0.04] ring-1 ring-gem/15 hover:bg-gem/[0.07]"
          : "border-line hover:bg-surface-2"
      }`}
    >
      {/* Hide-× pinned to the corner so it never competes with the title's first line. */}
      <button
        onClick={() => onHide(movie.id, title)}
        aria-label={`Hide ${title} from all days`}
        title="Hide this movie"
        className="absolute right-1 top-1 z-10 rounded p-0.5 text-ink-3 transition hover:bg-surface-3 hover:text-rose-300 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:opacity-50 sm:group-hover:opacity-100"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      {density !== "list" && (
        <Link href={`/movie/${movie.id}`} aria-label={`View showtimes for ${title}`} className="flex-none self-start">
          <Poster movie={movie} sizeCls="w-11 sm:w-12 xl:w-10" />
        </Link>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 className="min-w-0 pr-5 text-[13px] font-semibold leading-tight text-ink [overflow-wrap:normal] line-clamp-2 sm:line-clamp-3">
          <Link
            href={`/movie/${movie.id}`}
            title={title}
            className="rounded transition hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {title}
          </Link>
        </h3>

        {hasMetaRow && (
          <div className="flex flex-wrap items-center gap-1">
            {hasRating && <RatingBadge movie={movie} />}
            {isNew && (
              <span
                title="New release / premiere"
                className="rounded bg-accent px-1 py-px text-[9px] font-bold uppercase tracking-[0.03em] text-black"
              >
                New
              </span>
            )}
            {movie.isClassic && <Badge tone="classic" title={BADGE_GLOSS.Throwback}>Throwback</Badge>}
            {movie.isSpecialEvent && <Badge tone="special" title={BADGE_GLOSS.Special}>Special</Badge>}
            {movie.isIndie && <Badge tone="indie" title={BADGE_GLOSS.Indie}>Indie</Badge>}
            {movie.isForeign && <Badge tone="foreign" title={BADGE_GLOSS.Foreign}>Foreign</Badge>}
            {movie.isRare && <Badge tone="rare" title={BADGE_GLOSS.Rare}>Rare</Badge>}
            {metaBits.length > 0 && <span className="text-[10px] text-ink-3">{metaBits.join(" · ")}</span>}
          </div>
        )}

        <div className="flex flex-col gap-1">
          {showGroups.map((g) => (
            <div key={g.key} className="flex flex-wrap items-center gap-1">
              <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-[0.03em] text-ink-3">
                {theatreLabel(g.theatre.slug, g.theatre.name)}
                {g.tag && <span className={isCaptionTag(g.tag) ? "" : "text-accent"}> {g.tag}</span>}
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

function asCategory(v: string | null): Category {
  return v === "gems" || v === "classic" || v === "special" ? v : "all";
}

function shift(iso: string, days: number): string {
  return DateTime.fromISO(iso, { zone: TZ }).plus({ days }).toISODate()!;
}

function formatRange(startISO: string): string {
  const start = DateTime.fromISO(startISO, { zone: TZ });
  const end = start.plus({ days: 6 });
  return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d")}`;
}

// This (or the upcoming) Friday — anchors a "weekend" week starting Fri. If today
// is already Fri/Sat/Sun, anchor at today so the current weekend stays in view.
function upcomingFriday(): string {
  const dt = DateTime.now().setZone(TZ).startOf("day");
  return (dt.weekday >= 5 ? dt : dt.plus({ days: 5 - dt.weekday })).toISODate()!;
}

function fmtRuntime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

// Sunday on or before the given date (Luxon's startOf("week") is Monday-based).
function startOfSundayWeek(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: TZ }).startOf("day");
  return dt.minus({ days: dt.weekday % 7 }).toISODate()!; // weekday: 1=Mon…7=Sun → Sun→0
}

function formatMonthRange(gridStart: string): string {
  const start = DateTime.fromISO(gridStart, { zone: TZ });
  const end = start.plus({ days: MONTH_SPAN - 1 });
  return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d")}`;
}

// ---- Upcoming view ---------------------------------------------------------

type UpcomingBucketKey = "opening" | "special" | "throwback" | "rare";

interface UpcomingItem {
  key: string;
  movie: Movie; // representative film (poster/title/rating/badges)
  title: string; // display title, or the series label for collapsed series
  isSeries: boolean;
  memberCount: number; // distinct films in a collapsed series (1 otherwise)
  firstShowtime: string; // earliest startsAt (sort key)
  firstDateKey: string;
  lastDateKey: string;
  playDates: string[]; // sorted distinct dateKeys across the horizon
  theatres: { slug: string; name: string }[];
  isOpening: boolean;
  bucket: UpcomingBucketKey;
}

type UpcomingBuckets = Record<UpcomingBucketKey, UpcomingItem[]>;

const EMPTY_UPCOMING: UpcomingBuckets = { opening: [], special: [], throwback: [], rare: [] };

const UPCOMING_SECTIONS: { key: UpcomingBucketKey; label: string }[] = [
  { key: "opening", label: "Opening soon" },
  { key: "special", label: "Special events" },
  { key: "throwback", label: "Throwbacks" },
  { key: "rare", label: "Rare & indie" },
];

const OPENING_GRACE_DAYS = 7; // a release within the last week still counts as "just opened"
// Accessibility / one-off special screenings of a film (its main title already carries
// the opening) — never an "opening" themselves, regardless of the film's release date.
const SPECIAL_SCREENING_RE = /\b(sensory[\s-]?friendly|open[\s-]?caption(?:ed)?)\b/i;

// A genuine opening: its first upcoming showtime is in the future AND its theatrical
// release is upcoming or only days old. A film whose release is already weeks past is
// out — a gap in its schedule (only a future sensory-friendly screening, or simply no
// showtime literally today) must NOT make it look like it's opening tomorrow.
function isOpeningItem(movie: Movie, firstDateKey: string, today: string): boolean {
  if (firstDateKey <= today) return false; // its next/first showtime must be upcoming
  if (movie.isClassic || movie.isSpecialEvent) return false; // repertory/events aren't openings
  if (SPECIAL_SCREENING_RE.test(movie.title)) return false; // accessibility one-offs aren't openings
  // Require the real release date — without it we can't tell a premiere from a film
  // that's already been running, so don't claim "opening" (it still shows under Rare/
  // Indie/Foreign if it qualifies).
  if (!movie.releaseDate) return false;
  return movie.releaseDate.slice(0, 10) >= shift(today, -OPENING_GRACE_DAYS);
}

function aggregateUpcoming(shows: ApiShowtime[]): UpcomingBuckets {
  const today = todayISO();
  interface Entry {
    rep: ApiShowtime;
    movies: Set<string>;
    dates: Set<string>;
    theatres: Map<string, { slug: string; name: string }>;
    first: string;
    anyGem: boolean;
    series: { key: string; label: string } | null;
  }
  const map = new Map<string, Entry>();
  for (const s of shows) {
    const series = seriesOf(s.movie.title);
    const key = series ? series.key : s.movie.id;
    let e = map.get(key);
    if (!e) {
      e = {
        rep: s,
        movies: new Set(),
        dates: new Set(),
        theatres: new Map(),
        first: s.startsAt,
        anyGem: false,
        series,
      };
      map.set(key, e);
    }
    e.movies.add(s.movie.id);
    if (s.dateKey) e.dates.add(s.dateKey);
    e.theatres.set(s.theatre.slug, s.theatre);
    if (s.startsAt < e.first) {
      e.first = s.startsAt;
      e.rep = s; // keep the earliest screening's film as representative
    }
    if (s.isGem) e.anyGem = true;
  }

  const buckets: UpcomingBuckets = { opening: [], special: [], throwback: [], rare: [] };
  for (const [key, e] of map) {
    const playDates = [...e.dates].sort();
    if (playDates.length === 0) continue;
    const movie = e.rep.movie;
    const firstDateKey = playDates[0];
    const isOpening = !e.series && isOpeningItem(movie, firstDateKey, today);
    // Rarity is computed on distinct play-dates (window-stable), not the API's
    // showtime-count isRare, which inflates over a 90-day window.
    const isRareUpcoming = !e.series && playDates.length <= RARE_DAYS;
    // Scope = gems + genuine openings. Drop wide mid-run releases that are neither.
    const include =
      isOpening ||
      e.anyGem ||
      !!e.series ||
      movie.isClassic ||
      movie.isSpecialEvent ||
      movie.isIndie ||
      movie.isForeign ||
      isRareUpcoming;
    if (!include) continue;

    let bucket: UpcomingBucketKey;
    if (isOpening) bucket = "opening";
    else if (movie.isSpecialEvent) bucket = "special";
    else if (movie.isClassic) bucket = "throwback";
    else if (e.series) bucket = "special";
    else bucket = "rare";

    buckets[bucket].push({
      key,
      movie,
      title: e.series ? e.series.label : displayTitle(movie.title),
      isSeries: !!e.series,
      memberCount: e.movies.size,
      firstShowtime: e.first,
      firstDateKey,
      lastDateKey: playDates[playDates.length - 1],
      playDates,
      theatres: [...e.theatres.values()],
      isOpening,
      bucket,
    });
  }
  for (const k of Object.keys(buckets) as UpcomingBucketKey[])
    buckets[k].sort((a, b) => (a.firstShowtime < b.firstShowtime ? -1 : a.firstShowtime > b.firstShowtime ? 1 : 0));
  return buckets;
}

function UpcomingView({
  buckets,
  onHide,
  onClear,
}: {
  buckets: UpcomingBuckets;
  onHide: (id: string, title: string) => void;
  onClear?: () => void;
}) {
  const sections = UPCOMING_SECTIONS.filter((s) => buckets[s.key].length > 0);
  if (sections.length === 0) {
    return (
      <div className="mt-10 flex flex-col items-center gap-3 text-center">
        <p className="text-sm text-ink-3">No upcoming highlights in the next 90 days.</p>
        {onClear && (
          <button
            onClick={onClear}
            className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Clear filters
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {sections.map((s) => (
        <section key={s.key} aria-label={s.label}>
          <h2 className="mb-2 flex items-baseline gap-2">
            <span className="font-display text-sm font-semibold uppercase tracking-[0.12em] text-ink">
              {s.label}
            </span>
            <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink-2">
              {buckets[s.key].length}
            </span>
          </h2>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {buckets[s.key].map((it) => (
              <UpcomingItemCard key={it.key} item={it} onHide={onHide} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function UpcomingItemCard({ item, onHide }: { item: UpcomingItem; onHide: (id: string, title: string) => void }) {
  const router = useRouter();
  const { movie } = item;
  // A collapsed series opens its series page; a single film opens its movie page.
  const href = item.isSeries ? `/series/${item.key}` : `/movie/${item.key}`;
  const fmt = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toFormat("ccc, LLL d");
  // Primary line = the date that matters: the opening day, or the play-range.
  const primary = item.isOpening
    ? `Opens ${fmt(item.firstDateKey)}`
    : item.firstDateKey === item.lastDateKey
      ? fmt(item.firstDateKey)
      : `${fmt(item.firstDateKey)} – ${fmt(item.lastDateKey)}`;
  // Secondary line folds count + theatres together to save vertical space.
  const count = item.isSeries ? item.memberCount : item.playDates.length;
  const countWord = item.isSeries ? (count === 1 ? "event" : "events") : count === 1 ? "date" : "dates";
  const theatres = item.theatres.map((t) => theatreLabel(t.slug, t.name)).join(" · ");
  const meta = [count > 1 ? `${count} ${countWord}` : "", theatres].filter(Boolean).join(" · ");
  const showRare = item.bucket === "rare" && !movie.isIndie && !movie.isForeign;
  const hasBadges =
    !item.isSeries && (movie.isClassic || movie.isSpecialEvent || movie.isIndie || movie.isForeign || showRare);

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(href);
        }
      }}
      aria-label={`${item.title} — ${primary}. View showtimes.`}
      className="group flex cursor-pointer gap-2 rounded-lg border border-gem/25 bg-gem/[0.03] p-1.5 text-left transition hover:bg-gem/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <Poster movie={movie} sizeCls="w-12" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-start gap-1">
          <h3
            title={item.title}
            className="min-w-0 flex-1 text-[13px] font-semibold leading-tight text-ink [overflow-wrap:normal] line-clamp-2"
          >
            {item.title}
          </h3>
          {(movie.letterboxdRating != null || movie.letterboxdUrl) && (
            <span onClick={(e) => e.stopPropagation()}>
              <RatingBadge movie={movie} />
            </span>
          )}
          {!item.isSeries && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onHide(movie.id, item.title);
              }}
              aria-label={`Hide ${item.title}`}
              title="Hide this movie"
              className="-mr-0.5 -mt-0.5 flex-none rounded p-0.5 text-ink-3 opacity-100 transition hover:bg-surface-3 hover:text-rose-300 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:opacity-60"
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
        {hasBadges && (
          <div className="flex flex-wrap gap-1">
            {movie.isClassic && <Badge tone="classic" title={BADGE_GLOSS.Throwback}>Throwback</Badge>}
            {movie.isSpecialEvent && <Badge tone="special" title={BADGE_GLOSS.Special}>Special</Badge>}
            {movie.isIndie && <Badge tone="indie" title={BADGE_GLOSS.Indie}>Indie</Badge>}
            {movie.isForeign && <Badge tone="foreign" title={BADGE_GLOSS.Foreign}>Foreign</Badge>}
            {showRare && <Badge tone="rare" title={BADGE_GLOSS.Rare}>Rare</Badge>}
          </div>
        )}
        <p className={`text-[11px] font-semibold ${item.isOpening ? "text-accent" : "text-ink-2"}`}>{primary}</p>
        {meta && <p className="truncate text-[11px] text-ink-3">{meta}</p>}
      </div>
    </article>
  );
}
