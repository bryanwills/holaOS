---
name: app-builder-sdk
description: Build the backend of a new holaOS app using @holaboss/app-builder-sdk — 5 declarative primitives (connection / resource / action / sync / start), provider wiring, install + bind + propose_connect flow. For the visual layer (`src/client/`), this skill delegates to the `build-dashboard` skill.
---

# App Builder (SDK) — backend half

Use this skill whenever the user wants a new holaOS app.

Two app shapes both ship through the same SDK; pick the one the request needs:

1. **Integration-only module** — Slack, Discord, Notion, Stripe, Linear, anything whose value is "talk to one external service via MCP tools, agent drives, no per-app dashboard". The SDK's default web stub is fine; no `src/client/` directory. **Only this skill is required.**
2. **Dashboard app** — vibe-coded content planners, CRMs, kanban-style trackers, podcast-guest managers, anything where the user expects a workspace pane. **Has a real UI** under `src/client/`. **This skill covers the backend; invoke `skill({ name: "build-dashboard" })` for the visual layer.**

The SDK core (5 primitives below) is identical for both shapes. The dashboard shape adds `src/client/` and is built by the other skill.

All supplemental files named in this skill are bundled beside this `SKILL.md`. Treat those paths as skill-local references that are safe to use in packaged runtimes; do not guess at repo-root paths.

## When NOT to use this skill

- The user already has a working hola-boss-apps module and wants to extend it → modify it in place; don't rewrite as SDK. (The legacy app-builder skill that used to live alongside this one has been removed; all new app work goes through this SDK.)

## The 5 primitives

Every SDK app composes exactly these:

```ts
app.connection()             // declares "this app needs an integration binding"
app.resource(name, {...})    // declares a row type (status machine, schema, emit rules)
app.action(resource, name, { fromStates, toState, run, [reversible], [steps], [schema] })
app.sync(name, { schedule, attachTo, fetch, upsert, normalize })
app.start()                  // validate config; no scheduling — automations layer does that
```

Mental model:
- `resource` = a row in the app's SQLite (e.g. `message`, `event`, `issue`, `pin`)
- `action` = state transition + upstream API call (e.g. `send_message: draft → sent`)
- `sync` = periodic upstream read that upserts records keyed by external id
- HOW (steps / states / reversal) lives in the SDK. WHEN (scheduling, retry) lives in Holaboss automations — **the SDK never schedules**.

Full type contract: `sdk-package/src/types.ts`. Public exports: `sdk-package/src/index.ts`.

### `provider.id` MUST be the Composio toolkit slug

There is ONE provider identifier; the same value flows through every layer of the connect + proxy chain:

- `app.runtime.yaml`'s `integration.destination`
- `pending_integrations[].provider_id` (runtime emits this to drive the chat Connect card)
- Hono `/api/composio/connect`'s `body.provider` (Hono uses it verbatim as Composio's `toolkit_slug`)
- `integration_connections.provider_id` (DB row created at OAuth finalize)
- `integration_bindings.integration_key` (DB row created when the user clicks Bind)
- `createRuntimeBrokerTransport({ provider })` at runtime (broker keys the binding lookup on it)

`provider.id` in `ProviderRegistry` IS this value. It MUST be the canonical Composio toolkit slug — the exact string in Composio's catalog at https://platform.composio.dev — not a "user-friendly" alias. Common ones that bite:

- Discord bot: **`discordbot`** (NOT `discord` — that slug, if it exists, grants only `identify` scope and cannot post messages → `POST /channels/.../messages` returns 401, which the SDK maps to `not_connected`)
- Google Calendar: **`googlecalendar`** (NOT `gcal` or `google`)
- Google Sheets: **`googlesheets`**
- Google Drive: **`googledrive`**
- Slack / GitHub / Gmail / Notion / Stripe / Linear / Figma / Calendly / Mailchimp / Reddit / Twitter / Instagram / YouTube / LinkedIn: **lowercase brand name** (verify in catalog).

If unsure, verify against the **integration store catalog** BEFORE writing `provider.ts` — the runtime will reject `workspace_apps_register` on any `provider` that isn't in this list with a "did you mean '<x>'?" suggestion. The store catalog is the curated subset of Composio toolkits we explicitly support; Composio has 1000+ toolkits but only the ones in `runtime/api-server/src/integration-store-catalog.ts` (Hero + Supported tiers) are accepted.

```bash
# Look up supported slugs from the runtime (preferred — single source of truth):
curl -sS http://127.0.0.1:8080/api/v1/capabilities/runtime-tools/integrations/catalog | jq '.provider_ids'

# Or grep the catalog file directly if you have the repo open.
```

Composio's own catalog (`https://backend.composio.dev/api/v3/toolkits`) is a useful reference for slug spelling but is **not** the source of truth — a slug existing on Composio does NOT mean we support it. If you want to add a new toolkit, the workflow is: add a row to `integration-store-catalog.ts`, not bake the unsupported slug into your app.

The legacy `composioToolkit` field on `ProviderRegistry` is **deprecated**. Do not set it. If a reference still does, replace `id` with the same value and drop `composioToolkit`. Splitting them was a misreading of the runtime — the broker proxy uses ONLY `provider` (= `cfg.id`); `composioToolkit` is dead code, currently used only by `manifest.ts` as a fallback that should never trigger when `id` is correct.

### Connection readiness: ask the runtime, never the upstream host

If your app needs to show "connected / needs connection" status in the UI, you **MUST** call `getIntegrationStatus()` from `@holaboss/app-builder-sdk` on mount (via a TanStack Start server function or loader), and re-call it after the user finishes any Connect flow. There is **no other supported way** to detect connectivity. Pinging the upstream host (`https://api.twitter.com/...`, `https://api.notion.com/...`) is not just suboptimal — it is the exact failure mode that left every previous vibe-coded dashboard stuck on "needs connection" the moment Composio rerouted the toolkit (api.twitter.com → api.x.com, Discord scope-only slug, etc.). The register-time lint rejects hardcoded upstream hosts; `getIntegrationStatus()` is the only way through.

```ts
// src/client/lib/integration-status.ts (TanStack Start server function)
import { getIntegrationStatus } from "@holaboss/app-builder-sdk"

export const integrationStatus = createServerFn().handler(async () => {
  return getIntegrationStatus()
})

// or narrow to one provider for a per-toolkit badge:
export const twitterStatus = createServerFn().handler(async () => {
  return getIntegrationStatus({ provider: "twitter" })
})
```

The helper reads `HOLABOSS_APP_GRANT` + `WORKSPACE_API_URL` (both injected by the runtime when your app starts) and calls the runtime's `/api/v1/integrations/readiness` endpoint. Response shape: `{ ready: boolean, issues: [{ provider, integrationKey, code, message }] }`. `code` is one of `ready | integration_not_bound | integration_not_connected | integration_needs_reauth` — the `build-dashboard` skill's `ConnectionPill` component already maps these codes to UI affordances.

There is **no legitimate reason** for an SDK app to ping the upstream API host as a connectivity test. If something looks like it needs that, you want `getIntegrationStatus` instead.

The runtime enforces this at `workspace_apps_register` time: a source-tree scan rejects any app whose `src/` contains hardcoded toolkit hosts like `api.twitter.com`, `api.x.com`, `api.github.com`, `slack.com/api`, `api.notion.com`, `api.linear.app`, `gmail.googleapis.com`, etc. The error names the file, line, and the provider you should be routing through instead. The right shape is **always** `createRuntimeBrokerTransport({ provider })` — no upstream host belongs in your app code.

## Dashboard apps — delegate to `build-dashboard`

The SDK's default `startMcpServer({ httpPort, ... })` ships a placeholder "headless module" page on the http port. That placeholder is **only acceptable for integration-only modules**. The moment the user asks for a dashboard / list / kanban / calendar / "let me see my X":

**Invoke `skill({ name: "build-dashboard" })`** and follow its instructions. That skill owns the entire visual layer end-to-end — foundation files (inline), shape catalog (queue / table / kanban / form / calendar), required infra (Tailwind compile, deps, `vite.config.ts`), and a lint-enforced verification checklist. Do NOT try to compose `src/client/` from this skill alone — there are no UI rules here on purpose.

Both skills are required for dashboard apps:
- **this skill** covers the backend half: 5 primitives, provider wiring, integration block, install protocol, bind + propose_connect flow
- **`build-dashboard`** covers the `src/client/` half

For integration-only modules (no `src/client/`), only this skill is required.

## Pick a reference shape (backend only)

Copy the closest bundled backend reference dir; don't write from scratch. All references are at `reference/<shape>/` and are integration-only (no `src/client/`) — use them for the backend skeleton (`app.ts`, `provider.ts`, `server.ts`, `app.runtime.yaml`). If the app also has a dashboard, layer the `build-dashboard` skill's `src/client/` on top.

| Shape | Reference | Use when the request looks like |
|---|---|---|
| **messaging** | `slack-messaging/` | Send / edit / delete / react on a message; chat-like provider (Discord, Telegram, IRC, SMS). Has custom state alphabet + side-effect actions + reversible scheduled send. **Also the only backend reference with full `server.ts` + `app.runtime.yaml`** — copy those two files verbatim into any new module regardless of shape. |
| **publishing** | `pinterest-publishing/` | Multi-step upload-then-publish + reversible cancel; idempotency via `row.external_id` short-circuit. Use for any "create draft → confirm → publish → can be deleted" flow (image / video / blog posts). |
| **workflow** | `github-workflow/` | Multi-state lifecycle (`draft / open / in_progress / closed / reopened / failed`), reversible close↔reopen, side-effect actions (`comment`, `assign`) that don't change row.status. CRM leads / issue trackers / ticketing systems. |
| **event-with-time** | `gcalendar-events/` | Resources carry their own `start_time/end_time` (intrinsic, not "schedule this action later"); RSVP as side-effect; recurring (RRULE). Use for calendar / booking / appointment modules. |
| (already-built dogfood) | `telegram-messaging/` | First app a cold subagent built using only this skill + the SDK. Integer external IDs (`message_id` is int — stringify on persist). Read its inline notes if your provider also has integer IDs. |

Always read the `app.ts` of the chosen reference end-to-end before writing your own. Each one's top-of-file banner notes the shape it demonstrates and provider-specific quirks the agent who wrote it found.

## File layout per module

### Integration-only modules — 4 files

For Slack-style modules where the agent drives via MCP and no dashboard is needed:

```
<workspace>/apps/<app_id>/
├── app.ts              # buildXApp(options) — connection / resource / action / sync declarations
├── provider.ts         # ProviderRegistry: id, baseUrl, allowedHosts, whoamiPath
├── server.ts           # production entry: SqliteStateBackend + runtime-broker + startMcpServer
├── app.runtime.yaml    # manifest (lifecycle, healthchecks, mcp.tools list, env_contract, integration)
└── package.json        # declares @holaboss/app-builder-sdk via npm semver
```

`startMcpServer({ httpPort })`'s built-in placeholder is acceptable here — the user never opens this app's workspace pane in practice, they drive it from chat. Copy `reference/slack-messaging/{server.ts,app.runtime.yaml}` and adapt the constants. Copy `reference/<your-shape>/{app.ts,provider.ts}` and adapt the resource/action declarations.

### Dashboard apps — adds `src/client/`

Same 4 backend files above, plus a `src/client/` directory. **The `build-dashboard` skill owns the `src/client/` shape** — invoke it for the visual layer. The only backend delta vs. integration-only is `server.ts`, which boots both the MCP server (`MCP_PORT`) and the dashboard HTTP server (`PORT`):

```ts
// 1) MCP — same as integration-only
startMcpServer({ port: Number(process.env.MCP_PORT), app, bridge })

// 2) Dashboard — Bun.serve the TanStack Start build output OR Vite dev server.
//    Reads from the SAME SqliteStateBackend the SDK uses, via TanStack Start
//    server functions. NEVER spin up a second DB.
import { build } from "./client/build" // built dashboard
Bun.serve({ port: Number(process.env.PORT), fetch: build.fetch })
```

The desktop's iframe (`AppSurfacePane`) resolves the URL to `env.PORT`; whatever you serve there is what the user sees.

## Install protocol

After writing the files into `<workspace>/apps/<app_id>/`, do these in order. Do not skip steps:

### 1. `package.json` — npm semver, no `file:` paths

```json
{
  "name": "<app_id>-app",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "dependencies": {
    "@holaboss/app-builder-sdk": "latest"
  }
}
```

Dashboard apps add `@holaboss/ui` + react + vite + tailwind devDeps; the `build-dashboard` skill spells out the full `package.json` snippet.

`@holaboss/app-builder-sdk` and `@holaboss/ui` live on npmjs.com (public, Apache-2.0). `bun install` pulls them down like any normal dep — no repo checkout assumption, no machine-specific file: paths. Use `"latest"` literally; do not pin a version. These packages are lockstep-evolving alongside the runtime — pre-1.0 caret semver (`^0.1.0`) only matches `0.1.x`, so any pinned dep silently drifts behind the runtime.

### 2. `bun install` once in the app dir

```
cd <workspace>/apps/<app_id> && bun install
```

If the user's runtime injects `WORKSPACE_DB_PATH`, `HOLABOSS_APP_GRANT`, `HOLABOSS_INTEGRATION_BROKER_URL`, `MCP_PORT`, `PORT` (it does — see runtime's `app-lifecycle-worker.ts`), the production entry in `server.ts` runs as-is. Don't try to set these yourself.

### 3. `app.runtime.yaml` — declare env contract + mcp tools

Required env contract for any SDK app:

```yaml
env_contract:
  - "HOLABOSS_WORKSPACE_ID"
  - "WORKSPACE_DB_PATH"
  - "HOLABOSS_INTEGRATION_BROKER_URL"
  - "HOLABOSS_APP_GRANT"
  - "MCP_PORT"
```

Dashboard apps also add `PORT`.

`mcp.tools` list must match what `app.derivedTools()` returns. The derivation rules from `sdk-package/src/app.ts:165-238` are:
- `<app_id>_connection_status` — always
- For each resource: `<app_id>_list_<plural>`, `<app_id>_get_<resource>`, and (if `refreshEvery + fetch` declared) `<app_id>_refresh_<plural>`
- For each action: `<app_id>_<action_name>_<resource_name>` (or `def.toolName` override), plus `<app_id>_cancel_<action>_<resource>` for reversible
- For each sync: `<app_id>_<sync_name>_sync_status`
- `<app_id>_snapshot` — always

If you're not sure, write the app, `bun run server.ts` once locally, and read the "Tools registered: N" log line.

### 4. `integration` block in app.runtime.yaml — REQUIRED if the app calls any provider

If your app uses `createRuntimeBrokerTransport({ provider })` or otherwise consumes a Composio toolkit, you **must** declare a matching `integrations:` entry. Without it:
- The runtime binding lookup has no key to match, so `upsertIntegrationBinding` succeeds at the row level but `getIntegrationStatus()` reports `integration_not_bound` forever.
- The Connect card the chat renders never resolves, the multi-card gate keeps the agent paused, and the user sees a dashboard stuck on "needs connection" no matter how many times they click Connect.

Skip this block only when the app is purely internal (no upstream calls).

```yaml
integrations:
  - key: <integration_key>          # local handle the app uses; usually same as provider_id
    provider: <provider_id>         # MUST be a Composio store catalog slug (see section above)
    capability: <api | messaging | files | ...>
    required: true                  # block startup if not bound
    credential_source: platform     # always; uses Composio via runtime broker
```

### 5. Register in `workspace.yaml`

Three places to add. They're separate top-level sections; don't reorder existing entries.

```yaml
mcp_registry:
  allowlist:
    tool_ids:
      - <app_id>.<tool_name>     # add one line per tool from app.runtime.yaml mcp.tools
      # ...
  servers:
    <app_id>:
      type: remote
      url: http://localhost:<MCP_PORT>/mcp/sse
      enabled: true
      timeout_ms: 120000   # vibe-coded apps cold-start slowly: first npm install + first build + boot easily blow past 30s; 120s is the runtime default for the same reason
applications:
  - app_id: <app_id>
    config_path: apps/<app_id>/app.runtime.yaml
    lifecycle:
      setup: bun install
      start: >-
        MCP_PORT=<port> nohup bun run server.ts > /tmp/<app_id>-module.log 2>&1 &
      stop: kill $(lsof -t -i :<port> 2>/dev/null) 2>/dev/null || true
```

The MCP port and HTTP port are allocated by the runtime per app (`workspace-apps.ts:122`). For dogfood you can hard-code free ports in the high 38000s.

### 6. Bind the integration connection

After installing the app, bind it to the existing provider connection:

```
curl -X PUT 'http://127.0.0.1:40531/api/v1/integrations/bindings/<workspace_id>/app/<app_id>/<provider_id>' \
  -H 'Content-Type: application/json' \
  -d '{"connection_id":"<existing_connection_id>"}'
```

Get `<existing_connection_id>` from the runtime DB:

```
sqlite3 ~/.holaboss-desktop/sandbox-host/state/control-plane.db \
  "SELECT connection_id, account_handle FROM integration_connections WHERE provider_id='<provider>' AND status='active';"
```

If no row → user has not connected this provider yet; tell them to use the desktop integrations panel before continuing. Don't try to mint a Composio connection from the agent — that's an OAuth flow that requires user consent in the desktop UI.

The PUT triggers `refreshAppsForIntegrationBinding` which restarts the app process, so the new env propagates within a few seconds.

### Propose connect for every required integration BEFORE declaring the app done

The single biggest failure mode in vibe-coded apps is **shipping a non-functional app and rationalizing it as "safe mode" / "access not available yet" instead of asking the user to connect**. That rationalization is wrong every time. Read this carefully.

**The required loop:**

1. App declares `integrations: [...]` in `app.runtime.yaml` for every provider it uses. (See section 4 above — this is mandatory whenever the app calls any provider; the alternative is not "skip the declaration", it is "you do not need this provider in your app".)
2. `workspace_apps_register` / `workspace_apps_ensure_running` returns a `pending_integrations` array listing every declared provider that does not yet have an active connection.
3. For **each** entry in `pending_integrations`, you call `holaboss_workspace_integrations_propose_connect({ toolkit_slug })`. One card per provider. Same turn is fine.
4. You stop. The runtime emits a `waiting_on_pending_integrations` event, parks your next input, and re-dispatches it the moment all required connections land as `active`. You do not poll, do not retry, do not chain "let me also call gmail_get_profile to verify" — that hits 401 noise.
5. When the system re-dispatches you, every required provider is connected, the dashboard's `getIntegrationStatus()` will return `ready: true`, and the app actually works.

**The trap you must NOT fall into:**

- Do not catch a 401 / `integration_not_connected` from an MCP tool and conclude "this API is not available" or "Composio doesn't expose this". That error means **the user hasn't connected yet**, NOT that the action is missing. Propose connect and try again after the user authorizes.
- Do not skip declaring `integrations` in the manifest because "then the gate will pause my turn". The gate IS the contract — being paused is the correct outcome when the user needs to do an OAuth step. Skipping the declaration to dodge the gate is shipping a broken app.
- Do not invent "safe mode", "manual mode", "logging-only mode", "preview mode", or any other phrase that means "the app I just shipped doesn't actually work". Those are agent rationalizations of the same underlying bug: you did not propose_connect when you should have.
- Do not double-propose the same toolkit "in case the first one didn't take" — the gate de-dupes by slug.

**Concrete heuristic:** if your final message would contain any of "isn't available yet", "doesn't expose", "safe mode", "manual mode", "logging-only", "no real recipient", or "shows blockers instead of pretending to send" — stop, go back to step 3, and propose_connect the missing providers. Then re-evaluate.

## Verification checklist (backend)

Run all of these. Stop at the first failure and report the symptom verbatim, don't paper over it. Dashboard apps have additional checks in the `build-dashboard` skill — run both lists.

1. `cd <workspace>/apps/<app_id> && bun install` → exit 0, lockfile written
2. `MCP_PORT=<port> WORKSPACE_DB_PATH=/tmp/<app_id>.db HOLABOSS_INTEGRATION_BROKER_URL=http://localhost:40531/api/v1/integrations HOLABOSS_APP_GRANT=fake bun run server.ts &` → "MCP server listening on :<port>" and "Tools registered: N" in stdout
3. `curl http://localhost:<port>/mcp/health` → `{"status":"ok","app_id":"<app_id>"}`
4. (After registering in workspace.yaml + restarting desktop or hitting the binding refresh API) the app appears in the desktop integrations pane
5. After the manual PUT binding step, agent calls `<app_id>_connection_status` → returns `{connected: true, identity: {...}}` if `provider.whoamiPath` is set, else `{connected: null, reason: "no_probe_defined"}`. Anything else (`{connected: false, reason: ...}`) means the binding or the upstream is broken — read the `message` field, fix root cause, don't retry blindly.
6. Agent calls one real action tool end-to-end (e.g. `discord_send_message_message`). Must return `{ok: true, externalId: "..."}` and the provider must show the action in its UI (the user can verify).

## SDK / backend anti-patterns

- Do not import `@holaboss/bridge` — that's the legacy SDK. Use `@holaboss/app-builder-sdk` exclusively.
- Do not write `as any` to dodge a type error. The SDK vends `RowOf<TSchema>` end-to-end via `z.infer`; if a callback's `row` doesn't have the field you want, the schema is missing it — fix the schema.
- Do not hardcode the broker URL, grant, workspace id, MCP port, or dashboard PORT. They're env-injected at boot.
- Do not write a "scheduler" — no cron in app code. Sync `schedule:` strings are descriptive, not executed by the SDK.
- Do not write a separate SKILL.md under the app's directory. The two skill systems are `embedded-skills/` (here) and `<workspace>/skills/`. App-local Markdown is not a skill.
- Do not deploy until step 5 of the verification checklist returns `connected: true`. A green `/mcp/health` is necessary but not sufficient.
- Do not spin up a second SQLite DB for the dashboard. The dashboard reads from the same `SqliteStateBackend` the SDK uses (the table `app.resource()` declared) — via TanStack Start server functions.
- **Hand-rolled polling / `setInterval` / `setTimeout(retry, N)` / custom backoff loops.** All scheduling and retry lives in the workspace automations layer. The SDK's `sync(name, { schedule, ... })` is a **declarative** statement of intent — Holaboss runs it on the declared cadence; you do not. Putting an interval in client or server code creates duplicate fetches, fights workspace pause/resume, and ignores user-level rate budgets.
- **Custom OAuth, token storage, or refresh logic.** The runtime broker via Composio owns the OAuth lifecycle, token rotation, scope negotiation, and re-auth detection end-to-end. Your app's only credential primitive is `createRuntimeBrokerTransport({ provider })`. If you find yourself reading a token, you are off-path; route through the broker instead.
- **Hardcoded user identity in code** — usernames, email addresses, account ids, workspace names. These are mutable + per-workspace. Read identity from `getIntegrationStatus()` issues (handle/email come back enriched), from app row state, or from a server-function parameter. Never bake "@jotyy" or "user@example.com" into source.
- **Layering a second ORM / entity abstraction on top of `resource` + `action` + `sync`.** The five primitives are the whole storage contract; the MCP tool surface and the dashboard reads derive from them. If you need a field, a state, or an action that doesn't exist in your `resource`, extend the resource — don't wrap it in your own `class Repository`. A parallel model silently desynchronizes from the tools the agent gets.
- **Forgetting the `integration:` block when the app uses a Composio provider.** If you call `createRuntimeBrokerTransport({ provider: "gmail" })` anywhere in the app, `app.runtime.yaml` MUST declare a matching `integrations:` entry. Otherwise the binding step has no key to bind, `getIntegrationStatus()` reports `integration_not_bound`, and the dashboard is stuck.

## Schema migration (from PM doc)

vibe coding's biggest failure mode is destructive migrations. Rules:

| Change | Behaviour |
|---|---|
| Add field | Additive, safe, default value auto-filled, agent does it directly |
| Rename field | Safe, auto-migrate |
| Delete field | Destructive — require user confirm + auto-backup the old data |
| Change field type | Destructive — same |
| Change state alphabet | Existing-state mapping must be explicit; agent proposes, user confirms |

Each schema change is a version; the user must be able to roll back.

## Reference index (read order)

### Always

1. `sdk-package/README.txt` — top-level overview bundled for packaged runtimes
2. `sdk-package/src/index.ts` — public surface
3. `sdk-package/src/types.ts` — full type contract, including `RowOf` and the integer-id stringify note
4. `sdk-package/src/app.ts` — derived tool naming, primitive wiring, and registration behavior

### For the backend shape

5. `reference/<shape>/app.ts` — copy + adapt; pick the shape that matches the user's request (messaging / publishing / workflow / event-with-time)
6. `reference/slack-messaging/server.ts` + `reference/slack-messaging/app.runtime.yaml` — copy + adapt; this is the only bundled reference that ships a complete `server.ts`

### For dashboard apps

7. **Invoke `skill({ name: "build-dashboard" })`** — that skill owns the entire visual layer with inline file templates and a shape catalog. Do not try to compose `src/client/` from this skill alone.
