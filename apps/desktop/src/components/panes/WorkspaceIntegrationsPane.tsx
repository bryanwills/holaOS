import { Info, Loader2, RefreshCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { useIntegrationAccountMetadata } from "@/lib/integrationAccountStore";
import { accountDisplayLabel } from "@/lib/integrationDisplay";

interface WorkspaceIntegrationsPaneProps {
  workspaceId: string;
}

interface ComposioToolkitInfo {
  slug: string;
  name: string;
  logo: string | null;
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function composioFallbackLogo(slug: string): string | null {
  const cleaned = slug.trim().toLowerCase();
  return cleaned ? `https://logos.composio.dev/api/${cleaned}` : null;
}

function connectionToAccountPayload(
  conn: WorkspaceIntegrationConnectionPayload,
  toolkit: WorkspaceIntegrationPayload,
): IntegrationConnectionPayload {
  return {
    connection_id: conn.connected_account_id,
    owner_user_id: conn.user_id ?? "",
    provider_id: toolkit.toolkit_slug,
    account_label: toolkit.toolkit_name,
    account_external_id: conn.connected_account_id,
    account_handle: null,
    account_email: null,
    auth_mode: "composio",
    granted_scopes: [],
    status: conn.status?.toLowerCase() === "active" ? "active" : "inactive",
    secret_ref: null,
    created_at: conn.created_at,
    updated_at: conn.created_at,
  };
}

export function WorkspaceIntegrationsPane({ workspaceId }: WorkspaceIntegrationsPaneProps) {
  const [data, setData] = useState<WorkspaceIntegrationsListResponsePayload | null>(null);
  const [toolkitsBySlug, setToolkitsBySlug] = useState<Map<string, ComposioToolkitInfo>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [mutatingToolkit, setMutatingToolkit] = useState<string | null>(null);
  const [cleaningToolkit, setCleaningToolkit] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [result, toolkitsResult] = await Promise.all([
        window.electronAPI.workspace.listWorkspaceIntegrations(workspaceId),
        window.electronAPI.workspace
          .composioListToolkits()
          .catch(() => ({ toolkits: [] as ComposioToolkitInfo[] })),
      ]);
      setData(result);
      const map = new Map<string, ComposioToolkitInfo>();
      for (const t of toolkitsResult.toolkits) {
        map.set(t.slug.trim().toLowerCase(), {
          slug: t.slug,
          name: t.name,
          logo: t.logo ?? null,
        });
      }
      setToolkitsBySlug(map);
    } catch (error) {
      setStatusMessage(normalizeErrorMessage(error));
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const allConnections = useMemo(() => {
    if (!data) return [];
    return data.integrations.flatMap((integration) =>
      integration.connections.map((conn) => connectionToAccountPayload(conn, integration)),
    );
  }, [data]);
  const accountMetadata = useIntegrationAccountMetadata(allConnections);

  const dedupedByToolkit = useMemo(() => {
    const result = new Map<
      string,
      Array<{
        canonical: WorkspaceIntegrationConnectionPayload;
        duplicates: WorkspaceIntegrationConnectionPayload[];
      }>
    >();
    if (!data) return result;
    for (const integration of data.integrations) {
      const groups = new Map<string, WorkspaceIntegrationConnectionPayload[]>();
      for (const conn of integration.connections) {
        const meta = accountMetadata.get(conn.connected_account_id);
        const email = meta?.email?.trim().toLowerCase();
        const handle = meta?.handle?.trim().toLowerCase();
        const identityKey = email || handle || `ca:${conn.connected_account_id}`;
        const list = groups.get(identityKey);
        if (list) list.push(conn);
        else groups.set(identityKey, [conn]);
      }
      const entries: Array<{
        canonical: WorkspaceIntegrationConnectionPayload;
        duplicates: WorkspaceIntegrationConnectionPayload[];
      }> = [];
      for (const conns of groups.values()) {
        const sorted = conns
          .slice()
          .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
        const [canonical, ...duplicates] = sorted;
        if (!canonical) continue;
        entries.push({ canonical, duplicates });
      }
      result.set(integration.toolkit_slug, entries);
    }
    return result;
  }, [data, accountMetadata]);

  const setEnabled = useCallback(
    async (toolkitSlug: string, enabled: boolean) => {
      setMutatingToolkit(toolkitSlug);
      setStatusMessage("");
      try {
        if (enabled) {
          await window.electronAPI.workspace.clearWorkspaceIntegrationOverride(
            workspaceId,
            toolkitSlug,
          );
        } else {
          await window.electronAPI.workspace.setWorkspaceIntegrationOverride(
            workspaceId,
            toolkitSlug,
            { state: "disabled" },
          );
        }
        await load();
      } catch (error) {
        setStatusMessage(normalizeErrorMessage(error));
      } finally {
        setMutatingToolkit(null);
      }
    },
    [load, workspaceId],
  );

  const setPinnedAccount = useCallback(
    async (toolkitSlug: string, connectionId: string | "auto") => {
      setMutatingToolkit(toolkitSlug);
      setStatusMessage("");
      try {
        if (connectionId === "auto") {
          await window.electronAPI.workspace.clearWorkspaceIntegrationOverride(
            workspaceId,
            toolkitSlug,
          );
        } else {
          await window.electronAPI.workspace.setWorkspaceIntegrationOverride(
            workspaceId,
            toolkitSlug,
            { state: "pinned", pinned_connection_id: connectionId },
          );
        }
        await load();
      } catch (error) {
        setStatusMessage(normalizeErrorMessage(error));
      } finally {
        setMutatingToolkit(null);
      }
    },
    [load, workspaceId],
  );

  const cleanupDuplicates = useCallback(
    async (toolkitSlug: string, duplicateConnectionIds: string[]) => {
      if (duplicateConnectionIds.length === 0) return;
      setCleaningToolkit(toolkitSlug);
      setStatusMessage("");
      let failed = 0;
      for (const id of duplicateConnectionIds) {
        try {
          await window.electronAPI.workspace.composioDeleteUpstream(id);
          await window.electronAPI.workspace
            .deleteIntegrationConnection(id)
            .catch(() => undefined);
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) {
        setStatusMessage(
          `Could not delete ${failed} of ${duplicateConnectionIds.length} duplicates. Try again.`,
        );
      }
      await load();
      setCleaningToolkit(null);
    },
    [load],
  );

  if (isLoading) {
    return (
      <div className="grid gap-3">
        <Header onRefresh={load} />
        <div className="flex items-center justify-center rounded-xl border border-border px-6 py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const integrations = data?.integrations ?? [];
  const usable = integrations.filter((i) => i.supported);

  return (
    <div className="grid gap-4">
      <Header onRefresh={load} />

      {statusMessage ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {statusMessage}
        </div>
      ) : null}

      {usable.length === 0 ? (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="font-medium text-foreground">
              No connectable integrations yet
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Connect an integration in Settings → Integrations. Once it's
              wired up to the agent, it'll show up here.
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {usable.map((integration) => {
            const toolkitInfo = toolkitsBySlug.get(integration.toolkit_slug);
            const logo =
              toolkitInfo?.logo ??
              integration.toolkit_logo ??
              composioFallbackLogo(integration.toolkit_slug);
            const displayName =
              toolkitInfo?.name || integration.toolkit_name || integration.toolkit_slug;
            const isEnabled = integration.effective_state !== "disabled";
            const isMutating = mutatingToolkit === integration.toolkit_slug;
            const isCleaning = cleaningToolkit === integration.toolkit_slug;
            const dedupeEntries = dedupedByToolkit.get(integration.toolkit_slug) ?? [];
            const uniqueIdentityCount = dedupeEntries.length;
            const totalDuplicates = dedupeEntries.reduce(
              (sum, entry) => sum + entry.duplicates.length,
              0,
            );
            const showPicker = isEnabled && uniqueIdentityCount > 1;
            const pinnedActiveId =
              integration.effective_state === "pinned" && integration.pinned_connection_id
                ? integration.pinned_connection_id
                : null;
            const pickerValue = pinnedActiveId
              ? (dedupeEntries.find(
                  (e) =>
                    e.canonical.connected_account_id === pinnedActiveId ||
                    e.duplicates.some(
                      (d) => d.connected_account_id === pinnedActiveId,
                    ),
                )?.canonical.connected_account_id ?? "auto")
              : "auto";
            const allDuplicateIds = dedupeEntries.flatMap((entry) =>
              entry.duplicates.map((d) => d.connected_account_id),
            );

            return (
              <div
                className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3"
                key={integration.toolkit_slug}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <ToolkitLogo logo={logo} name={displayName} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {displayName}
                        </span>
                        {integration.tier === "auto" ? (
                          <span
                            className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
                            title="Tool set auto-discovered from Composio. Coverage may vary until curated."
                          >
                            Auto
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {describeState(integration, dedupeEntries, accountMetadata)}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    {isMutating ? (
                      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    ) : null}
                    <Switch
                      checked={isEnabled}
                      disabled={isMutating || integration.connections.length === 0}
                      onCheckedChange={(value) =>
                        void setEnabled(integration.toolkit_slug, value)
                      }
                    />
                  </div>
                </div>

                {totalDuplicates > 0 ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
                    <div className="text-[11px] text-muted-foreground">
                      {totalDuplicates} duplicate
                      {totalDuplicates === 1 ? "" : "s"} found — same identity
                      connected multiple times.
                    </div>
                    <Button
                      disabled={isCleaning || isMutating}
                      onClick={() =>
                        void cleanupDuplicates(integration.toolkit_slug, allDuplicateIds)
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {isCleaning ? (
                        <Loader2 className="mr-2 size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="mr-2 size-3.5" />
                      )}
                      Clean up
                    </Button>
                  </div>
                ) : null}

                {showPicker ? (
                  <div className="flex items-center gap-3">
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Account
                    </span>
                    <Select
                      disabled={isMutating}
                      onValueChange={(value) =>
                        void setPinnedAccount(integration.toolkit_slug, value as string)
                      }
                      value={pickerValue}
                    >
                      <SelectTrigger className="h-8 flex-1 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          Auto · most-recent active
                        </SelectItem>
                        {dedupeEntries.map((entry) => (
                          <SelectItem
                            key={entry.canonical.connected_account_id}
                            value={entry.canonical.connected_account_id}
                          >
                            {accountDisplayLabel(
                              connectionToAccountPayload(entry.canonical, integration),
                              accountMetadata.get(entry.canonical.connected_account_id),
                              0,
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}

function Header({ onRefresh }: { onRefresh: () => void }) {
  return (
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-medium text-foreground">
          Workspace integrations
        </h2>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          The agent in this workspace can use any of these. Toggle off to hide,
          or pick a specific account when you've connected more than one.
        </p>
      </div>
      <Button onClick={onRefresh} size="sm" type="button" variant="ghost">
        <RefreshCcw className="mr-2 size-3.5" />
        Refresh
      </Button>
    </header>
  );
}

function ToolkitLogo({
  logo,
  name,
}: {
  logo: string | null;
  name: string;
}) {
  const [failed, setFailed] = useState(false);
  if (logo && !failed) {
    return (
      <img
        alt={`${name} logo`}
        className="size-8 shrink-0 rounded-md bg-muted object-contain p-1"
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        src={logo}
      />
    );
  }
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium text-muted-foreground">
      {initial}
    </div>
  );
}

function describeState(
  integration: WorkspaceIntegrationPayload,
  dedupeEntries: Array<{
    canonical: WorkspaceIntegrationConnectionPayload;
    duplicates: WorkspaceIntegrationConnectionPayload[];
  }>,
  metadata: Map<string, { email?: string | null; handle?: string | null } | undefined>,
): string {
  if (integration.connections.length === 0) {
    return "Not connected yet.";
  }
  if (integration.effective_state === "disabled") {
    return "Disabled in this workspace.";
  }
  if (integration.effective_state === "pinned" && integration.effective_connection_id) {
    const meta = metadata.get(integration.effective_connection_id);
    const label = meta?.email ?? meta?.handle ?? integration.effective_connection_id;
    return `Locked to ${label}`;
  }
  if (integration.effective_state === "pinned") {
    return "Pinned account no longer active.";
  }
  const uniqueCount = dedupeEntries.length;
  if (uniqueCount > 1) {
    return `${uniqueCount} accounts · auto-picks most recent`;
  }
  const entry = dedupeEntries[0];
  if (!entry) return "Active";
  const meta = metadata.get(entry.canonical.connected_account_id);
  return meta?.email ?? meta?.handle ?? "Active";
}
