// Writes tags to admin exactly the way the admin UI does:
//   PATCH https://admin-api.arenaclub.com/cards/{ITEM_ID}   { "tag": "x" } | { "tag": null }
// Auth: a short-lived SuperTokens session minted server-side, sent as the
// sAccessToken cookie with rid: anti-csrf and st-auth-mode: cookie.
import supertokens from "supertokens-node";
import Session from "supertokens-node/recipe/session";
import { config } from "./config";

let initialized = false;
export const initSupertokens = () => init();
function init() {
  if (initialized) return;
  supertokens.init({
    framework: "custom",
    supertokens: { connectionURI: config.supertokensUri(), apiKey: config.supertokensApiKey() },
    appInfo: {
      appName: "arena-tag-mcp",
      apiDomain: "https://api.arenaclub.com", // matches the "iss" on admin sessions
      apiBasePath: "/st/auth",
      websiteDomain: config.adminOrigin(),
    },
    recipeList: [Session.init()],
  });
  initialized = true;
}

export type AdminSession = { accessToken: string; revoke: () => Promise<void> };

/** Mints a short-lived admin session as this admin user (the person doing the run). */
export async function openAdminSession(adminUserId: string = config.sessionUserId()): Promise<AdminSession> {
  init();
  const session = await Session.createNewSessionWithoutRequestResponse(
    config.sessionTenantId(),
    supertokens.convertToRecipeUserId(adminUserId),
    { ...(config.mfaDone() ? { "st-mfa": { c: {}, v: true } } : {}), ...(config.sessionExtraPayload() ?? {}) },
    {},
    true // no anti-CSRF token; admin uses the rid header instead
  );
  const { accessToken } = session.getAllSessionTokensDangerously();
  return {
    accessToken,
    revoke: async () => {
      try {
        await session.revokeSession();
      } catch {
        /* best effort */
      }
    },
  };
}

function headers(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Cookie: `sAccessToken=${accessToken}`,
    rid: "anti-csrf",
    "st-auth-mode": "cookie",
    Origin: config.adminOrigin(),
    Referer: `${config.adminOrigin()}/`,
  };
}

export type WriteResult = { ok: boolean; status: number; returnedTag?: string | null; error?: string };

export type WriteKind = "card" | "watch" | "overall" | "grades";
const GRADE_KEYS = ["overall", "centering", "corners", "edges", "surface"] as const;
/** Writes one field on an item: the tag (cards / watches), or the card's overall grade (kind "overall"). */
export async function patchTag(session: AdminSession, itemId: string, tag: string | null, kind: WriteKind = "card"): Promise<WriteResult> {
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return { ok: false, status: 0, error: "invalid item id" };
  const path = kind === "watch" ? config.watchTagPath() : "/cards/{id}";
  if (!path) return { ok: false, status: 0, error: "WATCH_TAG_PATH is not set" };
  const url = `${config.adminApiUrl()}${path.replace("{id}", itemId)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: headers(session.accessToken),
        body: JSON.stringify(
          kind === "grades"
            ? Object.fromEntries(Object.entries(JSON.parse(tag || "{}") as Record<string, number>).filter(([k]) => (GRADE_KEYS as readonly string[]).includes(k)).map(([k, v]) => [config.gradeField(k as (typeof GRADE_KEYS)[number]), Number(v)]))
            : kind === "overall" ? { [config.overallField()]: tag === null ? null : Number(tag) } : { tag }
        ),
      });
      if (res.ok) {
        let returnedTag: string | null | undefined;
        try {
          const body = await res.json();
          const field = kind === "grades" ? "\u0000" : kind === "overall" ? config.overallField() : "tag"; // grades: several fields, not compared
          if (body && typeof body === "object" && field in body) returnedTag = body[field] == null ? null : kind === "overall" ? String(Number(body[field])) : body[field];
        } catch {
          /* non-JSON body is fine */
        }
        return { ok: true, status: res.status, returnedTag };
      }
      // Retry only on rate limits / server errors
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 3) return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) || "server error" };
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      return { ok: false, status: res.status, error: (await res.text()).slice(0, 300) };
    } catch (e) {
      if (attempt === 3) return { ok: false, status: 0, error: String(e) };
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  return { ok: false, status: 0, error: "exhausted retries" };
}

// Read-only check that the minted session is accepted by admin.
export async function checkAuth(itemId: string) {
  const session = await openAdminSession();
  try {
    const res = await fetch(`${config.adminApiUrl()}/cards/${itemId}`, {
      method: "GET",
      headers: headers(session.accessToken),
    });
    const text = await res.text();
    let tag: unknown;
    try {
      tag = JSON.parse(text)?.tag;
    } catch {
      /* ignore */
    }
    return { status: res.status, ok: res.ok, card_tag_field: tag, body_preview: res.ok ? undefined : text.slice(0, 300) };
  } finally {
    await session.revoke();
  }
}

// Does admin accept a session for this admin user? Asks for a card id that can't exist:
// 404 means the login was accepted, 401/403 means admin refused it. Writes nothing.
export async function adminAccess(adminUserId: string) {
  let session: AdminSession | null = null;
  try {
    session = await openAdminSession(adminUserId);
    const res = await fetch(`${config.adminApiUrl()}/cards/00000000-0000-0000-0000-000000000000`, { headers: headers(session.accessToken) });
    const refused = res.status === 401 || res.status === 403;
    return { ok: !refused, status: res.status, detail: refused ? (await res.text()).slice(0, 300) : undefined };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (session) await session.revoke();
  }
}

// After grades change, rebuild the label and slab images exactly the way the admin review page does, then keep them:
//   1. GET /cards/{id}
//   2. PATCH /cards/generate_label_images  (whole card) -> label + print-label links, labelVersion
//   3. put those on the card the way the page does: storage.googleapis.com/arenaxlab/... -> assets.arenaclub.com/...?ixlib=react-9.7.0,
//      V2 label fields = the label, trimmed pictures left as they are
//   4. PATCH /cards/generate_slab_images   (that card) -> slab links
//   5. PATCH /cards/{id} with the new label / V2 label / print label / slab links + labelVersion
const LABEL_KEYS = ["frontLabelPictureUrl", "backLabelPictureUrl", "frontPrintLabelPictureUrl", "backPrintLabelPictureUrl"] as const;
const asAsset = (u: unknown) => {
  if (typeof u !== "string" || !u) return u;
  const m = u.match(/^https:\/\/storage\.googleapis\.com\/arenaxlab\/(.+)$/);
  if (!m) return u;
  return `https://assets.arenaclub.com/${m[1]}${m[1].includes("?") ? "" : "?ixlib=react-9.7.0"}`;
};
export async function regenerateImages(session: AdminSession, itemId: string) {
  const out = { label: 0, slab: 0, saved: 0, error: undefined as string | undefined, links: {} as Record<string, unknown> };
  const call = async (path: string, method: string, body?: unknown) =>
    fetch(`${config.adminApiUrl()}${path}`, { method, headers: headers(session.accessToken), body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const res = await call(`/cards/${itemId}`, "GET");
    if (!res.ok) { out.error = `load card ${res.status}`; return out; }
    const body = await res.json();
    const card: Record<string, unknown> = body && typeof body === "object" && "card" in body && body.card && typeof body.card === "object" ? body.card : body;
    const save: Record<string, unknown> = {};

    const lr = await call(`/cards/generate_label_images`, "PATCH", card);
    out.label = lr.status;
    if (!lr.ok) { out.error = `generate_label_images ${lr.status}: ${(await lr.text()).slice(0, 200)}`; return out; }
    const labels = (await lr.json().catch(() => ({}))) as Record<string, unknown>;
    for (const k of LABEL_KEYS) if (labels[k]) save[k] = card[k] = asAsset(labels[k]);
    if (save.frontLabelPictureUrl) save.frontV2LabelPictureUrl = card.frontV2LabelPictureUrl = save.frontLabelPictureUrl;
    if (save.backLabelPictureUrl) save.backV2LabelPictureUrl = card.backV2LabelPictureUrl = save.backLabelPictureUrl;
    if (labels.labelVersion != null) save.labelVersion = card.labelVersion = labels.labelVersion;
    if (!save.frontLabelPictureUrl) { out.error = "generate_label_images returned no label"; return out; }

    const sr = await call(`/cards/generate_slab_images`, "PATCH", card);
    out.slab = sr.status;
    if (!sr.ok) { out.error = `generate_slab_images ${sr.status}: ${(await sr.text()).slice(0, 200)}`; return out; }
    const slabs = (await sr.json().catch(() => ({}))) as Record<string, unknown>;
    for (const k of ["frontSlabPictureUrl", "backSlabPictureUrl"]) if (slabs[k]) save[k] = asAsset(slabs[k]);
    if (!save.frontSlabPictureUrl) { out.error = "generate_slab_images returned no slab"; return out; }

    // the Approve also carries the slab as the V2 slab
    save.frontV2SlabPictureUrl = save.frontSlabPictureUrl;
    if (save.backSlabPictureUrl) save.backV2SlabPictureUrl = save.backSlabPictureUrl;
    out.links = save;
    if (config.saveImageLinks()) {
      const r = await call(`/cards/${itemId}`, "PATCH", save);
      out.saved = r.status;
      if (!r.ok) out.error = `save image links ${r.status}: ${(await r.text()).slice(0, 200)}`;
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

// ---------- Approve: same as clicking "Approve" on the admin review page ----------
// POST /grades/review with a new grade record: status "approved", kind "review", the grades, gradingReport,
// all picture links, the card's details, and who reviewed it (graderId from /users/{id}/grader,
// gradingTaskId = the card's "review" grading task).
const DROP = new Set(["id", "createdAt", "updatedAt", "verificationDuration", "isVerified", "verifierId", "notes", "verificationStatus"]);
const CARD_KEYS = ["cardTypeId", "brand", "year", "gradingCompany", "gradingReport", "labelVersion", "team", "sport", "language", "slabKind", "isRookie", "isRelic",
  "isFullArt", "holo", "insert", "edition", "rarity", "signature", "playerName", "setName", "setNumber", "parallelName", "parallelNumber", "parallelTotal",
  "labelPlayerName", "labelSetName", "labelParallel", "searchBrand", "side", "subset", "design", "promo", "isShortPrint"];
const PIC = /Picture(Url|Id)$/;
export async function approveReview(session: AdminSession, itemId: string, adminUserId: string, reviewerName: string, links: Record<string, unknown> = {}, grades: Record<string, number> = {}, cardIn?: Record<string, any>) {
  const get = async (path: string) => {
    const r = await fetch(`${config.adminApiUrl()}${path}`, { headers: headers(session.accessToken) });
    if (!r.ok) throw new Error(`${path.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return r.json();
  };
  try {
    const grader = await get(`/users/${adminUserId}/grader`);
    if (!grader?.id) throw new Error("this admin login has no grader record, so it can't approve");
    const tasks = await get(`/grading_tasks?limit=100&offset=0&search=&where=card_id=${itemId}`);
    const list: any[] = Array.isArray(tasks?.data) ? tasks.data : Array.isArray(tasks) ? tasks : [];
    const review = list.filter((t) => t?.kind === "review" || t?.skill === "review").sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!review?.id) throw new Error("this card has no review task");
    const last = [...(review.grades ?? [])].sort((a: any, b: any) => String(b.finishedAt ?? b.createdAt).localeCompare(String(a.finishedAt ?? a.createdAt)))[0] ?? {};
    let card: Record<string, any> | undefined = cardIn;
    if (!card) { const cardRaw = await get(`/cards/${itemId}`); card = cardRaw && typeof cardRaw === "object" && cardRaw.card ? cardRaw.card : cardRaw; }
    card = card as Record<string, any>;

    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(last)) if (!DROP.has(k)) body[k] = v;           // card details from the last review grade
    for (const k of CARD_KEYS) if (card[k] !== undefined) body[k] = card[k];             // ...updated from the card itself
    for (const [k, v] of Object.entries(card)) if (PIC.test(k)) body[k] = v;             // every picture link on the card
    if (card.gradingSetId !== undefined) body.setId = card.gradingSetId;
    if (card.gradingSubsetId !== undefined) body.subsetId = card.gradingSubsetId;
    if (card.gradingParallelId !== undefined) body.parallelId = card.gradingParallelId;
    for (const g of ["overall", "centering", "corners", "edges", "surface"]) if (card[g] !== undefined) body[g] = card[g];
    Object.assign(body, links);                                                          // the label / slab just rebuilt
    Object.assign(body, grades);                                                         // the new grades
    const now = new Date();
    Object.assign(body, {
      status: "approved", kind: "review", name: reviewerName, graderId: grader.id, userId: adminUserId,
      gradingTaskId: review.id, cardId: itemId, startedAt: new Date(now.getTime() - 1000).toISOString(), finishedAt: now.toISOString(), duration: 1,
    });
    delete body.grades;
    const r = await fetch(`${config.adminApiUrl()}/grades/review`, { method: "POST", headers: headers(session.accessToken), body: JSON.stringify(body) });
    if (!r.ok) return { ok: false, status: r.status, error: (await r.text()).slice(0, 300) };
    const res = await r.json().catch(() => ({}));
    return { ok: true, status: r.status, grade_id: res?.id as string | undefined };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- Change grades the way the admin review page does ----------
// The review page never PATCHes grades onto /cards/{id}. It keeps the new grades on the card, rebuilds
// the label then the slab from that card, and the grade becomes real when it's approved (POST /grades/review).
//   1. GET /cards/{id}  2. put the new grades on it  3. generate_label_images  4. generate_slab_images  5. approve
export async function changeGradesLikeReview(session: AdminSession, itemId: string, adminUserId: string, reviewerName: string, grades: Record<string, number>) {
  const call = async (path: string, method: string, body?: unknown) =>
    fetch(`${config.adminApiUrl()}${path}`, { method, headers: headers(session.accessToken), body: body === undefined ? undefined : JSON.stringify(body) });
  const step = { label: 0, slab: 0, approve: 0 };
  try {
    const res = await call(`/cards/${itemId}`, "GET");
    if (!res.ok) return { ok: false, status: res.status, error: `load card: ${(await res.text()).slice(0, 200)}`, step };
    const raw = await res.json();
    const card: Record<string, any> = raw && typeof raw === "object" && raw.card ? raw.card : raw;
    const g: Record<string, number> = {};
    for (const [k, v] of Object.entries(grades)) { g[k] = Number(v); card[config.gradeField(k as any)] = Number(v); }

    const links: Record<string, unknown> = {};
    if (config.regenerateImages()) {
      const lr = await call(`/cards/generate_label_images`, "PATCH", card);
      step.label = lr.status;
      if (!lr.ok) return { ok: false, status: lr.status, error: `generate_label_images: ${(await lr.text()).slice(0, 200)}`, step };
      const labels = (await lr.json().catch(() => ({}))) as Record<string, unknown>;
      for (const k of LABEL_KEYS) if (labels[k]) links[k] = card[k] = asAsset(labels[k]);
      if (links.frontLabelPictureUrl) links.frontV2LabelPictureUrl = card.frontV2LabelPictureUrl = links.frontLabelPictureUrl;
      if (links.backLabelPictureUrl) links.backV2LabelPictureUrl = card.backV2LabelPictureUrl = links.backLabelPictureUrl;
      if (labels.labelVersion != null) links.labelVersion = card.labelVersion = labels.labelVersion;
      const sr = await call(`/cards/generate_slab_images`, "PATCH", card);
      step.slab = sr.status;
      if (!sr.ok) return { ok: false, status: sr.status, error: `generate_slab_images: ${(await sr.text()).slice(0, 200)}`, step };
      const slabs = (await sr.json().catch(() => ({}))) as Record<string, unknown>;
      for (const k of ["frontSlabPictureUrl", "backSlabPictureUrl"]) if (slabs[k]) links[k] = card[k] = asAsset(slabs[k]);
      if (links.frontSlabPictureUrl) links.frontV2SlabPictureUrl = links.frontSlabPictureUrl;
      if (links.backSlabPictureUrl) links.backV2SlabPictureUrl = links.backSlabPictureUrl;
    }
    const a = await approveReview(session, itemId, adminUserId, reviewerName, links, g, card);
    step.approve = a.status;
    if (!a.ok) return { ok: false, status: a.status, error: `approve: ${a.error}`, step };
    return { ok: true, status: a.status, grade_id: a.grade_id, rebuilt: !!links.frontLabelPictureUrl, step };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e), step };
  }
}
