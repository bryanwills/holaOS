import type {
  RuntimeStateStore,
  WorkspaceIntegrationOverrideRecord,
  WorkspaceIntegrationOverrideState,
} from "@holaboss/runtime-state-store";

import { listSupportedToolkitSlugs } from "./composio-tool-registry.js";
import type { ComposioConnectionSummary, ComposioService } from "./composio-service.js";

export type WorkspaceIntegrationEffectiveState =
  | "auto"        // No override: inherits the account active pool.
  | "disabled"    // Override: explicitly disabled in this workspace.
  | "pinned";     // Override: locked to a specific connected_account.

export interface WorkspaceIntegrationConnectionView {
  connected_account_id: string;
  status: string;
  user_id: string;
  created_at: string;
}

export interface WorkspaceIntegrationView {
  toolkit_slug: string;
  toolkit_name: string;
  toolkit_logo: string | null;
  supported: boolean;
  effective_state: WorkspaceIntegrationEffectiveState;
  effective_connection_id: string | null;
  pinned_connection_id: string | null;
  connections: WorkspaceIntegrationConnectionView[];
}

export interface ListWorkspaceIntegrationsResult {
  workspace_id: string;
  integrations: WorkspaceIntegrationView[];
}

export class WorkspaceIntegrationsService {
  private readonly store: RuntimeStateStore;
  private readonly composio: ComposioService | null;

  constructor(store: RuntimeStateStore, composio: ComposioService | null) {
    this.store = store;
    this.composio = composio;
  }

  async list(workspaceId: string): Promise<ListWorkspaceIntegrationsResult> {
    const overrides = this.store.listWorkspaceIntegrationOverrides({ workspaceId });
    const overrideByToolkit = new Map<string, WorkspaceIntegrationOverrideRecord>();
    for (const o of overrides) overrideByToolkit.set(o.toolkitSlug, o);

    let connections: ComposioConnectionSummary[] = [];
    if (this.composio) {
      try {
        connections = await this.composio.listConnections();
      } catch {
        connections = [];
      }
    }
    const supportedSlugs = new Set(listSupportedToolkitSlugs());

    const grouped = new Map<string, ComposioConnectionSummary[]>();
    for (const conn of connections) {
      if (conn.status !== "ACTIVE") continue;
      const list = grouped.get(conn.toolkitSlug);
      if (list) list.push(conn);
      else grouped.set(conn.toolkitSlug, [conn]);
    }

    // Show one row per toolkit that the user has at least one active
    // connection for OR an explicit override for. Sorted: supported
    // first (so the user lands on the controllable ones), then alpha.
    const toolkitSlugs = new Set<string>();
    for (const slug of grouped.keys()) toolkitSlugs.add(slug);
    for (const slug of overrideByToolkit.keys()) toolkitSlugs.add(slug);

    const views: WorkspaceIntegrationView[] = [];
    for (const slug of toolkitSlugs) {
      const conns = grouped.get(slug) ?? [];
      const override = overrideByToolkit.get(slug) ?? null;
      const supported = supportedSlugs.has(slug);
      const sample = conns[0] ?? null;

      let effectiveState: WorkspaceIntegrationEffectiveState = "auto";
      let effectiveConnectionId: string | null = sample?.id ?? null;
      if (override?.state === "disabled") {
        effectiveState = "disabled";
        effectiveConnectionId = null;
      } else if (override?.state === "pinned") {
        effectiveState = "pinned";
        effectiveConnectionId =
          override.pinnedConnectionId &&
          conns.some((c) => c.id === override.pinnedConnectionId)
            ? override.pinnedConnectionId
            : null;
      }

      views.push({
        toolkit_slug: slug,
        toolkit_name: sample?.toolkitName || slug,
        toolkit_logo: sample?.toolkitLogo ?? null,
        supported,
        effective_state: effectiveState,
        effective_connection_id: effectiveConnectionId,
        pinned_connection_id: override?.pinnedConnectionId ?? null,
        connections: conns.map((c) => ({
          connected_account_id: c.id,
          status: c.status,
          user_id: c.userId,
          created_at: c.createdAt,
        })),
      });
    }

    views.sort((a, b) => {
      if (a.supported !== b.supported) return a.supported ? -1 : 1;
      return a.toolkit_slug.localeCompare(b.toolkit_slug);
    });

    return { workspace_id: workspaceId, integrations: views };
  }

  setOverride(params: {
    workspaceId: string;
    toolkitSlug: string;
    state: WorkspaceIntegrationOverrideState;
    pinnedConnectionId?: string | null;
  }): WorkspaceIntegrationOverrideRecord {
    if (params.state === "pinned" && !params.pinnedConnectionId) {
      throw new Error("pinned state requires pinned_connection_id");
    }
    return this.store.upsertWorkspaceIntegrationOverride({
      workspaceId: params.workspaceId,
      toolkitSlug: params.toolkitSlug,
      state: params.state,
      pinnedConnectionId:
        params.state === "pinned" ? (params.pinnedConnectionId ?? null) : null,
    });
  }

  clearOverride(params: { workspaceId: string; toolkitSlug: string }): { deleted: boolean } {
    const deleted = this.store.deleteWorkspaceIntegrationOverride({
      workspaceId: params.workspaceId,
      toolkitSlug: params.toolkitSlug,
    });
    return { deleted };
  }
}
