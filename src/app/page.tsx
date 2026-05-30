"use client";

import { useEffect, useMemo, useState } from "react";
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

  const byDay = useMemo(() => groupByDay(data?.showtimes ?? []), [data]);
  const theatres = data?.theatres ?? [];

  function toggleTheatre(slug: string) {
    setSelectedTheatres((cur) =>
      cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug],
    );
  }

  return (
    <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">AMC Showtimes — Chicago</h1>
        <p className="mt-1 text-sm text-neutral-500">
          One calendar across downtown theaters. Classics, special events, and
          rarely-played films are highlighted so they don&apos;t get buried.
        </p>
      </header>

      <div className="mb-5 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setWeekStart(todayISO())}
            className="rounded-full border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Today
          </button>
          <button
            onClick={() => setWeekStart(shift(weekStart, -7))}
            className="rounded-full border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            aria-label="Previous week"
          >
            ← Prev
          </button>
          <button
            onClick={() => setWeekStart(shift(weekStart, 7))}
            className="rounded-full border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
            aria-label="Next week"
          >
            Next →
          </button>
          <span className="ml-1 text-sm text-neutral-500">{formatRange(weekStart)}</span>
          {loading && <span className="text-xs text-neutral-400">updating…</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.value}
              onClick={() => setCategory(c.value)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                category === c.value
                  ? "bg-blue-600 text-white"
                  : "border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              }`}
            >
              {c.label}
            </button>
          ))}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search movie…"
            className="ml-auto w-48 rounded-full border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-blue-500 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>

        {theatres.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-neutral-400">Theaters</span>
            {theatres.map((t) => {
              const dimmed = selectedTheatres.length > 0 && !selectedTheatres.includes(t.slug);
              return (
                <button
                  key={t.slug}
                  onClick={() => toggleTheatre(t.slug)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                    selectedTheatres.includes(t.slug)
                      ? "bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-900"
                      : dimmed
                        ? "border border-neutral-200 text-neutral-400 dark:border-neutral-800"
                        : "border border-neutral-300 dark:border-neutral-700"
                  }`}
                >
                  {t.name}
                </button>
              );
            })}
            {selectedTheatres.length > 0 && (
              <button
                onClick={() => setSelectedTheatres([])}
                className="text-xs text-blue-600 hover:underline"
              >
                clear
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        {(data?.dayKeys ?? []).map((day) => (
          <DayColumn key={day} day={day} groups={byDay[day] ?? []} />
        ))}
      </div>

      {data && data.total === 0 && (
        <p className="mt-10 text-center text-sm text-neutral-500">
          No showtimes match these filters for this week.
        </p>
      )}
    </main>
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
    <section className="rounded-lg border border-neutral-200 dark:border-neutral-800">
      <div
        className={`sticky top-0 z-10 rounded-t-lg border-b px-3 py-2 ${
          isToday
            ? "border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950"
            : "border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900"
        }`}
      >
        <div className="text-xs uppercase tracking-wide text-neutral-500">
          {dt.toFormat("ccc")}
        </div>
        <div className="text-sm font-semibold">{dt.toFormat("LLL d")}</div>
      </div>
      <div className="flex flex-col gap-2 p-2">
        {groups.length === 0 && (
          <p className="px-1 py-2 text-xs text-neutral-400">No showtimes</p>
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
  const hasMeta =
    movie.isClassic || movie.isSpecialEvent || movie.isRare || movie.letterboxdRating != null;
  return (
    <div
      className={`rounded-md border p-2 ${
        group.isGem
          ? "border-amber-300 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-950/30"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <div className="flex gap-2">
        {movie.posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={movie.posterUrl}
            alt=""
            loading="lazy"
            className="h-[4.5rem] w-12 flex-none rounded bg-neutral-200 object-cover dark:bg-neutral-800"
          />
        ) : (
          <div className="flex h-[4.5rem] w-12 flex-none items-center justify-center rounded bg-neutral-100 text-center text-[9px] leading-tight text-neutral-400 dark:bg-neutral-800">
            no art
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight">{movie.title}</div>
          {hasMeta && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {movie.isClassic && <Badge color="purple">Classic</Badge>}
              {movie.isSpecialEvent && <Badge color="rose">Special</Badge>}
              {movie.isRare && <Badge color="amber">Rare</Badge>}
              {movie.letterboxdRating != null && <RatingBadge movie={movie} />}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {group.shows
          .slice()
          .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1))
          .map((s) => (
            <a
              key={s.id}
              href={s.ticketUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`${s.theatre.name}${s.format ? " · " + s.format : ""}`}
              className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium text-neutral-800 hover:bg-blue-600 hover:text-white dark:bg-neutral-800 dark:text-neutral-100"
            >
              {s.time}
            </a>
          ))}
      </div>
    </div>
  );
}

function RatingBadge({ movie }: { movie: ApiShowtime["movie"] }) {
  const label = `★ ${movie.letterboxdRating!.toFixed(1)}`;
  const cls =
    "rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-green-800 dark:bg-green-900/50 dark:text-green-200";
  return movie.letterboxdUrl ? (
    <a
      href={movie.letterboxdUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="Letterboxd average rating"
      className={`${cls} hover:bg-green-200 dark:hover:bg-green-900`}
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
    purple: "bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-200",
    rose: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200",
    amber: "bg-amber-200 text-amber-900 dark:bg-amber-800/60 dark:text-amber-100",
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${map[color]}`}
    >
      {children}
    </span>
  );
}

function shift(iso: string, days: number): string {
  return DateTime.fromISO(iso, { zone: TZ }).plus({ days }).toISODate()!;
}

function formatRange(startISO: string): string {
  const start = DateTime.fromISO(startISO, { zone: TZ });
  const end = start.plus({ days: 6 });
  return `${start.toFormat("LLL d")} – ${end.toFormat("LLL d")}`;
}
