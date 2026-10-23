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
  watchCardId: () => num("WATCH_METABASE_CARD_ID", 45046),
  // Admin path that saves a watch's tag, e.g. /items/{id}. Live watch writes stay off until this is set.
  watchTagPath: () => process.env.WATCH_TAG_PATH || "",
  // Field on PATCH /cards/{id} that holds the card's overall grade (Arena Club tile "New overall").
  overallField: () => process.env.ARENA_OVERALL_FIELD || "overall",
  // Admin field for each grade on PATCH /cards/{id} (Arena Club grade editor). ARENA_FIELD_CENTERING etc. override.
  // Rebuild slab + label images after a grade change (like the admin review page). Set false to skip.
  regenerateImages: () => (process.env.ARENA_REGENERATE_IMAGES ?? "true").toLowerCase() !== "false",
  // Save the new label / slab links onto the card after rebuilding (set false if admin already keeps them on its own).
  saveImageLinks: () => (process.env.ARENA_SAVE_IMAGE_LINKS ?? "true").toLowerCase() !== "false",
  gradeField: (g: "overall" | "centering" | "corners" | "edges" | "surface") =>
    g === "overall" ? process.env.ARENA_OVERALL_FIELD || "overall" : process.env[`ARENA_FIELD_${g.toUpperCase()}`] || g,

  // Admin (writes)
  adminApiUrl: () => (process.env.ADMIN_API_URL || "https://admin-api.arenaclub.com").replace(/\/+$/, ""),
  adminOrigin: () => process.env.ADMIN_ORIGIN || "https://admin.arenaclub.com",

  // SuperTokens — the server mints its own short-lived session for this user
  supertokensUri: () => req("SUPERTOKENS_CONNECTION_URI"),
  supertokensApiKey: () => req("SUPERTOKENS_API_KEY"),
  sessionUserId: () => req("ADMIN_SESSION_USER_ID"),
  // Tell admin that MFA is complete on minted sessions (needed for people who have MFA on in admin).
  mfaDone: () => (process.env.ADMIN_SESSION_MFA_DONE ?? "").toLowerCase() === "true",
  // People not linked to their own admin login write through ADMIN_SESSION_USER_ID. Set false to require linking.
  sharedSessionFallback: () => (process.env.SHARED_SESSION_FALLBACK ?? "true").toLowerCase() !== "false",
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
