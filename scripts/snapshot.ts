// Dumps the current DB to src/data/snapshot.json, which the app serves when no
// DATABASE_URL is configured (i.e. on Vercel before Neon is wired up). Re-run
// after scraping to refresh the bundled demo data: `npm run snapshot`.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import { prisma } from "../src/lib/db";
import { THEATRE_TIMEZONE } from "../src/lib/theatres";

async function main() {
  // Only today onward — past showtimes are useless as a fallback and kept the
  // committed file growing every day.
  const today = DateTime.now().setZone(THEATRE_TIMEZONE).startOf("day").toJSDate();
  const showtimes = await prisma.showtime.findMany({
    where: { startsAt: { gte: today } },
    include: { movie: true, theatre: true },
    orderBy: { startsAt: "asc" },
  });
  const announced = await prisma.movie.findMany({
    where: { announced: true, amcReleaseDate: { gte: today } },
    orderBy: { amcReleaseDate: "asc" },
  });

  // Rich per-movie fields (synopsis, cast, trailer…) once per movie, not per showtime.
  type M = (typeof announced)[number];
  const detail = (m: M) => ({
    id: m.id,
    title: m.title,
    slug: m.slug,
    isClassic: m.isClassic,
    isSpecialEvent: m.isSpecialEvent,
    isIndie: m.isIndie,
    isForeign: m.isForeign,
    releaseDate: m.releaseDate ? m.releaseDate.toISOString() : null,
    rating: m.rating,
    runtimeMinutes: m.runtimeMinutes,
    posterUrl: m.posterUrl ?? m.amcPosterUrl,
    letterboxdRating: m.letterboxdRating,
    letterboxdUrl: m.letterboxdUrl,
    synopsis: m.synopsis,
    advisory: m.advisory,
    cast: m.cast,
    directors: m.directors,
    genre: m.genre,
    trailerUrl: m.trailerUrl,
    amcReleaseDate: m.amcReleaseDate ? m.amcReleaseDate.toISOString() : null,
  });
  const movieDetails: Record<string, ReturnType<typeof detail>> = {};
  for (const s of showtimes) movieDetails[s.movie.id] ??= detail(s.movie);
  for (const m of announced) movieDetails[m.id] ??= detail(m);
  const theatres = await prisma.theatre.findMany({ orderBy: { name: "asc" } });

  const data = {
    generatedAt: new Date().toISOString(),
    theatres: theatres.map((t) => ({ slug: t.slug, name: t.name, active: t.active })),
    showtimes: showtimes.map((s) => ({
      id: s.id,
      startsAt: s.startsAt.toISOString(),
      movieId: s.movieId,
      format: s.format,
      ticketUrl: s.ticketUrl,
      aListExcluded: s.aListExcluded,
      soldOut: s.soldOut,
      almostSoldOut: s.almostSoldOut,
      price: s.price,
      discount: s.discount,
      movie: {
        id: s.movie.id,
        title: s.movie.title,
        slug: s.movie.slug,
        isClassic: s.movie.isClassic,
        isSpecialEvent: s.movie.isSpecialEvent,
        isIndie: s.movie.isIndie,
        isForeign: s.movie.isForeign,
        releaseDate: s.movie.releaseDate ? s.movie.releaseDate.toISOString() : null,
        rating: s.movie.rating,
        runtimeMinutes: s.movie.runtimeMinutes,
        posterUrl: s.movie.posterUrl ?? s.movie.amcPosterUrl,
        letterboxdRating: s.movie.letterboxdRating,
        letterboxdUrl: s.movie.letterboxdUrl,
      },
      theatre: { slug: s.theatre.slug, name: s.theatre.name, active: s.theatre.active },
    })),
    movieDetails,
    announced: announced.map(detail),
  };

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "snapshot.json"), JSON.stringify(data));
  console.log(
    `wrote src/data/snapshot.json: ${data.showtimes.length} showtimes, ${data.theatres.length} theatres, ${data.announced.length} announced`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
