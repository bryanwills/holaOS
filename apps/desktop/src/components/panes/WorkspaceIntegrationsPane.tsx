import { Info, Loader2, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@/components/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useIntegrationAccountMetadata } from "@/lib/integrationAccountStore";
import { accountDisplayLabel } from "@/lib/integrationDisplay";

interface WorkspaceIntegrationsPaneProps {
  workspaceId: string;
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
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
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [mutatingToolkit, setMutatingToolkit] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await window.electronAPI.workspace.listWorkspaceIntegrations(
        workspaceId,
      );
      setData(result);
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

  if (isLoading) {
    return (
      <SettingsSection
        title="Workspace integrations"
        description="Control which of your account integrations the agent in this workspace can use."
      >
        <SettingsCard>
          <SettingsRow label="Loading…">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }

  const integrations = data?.integrations ?? [];

  return (
    <SettingsSection
      title="Workspace integrations"
      description="Your account integrations are the pool. Toggle which ones the agent in this workspace can use, and pick which account when you have more than one."
      action={
        <Button
          onClick={() => void load()}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCcw className="mr-2 size-3.5" />
          Refresh
        </Button>
      }
    >
      {statusMessage ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {statusMessage}
        </div>
      ) : null}

      {integrations.length === 0 ? (
        <SettingsCard>
          <SettingsRow
            description="Connect an integration in Settings → Integrations to make it available here."
            label="No account integrations yet"
            leading={<Info className="size-4 text-muted-foreground" />}
          />
        </SettingsCard>
      ) : (
        <SettingsCard>
          {integrations.map((integration) => {
            const isEnabled = integration.effective_state !== "disabled";
            const isMutating = mutatingToolkit === integration.toolkit_slug;
            const connectionCount = integration.connections.length;
            const showPicker = isEnabled && connectionCount > 1;
            const pickerValue =
              integration.effective_state === "pinned" && integration.pinned_connection_id
                ? integration.pinned_connection_id
                : "auto";

            return (
              <div className="flex flex-col gap-3 px-4 py-4" key={integration.toolkit_slug}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <ToolkitLogo
                      logo={integration.toolkit_logo}
                      name={integration.toolkit_name}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="truncate text-sm font-medium capitalize text-foreground">
                          {integration.toolkit_name || integration.toolkit_slug}
                        </div>
                        {!integration.supported ? (
                          <Badge className="text-[10px]" variant="outline">
                            Not yet supported
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {describeState(integration, accountMetadata)}
                      </div>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    {isMutating ? (
                      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                    ) : null}
                    <Switch
                      checked={isEnabled}
                      disabled={!integration.supported || isMutating || connectionCount === 0}
                      onCheckedChange={(value) =>
                        void setEnabled(integration.toolkit_slug, value)
                      }
                    />
                  </div>
                </div>

                {showPicker ? (
                  <div className="flex items-center gap-3 pl-11">
                    <span className="text-xs text-muted-foreground">Use account:</span>
                    <Select
                      disabled={isMutating}
                      onValueChange={(value) =>
                        void setPinnedAccount(integration.toolkit_slug, value as string)
                      }
                      value={pickerValue}
                    >
                      <SelectTrigger className="h-8 w-[260px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          Auto · most-recent active
                        </SelectItem>
                        {integration.connections.map((conn) => (
                          <SelectItem
                            key={conn.connected_account_id}
                            value={conn.connected_account_id}
                          >
                            {accountDisplayLabel(
                              connectionToAccountPayload(conn, integration),
                              accountMetadata.get(conn.connected_account_id),
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
        </SettingsCard>
      )}
    </SettingsSection>
  );
}

function ToolkitLogo({
  logo,
  name,
}: {
  logo: string | null;
  name: string;
}) {
  if (logo) {
    return (
      <img
        alt={`${name} logo`}
        className="size-8 rounded-md border border-border bg-background object-contain p-1"
        src={logo}
      />
    );
  }
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <div className="flex size-8 items-center justify-center rounded-md border border-border bg-muted text-xs font-medium text-muted-foreground">
      {initial}
    </div>
  );
}

function describeState(
  integration: WorkspaceIntegrationPayload,
  metadata: Map<string, { email?: string | null; handle?: string | null } | undefined>,
): string {
  if (integration.connections.length === 0) {
    return "No active account connected — disabled.";
  }
  if (integration.effective_state === "disabled") {
    return "Disabled in this workspace. The agent can't see this toolkit.";
  }
  if (integration.effective_state === "pinned" && integration.effective_connection_id) {
    const meta = metadata.get(integration.effective_connection_id);
    const label = meta?.email ?? meta?.handle ?? integration.effective_connection_id;
    return `Locked to ${label}.`;
  }
  if (integration.effective_state === "pinned") {
    return "Pinned account no longer active — agent can't use this toolkit.";
  }
  if (integration.connections.length > 1) {
    return `${integration.connections.length} accounts available · auto-picks the most recent.`;
  }
  const conn = integration.connections[0];
  if (!conn) {
    return "Inherits from your account integrations.";
  }
  const meta = metadata.get(conn.connected_account_id);
  const label = meta?.email ?? meta?.handle;
  return label
    ? `Active · ${label}`
    : "Inherits from your account integrations.";
}
