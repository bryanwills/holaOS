import { AlertTriangle, Check, LoaderCircle, Plug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  COMPOSIO_POLL_TIMEOUT_MS,
  IntegrationConnectCancelled,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";
import {
  type IntegrationErrorCopy,
  resolveIntegrationError,
} from "@/lib/integrationErrorMessages";

export interface AssistantTurnProposedIntegration {
  toolkit_slug: string;
  tier?: "hero" | "supported";
  category?: string;
  reason?: string | null;
}

export function AssistantTurnIntegrationProposals({
  proposals,
  workspaceId,
  onAfterConnect,
}: {
  proposals: AssistantTurnProposedIntegration[];
  workspaceId: string | null;
  onAfterConnect?: (toolkitSlug: string) => void;
}) {
  if (proposals.length === 0) return null;
  const seen = new Set<string>();
  const unique = proposals.filter((p) => {
    const key = p.toolkit_slug.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div className="mt-3 flex flex-col gap-2">
      {unique.map((proposal) => (
        <IntegrationProposalCard
          key={proposal.toolkit_slug}
          onAfterConnect={onAfterConnect}
          proposal={proposal}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  );
}

type ProposalPhase = "idle" | "connecting" | "done" | "error";

function IntegrationProposalCard({
  proposal,
  workspaceId,
  onAfterConnect,
}: {
  proposal: AssistantTurnProposedIntegration;
  workspaceId: string | null;
  onAfterConnect?: (toolkitSlug: string) => void;
}) {
  const { composioToolkitsByProvider, connectIntegrationProvider } =
    useWorkspaceDesktop();
  const slug = proposal.toolkit_slug.trim().toLowerCase();
  const toolkit = composioToolkitsByProvider[slug];
  const displayName = toolkit?.name ?? proposal.toolkit_slug;
  const logo = toolkit?.logo ?? `https://logos.composio.dev/api/${slug}`;

  const [phase, setPhase] = useState<ProposalPhase>("idle");
  const [errorCopy, setErrorCopy] = useState<IntegrationErrorCopy | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The propose_connect card hangs around in chat history. If the user
  // already authorized this toolkit (via the IntegrationConnectCard binding
  // flow, the integrations pane, or any earlier propose_connect), the
  // "Bound to {appId}" card above us is now the truthful indicator —
  // surfacing a duplicate "Connect {provider}" here just confuses the user.
  const [alreadyConnected, setAlreadyConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { connections } =
          await window.electronAPI.workspace.listIntegrationConnections();
        if (cancelled) return;
        const active = connections.some(
          (c) =>
            c.provider_id.trim().toLowerCase() === slug &&
            c.status === "active",
        );
        setAlreadyConnected(active);
      } catch {
        if (!cancelled) setAlreadyConnected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const startConnect = async () => {
    if (!workspaceId) {
      setErrorCopy(
        resolveIntegrationError({ provider: displayName, code: "no_workspace" }),
      );
      setRawError(null);
      setPhase("error");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("connecting");
    setErrorCopy(null);
    setRawError(null);
    try {
      await connectIntegrationProvider({
        provider: slug,
        accountLabel: `${displayName} (Managed)`,
        signal: controller.signal,
      });
      setPhase("done");
      onAfterConnect?.(slug);
    } catch (err) {
      if (err instanceof IntegrationConnectCancelled) {
        // User-driven cancel — silent return to idle.
        setPhase("idle");
        setErrorCopy(null);
        setRawError(null);
        return;
      }
      const copy = resolveIntegrationError({ provider: displayName, error: err });
      if (copy.action === "silent") {
        setPhase("idle");
        return;
      }
      setErrorCopy(copy);
      setRawError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

  // Suppress entirely when the toolkit is already connected via another
  // path. Wait for the readiness check before rendering anything, otherwise
  // the Connect button flashes before disappearing.
  if (alreadyConnected === null) return null;
  if (alreadyConnected && phase !== "done") return null;

  if (phase === "done") {
    return (
      <div className="flex max-w-[420px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-600">
          <Check className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {displayName} connected
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Send your next message — the agent can now use {displayName}.
          </div>
        </div>
      </div>
    );
  }

  if (phase === "connecting") {
    return (
      <ConnectingProposalCard
        displayName={displayName}
        logo={logo}
        onCancel={cancel}
      />
    );
  }

  if (phase === "error" && errorCopy) {
    return (
      <ErrorProposalCard
        copy={errorCopy}
        displayName={displayName}
        logo={logo}
        onAction={startConnect}
        rawError={rawError}
      />
    );
  }

  return (
    <div className="flex max-w-[420px] flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm">
      <div className="flex items-start gap-3">
        <ProviderLogo displayName={displayName} logo={logo} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            Connect {displayName}
          </div>
          {proposal.reason ? (
            <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {proposal.reason}
            </div>
          ) : (
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Authorize once. The agent will use it in this workspace.
            </div>
          )}
        </div>
        <Button
          className="h-7 px-3 text-xs"
          disabled={!workspaceId}
          onClick={() => void startConnect()}
          size="sm"
          type="button"
          variant="default"
        >
          Connect
        </Button>
      </div>
    </div>
  );
}

function ConnectingProposalCard({
  displayName,
  logo,
  onCancel,
}: {
  displayName: string;
  logo: string | null;
  onCancel: () => void;
}) {
  const elapsedMs = useElapsedMs();
  const focusedAfterStart = useReturnedToAppAfterStart();
  const remainingMs = Math.max(0, COMPOSIO_POLL_TIMEOUT_MS - elapsedMs);
  const fraction = Math.min(1, elapsedMs / COMPOSIO_POLL_TIMEOUT_MS);
  const showFirstHelper = elapsedMs > 30_000;
  const showStrongerHelper = elapsedMs > 90_000;
  // After the user has refocused the desktop window, if no connection has
  // arrived within ~5s of refocus we suspect they closed OAuth without
  // completing — bring the helper up immediately.
  const refocusHint = focusedAfterStart && elapsedMs > 5_000;

  return (
    <div
      aria-live="polite"
      className="flex max-w-[420px] flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm"
    >
      <div className="flex items-start gap-3">
        <ProviderLogo displayName={displayName} logo={logo} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
            <span className="truncate text-sm font-medium text-foreground">
              Waiting for {displayName} authorization…
            </span>
          </div>
          <div className="mt-1 text-xs tabular-nums text-muted-foreground">
            {formatRemaining(remainingMs)} left
          </div>
        </div>
        <Button
          className="h-7 px-3 text-xs"
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      <ProgressBar fraction={fraction} />
      {(showFirstHelper || refocusHint) && !showStrongerHelper ? (
        <div className="text-xs text-muted-foreground">
          {refocusHint
            ? `Did the ${displayName} window close before you finished? Cancel and try again.`
            : "If the authorization window didn't open, reopen it from your browser tabs."}
        </div>
      ) : null}
      {showStrongerHelper ? (
        <div className="text-xs text-amber-600 dark:text-amber-400">
          Still waiting. Cancel and reconnect if the {displayName} window isn't
          responding.
        </div>
      ) : null}
    </div>
  );
}

function ErrorProposalCard({
  copy,
  displayName,
  logo,
  onAction,
  rawError,
}: {
  copy: IntegrationErrorCopy;
  displayName: string;
  logo: string | null;
  onAction: () => void;
  rawError: string | null;
}) {
  const actionLabel =
    copy.action === "reconnect"
      ? "Reconnect"
      : copy.action === "reopen"
        ? "Reopen"
        : copy.action === "contact"
          ? "Get help"
          : "Try again";
  return (
    <div className="flex max-w-[420px] flex-col gap-2 rounded-xl border border-destructive/20 bg-card px-3 py-2.5 text-sm">
      <div className="flex items-start gap-3">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-destructive/10 text-destructive">
          <AlertTriangle className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {copy.headline}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {copy.detail}
          </div>
        </div>
        <Button
          className="h-7 px-3 text-xs"
          onClick={onAction}
          size="sm"
          type="button"
          variant="default"
        >
          {actionLabel}
        </Button>
      </div>
      {rawError ? (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none opacity-70 hover:opacity-100">
            Show technical details
          </summary>
          <div className="mt-1 max-h-32 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-[10px] leading-4 whitespace-pre-wrap break-words">
            {rawError}
          </div>
        </details>
      ) : null}
      <ProviderLogoShadow displayName={displayName} logo={logo} />
    </div>
  );
}

function ProviderLogo({
  displayName,
  logo,
}: {
  displayName: string;
  logo: string | null;
}) {
  return (
    <div className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background">
      {logo ? (
        <img
          alt={displayName}
          className="size-full object-contain p-0.5"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
          referrerPolicy="no-referrer"
          src={logo}
        />
      ) : (
        <Plug className="size-3.5 text-muted-foreground" />
      )}
    </div>
  );
}

// Renders the provider logo discreetly inside the error card footer so the
// user keeps visual context about which provider failed.
function ProviderLogoShadow({
  displayName,
  logo,
}: {
  displayName: string;
  logo: string | null;
}) {
  if (!logo) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <img
        alt=""
        className="size-3 object-contain opacity-70"
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
        referrerPolicy="no-referrer"
        src={logo}
      />
      <span>{displayName}</span>
    </div>
  );
}

function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <div
      aria-hidden="true"
      className="h-0.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full bg-foreground/30 transition-[width] duration-300 ease-out"
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
    </div>
  );
}

function formatRemaining(remainingMs: number): string {
  const totalSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

function useElapsedMs(): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  return elapsed;
}

function useReturnedToAppAfterStart(): boolean {
  const [returned, setReturned] = useState(false);
  useEffect(() => {
    const onFocus = () => setReturned(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return returned;
}
