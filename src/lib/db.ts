import { PrismaClient } from "../generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  // Choose the driver adapter by URL scheme: Postgres in prod, SQLite locally.
  // The generated client's SQL dialect must match (see scripts/db-provider.mjs,
  // run with PRISMA_DB_PROVIDER=postgresql for prod builds).
  if (/^postgres(ql)?:\/\//.test(url)) {
    const { PrismaPg } = require("@prisma/adapter-pg");
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  }
  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
