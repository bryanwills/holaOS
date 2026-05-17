// Public API surface for @holaboss/app-sdk v2 experiment.

export { createApp } from "./app.ts"
export type { CreateAppOptions } from "./app.ts"
export { createBridge } from "./bridge.ts"
export type { TransportFn } from "./bridge.ts"
export { SqliteStateBackend } from "./runtime/state-backend-sqlite.ts"
export type { SqliteStateBackendOpts } from "./runtime/state-backend-sqlite.ts"
export { z } from "zod"

export type {
  AppHandle,
  AppConfig,
  AppState,
  BridgeClient,
  BridgeError,
  BridgeErrorCode,
  DerivedTool,
  StateBackend,
  ProxyResult,
  ProviderRegistry,
  ResourceDef,
  ResourceHandle,
  StateTuple,
  ActionDef,
  ReversibleDef,
  Step,
  StepContext,
  StepResult,
  SyncDef,
  TurnContext,
  HttpMethod,
} from "./types.ts"
