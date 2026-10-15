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

export async function patchTag(session: AdminSession, itemId: string, tag: string | null, kind: "card" | "watch" = "card"): Promise<WriteResult> {
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return { ok: false, status: 0, error: "invalid item id" };
  const path = kind === "watch" ? config.watchTagPath() : "/cards/{id}";
  if (!path) return { ok: false, status: 0, error: "WATCH_TAG_PATH is not set" };
  const url = `${config.adminApiUrl()}${path.replace("{id}", itemId)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: headers(session.accessToken),
        body: JSON.stringify({ tag }),
      });
      if (res.ok) {
        let returnedTag: string | null | undefined;
        try {
          const body = await res.json();
          if (body && typeof body === "object" && "tag" in body) returnedTag = body.tag ?? null;
        } catch {
          /* non-JSON body is fine */
        }
        return { ok: true, status: res.status, returnedTag };
      }
      // Retry only on rate limits / server errors
      if (res.status === 429 || res.status >= 500) {
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
