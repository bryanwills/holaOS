import assert from "node:assert/strict";
import test from "node:test";

import {
  ComposioApiClient,
  ComposioApiClientError,
  createComposioApiClientFromEnv,
} from "./composio-api-client.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface ScriptedResponse {
  status: number;
  body: unknown;
}

function makeHarness() {
  const captured: CapturedRequest[] = [];
  const scripted: ScriptedResponse[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const headersRecord: Record<string, string> = {};
    const rawHeaders = init?.headers ?? {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headersRecord[key] = value;
      });
    } else if (Array.isArray(rawHeaders)) {
      for (const [key, value] of rawHeaders) {
        headersRecord[key] = value;
      }
    } else if (typeof rawHeaders === "object" && rawHeaders) {
      for (const [key, value] of Object.entries(
        rawHeaders as Record<string, string>,
      )) {
        headersRecord[key] = value;
      }
    }
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers: headersRecord,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = scripted.shift();
    if (!next) {
      throw new Error("no scripted response");
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { captured, scripted, fetchImpl };
}

function makeClient(fetchImpl: typeof fetch): ComposioApiClient {
  return new ComposioApiClient({
    honoBaseUrl: "https://hono.example.com",
    serviceToken: "svc-token",
    fetchImpl,
  });
}

test("executeAction posts to /internal/tools/execute with X-API-Key and the canonical body", async () => {
  const { captured, scripted, fetchImpl } = makeHarness();
  scripted.push({
    status: 200,
    body: { ok: true, data: { emails: 12 }, log_id: "lg_1" },
  });
  const client = makeClient(fetchImpl);
  const result = await client.executeAction({
    toolSlug: "GMAIL_GET_PROFILE",
    ownerUserId: "user-1",
    connectedAccountId: "ca_abc",
    arguments: { user_id: "me" },
  });
  assert.deepEqual(result, { data: { emails: 12 }, logId: "lg_1" });
  assert.equal(captured.length, 1);
  assert.equal(
    captured[0]!.url,
    "https://hono.example.com/api/composio/internal/tools/execute",
  );
  assert.equal(captured[0]!.method, "POST");
  assert.equal(captured[0]!.headers["X-API-Key"], "svc-token");
  assert.equal(
    captured[0]!.body,
    JSON.stringify({
      tool_slug: "GMAIL_GET_PROFILE",
      owner_user_id: "user-1",
      connected_account_id: "ca_abc",
      arguments: { user_id: "me" },
    }),
  );
});

test("executeAction surfaces typed error info when Hono returns ok=false", async () => {
  const { scripted, fetchImpl } = makeHarness();
  scripted.push({
    status: 409,
    body: {
      ok: false,
      error: {
        code: "connection_expired",
        message: "Token expired",
        slug: "TOOL_AUTH_BadConnectedAccountState",
        connected_account_id: "ca_abc",
        user_action: "reconnect",
      },
    },
  });
  const client = makeClient(fetchImpl);
  await assert.rejects(
    () =>
      client.executeAction({
        toolSlug: "GMAIL_GET_PROFILE",
        ownerUserId: "user-1",
        connectedAccountId: "ca_abc",
      }),
    (error) => {
      assert.equal(error instanceof ComposioApiClientError, true);
      const info = (error as ComposioApiClientError).info;
      assert.equal(info.code, "connection_expired");
      assert.equal(info.userAction, "reconnect");
      assert.equal(info.connectedAccountId, "ca_abc");
      assert.equal((error as ComposioApiClientError).httpStatus, 409);
      return true;
    },
  );
});

test("proxyRequest forwards method+endpoint+body to /internal/proxy", async () => {
  const { captured, scripted, fetchImpl } = makeHarness();
  scripted.push({
    status: 200,
    body: {
      ok: true,
      data: { id: "row-1" },
      status: 200,
      headers: { "content-type": "application/json" },
    },
  });
  const client = makeClient(fetchImpl);
  const result = await client.proxyRequest({
    ownerUserId: "user-1",
    connectedAccountId: "ca_abc",
    endpoint: "/api/v2/users/me",
    method: "GET",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { id: "row-1" });
  assert.equal(captured.length, 1);
  assert.equal(
    captured[0]!.url,
    "https://hono.example.com/api/composio/internal/proxy",
  );
  const parsed = JSON.parse(captured[0]!.body ?? "{}") as Record<string, unknown>;
  assert.equal(parsed.owner_user_id, "user-1");
  assert.equal(parsed.connected_account_id, "ca_abc");
  assert.equal(parsed.endpoint, "/api/v2/users/me");
  assert.equal(parsed.method, "GET");
});

test("listConnections passes owner_user_id and optional provider_id as query params", async () => {
  const { captured, scripted, fetchImpl } = makeHarness();
  scripted.push({
    status: 200,
    body: { ok: true, connections: [{ id: "ca_1" }, { id: "ca_2" }] },
  });
  const client = makeClient(fetchImpl);
  const result = await client.listConnections({
    ownerUserId: "user-1",
    providerId: "gmail",
  });
  assert.equal(result.connections.length, 2);
  assert.equal(captured[0]!.method, "GET");
  assert.match(
    captured[0]!.url,
    /\/api\/composio\/internal\/connections\?owner_user_id=user-1&provider_id=gmail$/,
  );
});

test("getConnection passes connection id through encoded URL", async () => {
  const { captured, scripted, fetchImpl } = makeHarness();
  scripted.push({
    status: 200,
    body: { ok: true, connection: { id: "ca_abc/xyz", status: "active" } },
  });
  const client = makeClient(fetchImpl);
  const result = await client.getConnection("ca_abc/xyz");
  assert.equal((result.connection as { status?: string }).status, "active");
  assert.match(
    captured[0]!.url,
    /\/api\/composio\/internal\/connections\/ca_abc%2Fxyz$/,
  );
});

test("listToolkitTools normalizes empty payload to []", async () => {
  const { scripted, fetchImpl } = makeHarness();
  scripted.push({ status: 200, body: { ok: true } });
  const client = makeClient(fetchImpl);
  const result = await client.listToolkitTools("gmail");
  assert.deepEqual(result.tools, []);
});

test("constructor rejects missing config", () => {
  assert.throws(
    () =>
      new ComposioApiClient({
        honoBaseUrl: "",
        serviceToken: "svc",
      }),
    /honoBaseUrl/,
  );
  assert.throws(
    () =>
      new ComposioApiClient({
        honoBaseUrl: "https://hono.example",
        serviceToken: "",
      }),
    /serviceToken/,
  );
});

test("createComposioApiClientFromEnv returns null when env is missing pieces", () => {
  assert.equal(
    createComposioApiClientFromEnv({} as NodeJS.ProcessEnv),
    null,
  );
  assert.equal(
    createComposioApiClientFromEnv({
      HOLABOSS_AUTH_BASE_URL: "https://hono.example",
    } as NodeJS.ProcessEnv),
    null,
  );
  assert.equal(
    createComposioApiClientFromEnv({
      AGENT_SERVICE_API_KEY: "svc",
    } as NodeJS.ProcessEnv),
    null,
  );
});

test("createComposioApiClientFromEnv returns a configured client when both env vars are set", () => {
  const client = createComposioApiClientFromEnv({
    HOLABOSS_AUTH_BASE_URL: "https://hono.example",
    AGENT_SERVICE_API_KEY: "svc",
  } as NodeJS.ProcessEnv);
  assert.ok(client);
  assert.equal(client?.honoBaseUrl, "https://hono.example");
});
