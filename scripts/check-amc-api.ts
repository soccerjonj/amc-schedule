// Readiness check for the AMC official API provider — run before switching the
// nightly job to it:  npm run amc:check
// Reads AMC_VENDOR_KEY from .env (never printed). Writes nothing.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AmcApiError, AmcApiProvider, mapApiShowtime } from "../src/lib/providers/amcApi";
import { SEED_THEATRES } from "../src/lib/theatres";

function tally(values: string[]): string {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `    ${String(n).padStart(5)}  ${k}`).join("\n");
}

async function main() {
  const api = new AmcApiProvider();

  // 1. Auth
  try {
    await api.open();
  } catch (e) {
    const msg = (e as Error).message;
    console.log(`✗ Not ready: ${msg}`);
    if (e instanceof AmcApiError && (e.status === 401 || e.status === 403)) {
      console.log("  AMC deploys new keys to production on Thursdays — try again later.");
    }
    process.exit(1);
  }
  console.log("✓ Key authorized");

  // 2. Theatre ids
  console.log("\nTheatres:");
  for (const t of SEED_THEATRES) {
    try {
      console.log(`  ✓ ${t.slug.padEnd(30)} → AMC id ${await api.resolveTheatreId(t)}`);
    } catch (e) {
      console.log(`  ✗ ${t.slug.padEnd(30)} → ${(e as Error).message}`);
    }
  }

  // 3. One theatre's showtimes in depth
  const theatre = SEED_THEATRES[0];
  const { byDate, pages, raw } = await api.fetchTheatre(theatre);
  const mapped = raw.map(mapApiShowtime).filter((s) => s !== null);
  const dates = [...byDate.keys()].sort();
  console.log(`\n${theatre.name}: ${raw.length} showtimes (${raw.length - mapped.length} cancelled) in ${pages} page(s)`);
  console.log(`  horizon: ${dates[0] ?? "-"} → ${dates.at(-1) ?? "-"} (${dates.length} days)`);
  console.log(`  per day: ${dates.map((d) => `${d.slice(5)}:${byDate.get(d)!.length}`).join("  ")}`);

  console.log("\n  premiumFormat values:\n" + tally(raw.map((s) => s.premiumFormat || "(none)")));
  console.log("\n  attribute names:\n" + tally(raw.flatMap((s) => (s.attributes ?? []).map((a) => `${a.name} [${a.code}]`))));
  console.log("\n  derived format →\n" + tally(mapped.map((s) => s.format)));
  console.log("\n  sample mapped rows:");
  for (const s of mapped.slice(0, 3)) console.log("   ", JSON.stringify(s));

  // 4. Identity compatibility with existing data (the bundled snapshot of the DB)
  const snapFile = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "snapshot.json");
  const snap = JSON.parse(readFileSync(snapFile, "utf8")) as {
    showtimes: { id: string; movieId: string; movie: { title: string } }[];
  };
  const snapTitle = new Map(snap.showtimes.map((s) => [s.movieId, s.movie.title]));
  const apiMovies = new Map(mapped.map((s) => [s.movieId, s.movieTitle]));
  const known = [...apiMovies.keys()].filter((id) => snapTitle.has(id));
  console.log(
    `\nMovie ids: ${known.length}/${apiMovies.size} API movies already exist in the DB snapshot ` +
      `(new releases since Sep 2 won't).`,
  );
  const titleDiffs = known.filter((id) => snapTitle.get(id) !== apiMovies.get(id));
  if (titleDiffs.length) {
    console.log(`  title differences (API vs website) — check TMDB matching:`);
    for (const id of titleDiffs.slice(0, 15)) console.log(`    ${id}: "${apiMovies.get(id)}"  vs  "${snapTitle.get(id)}"`);
  }
  const snapShowIds = new Set(snap.showtimes.map((s) => s.id));
  const sameShowIds = mapped.filter((s) => snapShowIds.has(s.showtimeId)).length;
  console.log(`Showtime ids: ${sameShowIds} of ${mapped.length} match snapshot ids (only overlapping dates can match).`);

  await api.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
