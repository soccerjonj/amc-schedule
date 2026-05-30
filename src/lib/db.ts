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

function getClient(): PrismaClient {
  const existing = globalForPrisma.prisma ?? createClient();
  if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = existing;
  return existing;
}

// Lazy: instantiating the client (and loading its native driver) is deferred to
// first use. In snapshot mode (no DATABASE_URL) the API never touches `prisma`,
// so the SQLite/Postgres native adapter is never required — which is what lets
// the app deploy to Vercel with no database configured.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const client = getClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});
