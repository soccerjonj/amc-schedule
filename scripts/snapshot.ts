// Dumps the current DB to src/data/snapshot.json, which the app serves when no
// DATABASE_URL is configured (i.e. on Vercel before Neon is wired up). Re-run
// after scraping to refresh the bundled demo data: `npm run snapshot`.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db";

async function main() {
  const showtimes = await prisma.showtime.findMany({
    include: { movie: true, theatre: true },
    orderBy: { startsAt: "asc" },
  });
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
      movie: {
        id: s.movie.id,
        title: s.movie.title,
        slug: s.movie.slug,
        isClassic: s.movie.isClassic,
        isSpecialEvent: s.movie.isSpecialEvent,
        posterUrl: s.movie.posterUrl,
        letterboxdRating: s.movie.letterboxdRating,
        letterboxdUrl: s.movie.letterboxdUrl,
      },
      theatre: { slug: s.theatre.slug, name: s.theatre.name, active: s.theatre.active },
    })),
  };

  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "snapshot.json"), JSON.stringify(data));
  console.log(
    `wrote src/data/snapshot.json: ${data.showtimes.length} showtimes, ${data.theatres.length} theatres`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
