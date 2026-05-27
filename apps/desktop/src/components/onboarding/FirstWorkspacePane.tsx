import { Folder, FolderOpen, X } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { firstWorkspacePaneSectionClassName } from "@/components/layout/firstWorkspacePaneLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trackUmamiEvent } from "@/lib/analytics/umami";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { holabossLogoUrl } from "@/lib/assetPaths";
import {
  type FirstWorkspaceStep as SimpleStep,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";
import { cn } from "@/lib/utils";
import { CreatingView } from "./CreatingView";
import { OnboardingShell } from "./OnboardingShell";
import {
  WizardField,
  WorkspaceWizardLayout,
} from "./WorkspaceWizardLayout";

type FolderChoice = "default" | "custom";

interface FirstWorkspacePaneProps {
  variant?: "full" | "panel";
  onClose?: () => void;
}

const STEP_INDEX: Record<SimpleStep, number> = {
  name: 1,
  folder: 2,
};
const TOTAL_STEPS = 2;

/**
 * Simplified workspace creation: name → location + folder → create.
 * Templates, marketplace browsing, and browser-profile bootstrapping are intentionally
 * skipped from this entry. Sign-in is gated upstream by RequireAuth.
 */
export function FirstWorkspacePane({
  variant = "full",
  onClose,
}: FirstWorkspacePaneProps) {
  const {
    newWorkspaceName,
    setNewWorkspaceName,
    setTemplateSourceMode,
    setBrowserBootstrapMode,
    workspaceCreateLocation,
    setWorkspaceCreateLocation,
    selectedWorkspaceFolder,
    chooseWorkspaceFolder,
    clearSelectedWorkspaceFolder,
    runtimeStatus,
    workspaceCreatePhase,
    isCreatingWorkspace,
    workspaceErrorMessage,
    resolvedUserId,
    createWorkspace,
    firstWorkspaceStep,
    setFirstWorkspaceStep,
  } = useWorkspaceDesktop();

  const isPanelVariant = variant === "panel";
  const step = firstWorkspaceStep;
  const setStep = setFirstWorkspaceStep;

  // Panel-variant always reopens at the first step. Full-variant trusts the
  // provider's persisted step so a transient remount doesn't lose progress.
  useLayoutEffect(() => {
    if (!isPanelVariant) {
      return;
    }
    setFirstWorkspaceStep("name");
  }, [isPanelVariant, setFirstWorkspaceStep]);

  const [folderChoice, setFolderChoice] = useState<FolderChoice>(() =>
    selectedWorkspaceFolder?.rootPath ? "custom" : "default",
  );

  // Pin defaults on mount so any prior session's marketplace/copy state can't
  // leak into the create call. Use plain "empty" — "empty_onboarding" triggers
  // the chat-based ONBOARD.md takeover which has no script to run for an
  // empty workspace and would just throw the agent into a quota error loop.
  useEffect(() => {
    setTemplateSourceMode("empty");
    setBrowserBootstrapMode("fresh");
    setWorkspaceCreateLocation("local");
    // These context setters are recreated by the provider, so treating them as
    // effect dependencies would rerun this initialization after every render
    // and immediately snap the location selector back to "local".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    trackUmamiEvent("onboarding_step_viewed", {
      step,
      variant: isPanelVariant ? "panel" : "full",
    });
  }, [step, isPanelVariant]);

  const trimmedName = newWorkspaceName.trim();
  const sectionClassName = firstWorkspacePaneSectionClassName("configure");
  const defaultRoot = runtimeStatus?.sandboxRoot?.trim() || "";
  const customPath = selectedWorkspaceFolder?.rootPath?.trim() || "";

  function handleContinueFromName() {
    if (!trimmedName) {
      return;
    }
    setStep("folder");
  }

  function handleSelectDefault() {
    setWorkspaceCreateLocation("local");
    setFolderChoice("default");
    clearSelectedWorkspaceFolder();
  }

  function handleSelectCustom() {
    setWorkspaceCreateLocation("local");
    setFolderChoice("custom");
    if (!customPath) {
      void chooseWorkspaceFolder();
    }
  }

  function handleCreateWorkspace() {
    if (createDisabled) {
      return;
    }
    trackUmamiEvent("first_workspace_create_started", {
      folder_choice: folderChoice,
      onboarding_mode: "start",
    });
    void createWorkspace({ workspaceOnboardingMode: "start" }).then(() => {
      trackUmamiEvent("first_workspace_created", {
        folder_choice: folderChoice,
        onboarding_mode: "start",
      });
      if (isPanelVariant) {
        onClose?.();
      }
    });
  }

  const createDisabled =
    !trimmedName ||
    (workspaceCreateLocation === "local" &&
      folderChoice === "custom" &&
      !customPath) ||
    (workspaceCreateLocation === "cloud" && !resolvedUserId);

  const shellOnBack =
    step === "folder" ? () => setStep("name") : undefined;
  const showCloseButton = isPanelVariant && step === "name";

  const innerContent = isCreatingWorkspace ? (
    <OnboardingShell onClose={isPanelVariant ? onClose : undefined}>
      <CreatingView
        browserBootstrapMode="fresh"
        creatingViaMarketplace={false}
        panelVariant={isPanelVariant}
        sectionClassName={sectionClassName}
        workspaceCreateLocation={workspaceCreateLocation}
        workspaceCreatePhase={workspaceCreatePhase}
      />
    </OnboardingShell>
  ) : (
    <OnboardingShell
      onBack={shellOnBack}
      onClose={showCloseButton ? onClose : undefined}
    >
      <section className={sectionClassName}>
        {step === "name" ? (
          <WorkspaceWizardLayout
            description="Pick a name for your workspace. You can rename it later from settings."
            errorMessage={workspaceErrorMessage || null}
            primary={{
              label: "Continue",
              onClick: handleContinueFromName,
              disabled: !trimmedName,
            }}
            stepIndex={STEP_INDEX.name}
            stepTotal={TOTAL_STEPS}
            tertiary={
              isPanelVariant
                ? { label: "Cancel", onClick: () => onClose?.() }
                : undefined
            }
            title="Name your workspace"
            width="md"
          >
            <WizardField htmlFor="workspace-name" label="Workspace name" required>
              <div className="rounded-lg bg-fg-2 shadow-2xs transition-colors focus-within:bg-background focus-within:shadow-xs">
                <Input
                  autoFocus
                  className="h-10 border-0 bg-transparent shadow-none focus-visible:ring-0"
                  id="workspace-name"
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && trimmedName) {
                      e.preventDefault();
                      handleContinueFromName();
                    }
                  }}
                  placeholder="My first workspace"
                  value={newWorkspaceName}
                />
              </div>
            </WizardField>
          </WorkspaceWizardLayout>
        ) : step === "folder" ? (
          <WorkspaceWizardLayout
            description={
              workspaceCreateLocation === "cloud"
                ? "Cloud workspaces run in the hosted runtime and open through the remote control plane."
                : "Files run locally on this machine. Use the default location or pick a folder you control."
            }
            errorMessage={workspaceErrorMessage || null}
            primary={{
              label: "Create workspace",
              onClick: handleCreateWorkspace,
              disabled: createDisabled,
            }}
            secondary={{
              label: "Back",
              onClick: () => setStep("name"),
            }}
            stepIndex={STEP_INDEX.folder}
            stepTotal={TOTAL_STEPS}
            title="Where should it live?"
            width="md"
          >
            <div className="space-y-3">
              <WizardField
                help="Local keeps files on this machine. Cloud stores them inside the hosted runtime."
                label="Workspace location"
              >
                <Tabs
                  onValueChange={(value) => {
                    if (!value) {
                      return;
                    }
                    setWorkspaceCreateLocation(value as WorkspaceLocationPayload);
                    if (value === "local" && !selectedWorkspaceFolder?.rootPath) {
                      setFolderChoice("default");
                    }
                  }}
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

              {workspaceCreateLocation === "cloud" ? (
                resolvedUserId ? (
                  <div className="rounded-lg bg-fg-2 px-3 py-2.5 text-sm text-muted-foreground shadow-2xs">
                    Files will be stored inside the remote runtime and opened through the cloud workspace gateway.
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 rounded-lg bg-fg-2 px-3 py-2.5 shadow-2xs">
                    <p className="text-sm text-muted-foreground">
                      Sign in to create a cloud workspace.
                    </p>
                    <Button
                      onClick={() => void window.electronAPI.auth.requestAuth()}
                      size="sm"
                      type="button"
                      variant="bordered"
                    >
                      Connect holaOS
                    </Button>
                  </div>
                )
              ) : (
                <>
                  <FolderOption
                    active={folderChoice === "default"}
                    description={
                      defaultRoot
                        ? `Files live in ${defaultRoot}/workspace/<id>.`
                        : "Holaboss-managed location on this machine."
                    }
                    icon={<Folder />}
                    onSelect={handleSelectDefault}
                    title="Use the default folder"
                  />

                  <FolderOption
                    active={folderChoice === "custom"}
                    description="Keep the workspace files on a drive or folder you control."
                    icon={<FolderOpen />}
                    onSelect={handleSelectCustom}
                    title="Choose a custom folder"
                  />

                  {folderChoice === "custom" ? (
                    customPath ? (
                      <div className="flex items-center gap-2 rounded-lg bg-fg-2 px-3 py-2 shadow-2xs">
                        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                        <span
                          className="flex-1 truncate font-mono text-[11px]"
                          title={customPath}
                        >
                          {customPath}
                        </span>
                        <Button
                          aria-label="Clear workspace folder"
                          onClick={clearSelectedWorkspaceFolder}
                          size="icon-xs"
                          type="button"
                          variant="ghost"
                        >
                          <X />
                        </Button>
                      </div>
                    ) : (
                      <Button
                        onClick={() => void chooseWorkspaceFolder()}
                        size="sm"
                        type="button"
                        variant="bordered"
                      >
                        <Folder />
                        Choose folder…
                      </Button>
                    )
                  ) : null}
                </>
              )}
            </div>
          </WorkspaceWizardLayout>
        ) : null}
      </section>
    </OnboardingShell>
  );

  if (isPanelVariant) {
    return (
      <div className="pointer-events-none fixed inset-0 z-40">
        <button
          aria-label="Close create workspace"
          className="pointer-events-auto absolute inset-0 bg-scrim backdrop-blur-sm"
          onClick={onClose}
          type="button"
        />
        <div className="pointer-events-auto absolute inset-0 flex min-h-0 flex-col">
          {innerContent}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-30 flex min-h-0 flex-col">
      {innerContent}
    </div>
  );
}

interface FolderOptionProps {
  active: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onSelect: () => void;
}

function FolderOption({
  active,
  title,
  description,
  icon,
  onSelect,
}: FolderOptionProps) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left transition-colors",
        active ? "bg-background shadow-2xs" : "bg-fg-2 hover:bg-fg-4",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-2xs [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}
