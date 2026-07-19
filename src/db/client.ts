import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL environment variable is not set");
  // Serverless-resilient pool. On Vercel each function instance holds its own pool; the
  // Railway proxy drops idle/excess connections, and frozen-then-thawed functions inherit
  // stale sockets ("Connection terminated unexpectedly"). Keep the pool small, close idle
  // connections quickly so they never go stale, and keep sockets alive.
  const adapter = new PrismaPg({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
  });
  return new PrismaClient({ adapter });
}

// Reuse a single client across module reloads AND across warm serverless invocations
// (globalThis persists while the instance is warm) so we don't open a new pool per request.
const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? createPrismaClient();
g.prisma = prisma;
