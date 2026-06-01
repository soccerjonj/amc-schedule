import { DateTime } from "luxon";
import { prisma } from "./db";
import { classify, isHiddenTitle } from "./classify";
import { enrichMovies } from "./enrich";
import { getProvider } from "./providers";
import { SEED_THEATRES, THEATRE_TIMEZONE } from "./theatres";
import type { RawShowtime, TheatreRef } from "./providers/types";

export function dateWindow(days: number, startOffset = 0): string[] {
  const out: string[] = [];
  const base = DateTime.now().setZone(THEATRE_TIMEZONE).startOf("day");
  for (let i = startOffset; i < startOffset + days; i++) {
    out.push(base.plus({ days: i }).toISODate()!);
  }
  return out;
}

function dayBoundsUtc(date: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(`${date}T00:00`, { zone: THEATRE_TIMEZONE });
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

async function upsertTheatres(theatres: TheatreRef[]) {
  for (const t of theatres) {
    await prisma.theatre.upsert({
      where: { id: t.id },
      create: { id: t.id, slug: t.slug, urlPath: t.urlPath, name: t.name, city: "Chicago" },
      update: { slug: t.slug, urlPath: t.urlPath, name: t.name },
    });
  }
}

async function upsertMovieFromShowtimes(
  movieId: string,
  shows: RawShowtime[],
  releaseYear: number | null,
) {
  // A movie's AMC attributes are program-level (same movieId → same labels across
  // its showtimes), so the day's shows are exhaustive — no need to read the
  // existing row to merge. The release year is preloaded once (see ingest()).
  const attrSet = new Set<string>();
  for (const s of shows) s.attributes.forEach((a) => attrSet.add(a));
  const attributes = [...attrSet];
  // Classify from real AMC attribute labels only — marketing/format headings
  // (e.g. "Fan First Premiere") produce false positives. Recomputed fresh each
  // run so flags stay accurate as listings change.
  const first = shows[0];
  // releaseYear (from a prior enrichment) keeps the "old film => Throwback/Fan
  // Fave" heuristic stable across re-scrapes; enrichMovies refreshes it later.
  const cls = classify({ title: first.movieTitle, attributes, releaseYear });
  const flags = {
    isClassic: cls.isClassic,
    isSpecialEvent: cls.isSpecialEvent,
    isIndie: cls.isIndie,
    isForeign: cls.isForeign,
  };
  await prisma.movie.upsert({
    where: { id: movieId },
    create: {
      id: movieId,
      slug: first.movieSlug,
      title: first.movieTitle,
      attributes: JSON.stringify(attributes),
      ...flags,
    },
    update: {
      slug: first.movieSlug,
      title: first.movieTitle,
      attributes: JSON.stringify(attributes),
      ...flags,
    },
  });
}

export interface IngestOptions {
  days?: number;
  theatres?: TheatreRef[];
}

export async function ingest(opts: IngestOptions = {}) {
  const days = opts.days ?? 14;
  const theatres = opts.theatres ?? SEED_THEATRES;
  const dates = dateWindow(days);
  await upsertTheatres(theatres);

  // Preload each movie's enriched release year once (instead of a findUnique per
  // movie per day) so classification stays correct without thousands of round-trips.
  const yearByMovie = new Map<string, number | null>();
  for (const m of await prisma.movie.findMany({ select: { id: true, releaseYear: true } }))
    yearByMovie.set(m.id, m.releaseYear);

  const provider = getProvider();
  await provider.open();
  const stats = { theatres: theatres.length, dates: dates.length, showtimes: 0, errors: 0 };

  try {
    for (const theatre of theatres) {
      for (const date of dates) {
        try {
          const shows = await provider.getShowtimes(theatre, date);
          await persistDay(theatre, date, shows, yearByMovie);
          stats.showtimes += shows.length;
          console.log(`  ${theatre.slug} ${date}: ${shows.length} showtimes`);
        } catch (err) {
          stats.errors++;
          console.warn(`  ! ${theatre.slug} ${date} failed:`, (err as Error).message);
        }
      }
    }
  } finally {
    await provider.close();
  }

  // Enrich posters/ratings after the browser is closed. Gated on a TMDB key so
  // keyless local scrapes still succeed (metadata just stays null). Never let
  // enrichment failures fail the scrape.
  if (process.env.TMDB_API_KEY) {
    try {
      const force = process.env.ENRICH_FORCE === "true" || process.env.ENRICH_FORCE === "1";
      const e = await enrichMovies({ force });
      console.log(`  enrich${force ? " (forced)" : ""}:`, e);
    } catch (err) {
      console.warn("  ! enrichment failed:", (err as Error).message);
    }
  }
  return stats;
}

async function persistDay(
  theatre: TheatreRef,
  date: string,
  rawShows: RawShowtime[],
  yearByMovie: Map<string, number | null>,
) {
  // Drop non-public listings (e.g. private theatre rentals) so they never enter the DB.
  const shows = rawShows.filter((s) => !isHiddenTitle(s.movieTitle));

  // group by movie and upsert movies first (FK target)
  const byMovie = new Map<string, RawShowtime[]>();
  for (const s of shows) {
    const arr = byMovie.get(s.movieId) ?? [];
    arr.push(s);
    byMovie.set(s.movieId, arr);
  }
  for (const [movieId, ms] of byMovie)
    await upsertMovieFromShowtimes(movieId, ms, yearByMovie.get(movieId) ?? null);

  const { start, end } = dayBoundsUtc(date);
  // dedupe by showtimeId (a movie can appear under multiple format blocks)
  const unique = new Map<string, RawShowtime>();
  for (const s of shows) unique.set(s.showtimeId, s);

  await prisma.$transaction([
    prisma.showtime.deleteMany({
      where: { theatreId: theatre.id, startsAt: { gte: start, lt: end } },
    }),
    prisma.showtime.createMany({
      data: [...unique.values()].map((s) => ({
        id: s.showtimeId,
        theatreId: theatre.id,
        movieId: s.movieId,
        startsAt: s.startsAt,
        format: s.format,
        ticketUrl: s.ticketUrl,
      })),
    }),
  ]);
}
