import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creatingViewPath = path.join(__dirname, "CreatingView.tsx");
const firstWorkspacePanePath = path.join(__dirname, "FirstWorkspacePane.tsx");
const onboardingShellPath = path.join(__dirname, "OnboardingShell.tsx");

test("creating view uses the publish-flow shell DNA: rounded card on bg-fg-2 canvas with subtle shadow", async () => {
  const source = await readFile(creatingViewPath, "utf8");

  // Card: rounded-2xl bg-background with shadow-xs — matches PublishScreen.
  assert.match(source, /rounded-2xl bg-background[\s\S]*shadow-xs/);
  // No more theme-shell with hard borders.
  assert.doesNotMatch(source, /theme-shell/);
  assert.doesNotMatch(source, /border border-border\/45/);
  // Halo spinner wrapper survives the redesign.
  assert.match(source, /bg-primary\/10/);
});

test("first workspace pane passes panel variant through to the creating view", async () => {
  const source = await readFile(firstWorkspacePanePath, "utf8");

  assert.match(source, /<CreatingView[\s\S]*panelVariant=\{isPanelVariant\}/);
  assert.match(source, /<CreatingView[\s\S]*workspaceCreateLocation=\{workspaceCreateLocation\}/);
});

test("first workspace pane runs the welcome → name → folder flow", async () => {
  const source = await readFile(firstWorkspacePanePath, "utf8");

  assert.match(source, /type OnboardingStep =[\s\S]*\| "browser_profile"/);
  assert.match(
    source,
    /onContinue=\{\(\) =>\s*cloudScratchCreateSelected\s*\?\s*void createWorkspace\(\)\s*:\s*setStep\("browser_profile"\)\s*\}/,
  );
  assert.match(
    source,
    /<BrowserProfileStep[\s\S]*onBack=\{\(\) => setStep\("configure"\)\}/,
  );
  assert.match(source, /listImportBrowserProfiles\(browserImportSource\)/);
});

test("creating view adapts progress text for copy/import browser bootstrap modes", async () => {
  const source = await readFile(creatingViewPath, "utf8");

  assert.match(
    source,
    /browserBootstrapMode\?: "fresh" \| "copy_workspace" \| "import_browser";/,
  );
  assert.match(source, /workspaceCreateLocation\?: WorkspaceLocationPayload;/);
  assert.match(source, /workspaceCreatePhase\?:/);
  assert.match(source, /"waiting_for_cloud_runtime"/);
  assert.match(source, /"Launching your cloud workspace"/);
  assert.match(source, /"Starting remote runtime"/);
  assert.match(source, /"Copying browser profile"/);
  assert.match(source, /"Importing browser data"/);
});

test("first workspace pane wraps the flow in the bg-fg-2 full-screen canvas via OnboardingShell", async () => {
  const paneSource = await readFile(firstWorkspacePanePath, "utf8");
  const shellSource = await readFile(onboardingShellPath, "utf8");

  // Pane keeps the fixed-position takeover; panel variant adds a scrim.
  assert.match(paneSource, /fixed inset-0 z-30/);
  assert.match(paneSource, /fixed inset-0 z-40/);
  assert.match(paneSource, /bg-scrim backdrop-blur-sm/);
  // Canvas chrome (bg-fg-2 + macOS draggable region) lives inside the shell.
  assert.match(shellSource, /bg-fg-2/);
  assert.match(shellSource, /titlebar-drag-region/);
});
