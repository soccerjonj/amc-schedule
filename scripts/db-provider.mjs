// Rewrites the datasource provider in prisma/schema.prisma so one schema serves
// both local SQLite and prod Postgres. Prisma can't take the provider from an
// env var, so prod builds run: PRISMA_DB_PROVIDER=postgresql node scripts/db-provider.mjs
// (then `prisma generate`). Defaults to sqlite, leaving local dev unchanged.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const provider = process.env.PRISMA_DB_PROVIDER ?? "sqlite";
if (provider !== "sqlite" && provider !== "postgresql") {
  console.error(`Unsupported PRISMA_DB_PROVIDER: ${provider} (use sqlite|postgresql)`);
  process.exit(1);
}

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "..", "prisma", "schema.prisma");
const src = readFileSync(schemaPath, "utf8");
const next = src.replace(/(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]+"/s, `$1"${provider}"`);

if (next === src) {
  console.log(`provider already "${provider}"`);
} else {
  writeFileSync(schemaPath, next);
  console.log(`set datasource provider to "${provider}"`);
}
