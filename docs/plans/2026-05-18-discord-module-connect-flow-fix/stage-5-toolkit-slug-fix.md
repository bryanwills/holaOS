# Stage 5 — Composio toolkit slug must be the actual slug, not an alias

> Symptom: after Stages 1–4 land, the Discord SDK module connects, the
> Connect card transitions to "Jotyy / jotyy4352", and the
> `discord_sdk_connection_status` tool reports `connected: true` with the
> user's real identity — but `discord_sdk_send_message_message` returns
> `code: not_connected` / `401: Unauthorized`.

## Root cause

The agent-generated `provider.ts` set:

```ts
export const DISCORD: ProviderRegistry = {
  id: "discord",           // ← wrong
  composioToolkit: "discordbot",
  // ...
}
```

and `app.runtime.yaml` followed with `integration.destination: "discord"`.

Composio actually has two Discord toolkits in its catalog:

- `discord` — a consumer-OAuth slug that grants only `identify` scope. Tokens issued under it can call `GET /users/@me` (which is why `connection_status` looked OK) but cannot post messages, manage channels, or read guilds.
- `discordbot` — the bot-OAuth slug that requests `bot` scope, prompts the user to choose a guild to install the bot to, and grants a Bot token that can post messages.

The OAuth flow went through `discord`, so we ended up with an Identify-only token. `POST /channels/.../messages` returns 401 from Discord, the SDK bridge maps that to `BridgeError(code: "not_connected", upstreamStatus: 401)`, and that's what the agent saw.

### Why the agent split `id` and `composioToolkit`

The `app-builder-sdk` skill told the agent that `provider.id` is the
"Holaboss control-plane binding key" and `composioToolkit` is the
"Composio API slug" — implying they can differ, with `discord` as the
binding key and `discordbot` as the API slug. The agent followed that
advice and recorded it in a comment inside the generated `provider.ts`.

That premise is wrong. The runtime broker
(`integration-broker.ts:154-213`) keys binding lookup on the SAME
`provider` value the SDK transport sends, which is `cfg.id` — and that
same value is what `pending_integrations[].provider_id` carries to the
chat UI, which is what `composioConnect`'s `body.provider` forwards to
Hono, which is what Hono passes as `toolkit_slug` to Composio. ONE
value, used by every layer.

`composioToolkit` is read by exactly one place
(`experiments/app-builder-sdk/src/runtime/manifest.ts:76`) as a
fallback for `integration.destination` when generating the yaml. The
runtime broker, Hono, and the binding store never read it. So the
"two-id" mental model the skill encouraged could only ever cause
divergence — never reconcile.

## Fix

### Live workspace patch (immediate)

Already applied to `~/.holaboss-desktop/sandbox-host/workspace/<id>/apps/discord-sdk/`:

- `app.runtime.yaml`: `integration.destination: "discordbot"` (was `"discord"`).
- `provider.ts`: `id: "discordbot"` (was `"discord"`); `composioToolkit` field removed entirely; the wrong "DO NOT confuse" comment replaced with one explaining the single-value rule.

After patching, the running `bun` process is killed so the next
`ensureAppRunning` cycle re-imports the SDK with the corrected
`provider.id`. (The SDK's runtime-broker transport reads `cfg.id` once
at module init time — see `runtime-broker.ts:54`.)

### Skill update (so the agent doesn't repeat this)

`runtime/harnesses/src/embedded-skills/app-builder-sdk/SKILL.md`:

- Section `### provider.id vs composioToolkit — DO NOT CONFUSE` removed.
- Replaced with `### provider.id MUST be the Composio toolkit slug`
  that enumerates the layers a single value flows through, calls out
  Discord/Google Calendar/etc. as common slug pitfalls, and gives a
  `curl` snippet against Composio's catalog API to verify before
  writing the file.
- `composioToolkit` marked deprecated.

### SDK type update

`experiments/app-builder-sdk/src/types.ts`:

- `ProviderRegistry.id` gets a doc comment naming every layer it flows through.
- `ProviderRegistry.composioToolkit` gets `@deprecated` with an
  explanation pointing at this exact failure mode.

The field stays in the type (rather than getting removed) because
`manifest.ts:76` still references it; deleting it would force a
coordinated change to the manifest generator. Marking it `@deprecated`
makes IDEs strike it through and stops new authors from picking it up.

## Files changed

- `holaOS/experiments/app-builder-sdk/src/types.ts`
- `holaOS/runtime/harnesses/src/embedded-skills/app-builder-sdk/SKILL.md`
- `<workspace>/apps/discord-sdk/app.runtime.yaml`
- `<workspace>/apps/discord-sdk/provider.ts`

## Verification (user-side)

1. **Disconnect** the existing Discord connection in the Integrations
   pane. The Composio-side connected_account from the previous OAuth
   flow used the `discord` toolkit and only has identify scope; reusing
   it won't help.
2. The runtime should auto-restart `discord-sdk` once the killed `bun`
   process is detected as down by the health probe. If not, restart
   manually from the apps list.
3. Re-open the chat. Ask the agent for status; the Connect card should
   re-appear (Stage 1 emit on any completion-type tool covers this).
4. Click **Connect Discord**. The OAuth URL Composio returns should
   now request `bot` + `applications.commands` scopes and prompt for
   a guild to install the bot into.
5. After authorize+install, the card transitions to bound and the
   discord-sdk app auto-restarts (Stage 2). The next
   `discord_sdk_send_message_message` call returns
   `{ ok: true, externalId: "..." }` and the message appears in
   channel `1505798104904110182`.

## Out of scope (already shipped in earlier stages)

- Connect card emission (Stage 1), app restart after bind (Stage 2),
  toolkit-mapping removal in Hono (Stage 3), account display (Stage 4)
  are all prerequisites for Stage 5 to even be observable.
