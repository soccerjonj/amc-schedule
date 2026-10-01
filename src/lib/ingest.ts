import { DateTime } from "luxon";
import { prisma } from "./db";
import { classify, isHiddenTitle } from "./classify";
import { enrichMovies } from "./enrich";
import { getProvider } from "./providers";
import { SEED_THEATRES, THEATRE_TIMEZONE } from "./theatres";
import type { AnnouncedMovie, MovieDetails, RawShowtime, ShowtimeProvider, TheatreRef } from "./providers/types";

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
  // The AMC API reports MPAA rating + runtime for what's actually screening; when
  // present they win over TMDB's (enrichment only fills gaps). The scraper has none.
  const rating = shows.find((s) => s.mpaaRating)?.mpaaRating;
  const runtimeMinutes = shows.find((s) => s.runtimeMinutes)?.runtimeMinutes;
  const amcMeta = { ...(rating ? { rating } : {}), ...(runtimeMinutes ? { runtimeMinutes } : {}) };
  await prisma.movie.upsert({
    where: { id: movieId },
    create: {
      id: movieId,
      slug: first.movieSlug,
      title: first.movieTitle,
      attributes: JSON.stringify(attributes),
      ...flags,
      ...amcMeta,
    },
    update: {
      slug: first.movieSlug,
      title: first.movieTitle,
      attributes: JSON.stringify(attributes),
      ...flags,
      ...amcMeta,
    },
  });
}

export interface IngestOptions {
  days?: number;
  theatres?: TheatreRef[];
}

const MAX_CONSECUTIVE_FAILURES = 5;

// AMC flags individual showings (often events/premium) as not A-List eligible.
const A_LIST_EXCLUDED = /excluded from a-?list/i;

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
  let consecutiveFailures = 0;
  const seenMovies = new Set<string>();

  try {
    for (const theatre of theatres) {
      for (const date of dates) {
        try {
          const shows = await provider.getShowtimes(theatre, date);
          await persistDay(theatre, date, shows, yearByMovie);
          for (const s of shows) seenMovies.add(s.movieId);
          stats.showtimes += shows.length;
          consecutiveFailures = 0;
          console.log(`  ${theatre.slug} ${date}: ${shows.length} showtimes`);
        } catch (err) {
          // A failed day is skipped, so its existing showtimes are left untouched.
          stats.errors++;
          consecutiveFailures++;
          console.warn(`  ! ${theatre.slug} ${date} failed:`, (err as Error).message);
          // A run of failures means the source is down or blocking us — stop now
          // with a clear error instead of grinding through every remaining page.
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            throw new Error(
              `Aborting: ${consecutiveFailures} pages in a row failed (last: ${(err as Error).message}). ` +
                `No existing showtimes were overwritten.`,
            );
          }
        }
      }
    }
    // Extras the provider may offer (AMC API). Each is best-effort: a failure here
    // never fails the run or touches showtimes.
    await attachMovieDetails(provider, [...seenMovies]);
    await refreshAnnounced(provider, ANNOUNCED_HORIZON_DAYS);
  } finally {
    await provider.close();
  }

  await trimOldShowtimes();

  // Enrich posters/ratings after the provider is closed. Gated on a TMDB key so
  // keyless local scrapes still succeed (metadata just stays null). Never let
  // enrichment failures fail the scrape.
  if (process.env.TMDB_API_KEY) {
    try {
      const force = process.env.ENRICH_FORCE === "true" || process.env.ENRICH_FORCE === "1";
      const dryRun = process.env.ENRICH_DRY_RUN === "true" || process.env.ENRICH_DRY_RUN === "1";
      const e = await enrichMovies({ force, dryRun });
      console.log(`  enrich${force ? " (forced)" : ""}${dryRun ? " (DRY RUN — nothing saved)" : ""}:`, e);
    } catch (err) {
      console.warn("  ! enrichment failed:", (err as Error).message);
    }
  }
  return stats;
}

// Keep a week of history (so the calendar can page back) and drop anything older.
const KEEP_PAST_DAYS = 7;
// Announced films are listed this far ahead (matches the Upcoming feed), whatever
// window the showtime scrape itself covers.
const ANNOUNCED_HORIZON_DAYS = 90;

async function trimOldShowtimes() {
  try {
    const cutoff = DateTime.now().setZone(THEATRE_TIMEZONE).startOf("day").minus({ days: KEEP_PAST_DAYS });
    const res = await prisma.showtime.deleteMany({ where: { startsAt: { lt: cutoff.toJSDate() } } });
    console.log(`  trimmed ${res.count} showtimes before ${cutoff.toISODate()}`);
  } catch (err) {
    console.warn("  ! trimming failed:", (err as Error).message);
  }
}

// Only overwrite a field when the source actually has a value.
function detailFields(d: MovieDetails) {
  return {
    ...(d.synopsis ? { synopsis: d.synopsis } : {}),
    ...(d.advisory ? { advisory: d.advisory } : {}),
    ...(d.cast ? { cast: d.cast } : {}),
    ...(d.directors ? { directors: d.directors } : {}),
    ...(d.genre ? { genre: d.genre } : {}),
    ...(d.trailerUrl ? { trailerUrl: d.trailerUrl } : {}),
    ...(d.posterUrl ? { amcPosterUrl: d.posterUrl } : {}),
    ...(d.releaseDate ? { amcReleaseDate: d.releaseDate } : {}),
  };
}

async function attachMovieDetails(provider: ShowtimeProvider, movieIds: string[]) {
  if (!provider.getMovieDetails || movieIds.length === 0) return;
  try {
    const details = await provider.getMovieDetails(movieIds);
    let n = 0;
    for (const [id, d] of details) {
      const data = detailFields(d);
      if (Object.keys(data).length === 0) continue;
      n += (await prisma.movie.updateMany({ where: { id }, data })).count;
    }
    console.log(`  movie details: ${n}/${movieIds.length} movies updated`);
  } catch (err) {
    console.warn("  ! movie details failed:", (err as Error).message);
  }
}

async function refreshAnnounced(provider: ShowtimeProvider, days: number) {
  if (!provider.getAnnounced) return;
  let list: AnnouncedMovie[];
  try {
    list = (await provider.getAnnounced(days)).filter((m) => !isHiddenTitle(m.title));
  } catch (err) {
    console.warn("  ! announced list failed:", (err as Error).message);
    return; // keep the previous announced flags rather than clearing them
  }
  const ok: string[] = [];
  for (const m of list) {
    const cls = classify({ title: m.title, attributes: [], releaseYear: null });
    const shared = {
      announced: true,
      amcReleaseDate: m.releaseDate,
      ...(m.mpaaRating ? { rating: m.mpaaRating } : {}),
      ...(m.runtimeMinutes ? { runtimeMinutes: m.runtimeMinutes } : {}),
      ...detailFields(m),
    };
    try {
      await prisma.movie.upsert({
        where: { id: m.id },
        create: { id: m.id, slug: m.slug, title: m.title, isSpecialEvent: cls.isSpecialEvent, isClassic: cls.isClassic, ...shared },
        update: shared,
      });
      ok.push(m.id);
    } catch (err) {
      console.warn(`  ! announced ${m.title}:`, (err as Error).message);
    }
  }
  const cleared = await prisma.movie.updateMany({ where: { announced: true, id: { notIn: ok } }, data: { announced: false } });
  console.log(`  announced: ${ok.length} films (cleared ${cleared.count})`);
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
        aListExcluded: s.attributes.some((a) => A_LIST_EXCLUDED.test(a)),
        soldOut: s.soldOut ?? false,
        almostSoldOut: s.almostSoldOut ?? false,
        price: s.price ?? null,
        discount: s.discount ?? null,
      })),
    }),
  ]);
}
