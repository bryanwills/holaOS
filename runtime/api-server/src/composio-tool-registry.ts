import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import yaml from "js-yaml";

import {
  type ComposioMcpHostCliRequest,
  type ComposioMcpToolEntry,
  startComposioMcpHost,
} from "./composio-mcp-host.js";
import { ComposioService } from "./composio-service.js";

// Must satisfy TOOL_ID_PATTERN in workspace-runtime-plan.ts:158
// (^[A-Za-z0-9][A-Za-z0-9_-]*$) — leading underscore variants are rejected
// by the plan validator at agent-run time, see the guard test below.
export const COMPOSIO_REGISTRY_SERVER_ID = "holaboss_composio";

// One-shot cleanup for workspace.yaml files written by a pre-release build
// that used `__composio__` — that id fails TOOL_ID_PATTERN so the entry
// crashes pi at agent-run time. Drop the legacy entry whenever we rewrite.
const LEGACY_COMPOSIO_SERVER_IDS = ["__composio__"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Writes (or replaces) the Composio sidecar's entry in workspace.yaml's
 * mcp_registry. Mirrors `writeWorkspaceMcpRegistryEntry` in workspace-apps.ts
 * but uses a reserved server id (`holaboss_composio`) so it can't collide
 * with a user app id (module ids are bare provider names like `twitter`,
 * `gmail`, etc.).
 */
export interface ComposioMcpRegistryParams {
  serverUrl: string;
  toolNames: string[];
  timeoutMs?: number;
  bumpStartedAt?: boolean;
}

export function writeComposioMcpRegistryEntry(
  workspaceDir: string,
  params: ComposioMcpRegistryParams,
): void {
  const yamlPath = path.join(workspaceDir, "workspace.yaml");
  const raw = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, "utf8") : "";
  const data = (raw ? (yaml.load(raw) as Record<string, unknown>) : {}) || {};

  const registry = isRecord(data.mcp_registry) ? data.mcp_registry : {};
  const servers = isRecord(registry.servers) ? registry.servers : {};
  const allowlist = isRecord(registry.allowlist) ? registry.allowlist : {};
  const existingToolIds: string[] = Array.isArray(allowlist.tool_ids)
    ? (allowlist.tool_ids as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  for (const legacyId of LEGACY_COMPOSIO_SERVER_IDS) {
    delete servers[legacyId];
  }

  const previousServer = isRecord(servers[COMPOSIO_REGISTRY_SERVER_ID])
    ? (servers[COMPOSIO_REGISTRY_SERVER_ID] as Record<string, unknown>)
    : null;
  const startedAt = params.bumpStartedAt
    ? new Date().toISOString()
    : (typeof previousServer?.started_at === "string"
        ? previousServer.started_at
        : new Date().toISOString());

  servers[COMPOSIO_REGISTRY_SERVER_ID] = {
    type: "remote",
    url: params.serverUrl,
    enabled: true,
    timeout_ms: params.timeoutMs ?? 30_000,
    started_at: startedAt,
  };

  const composioIdPrefixes = [
    `${COMPOSIO_REGISTRY_SERVER_ID}.`,
    ...LEGACY_COMPOSIO_SERVER_IDS.map((id) => `${id}.`),
  ];
  const otherToolIds = existingToolIds.filter(
    (id) => !composioIdPrefixes.some((prefix) => id.startsWith(prefix)),
  );
  const newToolIds = [
    ...otherToolIds,
    ...params.toolNames.map((name) => `${COMPOSIO_REGISTRY_SERVER_ID}.${name}`),
  ];

  allowlist.tool_ids = newToolIds;
  registry.servers = servers;
  registry.allowlist = allowlist;
  data.mcp_registry = registry;

  fs.writeFileSync(yamlPath, yaml.dump(data), "utf8");
}

export function removeComposioMcpRegistryEntry(workspaceDir: string): void {
  const yamlPath = path.join(workspaceDir, "workspace.yaml");
  if (!fs.existsSync(yamlPath)) {
    return;
  }
  const raw = fs.readFileSync(yamlPath, "utf8");
  const data = (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};
  const registry = data.mcp_registry as Record<string, unknown> | undefined;
  if (!registry) {
    return;
  }
  const servers = registry.servers as Record<string, unknown> | undefined;
  if (servers) {
    delete servers[COMPOSIO_REGISTRY_SERVER_ID];
    registry.servers = servers;
  }
  const allowlist = registry.allowlist as Record<string, unknown> | undefined;
  if (allowlist && Array.isArray(allowlist.tool_ids)) {
    allowlist.tool_ids = (allowlist.tool_ids as unknown[]).filter(
      (id): id is string =>
        typeof id === "string" && !id.startsWith(`${COMPOSIO_REGISTRY_SERVER_ID}.`),
    );
    registry.allowlist = allowlist;
  }
  data.mcp_registry = registry;
  fs.writeFileSync(yamlPath, yaml.dump(data), "utf8");
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port > 0) {
          resolve(port);
        } else {
          reject(new Error("failed to allocate port for composio-mcp"));
        }
      });
    });
  });
}

type ToolkitToolDefinition = Omit<ComposioMcpToolEntry, "connected_account_id" | "toolkit_slug">;

// Add a row here to expose a new Composio toolkit to the agent.
// Each entry is one toolkit; `tools` lists the verbs we expose for it.
// The internal catalog plan (docs/plans/2026-05-19-agent-direct-integration-tools.md §5.5)
// will replace this with a generated table fed by the Composio /tools endpoint.
const TOOLKIT_CATALOG: Record<string, { tools: ToolkitToolDefinition[] }> = {
  gmail: {
    tools: [
      {
        name: "gmail_get_profile",
        description:
          "Read the authenticated Gmail user's profile (email address, message count, thread count). Read-only.",
        tool_slug: "GMAIL_GET_PROFILE",
        input_schema: {
          type: "object",
          title: "GmailGetProfileRequest",
          properties: {
            user_id: {
              type: "string",
              default: "me",
              description: "User identifier — 'me' for the authenticated user.",
              examples: ["me", "user@example.com"],
            },
          },
        },
        annotations: { readOnlyHint: true },
      },
    ],
  },
};

export function listSupportedToolkitSlugs(): string[] {
  return Object.keys(TOOLKIT_CATALOG);
}

export function buildToolkitCatalog(
  toolkitSlug: string,
  connectedAccountId: string,
): ComposioMcpToolEntry[] {
  const entry = TOOLKIT_CATALOG[toolkitSlug];
  if (!entry) {
    return [];
  }
  return entry.tools.map((tool) => ({
    ...tool,
    toolkit_slug: toolkitSlug,
    connected_account_id: connectedAccountId,
  }));
}

export interface BootstrapComposioMcpParams {
  workspaceDir: string;
  honoBaseUrl: string;
  authCookie: string;
  catalog: ComposioMcpToolEntry[];
  host?: string;
  port?: number;
  composioService?: ComposioService;
}

export interface BootstrapComposioMcpResult {
  url: string;
  port: number;
  toolNames: string[];
  close: () => Promise<void>;
}

/**
 * Start a composio-mcp host bound to a free local port and write its
 * coordinates into the workspace's mcp_registry. Returned `close` shuts the
 * host down + removes the registry entry, so callers can hook this into
 * workspace lifecycle (start workspace → bootstrap; stop workspace → close).
 *
 * PR 1 boots the host in-process. PR 2+ will switch to subprocess sidecar
 * management (mirroring workspace-mcp-sidecar.ts) once we need restart-on-crash
 * + reuse across runtime restarts.
 */
export async function bootstrapComposioMcpForWorkspace(
  params: BootstrapComposioMcpParams,
): Promise<BootstrapComposioMcpResult> {
  if (params.catalog.length === 0) {
    throw new Error("composio MCP bootstrap requires at least one tool entry");
  }
  const host = params.host ?? "127.0.0.1";
  const port = params.port ?? (await findFreePort());

  const tools_json_base64 = Buffer.from(JSON.stringify(params.catalog), "utf8").toString("base64");
  const hostRequest: ComposioMcpHostCliRequest = {
    host,
    port,
    server_name: COMPOSIO_REGISTRY_SERVER_ID,
    hono_base_url: params.honoBaseUrl,
    auth_cookie: params.authCookie,
    tools_json_base64,
  };

  const httpServer = await startComposioMcpHost(hostRequest, {
    composioService: params.composioService,
  });

  const url = `http://${host}:${port}/mcp`;
  const toolNames = params.catalog.map((entry) => entry.name);

  try {
    writeComposioMcpRegistryEntry(params.workspaceDir, {
      serverUrl: url,
      toolNames,
      bumpStartedAt: true,
    });
  } catch (error) {
    httpServer.close();
    throw error;
  }

  return {
    url,
    port,
    toolNames,
    close: async () => {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      try {
        removeComposioMcpRegistryEntry(params.workspaceDir);
      } catch {
        // Workspace may have been deleted between bootstrap and close —
        // safe to ignore, the registry entry would be gone anyway.
      }
    },
  };
}
