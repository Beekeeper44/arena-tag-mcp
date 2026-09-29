// All settings come from Vercel env vars. Nothing secret is hard-coded.

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // Gate for the MCP endpoint itself: connector URL is /api/mcp?key=<MCP_ACCESS_KEY>
  mcpAccessKey: () => req("MCP_ACCESS_KEY"),

  // Metabase (reads) — question 4131 "Warehouse Cards"
  metabaseHost: () => req("METABASE_HOST").replace(/\/+$/, ""),
  metabaseApiKey: () => req("METABASE_API_KEY"),
  metabaseCardId: () => num("METABASE_CARD_ID", 4131),

  // Admin (writes)
  adminApiUrl: () => (process.env.ADMIN_API_URL || "https://admin-api.arenaclub.com").replace(/\/+$/, ""),
  adminOrigin: () => process.env.ADMIN_ORIGIN || "https://admin.arenaclub.com",

  // SuperTokens — the server mints its own short-lived session for this user
  supertokensUri: () => req("SUPERTOKENS_CONNECTION_URI"),
  supertokensApiKey: () => req("SUPERTOKENS_API_KEY"),
  sessionUserId: () => req("ADMIN_SESSION_USER_ID"),
  sessionTenantId: () => process.env.ADMIN_SESSION_TENANT_ID || "public",
  // Optional JSON merged into the minted access-token payload (only if admin rejects plain sessions)
  sessionExtraPayload: (): Record<string, unknown> | undefined => {
    const raw = process.env.ADMIN_SESSION_EXTRA_PAYLOAD;
    if (!raw) return undefined;
    return JSON.parse(raw);
  },

  // Neon — run registry + audit log
  databaseUrl: () => req("DATABASE_URL"),

  // Safety
  dryRun: () => (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
  maxItemsPerRun: () => num("MAX_ITEMS_PER_RUN", 100),
  writeConcurrency: () => num("WRITE_CONCURRENCY", 5),
  runExpiryHours: () => num("RUN_EXPIRY_HOURS", 24),
  // Optional comma-separated allowlist. Empty = any tag matching /^[a-z0-9_]+$/
  tagAllowlist: (): string[] =>
    (process.env.TAG_ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
};

export function validateTag(tag: string): string | null {
  if (!/^[a-z0-9_]+$/.test(tag)) return "Tag must be lowercase letters, numbers and underscores only.";
  const allow = config.tagAllowlist();
  if (allow.length && !allow.includes(tag)) return `Tag "${tag}" is not on TAG_ALLOWLIST (${allow.join(", ")}).`;
  return null;
}
