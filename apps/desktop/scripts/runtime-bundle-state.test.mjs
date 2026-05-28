import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveRuntimeBundleState } from "./runtime-bundle-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("resolveRuntimeBundleState watches shared runtime contracts", () => {
  const desktopRoot = path.resolve(__dirname, "..");
  const runtimeBundleState = resolveRuntimeBundleState(desktopRoot);

  assert.ok(runtimeBundleState.runtimeSourceInputs.includes(path.join(runtimeBundleState.repoRoot, "shared")));
});
