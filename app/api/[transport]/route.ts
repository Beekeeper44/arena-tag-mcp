import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { config } from "@/lib/config";
import { queryCards, summarize } from "@/lib/metabase";
import { checkAuth } from "@/lib/admin";
import { previewRun, stageRun, goLive, undoRun, verifyRun, getRun, listRuns } from "@/lib/runs";

export const maxDuration = 300;

const filterShape = {
  sport: z.string().optional(),
  set_name: z.union([z.string(), z.array(z.string())]).optional().describe("Contains-match, e.g. 'Prizm' also matches 'Prizm Draft Picks'. A list matches any of them."),
  player_name: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Player or Pokémon name. For several, pass a list, e.g. [\"Pikachu\",\"Charizard\"]; a card matches ANY of them. Use the last name for players."),
  parallel_name: z.union([z.string(), z.array(z.string())]).optional().describe("A list matches any of them"),
  grading_company: z.string().optional().describe("e.g. psa, bgs, sgc"),
  grade: z.union([z.string(), z.array(z.string())]).optional().describe("Matches 'company grade', e.g. 'psa 10'. A list matches any of them, e.g. [\"psa 9\",\"psa 10\"]"),
  min_estimated_value: z.number().optional().describe("Dollars"),
  max_estimated_value: z.number().optional().describe("Dollars"),
  tag: z.string().optional().describe("Contains-match on the card's CURRENT tag"),
  cert_number: z.string().optional(),
  ac_number: z.string().optional(),
  min_ev_age_days: z.number().optional(),
  max_ev_age_days: z.number().optional(),
  min_times_sold_back: z.number().optional(),
};
const filters = z.object(filterShape).describe("Filters passed to Metabase question 4131 (warehouse cards)");
const postFilters = z
  .object({
    only_untagged: z.boolean().optional(),
    current_tag_exact: z.string().optional(),
  })
  .optional();

const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });
const safe =
  <A,>(fn: (a: A) => Promise<unknown>) =>
  async (a: A) => {
    try {
      return text(await fn(a));
    } catch (e) {
      return { ...text({ error: e instanceof Error ? e.message : String(e) }), isError: true };
    }
  };

const mcp = createMcpHandler(
  (server) => {
    server.tool(
      "find_cards",
      "Read-only search of warehouse cards (Metabase question 4131). Returns count, breakdowns by set/player/parallel/grade/current tag, total estimated value and a sample. Use to explore before drafting a tag run.",
      { filters, post_filters: postFilters },
      safe(async ({ filters, post_filters }) => summarize(await queryCards(filters, post_filters ?? {})))
    );

    server.tool(
      "preview_tag_run",
      "Step 1 of 3. When the user names two or more players/Pokémon/sets, pass them as a list, never pick one. If no_cards_found_for is not empty, tell the user which names matched nothing. Drafts a tag run and returns the readback: how many cards would change, what tags would be overwritten, breakdowns, total EV and a sample. Writes nothing to admin. Always show the readback to the user and ask them to confirm the count before staging. A card holds ONE tag; setting a tag replaces its current one. mode=skip_tagged leaves already-tagged cards alone.",
      {
        filters,
        post_filters: postFilters,
        action: z.enum(["set", "clear"]),
        tag: z.string().optional().describe("Required for action=set. Lowercase, numbers, underscores."),
        mode: z.enum(["overwrite", "skip_tagged"]).optional(),
        requested_by: z.string().describe("Name of the person asking"),
      },
      safe((a) => previewRun(a))
    );

    server.tool(
      "stage_tag_run",
      "Step 2 of 3 (approval #1). Only call after the user explicitly approves the preview and states the count. Re-checks matches, freezes the exact card list and each card's previous tag (for undo). Refuses if the count drifted or exceeds the cap. Writes nothing to admin.",
      {
        run_id: z.string(),
        confirm_count: z.number().int().describe("The card count the user approved; must equal the preview count"),
        staged_by: z.string(),
      },
      safe((a) => stageRun(a))
    );

    server.tool(
      "go_live_tag_run",
      "Step 3 of 3 (approval #2). WRITES TO ADMIN. Only call after the user explicitly says to go live on this run_id. Tags exactly the frozen list, once. If DRY_RUN is on, it records what would be written instead.",
      { run_id: z.string(), confirm: z.boolean(), approved_by: z.string() },
      safe((a) => goLive(a))
    );

    server.tool(
      "undo_tag_run",
      "WRITES TO ADMIN. Restores every card in a completed run to its previous tag. Only call after the user explicitly asks to undo that run_id.",
      { run_id: z.string(), confirm: z.boolean(), requested_by: z.string() },
      safe((a) => undoRun(a))
    );

    server.tool(
      "verify_tag_run",
      "Read-only. Checks the warehouse (Snowflake via Metabase) for the tag on every card a run wrote. Cards not yet visible may still be syncing.",
      { run_id: z.string() },
      safe(({ run_id }) => verifyRun(run_id))
    );

    server.tool("get_tag_run", "Read-only. Full record for one run: who asked, staged, approved; counts by item status.", { run_id: z.string() }, safe(({ run_id }) => getRun(run_id)));

    server.tool("list_tag_runs", "Read-only. Recent runs, newest first.", { limit: z.number().int().optional() }, safe(({ limit }) => listRuns(limit ?? 20)));

    server.tool(
      "check_admin_auth",
      "Read-only. Mints a session and GETs one card from admin to confirm the server can authenticate. Use during setup.",
      { item_id: z.string().describe("An ITEM_ID from question 4131") },
      safe(({ item_id }) => checkAuth(item_id))
    );

    server.tool(
      "get_settings",
      "Read-only. Shows DRY_RUN, the per-run cap, concurrency, expiry and tag allowlist.",
      {},
      safe(async () => ({
        dry_run: config.dryRun(),
        max_items_per_run: config.maxItemsPerRun(),
        write_concurrency: config.writeConcurrency(),
        run_expiry_hours: config.runExpiryHours(),
        tag_allowlist: config.tagAllowlist(),
        metabase_card_id: config.metabaseCardId(),
      }))
    );
  },
  { serverInfo: { name: "arena-tag-mcp", version: "0.1.0" } },
  { basePath: "/api", maxDuration: 300, disableSse: true }
);

// Endpoint gate: https://<project>.vercel.app/api/mcp?key=<MCP_ACCESS_KEY>
async function handler(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!key || key !== config.mcpAccessKey()) {
    return new Response("Unauthorized", { status: 401 });
  }
  return mcp(req);
}

export { handler as GET, handler as POST, handler as DELETE };
