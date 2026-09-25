// Refill showtimes from the bundled snapshot (src/data/snapshot.json, written by
// the last successful scrape) for any theatre-day from today onward that is
// currently EMPTY in the database — e.g. days blanked by failed scrapes. Days that
// already have showtimes are never touched.
//
//   npx tsx scripts/restore-snapshot.ts            # dry run: report only
//   npx tsx scripts/restore-snapshot.ts --apply    # write to the database
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { prisma } from "../src/lib/db";
import { THEATRE_TIMEZONE } from "../src/lib/theatres";

interface SnapMovie {
  id: string;
  title: string;
  slug: string;
  isClassic: boolean;
  isSpecialEvent: boolean;
  isIndie: boolean;
  isForeign: boolean;
  releaseDate?: string | null;
  rating?: string | null;
  runtimeMinutes?: number | null;
  posterUrl: string | null;
  letterboxdRating: number | null;
  letterboxdUrl: string | null;
}
interface SnapShowtime {
  id: string;
  startsAt: string;
  movieId: string;
  format: string | null;
  ticketUrl: string;
  movie: SnapMovie;
  theatre: { slug: string };
}

const apply = process.argv.includes("--apply");

async function main() {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "snapshot.json");
  const snap = JSON.parse(readFileSync(file, "utf8")) as { generatedAt: string; showtimes: SnapShowtime[] };
  const today = DateTime.now().setZone(THEATRE_TIMEZONE).startOf("day");
  console.log(`Snapshot generated ${snap.generatedAt}; restoring days from ${today.toISODate()} on (${apply ? "APPLY" : "dry run"})`);

  // Group upcoming snapshot showtimes by theatre + local day.
  const groups = new Map<string, SnapShowtime[]>();
  for (const s of snap.showtimes) {
    const day = DateTime.fromISO(s.startsAt, { zone: THEATRE_TIMEZONE }).startOf("day");
    if (day < today) continue;
    const key = `${s.theatre.slug}|${day.toISODate()}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  // Keep only theatre-days the database currently has nothing for.
  const toRestore: SnapShowtime[] = [];
  const perTheatre = new Map<string, { days: number; showtimes: number; skippedDays: number }>();
  for (const [key, shows] of groups) {
    const [theatreId, iso] = key.split("|");
    const start = DateTime.fromISO(iso, { zone: THEATRE_TIMEZONE });
    const existing = await prisma.showtime.count({
      where: { theatreId, startsAt: { gte: start.toJSDate(), lt: start.plus({ days: 1 }).toJSDate() } },
    });
    const t = perTheatre.get(theatreId) ?? { days: 0, showtimes: 0, skippedDays: 0 };
    if (existing > 0) {
      t.skippedDays++;
    } else {
      t.days++;
      t.showtimes += shows.length;
      toRestore.push(...shows);
    }
    perTheatre.set(theatreId, t);
  }
  for (const [t, v] of [...perTheatre].sort()) {
    console.log(`  ${t.padEnd(30)} restore ${String(v.showtimes).padStart(4)} showtimes over ${String(v.days).padStart(2)} empty days  (kept ${v.skippedDays} days that already had data)`);
  }

  // Skip any showtime ids that already exist anywhere (never overwrite).
  const existingIds = new Set(
    (await prisma.showtime.findMany({ where: { id: { in: toRestore.map((s) => s.id) } }, select: { id: true } })).map((r) => r.id),
  );
  const fresh = toRestore.filter((s) => !existingIds.has(s.id));
  console.log(`Total: ${fresh.length} showtimes to insert (${toRestore.length - fresh.length} already present).`);

  if (!apply) {
    console.log("Dry run only — re-run with --apply to write.");
    return;
  }

  // Make sure every referenced movie exists (movies are never deleted by the scraper,
  // so this is normally a no-op). Create any missing ones from the snapshot.
  const movies = new Map(fresh.map((s) => [s.movieId, s.movie]));
  const haveMovies = new Set(
    (await prisma.movie.findMany({ where: { id: { in: [...movies.keys()] } }, select: { id: true } })).map((m) => m.id),
  );
  const badMovies = new Set<string>();
  for (const [id, m] of movies) {
    if (haveMovies.has(id)) continue;
    try {
      await prisma.movie.create({
        data: {
          id,
          slug: m.slug,
          title: m.title,
          isClassic: m.isClassic,
          isSpecialEvent: m.isSpecialEvent,
          isIndie: m.isIndie,
          isForeign: m.isForeign,
          releaseDate: m.releaseDate ? new Date(m.releaseDate) : null,
          rating: m.rating ?? null,
          runtimeMinutes: m.runtimeMinutes ?? null,
          posterUrl: m.posterUrl,
          letterboxdRating: m.letterboxdRating,
          letterboxdUrl: m.letterboxdUrl,
        },
      });
    } catch (err) {
      badMovies.add(id);
      console.warn(`  ! could not create movie ${id} (${m.title}):`, (err as Error).message);
    }
  }

  const rows = fresh
    .filter((s) => !badMovies.has(s.movieId))
    .map((s) => ({
      id: s.id,
      theatreId: s.theatre.slug,
      movieId: s.movieId,
      startsAt: new Date(s.startsAt),
      format: s.format,
      ticketUrl: s.ticketUrl,
    }));
  const res = await prisma.showtime.createMany({ data: rows });
  console.log(`Inserted ${res.count} showtimes.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
