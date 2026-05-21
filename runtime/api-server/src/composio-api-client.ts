// Server-side client for Composio's curated API surface, exposed for any
// runtime caller that needs Composio access without a logged-in user
// session attached. This is the runtime counterpart to the
// `/api/composio/internal/*` route family on Hono.
//
// Why this exists separately from `ComposioService`:
//
//   ComposioService (existing) — runtime → Hono /api/composio/{execute,proxy}
//     → user-session-bound, charges quota, used by the chat-driven MCP
//     sidecar where every request is on behalf of the logged-in user.
//
//   ComposioApiClient (this file) — runtime → Hono /api/composio/internal/*
//     → service-token auth (X-API-Key), no session, no quota. Used by
//     cron workers, onboarding context prefetch, background data
//     harvesting, training-set collection. Caller passes ownerUserId
//     explicitly on each call; Hono still verifies the connected
//     account upstream-matches that owner before forwarding.
//
// The COMPOSIO_API_KEY itself never reaches the runtime — Hono holds
// it, runtime only holds the symmetric service token shared with Hono
// (env: AGENT_SERVICE_API_KEY).

export interface ComposioApiClientConfig {
  /** Hono base URL (no trailing slash). Same shape as
   *  ComposioService.honoBaseUrl — the env var on the runtime side is
   *  HOLABOSS_AUTH_BASE_URL. Reused here so callers don't carry two
   *  copies of the same URL. */
  honoBaseUrl: string;
  /** Symmetric service-to-service token. Sent as `X-API-Key`. Must
   *  match Hono's `AGENT_SERVICE_API_KEY`. Read from
   *  `process.env.AGENT_SERVICE_API_KEY` on the runtime side. */
  serviceToken: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

export interface ComposioApiClientErrorInfo {
  code: string;
  message?: string;
  status?: number;
  slug?: string;
  logId?: string;
  connectedAccountId?: string;
  userAction?: string;
}

/** Thrown when a Composio internal call did not return ok=true. Carries
 *  the structured error from Hono so callers can branch on `info.code`
 *  (e.g. "connection_expired" → re-prompt user; "forbidden" → wrong
 *  owner). HTTP-layer failures (network, 5xx without JSON) come through
 *  as a regular Error. */
export class ComposioApiClientError extends Error {
  readonly info: ComposioApiClientErrorInfo;
  readonly httpStatus: number;

  constructor(httpStatus: number, info: ComposioApiClientErrorInfo) {
    super(info.message ?? info.code);
    this.name = "ComposioApiClientError";
    this.info = info;
    this.httpStatus = httpStatus;
  }
}

export interface ExecuteActionParams {
  toolSlug: string;
  ownerUserId: string;
  connectedAccountId: string;
  arguments?: Record<string, unknown>;
}

export interface ExecuteActionResponse<TData = unknown> {
  data: TData | null;
  logId: string | null;
}

export interface ProxyRequestParams {
  ownerUserId: string;
  connectedAccountId: string;
  endpoint: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ProxyRequestResponse<TData = unknown> {
  data: TData | null;
  status: number;
  headers: Record<string, string>;
}

export interface ListConnectionsParams {
  ownerUserId: string;
  providerId?: string;
}

export interface ListConnectionsResponse {
  connections: Array<Record<string, unknown>>;
}

export interface GetConnectionResponse {
  connection: Record<string, unknown>;
}

export interface ListToolkitToolsResponse {
  tools: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asErrorInfo(raw: unknown, fallbackCode: string): ComposioApiClientErrorInfo {
  if (!isRecord(raw)) {
    return { code: fallbackCode };
  }
  const out: ComposioApiClientErrorInfo = {
    code: typeof raw.code === "string" ? raw.code : fallbackCode,
  };
  if (typeof raw.message === "string") out.message = raw.message;
  if (typeof raw.status === "number") out.status = raw.status;
  if (typeof raw.slug === "string") out.slug = raw.slug;
  if (typeof raw.log_id === "string") out.logId = raw.log_id;
  if (typeof raw.connected_account_id === "string") {
    out.connectedAccountId = raw.connected_account_id;
  }
  if (typeof raw.user_action === "string") out.userAction = raw.user_action;
  return out;
}

export class ComposioApiClient {
  readonly honoBaseUrl: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ComposioApiClientConfig) {
    if (!config.honoBaseUrl) {
      throw new Error("ComposioApiClient: honoBaseUrl is required");
    }
    if (!config.serviceToken) {
      throw new Error("ComposioApiClient: serviceToken is required");
    }
    this.honoBaseUrl = config.honoBaseUrl.replace(/\/+$/, "");
    this.serviceToken = config.serviceToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Execute a Composio cataloged tool by slug for a specific user. The
   *  most general-purpose call — drives data fetches, posts, sends,
   *  searches, etc., across every toolkit Composio supports. */
  async executeAction<TData = unknown>(
    params: ExecuteActionParams,
  ): Promise<ExecuteActionResponse<TData>> {
    const response = await this.postJson("/api/composio/internal/tools/execute", {
      tool_slug: params.toolSlug,
      owner_user_id: params.ownerUserId,
      connected_account_id: params.connectedAccountId,
      arguments: params.arguments ?? {},
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      data?: TData | null;
      log_id?: string | null;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_execute_failed"),
      );
    }
    return {
      data: (payload.data ?? null) as TData | null,
      logId: payload.log_id ?? null,
    };
  }

  /** Forward an arbitrary upstream HTTP request through Composio's
   *  /tools/execute/proxy endpoint. Use this when the action you want
   *  isn't in Composio's curated tool catalog but the toolkit's
   *  underlying REST API exposes it. Composio still attaches the
   *  user's OAuth credentials to the request. */
  async proxyRequest<TData = unknown>(
    params: ProxyRequestParams,
  ): Promise<ProxyRequestResponse<TData>> {
    const response = await this.postJson("/api/composio/internal/proxy", {
      owner_user_id: params.ownerUserId,
      connected_account_id: params.connectedAccountId,
      endpoint: params.endpoint,
      method: params.method ?? "GET",
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.headers ? { headers: params.headers } : {}),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      data?: TData | null;
      status?: number;
      headers?: Record<string, string>;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_proxy_failed"),
      );
    }
    return {
      data: (payload.data ?? null) as TData | null,
      status: payload.status ?? response.status,
      headers: payload.headers ?? {},
    };
  }

  /** List Composio connected accounts for a given user, optionally
   *  filtered by toolkit. Returns the raw Composio account payloads so
   *  the caller decides which fields to keep. */
  async listConnections(
    params: ListConnectionsParams,
  ): Promise<ListConnectionsResponse> {
    const search = new URLSearchParams({ owner_user_id: params.ownerUserId });
    if (params.providerId) {
      search.set("provider_id", params.providerId);
    }
    const response = await this.getJson(
      `/api/composio/internal/connections?${search.toString()}`,
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      connections?: Array<Record<string, unknown>>;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_list_connections_failed"),
      );
    }
    return { connections: payload.connections ?? [] };
  }

  /** Read a single Composio connected account by id. */
  async getConnection(connectionId: string): Promise<GetConnectionResponse> {
    const response = await this.getJson(
      `/api/composio/internal/connections/${encodeURIComponent(connectionId)}`,
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      connection?: Record<string, unknown>;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_get_connection_failed"),
      );
    }
    return { connection: payload.connection ?? {} };
  }

  /** Enumerate the catalog of executable tools for a toolkit (the
   *  shapes you can feed to executeAction). Composio's tool catalog
   *  per toolkit is the source of truth for "what actions exist". */
  async listToolkitTools(toolkitSlug: string): Promise<ListToolkitToolsResponse> {
    const response = await this.getJson(
      `/api/composio/internal/toolkits/${encodeURIComponent(toolkitSlug)}/tools`,
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      tools?: Array<Record<string, unknown>>;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_list_tools_failed"),
      );
    }
    return { tools: payload.tools ?? [] };
  }

  private postJson(path: string, body: Record<string, unknown>): Promise<Response> {
    return this.fetchImpl(`${this.honoBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "X-API-Key": this.serviceToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  private getJson(path: string): Promise<Response> {
    return this.fetchImpl(`${this.honoBaseUrl}${path}`, {
      method: "GET",
      headers: {
        "X-API-Key": this.serviceToken,
        Accept: "application/json",
      },
    });
  }
}

/** Build a `ComposioApiClient` from the runtime's standard env vars.
 *  Returns `null` when either env is missing so the caller can branch on
 *  "Composio internal access not configured in this deployment" without
 *  throwing during boot. Matches the pattern used for ComposioService. */
export function createComposioApiClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ComposioApiClient | null {
  const honoBaseUrl = (env.HOLABOSS_AUTH_BASE_URL ?? "").trim();
  const serviceToken = (env.AGENT_SERVICE_API_KEY ?? "").trim();
  if (!honoBaseUrl || !serviceToken) {
    return null;
  }
  return new ComposioApiClient({ honoBaseUrl, serviceToken });
}
