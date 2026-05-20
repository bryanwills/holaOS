import fs from "node:fs";
import path from "node:path";

import {
  bootstrapComposioMcpForWorkspace,
  buildToolkitCatalog,
  listSupportedToolkitSlugs,
  type BootstrapComposioMcpResult,
} from "./composio-tool-registry.js";
import {
  ComposioService,
  type ComposioConnectionSummary,
} from "./composio-service.js";

export interface ComposioMcpManagerDeps {
  composio: ComposioService;
  workspaceRoot: string;
  logger?: Pick<typeof console, "info" | "warn" | "error">;
}

export interface ComposioMcpEnsureResult {
  status: "started" | "reused" | "skipped";
  reason?: string;
  url?: string;
  tool_names?: string[];
  toolkit_slug?: string;
  connected_account_id?: string;
}

/**
 * Lifecycle-aware wrapper around bootstrapComposioMcpForWorkspace.
 *
 * - `ensureRunning(workspaceId)` is idempotent: subsequent calls return the
 *    cached BootstrapResult instead of starting a second host (which would
 *    occupy a fresh port and overwrite the registry url to one that no MCP
 *    client connected to yet).
 * - `stopAll()` runs at runtime shutdown so hosts don't leak.
 * - If the runtime has no ComposioService configured (no auth cookie / no
 *    Hono base url), every call short-circuits with status: "skipped".
 */
export class ComposioMcpManager {
  private readonly composio: ComposioService;
  private readonly workspaceRoot: string;
  private readonly logger: NonNullable<ComposioMcpManagerDeps["logger"]>;
  private readonly cache = new Map<string, BootstrapComposioMcpResult>();
  private readonly inFlight = new Map<string, Promise<ComposioMcpEnsureResult>>();

  constructor(deps: ComposioMcpManagerDeps) {
    this.composio = deps.composio;
    this.workspaceRoot = deps.workspaceRoot;
    this.logger = deps.logger ?? console;
  }

  async ensureRunning(workspaceId: string): Promise<ComposioMcpEnsureResult> {
    const cached = this.cache.get(workspaceId);
    if (cached) {
      return {
        status: "reused",
        url: cached.url,
        tool_names: cached.toolNames,
      };
    }
    const pending = this.inFlight.get(workspaceId);
    if (pending) {
      return await pending;
    }

    const task = this.startUnsafe(workspaceId).finally(() => {
      this.inFlight.delete(workspaceId);
    });
    this.inFlight.set(workspaceId, task);
    return await task;
  }

  private async startUnsafe(workspaceId: string): Promise<ComposioMcpEnsureResult> {
    const workspaceDir = path.join(this.workspaceRoot, workspaceId);
    if (!fs.existsSync(workspaceDir)) {
      return { status: "skipped", reason: "workspace_not_found" };
    }

    let connections: ComposioConnectionSummary[];
    try {
      connections = await this.composio.listConnections();
    } catch (error) {
      this.logger.warn(
        "composio-mcp manager: listConnections failed, skipping bootstrap",
        error,
      );
      return { status: "skipped", reason: "list_connections_failed" };
    }

    const supportedSlugs = new Set(listSupportedToolkitSlugs());
    const activeSupported = connections.filter(
      (conn) => conn.status === "ACTIVE" && supportedSlugs.has(conn.toolkitSlug),
    );
    if (activeSupported.length === 0) {
      return { status: "skipped", reason: "no_supported_active_connection" };
    }
    // One workspace, many connected toolkits → flatten every supported
    // toolkit's catalog into one MCP host. Multi-account dedupe (same
    // toolkit connected twice) is P1.
    const catalog = activeSupported.flatMap((conn) => buildToolkitCatalog(conn.toolkitSlug, conn.id));
    const pick = activeSupported[0]!;

    let result: BootstrapComposioMcpResult;
    try {
      result = await bootstrapComposioMcpForWorkspace({
        workspaceDir,
        honoBaseUrl: this.composio.honoBaseUrl,
        authCookie: this.composio.authCookie,
        catalog,
        composioService: this.composio,
      });
    } catch (error) {
      this.logger.error(
        "composio-mcp manager: bootstrap failed",
        { workspaceId, toolkit: pick.toolkitSlug, err: error },
      );
      return { status: "skipped", reason: "bootstrap_failed" };
    }

    this.cache.set(workspaceId, result);
    this.logger.info(
      "composio-mcp manager: started",
      {
        workspaceId,
        toolkit: pick.toolkitSlug,
        connectedAccountId: pick.id,
        url: result.url,
        toolNames: result.toolNames,
      },
    );

    return {
      status: "started",
      url: result.url,
      tool_names: result.toolNames,
      toolkit_slug: pick.toolkitSlug,
      connected_account_id: pick.id,
    };
  }

  async stopAll(): Promise<void> {
    const entries = Array.from(this.cache.entries());
    this.cache.clear();
    await Promise.all(
      entries.map(async ([workspaceId, result]) => {
        try {
          await result.close();
        } catch (error) {
          this.logger.warn(
            "composio-mcp manager: close failed",
            { workspaceId, err: error },
          );
        }
      }),
    );
  }

  /** Currently running hosts. Exposed for tests + debug endpoints. */
  inspectRunning(): Array<{ workspace_id: string; url: string; tool_names: string[] }> {
    return Array.from(this.cache.entries()).map(([workspaceId, result]) => ({
      workspace_id: workspaceId,
      url: result.url,
      tool_names: result.toolNames,
    }));
  }
}
