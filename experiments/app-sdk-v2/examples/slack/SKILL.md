# Slack — provider skill notes

> First-class quirks an agent must know before writing or modifying the Slack
> module. Surfaced from real E2E debugging — not theoretical.

## Auth model

- Composio toolkit slug: `slack`
- OAuth handled by Composio (user clicks "Connect Slack" in desktop UI).
- After connect, `connected_account_id` is stored in workspace.db
  `integration_connections.account_external_id`.

## Error contract (NON-OBVIOUS)

**Slack returns errors as `HTTP 200 + body.ok: false`, not as 4xx/5xx.**

The SDK's BridgeClient only maps HTTP status to typed errors. Slack actions
must additionally check `r.data.ok` — see the `slackUnwrap` helper at the top
of `app.ts`.

```ts
const r = await bridge.call<SlackBody & { ts?: string }>("POST", "/chat.postMessage", {...})
const u = slackUnwrap(r)        // checks both HTTP status AND body.ok
if (!u.ok) return { fail: u.fail }
```

Error payload shape: `{ ok: false, error: "channel_not_found", ... }`.

## DM auto-resolution (NON-OBVIOUS)

When `channel` is passed as a **user_id** (`U07XXXX`) to `chat.postMessage`,
Slack auto-resolves it to the recipient's DM channel id (`D0XXXXX`) and
returns the resolved channel in the response.

Subsequent operations on that message (`chat.update`, `chat.delete`,
`reactions.add`) require the **DM channel id**, not the original user_id.

`send_message.run` persists `r.data.channel` back to `row.channel_id` so
edit/delete/react use the correct id.

## Scheduled-message cancellation window (NON-OBVIOUS — bit us in E2E)

`chat.deleteScheduledMessage` returns `invalid_scheduled_message_id` if
invoked **less than 60 seconds before `post_at`**. The error is not about ID
format — Slack has "graduated" the scheduled message out of the cancellable
queue.

Practical implication: agents (or E2E tests) that schedule a message and
immediately cancel must schedule **at least 60s out**. E2E uses 180s for
margin. If a cancel fails with `invalid_scheduled_message_id`, the agent
should tell the user "this message will still send because we missed the
cancel window".

The `schedule_send.reversible.run` propagates the error rather than
swallowing it — agent must see the failure.

## Reaction semantics

`reactions.add` is purely additive — calling it doesn't replace existing
reactions, it appends one more. Different from e.g. Telegram's
`setMessageReaction` which **replaces** all the bot's reactions on the
message.

## Body encoding / charset

Slack sometimes returns `warning: "missing_charset"` on success responses.
This is harmless — it means the `Content-Type` header lacked
`; charset=utf-8`. The Composio proxy doesn't add charset, so this warning
appears on every Slack call. Ignore unless you also see `ok: false`.

## Tested action contract

| Action | Endpoint | Required scope |
|---|---|---|
| `send_message` | `chat.postMessage` | `chat:write` |
| `schedule_send` | `chat.scheduleMessage` | `chat:write` |
| `edit_message` | `chat.update` | `chat:write` |
| `delete_message` | `chat.delete` | `chat:write` |
| `react` (side-effect, toState: null) | `reactions.add` | `reactions:write` |
| reverse of `schedule_send` | `chat.deleteScheduledMessage` | `chat:write` |

## State alphabet

`["draft", "scheduled", "sent", "edited", "deleted", "failed"]`

- `draft` — local-only, never sent
- `scheduled` — `chat.scheduleMessage` succeeded, awaiting post_at
- `sent` — `chat.postMessage` succeeded (terminal-but-mutable)
- `edited` — `chat.update` succeeded (also terminal-but-mutable; further
  edits stay in `edited`)
- `deleted` — `chat.delete` succeeded; row should not transition out
- `failed` — any action failed AND resource declared `failedState: "failed"`

## E2E setup notes (for the e2e runner)

- DM-self pattern: discover own user_id via `auth.test`, use as channel.
  Guarantees no team-channel spam.
- Discovery: list Composio connected accounts, filter by `toolkit.slug === "slack"`,
  pick first `ACTIVE`.
- See `examples/slack/e2e.ts` for the BDD-style harness pattern.
