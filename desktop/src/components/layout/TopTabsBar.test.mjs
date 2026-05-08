import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const TOP_TABS_BAR_PATH = new URL("./TopTabsBar.tsx", import.meta.url);

test("top tabs bar keeps the profile menu and gates the workspace switcher off on the control center", async () => {
  const source = await readFile(TOP_TABS_BAR_PATH, "utf8");

  assert.match(source, /const \[workspaceSwitcherOpen, setWorkspaceSwitcherOpen\] = useState\(false\);/);
  assert.match(source, /const \{ selectedWorkspaceId, setSelectedWorkspaceId } =\s*useWorkspaceSelection\(\);/);
  assert.match(source, /if \(!controlCenterActive \|\| !workspaceSwitcherOpen\) \{\s*return;\s*\}\s*closeWorkspaceSwitcher\(\);/);
  assert.match(source, /!controlCenterActive \? \(/);
  assert.match(source, /!controlCenterActive &&\s*workspaceSwitcherOpen/);
  assert.match(source, /<DropdownMenu>/);
  assert.doesNotMatch(source, /<NotificationCenter/);
  assert.doesNotMatch(source, /notificationUnreadCount/);
});

test("top tabs bar exposes a control center action alongside integrated title bar controls", async () => {
  const source = await readFile(TOP_TABS_BAR_PATH, "utf8");

  assert.match(source, /controlCenterActive\?: boolean;/);
  assert.match(source, /onOpenControlCenter\?: \(\) => void;/);
  assert.match(source, /!controlCenterActive \? \(/);
  assert.match(source, /variant="bordered"\s*size="sm"/);
  assert.match(source, /onClick=\{\(\) => onOpenControlCenter\?\.\(\)\}/);
  assert.match(source, /Show all workspaces/);
  assert.match(
    source,
    /const isWindowsIntegratedTitleBar =\s*integratedTitleBar && desktopPlatform === "win32";/,
  );
  assert.match(source, /window\.electronAPI\.ui\.getWindowState\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.minimizeWindow\(\)/);
  assert.match(source, /window\.electronAPI\.ui\.closeWindow\(\)/);
  assert.match(source, /aria-label="Minimize window"/);
  assert.match(source, /aria-label="Close window"/);
});

test("top tabs bar workspace switcher makes same-name workspaces distinguishable", async () => {
  const source = await readFile(TOP_TABS_BAR_PATH, "utf8");

  assert.match(source, /workspace\.id\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(source, /\(workspace\.location \|\| ""\)\.toLowerCase\(\)\.includes\(query\)/);
  assert.match(source, /const workspaceShortId = useCallback\(\(workspaceId: string\) => \{/);
  assert.match(source, /return workspaceId\.trim\(\)\.slice\(0, 8\);/);
  assert.match(source, /const workspaceSwitcherMetaLabel = useCallback\(/);
  assert.match(source, /workspace\.location === "cloud" \? "Cloud" : "Local"/);
  assert.match(source, /workspaceShortId\(workspace\.id\)/);
  assert.match(source, /parts\.join\(" • "\)/);
  assert.match(source, /className="truncate text-\[11px\] font-normal text-muted-foreground"/);
});
