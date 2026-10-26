// JSON API for the Tag Bot screen. Everything except login needs the signed-in cookie.
import { config } from "@/lib/config";
import { searchArchived } from "@/lib/archived";
import { runArchivedStatus, undoArchivedStatus } from "@/lib/archived-status";
import { type CardFilters, type PostFilters } from "@/lib/metabase";
import { runSelection, runWatchSelection, runArenaSelection, runArchivedSelection, runOverallUpdate, runGradeUpdate, undoRun, listRuns } from "@/lib/runs";
import { searchArena } from "@/lib/arena";
import { openAdminSession, liveCards } from "@/lib/admin";
import { listPrompts, addPrompt, renamePrompt, deletePrompt } from "@/lib/ui";
import {
  can, type Role, type User, currentUser, sessionCookie, clearCookie, needsSetup, login, setupFirstAdmin, inviteInfo, acceptInvite,
  changePassword, adminLoginFor, listUsers, addUser, updateUser, resetInvite, relinkAdmin, testAdmin,
} from "@/lib/users";
import { smartSearch } from "@/lib/search";
import { searchWatches, watchToTile } from "@/lib/watches";

export const maxDuration = 300;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const fail = (e: unknown, status = 400) => json({ error: e instanceof Error ? e.message : String(e) }, status);

type Ctx = { params: Promise<{ action: string }> };
const forbid = (u: User, need: Role) =>
  can(u, need) ? null : json({ error: "Only TAG-BOT admins can do that." }, 403);
const origin = (req: Request) => new URL(req.url).origin;

export async function GET(req: Request, ctx: Ctx) {
  const { action } = await ctx.params;
  try {
    if (action === "config") return json({ needs_setup: await needsSetup() });
    const u = await currentUser(req);
    if (!u) return json({ error: "signed_out" }, 401);
    switch (action) {
      case "me":
        return json({
          id: u.id, user: u.name, email: u.email, role: u.role, is_admin: can(u, "admin"), can_write: true,
          linked: !!u.admin_user_id, dry_run: config.dryRun(), max_items_per_run: config.maxItemsPerRun(), max_archive_per_run: config.maxArchivePerRun(),
        });
      case "users":
        return forbid(u, "admin") ?? json(await listUsers());
      case "img": {
        // Same-origin copy of a watch photo so the screen can cut out its white background (signed-in only).
        const src = new URL(req.url).searchParams.get("u") || "";
        if (!/^https:\/\//i.test(src)) return json({ error: "bad url" }, 400);
        const r = await fetch(src, { redirect: "follow" });
        const type = r.headers.get("content-type") || "";
        if (!r.ok || !type.startsWith("image/")) return json({ error: `image ${r.status}` }, 502);
        const buf = await r.arrayBuffer();
        if (buf.byteLength > 12 * 1024 * 1024) return json({ error: "image too large" }, 413);
        return new Response(buf, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
      }
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

  const str = (k: string) => String(body[k] ?? "").trim();
  if (action === "logout") return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  try {
    if (action === "login") {
      const u = await login(str("email"), String(body.password ?? ""));
      return json({ user: u.name }, 200, { "Set-Cookie": sessionCookie(u.id) });
    }
    if (action === "setup") {
      const id = await setupFirstAdmin({ name: str("name"), email: str("email"), password: String(body.password ?? ""), code: str("code") });
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(id) });
    }
    if (action === "invite-info") return json(await inviteInfo(str("token")));
    if (action === "invite-accept") {
      const u = await acceptInvite(str("token"), String(body.password ?? ""));
      return json({ user: u.name }, 200, { "Set-Cookie": sessionCookie(u.id) });
    }
  } catch (e) {
    return fail(e);
  }

  const user = await currentUser(req);
  if (!user) return json({ error: "signed_out" }, 401);
  const u = user;

  try {
    switch (action) {
      case "find": {
        // Archived → Cards / Watches pills: same prompts and Metabase as the Cards / Watches tiles
        if (body.kind === "archived" && body.view === "arch_cards") body.kind = "cards";
        if (body.kind === "archived" && body.view === "arch_watches") body.kind = "watches";
        if (body.kind === "arena") {
          const a = await searchArena(String(body.text ?? ""));
          return json({ parsed: a.parsed, has_filter: a.has_filter, queries: [], ms: a.ms, total: a.rows.length, missing: a.missing, cards: a.rows, orders: a.orders,
            card_id: (a as any).card_id, check_card_id: (a as any).check_card_id,
            check_connected: a.check_connected,
            notice: a.no_ids ? "The Arena Club question has no item id column, so these cards can be searched but not tagged yet." : !a.check_connected ? "Overall check isn't connected yet: set ARENA_CHECK_CARD_ID to the Overall Check question to color cards PASS / FAIL." : undefined });
        }
        if (body.kind === "watches") {
          const w = await searchWatches(String(body.text ?? ""));
          return json({ parsed: w.parsed, has_filter: w.has_filter, queries: [], ms: w.ms, total: w.rows.length, missing: w.missing, inventory: w.inventory, cards: w.rows.map(watchToTile), notice: w.notice, searched: w.searched });
        }
        // Every prompt queries question 4131 fresh, using its own filters (only matching cards come back).
        if ((body.kind === "archived" || body.kind === "pl")) {
          const a = await searchArchived(body.view, String(body.text ?? ""));
          return json({ parsed: a.parsed, has_filter: a.has_filter, queries: [], ms: a.ms, total: a.rows.length, missing: a.missing.map((o) => ({ key: "order", value: o })),
            card_id: a.card_id, view: a.view, view_label: a.view_label, words: a.words,
            cards: a.rows.map(({ search, ...c }) => c) });
        }
        const r = await smartSearch(String(body.text ?? ""));
        return json({
          parsed: r.parsed,
          has_filter: r.has_filter,
          queries: r.queries,
          ms: r.ms,
          total: r.rows.length,
          missing: r.missing,
          cards: r.rows.map((r) => ({
            item_id: r.item_id, ac: r.ac_number ?? "", cert: r.cert_number ?? "", sport: (r.sport ?? "").toLowerCase(),
            set_name: r.set_name ?? "", player_name: r.player_name ?? "(no player)", parallel_name: r.parallel_name,
            grading_company: (r.grading_company ?? "").toLowerCase(), grade: (r.grade ?? "").toLowerCase(),
            ev: r.estimated_value ?? 0, tag: r.tag, img: r.front_slab_picture_url, card_url: r.card_url,
            insert: r.insert, parallel_total: r.parallel_total, status: r.item_status,
            ev_date: r.ev_date, ev_age_days: r.ev_age_days, order_number: r.order_number,
            times_sold_back: r.times_sold_back, bin: r.storage_bin_id, slot: r.storage_bin_slot,
            purchase_cost: r.purchase_cost, purchase_location: r.purchase_location, po_number: r.po_number, set_number: r.set_number,
          })),
        });
      }
      case "apply":
        if (body.kind === "archived" && body.view === "arch_cards") body.kind = "cards";
        if (body.kind === "archived" && body.view === "arch_watches") body.kind = "watches";
        if (body.kind === "arena")
          return json(await runArenaSelection({
            text: str("text"), action: body.action === "clear" ? "clear" : "set", tag: (body.tag as string) ?? null,
            mode: body.mode === "skip_tagged" ? "skip_tagged" : "overwrite", item_ids: Array.isArray(body.item_ids) ? (body.item_ids as string[]) : [],
            dry_run: body.dry_run === true, user: u.name, as_admin_user_id: adminLoginFor(u),
          }));
        if (body.kind === "watches")
          return json(
            await runWatchSelection({
              text: str("text"),
              action: body.action === "clear" ? "clear" : "set",
              tag: (body.tag as string) ?? null,
              mode: body.mode === "skip_tagged" ? "skip_tagged" : "overwrite",
              item_ids: Array.isArray(body.item_ids) ? (body.item_ids as string[]) : [],
              dry_run: body.dry_run === true,
              user: u.name,
              as_admin_user_id: adminLoginFor(u),
            })
          );
        if ((body.kind === "archived" || body.kind === "pl"))
          return json(await runArchivedSelection({
            view: body.view, text: str("text"), action: body.action === "clear" ? "clear" : "set", tag: (body.tag as string) ?? null,
            mode: body.mode === "skip_tagged" ? "skip_tagged" : "overwrite", item_ids: Array.isArray(body.item_ids) ? (body.item_ids as string[]) : [],
            dry_run: body.dry_run === true, user: u.name, as_admin_user_id: adminLoginFor(u),
          }));
        return json(await runSelection({
            filters: (body.filters ?? {}) as CardFilters,
            post_filters: (body.post_filters ?? {}) as PostFilters,
            action: body.action === "clear" ? "clear" : "set",
            tag: (body.tag as string) ?? null,
            mode: body.mode === "skip_tagged" ? "skip_tagged" : "overwrite",
            item_ids: Array.isArray(body.item_ids) ? (body.item_ids as string[]) : [],
            queries: Array.isArray(body.queries) ? (body.queries as CardFilters[]) : undefined,
            dry_run: body.dry_run === true,
            user: u.name,
            as_admin_user_id: adminLoginFor(u),
          }));
      case "overall":
        return json(await runOverallUpdate({
          text: str("text"), items: Array.isArray(body.items) ? (body.items as { item_id: string; overall: number }[]) : [],
          dry_run: body.dry_run === true, user: u.name, as_admin_user_id: adminLoginFor(u),
        }));
      case "grades":
        return json(await runGradeUpdate({
          text: str("text"), items: Array.isArray(body.items) ? (body.items as { item_id: string; grades: Record<string, number> }[]) : [],
          dry_run: body.dry_run === true, approve: body.approve === true, user: u.name, as_admin_user_id: adminLoginFor(u),
        }));
      case "live": {
        // current grades straight from admin for the cards on screen (Metabase lags behind)
        const ids = (Array.isArray(body.ids) ? (body.ids as string[]) : []).slice(0, 2000);
        const session = await openAdminSession(adminLoginFor(u));
        try { return json(await liveCards(session, ids)); } finally { await session.revoke(); }
      }
      case "status":
        // Archived tile: Not accepted / Pending rescan / Archive — apply or remove (logged, undoable)
        return json(await runArchivedStatus({
          view: body.view, text: str("text"), key: str("key"), op: str("op"), note: String(body.note ?? ""), notes: (body.notes && typeof body.notes === "object" ? body.notes : undefined) as Record<string, string> | undefined,
          item_ids: Array.isArray(body.item_ids) ? (body.item_ids as string[]) : [], dry_run: body.dry_run === true, user: u.name, as_admin_user_id: adminLoginFor(u),
          confirm_emailed: body.confirm_emailed === true, confirm_unboxed: body.confirm_unboxed === true,
        }));
      case "status-undo":
        return json(await undoArchivedStatus({ run_id: str("run_id"), user: u.name, as_admin_user_id: adminLoginFor(u) }));
      case "undo":
        return json(await undoRun({ run_id: str("run_id"), confirm: true, requested_by: u.name, as_admin_user_id: adminLoginFor(u) }));
      case "prompts":
        return json(await addPrompt(String(body.text ?? ""), u.name, body.name as string | undefined));
      case "prompts-rename":
        await renamePrompt(String(body.id), String(body.name ?? ""));
        return json({ ok: true });
      case "prompts-delete":
        await deletePrompt(String(body.id));
        return json({ ok: true });
      case "password":
        await changePassword(u.id, String(body.current ?? ""), String(body.next ?? ""));
        return json({ ok: true });

      // ---- people (admins) ----
      case "users-add": {
        const f = forbid(u, "admin");
        if (f) return f;
        const r = await addUser({ email: str("email"), name: str("name"), role: str("role") as Role, admin_user_id: str("admin_user_id") || null }, u);
        return json({ ...r, invite_url: `${origin(req)}/?invite=${r.invite_token}` });
      }
      case "users-update": {
        const f = forbid(u, "admin");
        if (f) return f;
        await updateUser(str("id"), {
          role: (body.role as Role) || undefined,
          active: typeof body.active === "boolean" ? body.active : undefined,
          admin_user_id: body.admin_user_id === undefined ? undefined : String(body.admin_user_id ?? ""),
        }, u);
        return json({ ok: true });
      }
      case "users-invite": {
        const f = forbid(u, "admin");
        if (f) return f;
        const r = await resetInvite(str("id"));
        return json({ invite_url: `${origin(req)}/?invite=${r.invite_token}` });
      }
      case "users-relink":
        return forbid(u, "admin") ?? json(await relinkAdmin(str("id"), str("email") || undefined));
      case "users-test":
        return forbid(u, "admin") ?? json(await testAdmin(str("id")));
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (e) {
    return fail(e);
  }
}
