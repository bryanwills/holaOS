// Executes a registered sync.
// SDK does NOT schedule — automations or tests call runSync().

import type { BridgeClient, ResourceHandle, SyncDef } from "../types.ts"
import type { RuntimeState } from "./state.ts"
import { createDbView } from "./db-view.ts"

interface RunSyncOpts {
  appId: string
  syncName: string
  syncDef: SyncDef<any, any, any>
  bridge: BridgeClient
  state: RuntimeState
}

export interface SyncRunResult {
  ok: boolean
  fetched: number
  upserted: number
  error?: { code: string; message: string }
}

export async function runSync(opts: RunSyncOpts): Promise<SyncRunResult> {
  const { appId, syncName, syncDef, bridge, state } = opts
  const startTime = Date.now()

  state.pushAudit("sync.start", { app: appId, sync: syncName })

  const db = createDbView(state)
  let rawList: unknown[]
  try {
    rawList = await syncDef.fetch({ bridge, db })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    state.pushAudit("sync.end", {
      app: appId, sync: syncName, outcome: "fail",
      total_ms: Date.now() - startTime, error: msg,
    })
    state.pushNotification({
      level: "warning",
      summary: `${appId} sync '${syncName}' failed: ${msg}`,
      agentHint: "Sync will retry on next automation tick.",
    })
    return { ok: false, fetched: 0, upserted: 0, error: { code: "fetch_failed", message: msg } }
  }

  const keyField = syncDef.upsert.key
  let upserted = 0
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const key = String(r[keyField] ?? "")
    if (!key) continue

    let normalized: Record<string, unknown> = {}
    try {
      normalized = syncDef.normalize(raw) as Record<string, unknown>
    } catch {
      // skip rows that don't normalize cleanly; sync as a whole still ok
      continue
    }

    // attachedRowId: if attachTo is provided, the normalized record's key
    // should match a row's id (or external_id). Try id match first.
    let attachedRowId = ""
    if (syncDef.attachTo) {
      const attachResource = syncDef.attachTo as ResourceHandle<any, any>
      const matched = state.rowsByResource(attachResource.name).find(
        rr => rr.id === key || rr.externalId === key,
      )
      attachedRowId = matched?.id ?? ""
    }

    state.upsertSyncRecord({
      syncName,
      attachedRowId,
      key,
      raw: r,
      normalized,
    })
    upserted++
  }

  state.pushAudit("sync.end", {
    app: appId, sync: syncName, outcome: "ok",
    fetched: rawList.length, upserted,
    total_ms: Date.now() - startTime,
  })

  return { ok: true, fetched: rawList.length, upserted }
}
