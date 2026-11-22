import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SignalingCoordinator } from '../apps/api/src/coordinator.ts';
import { createApiWorker, type Env } from '../apps/api/src/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function createInMemoryD1Database(): D1Database {
  const db = new DatabaseSync(':memory:');
  const migrationSql = fs.readFileSync(
    path.join(repoRoot, 'apps/api/migrations/0001_accounts_and_friend_codes.sql'),
    'utf8'
  );
  db.exec(migrationSql);

  const createBoundStatement = (sql: string, boundValues: unknown[] = []) => {
    const normalizeSql = sql.replace(/\?(\d+)/g, '?');
    return {
      bind(...values: unknown[]) {
        return createBoundStatement(sql, values);
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const stmt = db.prepare(normalizeSql);
        const row = stmt.get(...(boundValues as never[])) as T | undefined;
        return row ?? null;
      },
      async run(): Promise<D1Result> {
        const stmt = db.prepare(normalizeSql);
        stmt.run(...(boundValues as never[]));
        return {
          success: true,
          meta: {} as D1Meta,
          results: [],
        };
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const stmt = db.prepare(normalizeSql);
        const rows = stmt.all(...(boundValues as never[])) as T[];
        return {
          success: true,
          meta: {} as D1Meta,
          results: rows,
        };
      },
    };
  };

  return {
    prepare(sql: string) {
      return createBoundStatement(sql);
    },
    async batch() {
      return [];
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  } as unknown as D1Database;
}

function createInMemoryCoordinatorNamespace(nowFn: () => number): DurableObjectNamespace {
  let instance: SignalingCoordinator | null = null;
  const getOrCreate = (): SignalingCoordinator => {
    if (!instance) {
      const sqlite = new DatabaseSync(':memory:');
      const sqlStorage = {
        exec<T extends Record<string, SqlStorageValue>>(
          query: string,
          ...bindings: unknown[]
        ) {
          if (bindings.length === 0) {
            const trimmed = query.trim();
            if (/^SELECT\b/i.test(trimmed)) {
              const stmt = sqlite.prepare(trimmed);
              const rows = stmt.all() as T[];
              return { toArray: () => rows };
            }
            sqlite.exec(query);
            return { toArray: () => [] as T[] };
          }
          const stmt = sqlite.prepare(query);
          if (/^\s*SELECT\b/i.test(query)) {
            const rows = stmt.all(...(bindings as never[])) as T[];
            return { toArray: () => rows };
          }
          stmt.run(...(bindings as never[]));
          return { toArray: () => [] as T[] };
        },
      };
      const fakeState = {
        storage: { sql: sqlStorage },
      } as unknown as DurableObjectState;
      instance = new SignalingCoordinator(fakeState, {}, { now: nowFn });
    }
    return instance;
  };

  return {
    idFromName(name: string) {
      return { name } as unknown as DurableObjectId;
    },
    get() {
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          const req =
            input instanceof Request ? input : new Request(String(input), init);
          return getOrCreate().fetch(req);
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

export interface LocalTwoClientBackend {
  readonly baseUrl: string;
  readonly port: number;
  advanceClockMs: (deltaMs: number) => void;
  setNetworkDown: (down: boolean) => void;
  getTrafficAudit: () => {
    readonly totalRequests: number;
    readonly endpointCounts: Record<string, number>;
    readonly leakedStrings: string[];
    checkNoLeaks: (forbiddenValues: string[]) => string[];
  };
  close: () => Promise<void>;
}

/**
 * Starts an isolated loopback HTTP server executing the REAL Cloudflare Worker
 * (`createApiWorker`), SQLite D1 schema, and SQLite-backed `SignalingCoordinator`.
 */
export async function startLocalTwoClientBackend(options?: {
  port?: number;
}): Promise<LocalTwoClientBackend> {
  let clockOffsetMs = 0;
  let networkDown = false;
  const nowFn = () => Date.now() + clockOffsetMs;

  const env: Env = {
    ENVIRONMENT: 'local-two-client-e2e',
    DB: createInMemoryD1Database(),
    SIGNALING_COORDINATOR: createInMemoryCoordinatorNamespace(nowFn),
    AUTH_TOKEN_SECRET: 'local-two-client-e2e-hmac-secret-never-production',
  };
  const worker = createApiWorker();
  const dummyCtx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  let totalRequests = 0;
  const endpointCounts: Record<string, number> = {};
  const capturedBodies: string[] = [];

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

    // Loopback-only test harness control routes (never exposed in Worker production bundle)
    if (reqUrl.pathname === '/__test/advance-clock' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        ms?: number;
      };
      if (typeof body.ms === 'number' && Number.isFinite(body.ms)) {
        clockOffsetMs += body.ms;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, nowIso: new Date(nowFn()).toISOString() }));
      return;
    }

    if (reqUrl.pathname === '/__test/set-network-down' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        down?: boolean;
      };
      networkDown = Boolean(body.down);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, networkDown }));
      return;
    }

    if (networkDown) {
      res.destroy();
      return;
    }

    totalRequests += 1;
    const key = `${req.method ?? 'GET'} ${reqUrl.pathname}`;
    endpointCounts[key] = (endpointCounts[key] ?? 0) + 1;

    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const rawBody = Buffer.concat(chunks);
      if (rawBody.length > 0) {
        capturedBodies.push(rawBody.toString('utf8'));
      }

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }

      const fetchReq = new Request(`http://127.0.0.1${reqUrl.pathname}${reqUrl.search}`, {
        method: req.method || 'GET',
        headers,
        body:
          req.method && ['GET', 'HEAD'].includes(req.method.toUpperCase())
            ? undefined
            : rawBody.length > 0
              ? rawBody
              : undefined,
      });

      const workerRes = await worker.fetch!(fetchReq, env, dummyCtx);
      const outHeaders: Record<string, string> = {};
      workerRes.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      res.writeHead(workerRes.status, outHeaders);
      const buf = Buffer.from(await workerRes.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'INTERNAL_TEST_BACKEND_ERROR',
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(options?.port ?? 0, '127.0.0.1', () => resolve())
  );
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('Failed to bind local two-client test backend.');
  }
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    port,
    advanceClockMs(deltaMs: number) {
      clockOffsetMs += deltaMs;
    },
    setNetworkDown(down: boolean) {
      networkDown = down;
    },
    getTrafficAudit() {
      const joined = capturedBodies.join('\n');
      return {
        totalRequests,
        endpointCounts: { ...endpointCounts },
        leakedStrings: [],
        checkNoLeaks(forbiddenValues: string[]) {
          return forbiddenValues.filter((v) => v && joined.includes(v));
        },
      };
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const portArg = Number(process.env.ELM_TEST_BACKEND_PORT || 0) || 0;
  const backend = await startLocalTwoClientBackend({ port: portArg });
  console.log(`Elm-AnyDesk isolated test backend listening at ${backend.baseUrl}`);
}
