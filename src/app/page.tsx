"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";

const TZ = "America/Chicago";

interface ApiShowtime {
  id: string;
  startsAt: string;
  dateKey: string;
  time: string;
  format: string | null;
  ticketUrl: string;
  movie: {
    id: string;
    title: string;
    slug: string;
    isClassic: boolean;
    isSpecialEvent: boolean;
    isRare: boolean;
    posterUrl: string | null;
    letterboxdRating: number | null;
    letterboxdUrl: string | null;
  };
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

const CATEGORIES: { value: Category; label: string }[] = [
  { value: "all", label: "All movies" },
  { value: "gems", label: "Gems only" },
  { value: "classic", label: "Classics" },
  { value: "special", label: "Special events" },
];

// Short, column-friendly theatre labels (full names are too wide for narrow columns).
const THEATRE_LABEL: Record<string, string> = {
  "amc-river-east-21": "River East",
  "amc-600-north-michigan-9": "600 N Mich",
  "amc-newcity-14": "NewCity",
  "amc-dine-in-block-37": "Block 37",
  "amc-roosevelt-collection-16": "Roosevelt",
};

function todayISO() {
  return DateTime.now().setZone(TZ).startOf("day").toISODate()!;
}

export default function Page() {
  const [weekStart, setWeekStart] = useState<string>(todayISO());
  const [category, setCategory] = useState<Category>("all");
  const [selectedTheatres, setSelectedTheatres] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const params = new URLSearchParams({ start: weekStart, days: "7", category });
    if (selectedTheatres.length) params.set("theatres", selectedTheatres.join(","));
    if (debouncedQuery) params.set("q", debouncedQuery);
    setLoading(true);
    fetch(`/api/showtimes?${params.toString()}`)
      .then((r) => r.json())
      .then((d: ApiResponse) => setData(d))
      .finally(() => setLoading(false));
  }, [weekStart, category, selectedTheatres, debouncedQuery]);

  // Keep day-column headers pinned just below the (variable-height) sticky bar.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty("--bar-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byDay = useMemo(() => groupByDay(data?.showtimes ?? []), [data]);
  const theatres = data?.theatres ?? [];

  function toggleTheatre(slug: string) {
    setSelectedTheatres((cur) =>
      cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug],
    );
  }

  const navBtn =
    "rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-ink-2 transition hover:border-line-2 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  return (
    <>
      <div
        ref={barRef}
        className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-md"
      >
        <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-wide text-ink">
                AMC <span className="text-accent">Showtimes</span>
                <span className="text-ink-3"> · Chicago</span>
              </h1>
              <p className="mt-0.5 hidden text-xs text-ink-3 sm:block">
                Every movie across downtown theaters — classics, special events, and
                rarely-played films surfaced.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setWeekStart(todayISO())}
                className="rounded-full border border-accent/40 px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Today
              </button>
              <button onClick={() => setWeekStart(shift(weekStart, -7))} aria-label="Previous week" className={navBtn}>
                ← Prev
              </button>
              <button onClick={() => setWeekStart(shift(weekStart, 7))} aria-label="Next week" className={navBtn}>
                Next →
              </button>
              <span className="ml-1 text-sm text-ink-3">{formatRange(weekStart)}</span>
              {loading && <span className="animate-pulse text-xs text-ink-3">updating…</span>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {CATEGORIES.map((c) => {
              const active = category === c.value;
              const activeCls = c.value === "gems" ? "bg-gem text-black" : "bg-accent text-black";
              return (
                <button
                  key={c.value}
                  onClick={() => setCategory(c.value)}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    active
                      ? activeCls
                      : "border border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  {c.label}
                </button>
              );
            })}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search movie…"
              className="ml-auto w-44 rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-ink outline-none transition placeholder:text-ink-3 focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent sm:w-56"
            />
          </div>

          {theatres.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
                Theaters
              </span>
              {theatres.map((t) => {
                const selected = selectedTheatres.includes(t.slug);
                const dimmed = selectedTheatres.length > 0 && !selected;
                return (
                  <button
                    key={t.slug}
                    onClick={() => toggleTheatre(t.slug)}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                      selected
                        ? "bg-ink text-bg"
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
                <button
                  onClick={() => setSelectedTheatres([])}
                  className="text-xs text-accent hover:underline"
                >
                  clear
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 xl:grid-cols-7">
          {(data?.dayKeys ?? []).map((day) => (
            <DayColumn key={day} day={day} groups={byDay[day] ?? []} />
          ))}
        </div>

        {data && data.total === 0 && (
          <p className="mt-10 text-center text-sm text-ink-3">
            No showtimes match these filters for this week.
          </p>
        )}
      </main>
    </>
  );
}

interface MovieGroup {
  movie: ApiShowtime["movie"];
  isGem: boolean;
  earliest: string;
  shows: ApiShowtime[];
}

function groupByDay(shows: ApiShowtime[]): Record<string, MovieGroup[]> {
  const days: Record<string, Map<string, MovieGroup>> = {};
  for (const s of shows) {
    const day = s.dateKey;
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

function DayColumn({ day, groups }: { day: string; groups: MovieGroup[] }) {
  const dt = DateTime.fromISO(day, { zone: TZ });
  const isToday = day === todayISO();
  return (
    <section
      className={`flex flex-col rounded-xl border bg-surface/40 backdrop-blur-sm ${
        isToday ? "border-accent/30 ring-1 ring-accent/15" : "border-line"
      }`}
    >
      <div
        className={`sticky top-[var(--bar-h)] z-10 flex items-baseline justify-between rounded-t-xl border-b border-line px-3 py-2 backdrop-blur ${
          isToday ? "bg-surface/90" : "bg-surface/80"
        }`}
      >
        <span
          className={`font-display text-sm uppercase tracking-[0.15em] ${
            isToday ? "text-accent" : "text-ink-2"
          }`}
        >
          {dt.toFormat("ccc")}
        </span>
        <span className={`text-sm font-semibold ${isToday ? "text-accent" : "text-ink"}`}>
          {dt.toFormat("LLL d")}
        </span>
      </div>
      <div className="flex flex-col gap-2.5 p-2">
        {groups.length === 0 && (
          <div className="flex flex-col items-center gap-1 py-8 text-ink-3">
            <FilmIcon className="h-5 w-5 opacity-50" />
            <span className="text-xs">No showtimes</span>
          </div>
        )}
        {groups.map((g) => (
          <MovieCard key={g.movie.id} group={g} />
        ))}
      </div>
    </section>
  );
}

function MovieCard({ group }: { group: MovieGroup }) {
  const { movie } = group;
  return (
    <article
      className={`group relative flex flex-row overflow-hidden rounded-xl border transition duration-200 hover:-translate-y-0.5 lg:flex-col ${
        group.isGem
          ? "border-gem/40 bg-surface ring-1 ring-gem/25 shadow-[0_0_22px_-8px_rgba(245,196,81,0.55)] hover:bg-surface-2"
          : "border-line bg-surface hover:bg-surface-2"
      }`}
    >
      <div className="relative aspect-[2/3] w-20 flex-none overflow-hidden bg-surface-3 lg:w-full">
        {movie.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={upscalePoster(movie.posterUrl)}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-2 to-surface-3">
            <FilmIcon className="h-6 w-6 text-ink-3 lg:h-9 lg:w-9" />
          </div>
        )}
        {movie.letterboxdRating != null && (
          <div className="absolute right-1 top-1">
            <RatingBadge movie={movie} />
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        <h3 className="line-clamp-2 text-[13px] font-semibold leading-tight text-ink">
          {movie.title}
        </h3>

        {(movie.isClassic || movie.isSpecialEvent || movie.isRare) && (
          <div className="flex flex-wrap gap-1">
            {movie.isClassic && <Badge color="purple">Classic</Badge>}
            {movie.isSpecialEvent && <Badge color="rose">Special</Badge>}
            {movie.isRare && <Badge color="amber">Rare</Badge>}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {groupByTheatre(group.shows).map(({ theatre, shows }) => (
            <div key={theatre.slug} className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">
                {theatreLabel(theatre.slug, theatre.name)}
              </span>
              <div className="flex flex-wrap gap-1">
                {shows.map((s) => (
                  <TimeChip key={s.id} s={s} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

function TimeChip({ s }: { s: ApiShowtime }) {
  const tag = formatTag(s.format);
  return (
    <a
      href={s.ticketUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md bg-surface-3 px-2 py-1 text-[11px] font-medium text-ink ring-1 ring-line transition hover:bg-surface-2 hover:text-accent hover:ring-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span>{s.time}</span>
      {tag && (
        <span className="rounded-sm bg-accent/15 px-1 text-[9px] font-bold uppercase tracking-wide text-accent">
          {tag}
        </span>
      )}
    </a>
  );
}

function RatingBadge({ movie }: { movie: ApiShowtime["movie"] }) {
  const label = `★ ${movie.letterboxdRating!.toFixed(1)}`;
  const cls =
    "inline-flex items-center rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-lb ring-1 ring-lb/30 backdrop-blur-sm";
  return movie.letterboxdUrl ? (
    <a
      href={movie.letterboxdUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="Letterboxd average rating"
      className={`${cls} transition hover:bg-black/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lb`}
    >
      {label}
    </a>
  ) : (
    <span title="Letterboxd average rating" className={cls}>
      {label}
    </span>
  );
}

function Badge({
  color,
  children,
}: {
  color: "purple" | "rose" | "amber";
  children: React.ReactNode;
}) {
  const map = {
    purple: "bg-purple-500/15 text-purple-300 ring-purple-400/20",
    rose: "bg-rose-500/15 text-rose-300 ring-rose-400/20",
    amber: "bg-amber-500/15 text-amber-300 ring-amber-400/25",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ring-1 ${map[color]}`}
    >
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

interface TheatreGroup {
  theatre: { slug: string; name: string };
  shows: ApiShowtime[];
}

function groupByTheatre(shows: ApiShowtime[]): TheatreGroup[] {
  const map = new Map<string, TheatreGroup>();
  for (const s of shows) {
    const g = map.get(s.theatre.slug) ?? { theatre: s.theatre, shows: [] };
    g.shows.push(s);
    map.set(s.theatre.slug, g);
  }
  const groups = [...map.values()];
  for (const g of groups) g.shows.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  groups.sort((a, b) => (a.shows[0].startsAt < b.shows[0].startsAt ? -1 : 1));
  return groups;
}

function theatreLabel(slug: string, fallback: string): string {
  return THEATRE_LABEL[slug] ?? fallback;
}

// AMC's format strings are messy ("IMAX with Laser at AMC", "PRIME at AMC",
// "RealD 3D", language/caption variants), so match by substring; standard/digital
// and language variants produce no tag.
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

// TMDB serves multiple sizes from the same path; bump the stored w342 to w500 for
// crisper art on the larger redesigned cards.
function upscalePoster(url: string): string {
  return url.replace("/w342/", "/w500/");
}

function shift(iso: string, days: number): string {
  return DateTime.fromISO(iso, { zone: TZ }).plus({ days }).toISODate()!;
}

function formatRange(startISO: string): string {
  const start = DateTime.fromISO(startISO, { zone: TZ });
  const end = start.plus({ days: 6 });
  return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d")}`;
}
