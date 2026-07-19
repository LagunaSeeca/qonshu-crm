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

// Transient connection failures happen on serverless cold starts: the first query on a
// freshly-thawed function can inherit a socket the Railway proxy already dropped, surfacing
// as "Connection terminated unexpectedly" / ECONNRESET. Retry those on READ operations only
// (retrying writes could double-apply), which lets the pool re-establish a fresh connection.
const READ_OPS = new Set(["findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "findMany", "count", "aggregate", "groupBy"]);
const TRANSIENT = /Connection terminated|ECONNRESET|Closed|Can't reach database|connection.*closed|terminating connection|server closed the connection/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withRetry(base: PrismaClient): PrismaClient {
  return base.$extends({
    query: {
      async $allOperations({ operation, args, query }) {
        if (!READ_OPS.has(operation)) return query(args);
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await query(args);
          } catch (e) {
            lastErr = e;
            if (!TRANSIENT.test(e instanceof Error ? e.message : String(e))) throw e;
            await sleep(120 * (attempt + 1));
          }
        }
        throw lastErr;
      },
    },
  }) as unknown as PrismaClient;
}

// Reuse a single client across module reloads AND across warm serverless invocations
// (globalThis persists while the instance is warm) so we don't open a new pool per request.
const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? withRetry(createPrismaClient());
g.prisma = prisma;
