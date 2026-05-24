import { AlertTriangle, Cable, Check, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OAuthWaitIndicator } from "@/components/integration/OAuthWaitIndicator";
import { Button } from "@/components/ui/button";
import {
  type IntegrationErrorCopy,
  resolveIntegrationError,
} from "@/lib/integrationErrorMessages";
import { toolkitDisplayName } from "@/lib/toolkitDisplay";
import {
  IntegrationConnectCancelled,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";

export function HistoryRestoreSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading conversation"
      className="absolute inset-0 z-30 overflow-hidden bg-card px-6 pb-5 pt-5"
    >
      <div className="flex h-full flex-col">
        <div className="animate-pulse space-y-6">
          <div className="flex items-start justify-between gap-6">
            <div className="h-5 w-28 rounded-md bg-muted" />
            <div className="h-11 w-52 rounded-2xl bg-muted" />
          </div>
          <div className="space-y-3 px-3">
            <div className="flex items-center gap-2">
              <div className="h-5 w-6 rounded-md bg-muted" />
              <div className="h-5 w-14 rounded-md bg-muted" />
            </div>
            <div className="h-5 w-full rounded-md bg-muted" />
            <div className="h-5 w-full rounded-md bg-muted" />
            <div className="h-5 w-[42%] rounded-md bg-muted" />
          </div>
        </div>

        <div className="mt-auto">
          <div className="rounded-2xl border border-border bg-muted p-4">
            <div className="animate-pulse space-y-3">
              <div className="h-6 w-full rounded-lg bg-muted" />
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="size-8 rounded-full bg-muted" />
                  <div className="size-8 rounded-full bg-muted" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="size-8 rounded-full bg-muted" />
                  <div className="size-8 rounded-full bg-muted" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ParsedIntegrationError {
  /** Resolved from the structured marker or legacy regex; "" when unknown. */
  slug: string;
  /** "connection_expired" | "rate_limited" | "tool_failed" | "unknown" etc. */
  code: string;
}

/**
 * Top-level error presentation for a TraceStep with status === "error".
 * Prefers IntegrationErrorBanner (typed actionable copy + inline reconnect)
 * when the error text identifies an integration; falls back to a generic
 * failure shell with a "Show technical details" disclosure otherwise.
 *
 * Suppresses the legacy collapsed details box in TraceStepEntry so the raw
 * JSON dump doesn't appear twice when expanded.
 */
export function TraceStepErrorPresentation({
  details,
}: {
  details: string[];
}) {
  const errorText = details.join(" ");
  const parsed = parseStructuredMarker(errorText) ?? matchLegacyPattern(errorText);
  if (parsed) {
    return <IntegrationErrorBannerBody errorText={errorText} parsed={parsed} />;
  }
  return <GenericToolFailureBanner details={details} />;
}

// Kept for backward compat — some non-status callers still render the
// pure banner. Returns null when the text isn't an integration error.
export function IntegrationErrorBanner({ details }: { details: string[] }) {
  const errorText = details.join(" ");
  const parsed = parseStructuredMarker(errorText) ?? matchLegacyPattern(errorText);
  if (!parsed) return null;
  return <IntegrationErrorBannerBody errorText={errorText} parsed={parsed} />;
}

export function hasIntegrationMarker(details: string[]): boolean {
  const errorText = details.join(" ");
  return Boolean(parseStructuredMarker(errorText) ?? matchLegacyPattern(errorText));
}

function GenericToolFailureBanner({ details }: { details: string[] }) {
  const summary = (details[0] ?? "Tool failed").trim();
  const rawDetails = details.slice(1).join("\n").trim();
  return (
    <div className="mt-1.5 rounded-lg border border-destructive/20 bg-destructive/5 px-2.5 py-1.5">
      <div className="flex items-start gap-2 text-xs">
        <AlertTriangle className="mt-0.5 size-3 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">Tool failed</div>
          {summary ? (
            <div className="mt-0.5 line-clamp-2 text-muted-foreground">
              {summary}
            </div>
          ) : null}
        </div>
      </div>
      {rawDetails ? (
        <details className="mt-1.5 ml-5 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none opacity-70 hover:opacity-100">
            Show technical details
          </summary>
          <div className="mt-1 max-h-40 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-[10px] leading-4 whitespace-pre-wrap break-words">
            {rawDetails}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function IntegrationErrorBannerBody({
  errorText,
  parsed,
}: {
  errorText: string;
  parsed: ParsedIntegrationError;
}) {
  const displayName = toolkitDisplayName(parsed.slug);
  const copy = resolveIntegrationError({
    provider: displayName,
    code: parsed.code === "unknown" ? undefined : parsed.code,
    error: errorText,
  });

  const { connectIntegrationProvider } = useWorkspaceDesktop();
  const [phase, setPhase] = useState<"idle" | "connecting" | "done" | "error">(
    "idle",
  );
  const [reconnectError, setReconnectError] = useState<IntegrationErrorCopy | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  if (copy.action === "silent") return null;

  const canReconnect = copy.action === "reconnect" && Boolean(parsed.slug);

  const startReconnect = async () => {
    if (!parsed.slug) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setReconnectError(null);
    setPhase("connecting");
    try {
      await connectIntegrationProvider({
        provider: parsed.slug,
        accountLabel: `${displayName} (Managed)`,
        signal: controller.signal,
      });
      setPhase("done");
    } catch (err) {
      if (err instanceof IntegrationConnectCancelled) {
        setPhase("idle");
        return;
      }
      const errorCopy = resolveIntegrationError({ provider: displayName, error: err });
      if (errorCopy.action === "silent") {
        setPhase("idle");
        return;
      }
      setReconnectError(errorCopy);
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  };

  const cancelReconnect = () => {
    abortRef.current?.abort();
  };

  if (phase === "done") {
    return (
      <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/8 px-2.5 py-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <Check className="size-3 shrink-0" />
        <span>
          {displayName} reconnected — send your next message to retry.
        </span>
      </div>
    );
  }

  if (phase === "connecting") {
    return (
      <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-border bg-card px-2.5 py-2 text-xs">
        <Cable className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <OAuthWaitIndicator
            compact
            displayName={displayName}
            onCancel={cancelReconnect}
          />
        </div>
      </div>
    );
  }

  if (phase === "error" && reconnectError) {
    return (
      <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/8 px-2.5 py-1.5 text-xs">
        <AlertTriangle className="size-3 shrink-0 text-destructive" />
        <span className="flex-1 text-foreground">
          <span className="font-medium">{reconnectError.headline}</span>
          {reconnectError.detail ? (
            <span className="ml-1 text-muted-foreground">
              {reconnectError.detail}
            </span>
          ) : null}
        </span>
        <Button
          className="h-6 px-2 text-xs"
          onClick={() => void startReconnect()}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RotateCw className="size-3" />
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/8 px-2.5 py-1.5 text-xs text-warning">
      <Cable className="mt-0.5 size-3 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{copy.headline}</div>
        {copy.detail ? (
          <div className="mt-0.5 text-warning/80">{copy.detail}</div>
        ) : null}
      </div>
      {canReconnect ? (
        <Button
          className="h-6 px-2 text-xs"
          onClick={() => void startReconnect()}
          size="sm"
          type="button"
          variant="ghost"
        >
          Reconnect
        </Button>
      ) : null}
    </div>
  );
}

// Format emitted by composio-mcp-host.ts: [composio_error:CODE:SLUG]
function parseStructuredMarker(text: string): ParsedIntegrationError | null {
  const match = /\[composio_error:([a-z_]+)(?::([a-z0-9_-]+))?\]/i.exec(text);
  if (!match) return null;
  const code = (match[1] ?? "").toLowerCase();
  const slug = (match[2] ?? "").toLowerCase();
  return { code, slug };
}

// Fallback regex for non-Composio integration failures (legacy backend errors,
// app crashes that name the provider, etc.).
function matchLegacyPattern(text: string): ParsedIntegrationError | null {
  const patterns: Array<{ pattern: RegExp; slug: string }> = [
    { pattern: /no\s+google\s+token/i, slug: "google" },
    { pattern: /no\s+gmail\s+token/i, slug: "gmail" },
    { pattern: /no\s+github\s+token/i, slug: "github" },
    { pattern: /no\s+reddit\s+token/i, slug: "reddit" },
    { pattern: /no\s+twitter\s+token/i, slug: "twitter" },
    { pattern: /no\s+linkedin\s+token/i, slug: "linkedin" },
    { pattern: /PLATFORM_INTEGRATION_TOKEN/i, slug: "" },
    { pattern: /integration.*not.*connected/i, slug: "" },
    { pattern: /integration.*not.*bound/i, slug: "" },
    { pattern: /connect\s+via\s+(settings|integrations)/i, slug: "" },
  ];
  for (const { pattern, slug } of patterns) {
    if (pattern.test(text)) {
      return { code: "connection_not_authorized", slug };
    }
  }
  return null;
}
