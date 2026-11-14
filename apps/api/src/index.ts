import { PROTOCOL_VERSION, type ApiHealthResponse } from '@elm/protocol';

export interface Env {
  DB: D1Database;
  SIGNALING_COORDINATOR: DurableObjectNamespace;
}

/**
 * SQLite-backed Durable Object stub for Cloudflare Free Tier compliance.
 * Ephemeral invite coordination and WebRTC signaling will be implemented in Phase 3+.
 */
export class SignalingCoordinator implements DurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(_request: Request): Promise<Response> {
    // Verify SQLite storage availability on the Durable Object context
    const cursor = this.state.storage.sql.exec('SELECT 1 AS ready');
    const rows = cursor.toArray();
    return Response.json({
      durableObject: 'SignalingCoordinator',
      sqliteReady: rows.length === 1,
      note: 'Phase 1 scaffold stub — signaling not yet implemented.',
    });
  }
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      const payload: ApiHealthResponse = {
        status: 'ok',
        phase: 'phase-1-scaffold',
        protocolVersion: PROTOCOL_VERSION,
        timestamp: new Date().toISOString(),
      };
      return Response.json(payload);
    }

    return Response.json(
      {
        error: 'Not Found',
        message: 'Elm-AnyDesk API Phase 1 Scaffold. Auth and signaling are not implemented in Phase 1.',
      },
      { status: 404 }
    );
  },
} satisfies ExportedHandler<Env>;
