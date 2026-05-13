export interface IntegrationCatalogProviderRecord {
  provider_id: string;
  display_name: string;
  description: string;
  auth_modes: string[];
  supports_oss: boolean;
  supports_managed: boolean;
  default_scopes: string[];
  docs_url: string | null;
}

export const INTEGRATION_CATALOG_PROVIDERS: IntegrationCatalogProviderRecord[] = [
  {
    provider_id: "gmail",
    display_name: "Gmail",
    description: "Read, draft, and send emails through Gmail.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["gmail.send", "gmail.readonly"],
    docs_url: null
  },
  {
    provider_id: "googlesheets",
    display_name: "Google Sheets",
    description: "Read and manage spreadsheet data through Google Sheets.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["spreadsheets"],
    docs_url: null
  },
  {
    provider_id: "google",
    display_name: "Google",
    description: "Google account (legacy; prefer gmail or googlesheets).",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: [],
    docs_url: null
  },
  {
    provider_id: "github",
    display_name: "GitHub",
    description: "Triage PRs, issues, and repository workflows.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["repo", "read:org"],
    docs_url: null
  },
  {
    provider_id: "reddit",
    display_name: "Reddit",
    description: "Read and manage Reddit content and moderation workflows.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["read", "submit"],
    docs_url: null
  },
  {
    provider_id: "twitter",
    display_name: "Twitter / X",
    description: "Read and publish social updates on X.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["tweet.read", "tweet.write"],
    docs_url: null
  },
  {
    provider_id: "linkedin",
    display_name: "LinkedIn",
    description: "Manage LinkedIn content and workflows.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["r_liteprofile", "w_member_social"],
    docs_url: null
  }
];

const PROVIDER_ALIASES: Record<string, string> = {
  x: "twitter",
};

export function normalizeIntegrationProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

export function integrationCatalogProviderIds(): string[] {
  return INTEGRATION_CATALOG_PROVIDERS.map((provider) => provider.provider_id);
}

export function resolveIntegrationProviderAlias(providerId: string): string | null {
  const normalized = normalizeIntegrationProviderId(providerId);
  if (!normalized) {
    return null;
  }
  const providerIds = new Set(integrationCatalogProviderIds());
  if (providerIds.has(normalized)) {
    return normalized;
  }
  const alias = PROVIDER_ALIASES[normalized];
  return alias && providerIds.has(alias) ? alias : null;
}

export function validateCanonicalIntegrationProviderId(providerId: string): string {
  const normalized = normalizeIntegrationProviderId(providerId);
  const providerIds = integrationCatalogProviderIds();
  if (providerIds.includes(normalized)) {
    return normalized;
  }
  const alias = PROVIDER_ALIASES[normalized];
  const validList = providerIds.join(", ");
  if (alias && providerIds.includes(alias)) {
    throw new Error(
      `unknown integration provider '${providerId}'. Use canonical provider_id '${alias}' from the integration catalog. Valid provider_ids: ${validList}`,
    );
  }
  throw new Error(
    `unknown integration provider '${providerId}'. Call workspace_integrations_list_catalog and use one of its canonical provider_id values. Valid provider_ids: ${validList}`,
  );
}
