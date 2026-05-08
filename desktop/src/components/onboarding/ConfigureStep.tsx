import { Folder, FolderOpen, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IntegrationsList } from "./IntegrationsList";
import { TemplateCard } from "./TemplateCard";
import {
  WizardField,
  WorkspaceWizardLayout,
} from "./WorkspaceWizardLayout";

interface ConfigureStepProps {
  stepIndex: number;
  stepTotal: number;
  templateSourceMode: string;
  workspaceCreateLocation: WorkspaceLocationPayload;
  setWorkspaceCreateLocation: (value: WorkspaceLocationPayload) => void;
  selectedMarketplaceTemplate: TemplateMetadataPayload | null;
  selectedTemplateFolder: TemplateFolderSelectionPayload | null;
  selectedWorkspaceFolder: WorkspaceRuntimeFolderSelectionPayload | null;
  newWorkspaceName: string;
  setNewWorkspaceName: (value: string) => void;
  pendingIntegrations: ResolveTemplateIntegrationsResult | null;
  isResolvingIntegrations: boolean;
  connectingProvider: string | null;
  connectStatus: string;
  workspaceErrorMessage: string;
  continueDisabled: boolean;
  continueLabel?: string;
  hasUnconnectedIntegrations: boolean;
  showCreateLocationSelector?: boolean;
  showWorkspaceFolderPicker?: boolean;
  onChangeKit: () => void;
  onChangeFolder: () => void;
  onChooseWorkspaceFolder: () => void;
  onClearWorkspaceFolder: () => void;
  defaultWorkspaceRoot: string | null;
  onCancel: () => void;
  onConnect: (provider: string) => void;
  onContinue: () => void;
}

export function ConfigureStep({
  stepIndex,
  stepTotal,
  templateSourceMode,
  workspaceCreateLocation,
  setWorkspaceCreateLocation,
  selectedMarketplaceTemplate,
  selectedTemplateFolder,
  selectedWorkspaceFolder,
  newWorkspaceName,
  setNewWorkspaceName,
  pendingIntegrations,
  isResolvingIntegrations,
  connectingProvider,
  connectStatus,
  workspaceErrorMessage,
  continueDisabled,
  continueLabel = "Continue",
  hasUnconnectedIntegrations,
  showCreateLocationSelector = false,
  showWorkspaceFolderPicker = true,
  onChangeKit,
  onChangeFolder,
  onChooseWorkspaceFolder,
  onClearWorkspaceFolder,
  defaultWorkspaceRoot,
  onCancel,
  onConnect,
  onContinue,
}: ConfigureStepProps) {
  const primaryDisabled =
    continueDisabled ||
    hasUnconnectedIntegrations ||
    isResolvingIntegrations ||
    connectingProvider !== null;

  return (
    <WorkspaceWizardLayout
      description="Pick a name and where the workspace files live. We'll set up the rest."
      errorMessage={workspaceErrorMessage || null}
      primary={{
        label: continueLabel,
        onClick: onContinue,
        disabled: primaryDisabled,
      }}
      secondary={
        stepIndex > 1
          ? {
              label: "Back",
              onClick: onChangeKit,
            }
          : undefined
      }
      stepIndex={stepIndex}
      stepTotal={stepTotal}
      tertiary={{ label: "Cancel", onClick: onCancel }}
      title="Name your workspace"
      width="md"
    >
      <div className="space-y-5">
        {showCreateLocationSelector ? (
          <WizardField
            help="Cloud workspaces run inside the remote runtime. Local keeps files on this machine."
            label="Create location"
          >
            <Tabs
              onValueChange={(value) =>
                value && setWorkspaceCreateLocation(value as WorkspaceLocationPayload)
              }
              value={workspaceCreateLocation}
            >
              <TabsList className="w-full">
                <TabsTrigger className="h-9 flex-1" value="local">
                  Local
                </TabsTrigger>
                <TabsTrigger className="h-9 flex-1" value="cloud">
                  Cloud
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </WizardField>
        ) : null}

        {/* Source summary */}
        <TemplateCard
          onChangeFolder={onChangeFolder}
          onChangeKit={onChangeKit}
          selectedMarketplaceTemplate={selectedMarketplaceTemplate}
          selectedTemplateFolder={selectedTemplateFolder}
          templateSourceMode={templateSourceMode}
        />

        <WizardField htmlFor="workspace-name" label="Workspace name" required>
          <div className="rounded-lg bg-fg-2 shadow-subtle-xs transition-colors focus-within:bg-background focus-within:shadow-subtle-sm">
            <Input
              autoFocus
              className="h-10 border-0 bg-transparent shadow-none focus-visible:ring-0"
              id="workspace-name"
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="My first workspace"
              value={newWorkspaceName}
            />
          </div>
        </WizardField>

        {showWorkspaceFolderPicker ? (
          <WizardField
            help={
              selectedWorkspaceFolder?.rootPath ? (
                "Workspace files will live in the folder above."
              ) : defaultWorkspaceRoot ? (
                <>
                  Defaults to{" "}
                  <code className="rounded bg-fg-4 px-1 py-0.5 font-mono text-[11px]">
                    {defaultWorkspaceRoot}/workspace/&lt;id&gt;
                  </code>
                  . Pick a folder if you'd rather keep the files somewhere you
                  control.
                </>
              ) : (
                "Pick an empty folder if you'd rather keep the workspace files on a drive you control."
              )
            }
            label="Workspace folder"
            optional
          >
            {selectedWorkspaceFolder?.rootPath ? (
              <div className="flex items-center gap-2 rounded-lg bg-fg-2 px-3 py-2 shadow-subtle-xs">
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                <span
                  className="flex-1 truncate text-sm text-foreground"
                  title={selectedWorkspaceFolder.rootPath}
                >
                  {selectedWorkspaceFolder.rootPath}
                </span>
                <Button
                  aria-label="Clear workspace folder"
                  onClick={onClearWorkspaceFolder}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <X />
                </Button>
              </div>
            ) : (
              <Button
                className="w-full justify-start"
                onClick={onChooseWorkspaceFolder}
                size="lg"
                type="button"
                variant="bordered"
              >
                <Folder className="text-muted-foreground" />
                Choose an empty folder…
              </Button>
            )}
          </WizardField>
        ) : (
          <WizardField
            help="Remote workspaces keep their files inside the cloud runtime. Host folder pinning is not available."
            label="Workspace storage"
          >
            <p className="rounded-lg bg-fg-2 px-3 py-2.5 text-sm text-muted-foreground shadow-subtle-xs">
              This workspace will be stored inside its remote runtime.
            </p>
          </WizardField>
        )}

        <IntegrationsList
          connectStatus={connectStatus}
          connectingProvider={connectingProvider}
          isResolvingIntegrations={isResolvingIntegrations}
          onConnect={onConnect}
          pendingIntegrations={pendingIntegrations}
        />
      </div>
    </WorkspaceWizardLayout>
  );
}
