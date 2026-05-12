import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKSPACE_DESKTOP_PATH = new URL("./workspaceDesktop.tsx", import.meta.url);

test("deleting the selected workspace clears selection before the local delete runs", async () => {
  const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

  assert.match(source, /if \(selectedWorkspaceId === trimmedWorkspaceId\) \{/);
  assert.match(
    source,
    /const fallbackWorkspaceId =\s*workspaces\.find\(\(workspace\) => workspace\.id !== trimmedWorkspaceId\)\?\.id \?\?\s*"";/,
  );
  assert.match(source, /setSelectedWorkspaceId\(fallbackWorkspaceId\);/);
  assert.match(source, /setWorkspaceLifecycleWorkspaceId\(""\);/);
  assert.match(source, /setWorkspaceAppsReadyState\(false\);/);
  assert.match(source, /setWorkspaceBlockingReasonState\(""\);/);
  assert.match(source, /await window\.electronAPI\.workspace\.deleteWorkspace\(trimmedWorkspaceId\);/);
});

test("workspace desktop error normalization unwraps Electron IPC errors before mapping", async () => {
  const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

  assert.match(
    source,
    /const ipcMatch = message\.match\(\s*\/\^Error invoking remote method '\[\^'\]\+': Error: \(\.\+\)\$\/s,/,
  );
  assert.match(
    source,
    /const unwrappedMessage = ipcMatch \? ipcMatch\[1\]\.trim\(\) : message\.trim\(\);/,
  );
  assert.match(source, /const normalized = unwrappedMessage\.toLowerCase\(\);/);
  assert.match(
    source,
    /if \(rawNormalized\.includes\("error invoking remote method"\) && !ipcMatch\) \{/,
  );
  assert.match(source, /return unwrappedMessage;/);
});

test("workspace desktop hydrates workspace summaries from cached or live sources while bootstrap runs", async () => {
  const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

  assert.match(source, /const BOOTSTRAP_IPC_TIMEOUT_MS = 8_000;/);
  assert.match(
    source,
    /function withBootstrapTimeout<T>\(promise: Promise<T>, label: string\): Promise<T> \{/,
  );
  assert.match(
    source,
    /reject\(new Error\(`Timed out loading \$\{label\}\.`\)\);/,
  );
  assert.match(
    source,
    /const \[runtimeConfigResult, runtimeStatusResult, clientConfigResult\] = await Promise\.allSettled\(\[\s*withBootstrapTimeout\(window\.electronAPI\.runtime\.getConfig\(\), "runtime configuration"\),\s*withBootstrapTimeout\(window\.electronAPI\.runtime\.getStatus\(\), "runtime status"\),\s*withBootstrapTimeout\(window\.electronAPI\.workspace\.getClientConfig\(\), "desktop client configuration"\)\s*\]\);/,
  );
  assert.match(
    source,
    /if \(bootstrapErrors\.length > 0\) \{\s*setWorkspaceErrorMessage\(bootstrapErrors\[0\]\);\s*\}/,
  );
  assert.match(source, /type WorkspaceListLoadSource = "auto" \| "live" \| "cached";/);
  assert.match(
    source,
    /const canLoadLiveWorkspaceList = runtimeReadyForWorkspaceData \|\| isSignedIn;/,
  );
  assert.match(
    source,
    /const selectedWorkspaceNeedsLocalRuntime = selectedWorkspace\?\.location !== "cloud";/,
  );
  assert.match(
    source,
    /const workspaceListSource =\s*source === "auto"\s*\?\s*canLoadLiveWorkspaceList\s*\?\s*"live"\s*:\s*"cached"\s*:\s*source;/,
  );
  assert.match(
    source,
    /const workspaceResponse = workspaceListSource === "live"\s*\?\s*await window\.electronAPI\.workspace\.listWorkspaces\(\)\s*:\s*await window\.electronAPI\.workspace\.listWorkspacesCached\(\);/,
  );
  assert.match(
    source,
    /const unsubscribe = window\.electronAPI\.runtime\.onStateChange\(\(status\) => \{/,
  );
  assert.match(
    source,
    /void window\.electronAPI\.runtime\.getStatus\(\)\.then\(\(status\) => \{/,
  );
  assert.match(
    source,
    /const workspaceListSource =\s*nextRuntimeStatus\.status === "running" \|\| isSignedIn \? "live" : "cached";/,
  );
  assert.match(
    source,
    /const result = await loadWorkspaceData\(\{\s*preserveSelection: true,\s*allowEmpty: workspaceListSource === "live",\s*source: workspaceListSource,\s*\}\);/,
  );
  assert.match(
    source,
    /setHasHydratedWorkspaceList\(\s*\(current\) =>\s*current \|\| result\.source === "live" \|\| result\.resolvedCount > 0,\s*\);/,
  );
  assert.match(source, /await window\.electronAPI\.workspace\.listWorkspacesCached\(\);/);
  assert.match(
    source,
    /if \(\s*!selectedWorkspaceId \|\|\s*!selectedWorkspaceExists \|\|\s*\(selectedWorkspaceNeedsLocalRuntime && !runtimeReadyForWorkspaceData\)\s*\) \{/,
  );
});

test("workspace activation reset clears the activating flag before wiping readiness state", async () => {
  const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

  assert.match(
    source,
    /if \(!selectedWorkspaceId \|\| !selectedWorkspaceExists \|\| !runtimeReadyForWorkspaceData\) \{\s*setInstalledApps\(\[\]\);\s*setIsLoadingInstalledApps\(false\);\s*setIsActivatingWorkspace\(false\);\s*setWorkspaceLifecycleWorkspaceId\(""\);\s*setWorkspaceAppsReadyState\(false\);\s*setWorkspaceBlockingReasonState\(""\);\s*return;\s*\}/,
  );
});

test("workspace desktop re-activates workspaces while installed apps are still starting", async () => {
  const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

  assert.match(source, /const hasInitializing = installedApps\.some\(\(app\) => !app\.ready\);/);
  assert.match(
    source,
    /window\.electronAPI\.workspace\s*\.activateWorkspace\(selectedWorkspaceId\)/,
    "expected non-ready app polling to re-run workspace activation instead of only reading lifecycle state",
  );
});

test("workspace creation can copy an existing workspace browser profile or import from a browser", async () => {
  const source = await readFile(WORKSPACE_DESKTOP_PATH, "utf8");

  assert.match(source, /type WorkspaceCreateLocation = WorkspaceLocationPayload;/);
  assert.match(
    source,
    /const \[workspaceCreateLocation, setWorkspaceCreateLocationState\] =\s*useState<WorkspaceCreateLocation>\("local"\);/,
  );
  assert.match(
    source,
    /const isCloudCreate =\s*workspaceCreateLocation === "cloud" &&\s*\(templateSourceMode === "empty" \|\| templateSourceMode === "empty_onboarding"\);/,
  );
  assert.match(
    source,
    /const CLOUD_WORKSPACE_READY_POLL_INTERVAL_MS = 3_000;/,
  );
  assert.match(
    source,
    /const CLOUD_WORKSPACE_READY_TIMEOUT_MS = 10 \* 60 \* 1_000;/,
  );
  assert.match(
    source,
    /const PENDING_CLOUD_WORKSPACE_RECORD_TTL_MS = 2 \* 60 \* 1_000;/,
  );
  assert.match(
    source,
    /const pendingCloudWorkspaceRecordsRef = useRef\(new Map<string, number>\(\)\);/,
  );
  assert.match(
    source,
    /type WorkspaceCreatePhase =[\s\S]*\| "waiting_for_cloud_runtime"/,
  );
  assert.match(
    source,
    /function isRetryableCloudWorkspaceStartupError\(error: unknown\): boolean \{/,
  );
  assert.match(
    source,
    /async function waitForCloudWorkspaceReady\(\s*workspaceId: string,\s*\): Promise<WorkspaceLifecyclePayload> \{/,
  );
  assert.match(
    source,
    /function mergePendingCloudWorkspaceRecords\(\s*nextWorkspaces: WorkspaceRecordPayload\[\],\s*\): WorkspaceRecordPayload\[\] \{/,
  );
  assert.match(
    source,
    /for \(const \[workspaceId, expiresAt\] of pendingCloudWorkspaceRecords\) \{\s*if \(expiresAt <= now\) \{\s*pendingCloudWorkspaceRecords\.delete\(workspaceId\);/,
  );
  assert.match(
    source,
    /const nextWorkspaces = workspaceListSource === "live"\s*\?\s*mergePendingCloudWorkspaceRecords\(workspaceResponse\.items\)\s*:\s*workspaceResponse\.items;/,
  );
  assert.match(
    source,
    /const session = await window\.electronAPI\.workspace\.openWorkspace\(workspaceId\);/,
  );
  assert.match(
    source,
    /const lifecycle = await window\.electronAPI\.workspace\.getWorkspaceLifecycle\(workspaceId\);/,
  );
  assert.match(
    source,
    /setWorkspaceCreatePhase\("waiting_for_cloud_runtime"\);/,
  );
  assert.match(
    source,
    /const lifecycle = await waitForCloudWorkspaceReady\(createdWorkspaceId\);/,
  );
  assert.match(
    source,
    /pendingCloudWorkspaceRecordsRef\.current\.set\(\s*createdWorkspaceId,\s*Date\.now\(\) \+ PENDING_CLOUD_WORKSPACE_RECORD_TTL_MS,\s*\);/,
  );
  assert.match(
    source,
    /await loadWorkspaceData\(\{ preserveSelection: true, allowEmpty: true \}\);/,
  );
  assert.match(
    source,
    /setSelectedWorkspaceId\(createdWorkspaceId\);/,
  );
  assert.match(
    source,
    /const customWorkspacePath = isCloudCreate\s*\?\s*""\s*:\s*selectedWorkspaceFolder\?\.rootPath\?\.trim\(\) \|\| "";/,
  );
  assert.match(
    source,
    /if \(isCloudCreate && !resolvedUserId\) \{\s*throw new Error\("Sign in required to create a remote workspace."\);\s*\}/,
  );
  assert.match(
    source,
    /location: isCloudCreate \? "cloud" : "local",/,
  );
  assert.match(source, /type WorkspaceBrowserBootstrapMode = "fresh" \| "copy_workspace" \| "import_browser";/);
  assert.match(source, /const \[browserImportSource, setBrowserImportSourceState\] =\s*useState<BrowserImportSource>\("chrome"\);/);
  assert.match(source, /browserBootstrapMode === "copy_workspace"/);
  assert.match(source, /workspace\.copyBrowserWorkspaceProfile\(\{/);
  assert.match(source, /browserBootstrapMode === "import_browser"/);
  assert.match(source, /workspace\.importBrowserProfile\(\{/);
  assert.match(source, /profileDir:\s*browserImportSource === "safari"\s*\?\s*undefined\s*:\s*\(browserImportProfileDir\.trim\(\) \|\| undefined\),/);
  assert.match(source, /setWorkspaceCreatePhase\("copying_browser_profile"\);/);
  assert.match(source, /setWorkspaceCreatePhase\("importing_browser_profile"\);/);
});
