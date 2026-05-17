# app-sdk-v2 — Experimental Holaboss app SDK

A TypeScript prototype rebuilding the Holaboss app SDK around **5 orthogonal
primitives**. The goal: let agents author apps of any shape (publishing,
messaging, workflow, event-with-time, sync-mirror) with zero `as any`, strong
compile-time guardrails, and no scheduling/retry concerns leaking into app code.

**This is not production code.** It is a spike with passing end-to-end tests
to validate the API surface before integrating into the real Holaboss runtime.

## What's the SDK, what isn't

```
src/                      ← THE SDK — ~11 files, ~1100 lines. Touched only
│                            by SDK maintainers; agents adding apps NEVER
│                            modify this directory.
├── index.ts                public exports
├── types.ts                all type definitions
├── app.ts                  createApp + 5 primitive registrars
├── bridge.ts               BridgeClient + createBridge (transport contract)
├── bridge-transports/      optional transport adapters (bearer / composio-direct)
└── runtime/                internal execution: action-runner, sync-runner,
                            state, db-view

examples/<app>/           ← APP MODULES — fully self-contained. Each app
│                            owns its provider, business logic, tests, e2e.
│                            Adding a new platform = create one new directory
│                            here. SDK doesn't change.
├── provider.ts             ProviderRegistry constant (baseUrl, allowedHosts, ...)
├── app.ts                  business logic (createApp + resource/action calls)
│                            Per-provider quirks (Slack body.ok pattern, 60s
│                            window, etc.) are inline comments at the call
│                            site they apply to — single source of truth.
├── e2e.ts                  real-API end-to-end runner (optional)
└── (other files as the app needs)

test/<app>.test.ts        ← UNIT TESTS — mock transport, no network.
```

**This layout means**:
- Marketplace / third-party / agent-generated apps live entirely in
  `examples/<app>/` (or wherever the host runtime mounts them).
- SDK is independently versioned; an app pinning SDK 1.2.0 doesn't have to
  upgrade to use a new app authored against SDK 1.3.0.

> Note on Holaboss "skills": this SDK does NOT define a per-app SKILL.md
> convention — the real Holaboss skill system lives at
> `runtime/harnesses/src/embedded-skills/<skill-id>/SKILL.md` (system-wide,
> with frontmatter) and `<workspace>/skills/<skill-id>/SKILL.md`
> (workspace-local, created via the `skill-creator` skill). Provider quirks
> stay as code comments in `app.ts`; the existing `app-builder` skill needs
> an update — to know about the 5-primitive v2 SDK shape — when v2 SDK
> reaches production runtime integration.

## The 5 primitives

```ts
app.connection()                      // declares provider connection
app.resource(name, def)               // declares a typed entity with its own state alphabet
app.action(resource, name, def)       // declares a callable that transitions states
app.sync(name, def)                   // periodic fetch+upsert+normalize (automations-scheduled)
app.start()                           // boot
```

Read [`src/types.ts`](./src/types.ts) for the full type surface and the
ActionDef / SyncDef doc comments for the SDK ↔ Automations boundary.

## What's verified

| File | Shape | Tests |
|---|---|---|
| [`examples/pinterest/app.ts`](./examples/pinterest/app.ts) | publishing (multi-step + reversible) | 5 |
| [`examples/slack/app.ts`](./examples/slack/app.ts) | messaging (custom states, side-effect react) | 7 |
| [`examples/github-issues/app.ts`](./examples/github-issues/app.ts) | workflow (6-state lifecycle) | 7 |
| [`examples/gcalendar/app.ts`](./examples/gcalendar/app.ts) | event-with-time (RSVP, recurring) | 9 |
| `test/sync.test.ts` | sync E2E across 3 apps | 6 |
| `test/agent-mistakes.test.ts` | compile + runtime double-guard | 8 |
| **Total** | **4 distinct app shapes** | **42 / 167 expect / 0 fail** |

```bash
bun install
bun test           # 45 pass / 0 fail
bunx tsc --noEmit  # clean
```

## Transports — the SDK is auth-mechanism agnostic

The SDK never assumes Hono, Composio, OAuth, or any specific provider. The
`BridgeClient` delegates network I/O to a `TransportFn` (`(req) => response`).
You pick the transport that matches your deployment.

Bundled options under `src/bridge-transports/`:

| Transport | When to use | What you supply |
|---|---|---|
| `createBearerTokenTransport` | **Self-host OAuth** — you manage tokens (Auth0 / Clerk / your own auth server / manual). | `accessToken: string \| (() => Promise<string>)` |
| `createComposioDirectTransport` | Composio managed auth, no broker hop. Good for single-tenant deploys, local dev, E2E. | `COMPOSIO_API_KEY` + `connectedAccountId` |
| *(future)* `createBrokerProxyTransport` | Production sandbox via Holaboss runtime + grant. Same model as `@holaboss/bridge`. | `brokerUrl` + `grant` |
| Roll your own | Custom auth (Vault, mTLS, internal gateway). | Implement ~20 lines of `fetch` returning `{ status, body, headers }`. |

Bundled transports never call Holaboss backend / Hono. Production runtime
integrations are wired by the runtime team via the broker-proxy pattern; that's
separate from this SDK.

## Real E2E (single command, no Holaboss backend required)

```bash
cd experiments/app-sdk-v2
export COMPOSIO_API_KEY=ck_...
export COMPOSIO_SLACK_ACCOUNT_ID=ca_...   # from workspace.db, see e2e.ts header
export TEST_SLACK_CHANNEL=C0123ABCD
bun run examples/slack/e2e.ts
```

Sends real messages to your Slack workspace via `createComposioDirectTransport`.
Watch Slack — message + edit + 🚀 reaction should appear within seconds.

## What's in scope

- HOW an action does its work (steps, checkpoint, state transitions, reverse handler)
- Resource schema → typed callbacks (no `as any` in agent code)
- HTTP-level error normalization via `BridgeClient`
- Auto-derive MCP tool list from declarations
- Auto-emit `OutputCard` to dashboard surface on every state change

## What's NOT in scope (lives in automations)

- WHEN actions run (cron, schedule, future-time)
- Retry on transient failure (rate limit, network)
- Cross-app orchestration
- User-visible "what's scheduled" view

Actions MUST be idempotent: re-invoking on a row that carries persisted
intermediate state (e.g. `media_id` from a prior failed publish attempt) must
safely no-op the already-completed steps. The 4 examples demonstrate the
pattern via `row.external_id` short-circuit.

## Known weaknesses (honestly listed after a cold review pass)

1. **Idempotency is by convention, not by type.** Agent could write a
   non-idempotent action; type system won't catch it. Examples demonstrate
   the `row.external_id` short-circuit pattern. Future: optional
   `idempotencyKey: (row) => row.external_id` hook so SDK can short-circuit
   automatically.

2. **`askUser` protocol not designed.** No way for an action mid-step to pause
   and ask the user to choose a value. Requires runtime turn-suspend
   coordination — single-handed SDK can't define it cleanly.

3. **`app.start()` is a 1-line check.** Real implementation (start MCP SSE
   server, register with runtime, etc.) lands when this SDK is wired into the
   actual Holaboss runtime.

4. **Reverse tool naming convention.** Defaults to
   `<app>_cancel_<action>_<resource>`, or `<toolName>_reverse` when `toolName`
   was overridden on the forward action. Convention not encoded in types.

5. **`DbView.where()` supports scalar equality only** (string/number/boolean/
   null). Type system enforces via `ScalarFilter<T>` — passing an array or
   object as a where condition won't compile. Array-membership / object-deep
   queries need a separate primitive if/when needed.

6. **Sync record retention.** When a row is deleted (state="deleted") or an
   external resource disappears from sync results, prior sync records stay in
   `state.syncRecords` with dangling `attachedRowId`. Needs a retention
   policy. Low priority — only matters once SyncRecord drives UI.

7. **Three `as unknown` casts in `src/app.ts`** at storage boundaries (action
   and sync registration). These widen agent-precise types to a generic
   `Record<string, unknown>` shape so the storage arrays can be homogeneous.
   Each is annotated with intent. **Agent code (examples/) has zero `as
   any`.**

## Origin

Distilled from a multi-round design discussion (architecture review →
stress-test by independent subagents → cold review by a third subagent →
type-system fixes → sync execution). The design dossier lives in the parent
workspace, not in this repo.

## Next steps (if this lands)

1. Wire `BridgeClient` to the real `/broker/proxy`.
2. Replace in-memory state with SQLite (via `@holaboss/runtime-state-store`).
3. Replace derived tool list with real MCP SSE server registration.
4. Migrate one wrapper-shape module (e.g. `bannerbear`) as the first
   dog-fooding test (current: ~600 lines → target: ~80 lines).
5. Design `askUser` protocol with runtime team.
