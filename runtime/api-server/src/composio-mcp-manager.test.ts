import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ComposioMcpManager } from "./composio-mcp-manager.js";
import { ComposioService } from "./composio-service.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function createTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "composio-mcp-manager-test-"));
}

function makeWorkspace(root: string, workspaceId: string): void {
  const dir = path.join(root, workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.yaml"), "", "utf8");
}

interface MockFetch {
  fetch: typeof fetch;
  calls: Array<{ url: string; method?: string }>;
}

function mockFetch(handlers: {
  connections?: () => Response;
  execute?: () => Response;
}): MockFetch {
  const calls: Array<{ url: string; method?: string }> = [];
  const handler: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    calls.push({ url, method: init?.method });
    if (url.endsWith("/api/composio/connections") && handlers.connections) {
      return handlers.connections();
    }
    if (url.endsWith("/api/composio/execute") && handlers.execute) {
      return handlers.execute();
    }
    return new Response("not mocked", { status: 599 });
  };
  return { fetch: handler, calls };
}

test("ensureRunning bootstraps a host for the first ACTIVE Hero toolkit and writes the registry", async () => {
  const root = createTempRoot();
  try {
    makeWorkspace(root, "ws1");
    const { fetch: fetchImpl, calls } = mockFetch({
      connections: () =>
        jsonResponse({
          connections: [
            { id: "ca_gmail_active", status: "ACTIVE", toolkitSlug: "gmail", userId: "u1" },
            { id: "ca_slack_active", status: "ACTIVE", toolkitSlug: "slack", userId: "u1" },
          ],
        }),
    });
    const composio = new ComposioService({
      honoBaseUrl: "https://app.holaboss.test",
      authCookie: "hb_session=abc",
      fetchImpl,
    });
    const manager = new ComposioMcpManager({
      composio,
      workspaceRoot: root,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const result = await manager.ensureRunning("ws1");
    try {
      assert.equal(result.status, "started");
      assert.equal(result.toolkit_slug, "gmail");
      assert.equal(result.connected_account_id, "ca_gmail_active");
      assert.deepEqual(result.tool_names, ["gmail_get_profile"]);
      assert.match(result.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, "https://app.holaboss.test/api/composio/connections");

      const running = manager.inspectRunning();
      assert.equal(running.length, 1);
      assert.equal(running[0]?.workspace_id, "ws1");
    } finally {
      await manager.stopAll();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureRunning returns 'reused' on the second call and does not boot a second host", async () => {
  const root = createTempRoot();
  try {
    makeWorkspace(root, "ws1");
    let connectionsCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      if (url.endsWith("/api/composio/connections")) {
        connectionsCalls += 1;
        return jsonResponse({
          connections: [
            { id: "ca_gmail", status: "ACTIVE", toolkitSlug: "gmail", userId: "u1" },
          ],
        });
      }
      return new Response("not mocked", { status: 599 });
    };
    const composio = new ComposioService({
      honoBaseUrl: "https://app.holaboss.test",
      authCookie: "hb_session=abc",
      fetchImpl,
    });
    const manager = new ComposioMcpManager({
      composio,
      workspaceRoot: root,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    try {
      const first = await manager.ensureRunning("ws1");
      const second = await manager.ensureRunning("ws1");
      assert.equal(first.status, "started");
      assert.equal(second.status, "reused");
      assert.equal(first.url, second.url);
      assert.equal(connectionsCalls, 1, "should not re-query connections on reuse");
    } finally {
      await manager.stopAll();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureRunning short-circuits with skipped: no_supported_active_connection when user has no Hero connections", async () => {
  const root = createTempRoot();
  try {
    makeWorkspace(root, "ws1");
    const { fetch: fetchImpl } = mockFetch({
      connections: () =>
        jsonResponse({
          connections: [
            { id: "ca_x", status: "ACTIVE", toolkitSlug: "obscure_toolkit", userId: "u1" },
            { id: "ca_y", status: "EXPIRED", toolkitSlug: "gmail", userId: "u1" },
          ],
        }),
    });
    const composio = new ComposioService({
      honoBaseUrl: "https://app.holaboss.test",
      authCookie: "hb_session=abc",
      fetchImpl,
    });
    const manager = new ComposioMcpManager({
      composio,
      workspaceRoot: root,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const result = await manager.ensureRunning("ws1");
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "no_supported_active_connection");
    assert.equal(manager.inspectRunning().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureRunning short-circuits with skipped: list_connections_failed on Hono 5xx", async () => {
  const root = createTempRoot();
  try {
    makeWorkspace(root, "ws1");
    const fetchImpl: typeof fetch = async () => new Response("oops", { status: 503 });
    const composio = new ComposioService({
      honoBaseUrl: "https://app.holaboss.test",
      authCookie: "hb_session=abc",
      fetchImpl,
    });
    const manager = new ComposioMcpManager({
      composio,
      workspaceRoot: root,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const result = await manager.ensureRunning("ws1");
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "list_connections_failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureRunning short-circuits with skipped: workspace_not_found when the dir doesn't exist", async () => {
  const root = createTempRoot();
  try {
    const { fetch: fetchImpl } = mockFetch({
      connections: () =>
        jsonResponse({ connections: [{ id: "ca_gmail", status: "ACTIVE", toolkitSlug: "gmail" }] }),
    });
    const composio = new ComposioService({
      honoBaseUrl: "https://app.holaboss.test",
      authCookie: "hb_session=abc",
      fetchImpl,
    });
    const manager = new ComposioMcpManager({
      composio,
      workspaceRoot: root,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const result = await manager.ensureRunning("nonexistent_ws");
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "workspace_not_found");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent ensureRunning calls dedupe to one bootstrap (in-flight cache)", async () => {
  const root = createTempRoot();
  try {
    makeWorkspace(root, "ws1");
    let connectionsCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      if (url.endsWith("/api/composio/connections")) {
        connectionsCalls += 1;
        // Delay so a second ensureRunning lands while this one is mid-flight.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return jsonResponse({
          connections: [{ id: "ca_gmail", status: "ACTIVE", toolkitSlug: "gmail" }],
        });
      }
      return new Response("not mocked", { status: 599 });
    };
    const composio = new ComposioService({
      honoBaseUrl: "https://app.holaboss.test",
      authCookie: "hb_session=abc",
      fetchImpl,
    });
    const manager = new ComposioMcpManager({
      composio,
      workspaceRoot: root,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    try {
      const [a, b] = await Promise.all([manager.ensureRunning("ws1"), manager.ensureRunning("ws1")]);
      assert.equal(a.status, "started");
      assert.equal(b.status, "started");
      assert.equal(a.url, b.url, "both callers should observe the same host url");
      assert.equal(connectionsCalls, 1, "list_connections should fire once even under concurrent ensure");
      assert.equal(manager.inspectRunning().length, 1);
    } finally {
      await manager.stopAll();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stopAll closes every cached host and clears the cache", async () => {
  const root = createTempRoot();
  try {
    makeWorkspace(root, "ws1");
    makeWorkspace(root, "ws2");
    const { fetch: fetchImpl } = mockFetch({
      connections: () =>
        jsonResponse({
          connections: [{ id: "ca_gmail", status: "ACTIVE", toolkitSlug: "gmail" }],
        }),
    });
    const composio = new ComposioService({
      honoBaseUrl: "https://app.holaboss.test",
      authCookie: "hb_session=abc",
      fetchImpl,
    });
    const manager = new ComposioMcpManager({
      composio,
      workspaceRoot: root,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await manager.ensureRunning("ws1");
    await manager.ensureRunning("ws2");
    assert.equal(manager.inspectRunning().length, 2);

    await manager.stopAll();
    assert.equal(manager.inspectRunning().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
