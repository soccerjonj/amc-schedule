import "dotenv/config";
import { ingest } from "../src/lib/ingest";
import { SEED_THEATRES } from "../src/lib/theatres";
import { prisma } from "../src/lib/db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const days = parseInt(arg("days") ?? "14", 10);
  const only = arg("theatre");
  const theatres = only ? SEED_THEATRES.filter((t) => t.slug === only) : SEED_THEATRES;
  if (theatres.length === 0) {
    console.error(`No theatre matches "${only}". Known:`, SEED_THEATRES.map((t) => t.slug).join(", "));
    process.exit(1);
  }

  console.log(`Scraping ${theatres.length} theatre(s) x ${days} day(s)...`);
  const t0 = Date.now();
  const stats = await ingest({ days, theatres });
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, stats);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
