import { Cable } from "lucide-react";

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

export function IntegrationErrorBanner({ details }: { details: string[] }) {
  const errorText = details.join(" ");
  const integrationError = isIntegrationError(errorText);
  if (!integrationError) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-warning/20 bg-warning/8 px-2.5 py-1.5 text-xs text-warning">
      <Cable className="size-3 shrink-0" />
      <span>{integrationError.action}</span>
    </div>
  );
}

function isIntegrationError(
  text: string,
): { provider: string; action: string } | null {
  // Structured marker emitted by the Composio MCP host runtime
  // (composio-mcp-host.ts). Format: [composio_error:CODE:TOOLKIT_SLUG]
  // Recognized first because it carries code + toolkit explicitly.
  const structured = /\[composio_error:([a-z_]+)(?::([a-z0-9_-]+))?\]/i.exec(text);
  if (structured) {
    const code = (structured[1] ?? "").toLowerCase();
    const slug = (structured[2] ?? "").toLowerCase();
    const provider = providerDisplayNameFromSlug(slug);
    return {
      provider,
      action: composioErrorAction(code, provider),
    };
  }

  const patterns: Array<{ pattern: RegExp; provider: string }> = [
    { pattern: /no\s+google\s+token/i, provider: "Google" },
    { pattern: /no\s+github\s+token/i, provider: "GitHub" },
    { pattern: /no\s+reddit\s+token/i, provider: "Reddit" },
    { pattern: /no\s+twitter\s+token/i, provider: "Twitter" },
    { pattern: /no\s+linkedin\s+token/i, provider: "LinkedIn" },
    { pattern: /PLATFORM_INTEGRATION_TOKEN/i, provider: "" },
    { pattern: /integration.*not.*connected/i, provider: "" },
    { pattern: /integration.*not.*bound/i, provider: "" },
    { pattern: /connect\s+via\s+(settings|integrations)/i, provider: "" },
  ];
  for (const { pattern, provider } of patterns) {
    if (pattern.test(text)) {
      const resolved = provider || "this provider";
      return {
        provider: resolved,
        action: `Connect ${resolved} in the Integrations tab`,
      };
    }
  }
  return null;
}

const TOOLKIT_DISPLAY_NAMES: Record<string, string> = {
  gmail: "Gmail",
  google: "Google",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  github: "GitHub",
  reddit: "Reddit",
  twitter: "Twitter",
  linkedin: "LinkedIn",
  slack: "Slack",
  notion: "Notion",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  dropbox: "Dropbox",
  figma: "Figma",
  asana: "Asana",
  jira: "Jira",
  intercom: "Intercom",
  zendesk: "Zendesk",
  stripe: "Stripe",
  airtable: "Airtable",
  calendly: "Calendly",
};

function providerDisplayNameFromSlug(slug: string): string {
  if (!slug) return "this provider";
  const known = TOOLKIT_DISPLAY_NAMES[slug];
  if (known) return known;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function composioErrorAction(code: string, provider: string): string {
  switch (code) {
    case "connection_expired":
    case "connection_not_authorized":
      return `Reconnect ${provider} in the Integrations tab`;
    case "rate_limited":
      return `${provider} is busy — try again in a minute`;
    case "not_configured":
      return `${provider} isn't set up yet — open the Integrations tab to connect`;
    case "not_found":
      return `${provider} couldn't find the requested item`;
    case "tool_failed":
      return `${provider} returned an error — see details below`;
    default:
      return `Connect ${provider} in the Integrations tab`;
  }
}
