import { describe, test, expect } from "bun:test"
import { createBridge, type TransportFn } from "../src/bridge.ts"
import { SLACK } from "../src/providers/slack.ts"
import { buildSlackApp } from "../examples/slack/app.ts"
import type { AppHandleInternal } from "../src/app.ts"

let calls: Array<{ method: string; url: string; body?: any }> = []
let scriptedResponses: Array<{ status: number; body: unknown }> = []
const transport: TransportFn = async (req) => {
  calls.push({ method: req.method, url: req.url, body: req.body })
  const next = scriptedResponses.shift()
  if (!next) throw new Error(`no scripted response for ${req.method} ${req.url}`)
  return next
}
function bridge() {
  return createBridge({ provider: SLACK, transport })
}
function setup() {
  calls = []
  scriptedResponses = []
  const built = buildSlackApp() as unknown as { app: AppHandleInternal; message: any; channel: any }
  built.app._setTurn({ turnId: "turn_1", sessionId: "sess_1" })
  return built
}

describe("Slack — Slack's own states (sent/scheduled/edited/deleted)", () => {
  test("send_message: draft → sent (not 'published')", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "hello world",
    }, "draft")
    scriptedResponses.push({ status: 200, body: { ok: true, ts: "1234.567", channel: "C123" } })

    const r = await app._invokeAction({ actionName: "send_message", rowId: row.id, bridge: bridge() })
    expect(r).toEqual({ ok: true, externalId: "1234.567" })
    expect(app._state.getRow(row.id)!.status).toBe("sent")
    expect(app._state.getRow(row.id)!.externalId).toBe("1234.567")

    const card = app.state().outputs.find(o => o.rowId === row.id)
    expect(card!.surface).toBe("ops_log")
    expect(card!.status).toBe("sent")
  })

  test("schedule_send + reverse: scheduled → draft (real upstream cancel)", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "later",
    }, "draft")
    scriptedResponses.push({ status: 200, body: { ok: true, scheduled_message_id: "Q123", post_at: 999 } })
    await app._invokeAction({
      actionName: "schedule_send",
      rowId: row.id,
      input: { post_at: 999 },
      bridge: bridge(),
    })
    expect(app._state.getRow(row.id)!.status).toBe("scheduled")

    scriptedResponses.push({ status: 200, body: { ok: true } })
    const rev = await app._invokeReverse({ actionName: "schedule_send", rowId: row.id, bridge: bridge() })
    expect((rev as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("draft")
    expect(calls.at(-1)?.url).toContain("deleteScheduledMessage")
  })

  test("edit_message: sent → edited", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "old", external_id: "1234.567",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "1234.567" })

    scriptedResponses.push({ status: 200, body: { ok: true } })
    const r = await app._invokeAction({
      actionName: "edit_message", rowId: row.id, input: { text: "new" }, bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("edited")
    expect((app._state.getRow(row.id)!.data as any).text).toBe("new")
  })

  test("react: SIDE EFFECT, does NOT change message status", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "hi", external_id: "1234.567",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "1234.567" })
    app._state.upsertOutput({
      resourceName: "message", rowId: row.id, surface: "ops_log",
      status: "sent", summary: "hi", deepLink: null,
    })

    scriptedResponses.push({ status: 200, body: { ok: true } })
    const r = await app._invokeAction({
      actionName: "react", rowId: row.id, input: { emoji: "thumbsup" }, bridge: bridge(),
    })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("sent")
    const cards = app.state().outputs.filter(o => o.rowId === row.id)
    expect(cards).toHaveLength(1)
    expect(cards[0].status).toBe("sent")
  })

  test("custom toolName: react uses 'slack_react' not 'slack_react_message'", async () => {
    const { app } = setup()
    const names = app.derivedTools().map(t => t.name)
    expect(names).toContain("slack_react")
    expect(names).not.toContain("slack_react_message")
  })

  test("invalid state: trying to react on a draft is rejected", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "x",
    }, "draft")
    const r = await app._invokeAction({
      actionName: "react", rowId: row.id, input: { emoji: "ok" }, bridge: bridge(),
    })
    expect((r as any).fail.code).toBe("invalid_state")
  })

  test("delete_message: sent → deleted", async () => {
    const { app } = setup()
    const row = app._state.insertRow("message", {
      channel_id: "C123", text: "bye", external_id: "1234.567",
    }, "sent")
    app._state.updateRow(row.id, { externalId: "1234.567" })

    scriptedResponses.push({ status: 200, body: { ok: true } })
    const r = await app._invokeAction({ actionName: "delete_message", rowId: row.id, bridge: bridge() })
    expect((r as any).ok).toBe(true)
    expect(app._state.getRow(row.id)!.status).toBe("deleted")
  })
})
