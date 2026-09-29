// JSON API for the Tag Bot screen. Everything except login needs the signed-in cookie.
import { config } from "@/lib/config";
import { type CardFilters, type PostFilters } from "@/lib/metabase";
import { runSelection, undoRun, listRuns } from "@/lib/runs";
import { checkPassword, sessionCookie, clearCookie, currentUser, freshSearch, listPrompts, addPrompt, renamePrompt, deletePrompt } from "@/lib/ui";

export const maxDuration = 300;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const fail = (e: unknown, status = 400) => json({ error: e instanceof Error ? e.message : String(e) }, status);

type Ctx = { params: Promise<{ action: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { action } = await ctx.params;
  const user = currentUser(req);
  if (!user) return json({ error: "signed_out" }, 401);
  try {
    switch (action) {
      case "me":
        return json({ user, dry_run: config.dryRun(), max_items_per_run: config.maxItemsPerRun() });
      case "runs":
        return json(await listRuns(15));
      case "prompts":
        return json(await listPrompts());
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    return fail(e, 500);
  }
}

export async function POST(req: Request, ctx: Ctx) {
  const { action } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }

  if (action === "login") {
    try {
      const name = String(body.name ?? "").trim();
      if (!name) return json({ error: "Enter your name." }, 400);
      if (!checkPassword(String(body.password ?? ""))) return json({ error: "Wrong password." }, 401);
      return json({ user: name }, 200, { "Set-Cookie": sessionCookie(name) });
    } catch (e) {
      return fail(e, 500);
    }
  }
  if (action === "logout") return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });

  const user = currentUser(req);
  if (!user) return json({ error: "signed_out" }, 401);

  try {
    switch (action) {
      case "find": {
        // Every prompt pulls question 4131 fresh: names, sets, parallels and cards all come from this pull.
        const r = await freshSearch(String(body.text ?? ""));
        const LIMIT = 3000;
        return json({
          parsed: r.parsed,
          has_filter: r.has_filter,
          warehouse_cards: r.warehouse_cards,
          ms: r.ms,
          total: r.rows.length,
          missing: r.missing,
          cards: r.rows.slice(0, LIMIT).map((r) => ({
            item_id: r.item_id, ac: r.ac_number ?? "", cert: r.cert_number ?? "", sport: (r.sport ?? "").toLowerCase(),
            set_name: r.set_name ?? "", player_name: r.player_name ?? "(no player)", parallel_name: r.parallel_name,
            grading_company: (r.grading_company ?? "").toLowerCase(), grade: (r.grade ?? "").toLowerCase(),
            ev: r.estimated_value ?? 0, tag: r.tag, img: r.front_slab_picture_url, card_url: r.card_url,
            insert: r.insert, parallel_total: r.parallel_total, status: r.item_status,
            ev_date: r.ev_date, ev_age_days: r.ev_age_days, order_number: r.order_number,
            times_sold_back: r.times_sold_back, bin: r.storage_bin_id, slot: r.storage_bin_slot,
            purchase_cost: r.purchase_cost, purchase_location: r.purchase_location, po_number: r.po_number,
          })),
        });
      }
      case "apply":
        return json(
          await runSelection({
            filters: (body.filters ?? {}) as CardFilters,
            post_filters: (body.post_filters ?? {}) as PostFilters,
            action: body.action === "clear" ? "clear" : "set",
            tag: (body.tag as string) ?? null,
            mode: body.mode === "skip_tagged" ? "skip_tagged" : "overwrite",
            item_ids: Array.isArray(body.item_ids) ? (body.item_ids as string[]) : [],
            dry_run: body.dry_run === true,
            user,
          })
        );
      case "undo":
        return json(await undoRun({ run_id: String(body.run_id), confirm: true, requested_by: user }));
      case "prompts":
        return json(await addPrompt(String(body.text ?? ""), user, body.name as string | undefined));
      case "prompts-rename":
        await renamePrompt(String(body.id), String(body.name ?? ""));
        return json({ ok: true });
      case "prompts-delete":
        await deletePrompt(String(body.id));
        return json({ ok: true });
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    return fail(e);
  }
}
