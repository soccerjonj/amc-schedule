import { PrismaClient } from "../generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  // The adapter MUST match the provider the client was generated with, or Prisma
  // throws an "incompatible adapter" error. Both are driven by PRISMA_DB_PROVIDER
  // (see scripts/db-provider.mjs); fall back to the URL scheme so plain local dev
  // with no env set still resolves to SQLite.
  const provider =
    process.env.PRISMA_DB_PROVIDER ??
    (/^postgres(ql)?:\/\//.test(url) ? "postgresql" : "sqlite");
  if (provider === "postgresql") {
    const { PrismaPg } = require("@prisma/adapter-pg");
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  }
  const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
  return new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
