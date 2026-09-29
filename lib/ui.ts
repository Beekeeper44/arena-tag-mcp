// Web app helpers: sign-in, the card-name lexicon, saved prompts.
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { config } from "./config";
import { q } from "./db";

// ---------- sign-in ----------
// One team password (APP_PASSWORD). The cookie holds the person's name + an HMAC so it can't be forged.
const COOKIE = "tb_session";
const secret = () => `${config.mcpAccessKey()}::${process.env.APP_PASSWORD ?? ""}`;
const mac = (v: string) => createHmac("sha256", secret()).update(v).digest("base64url");

export const passwordRequired = () => !!process.env.APP_PASSWORD;

// With no APP_PASSWORD set, sign-in is name only (the name is what runs are logged under).
export function checkPassword(pw: string): boolean {
  const want = process.env.APP_PASSWORD;
  if (!want) return true;
  const a = Buffer.from(pw), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionCookie(name: string): string {
  const v = Buffer.from(name.slice(0, 60)).toString("base64url");
  return `${COOKIE}=${v}.${mac(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export function currentUser(req: Request): string | null {
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [v, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!v || !sig) return null;
  const good = mac(v);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  return Buffer.from(v, "base64url").toString();
}

// ---------- saved prompts (shared by the team) ----------
export const listPrompts = () =>
  q(`SELECT id, name, text, created_by, created_at FROM saved_prompts ORDER BY created_at DESC LIMIT 200`);

export async function addPrompt(text: string, user: string, name?: string) {
  const t = text.trim();
  if (!t) throw new Error("Prompt is empty.");
  const [dupe] = await q(`SELECT id FROM saved_prompts WHERE text = $1`, [t]);
  if (dupe) throw new Error("That prompt is already saved.");
  const id = "p_" + randomBytes(5).toString("hex");
  const nm = (name?.trim() || (t.length > 48 ? t.slice(0, 46) + "…" : t)).slice(0, 120);
  await q(`INSERT INTO saved_prompts (id, name, text, created_by) VALUES ($1,$2,$3,$4)`, [id, nm, t, user]);
  return { id, name: nm, text: t, created_by: user };
}
export const renamePrompt = (id: string, name: string) =>
  q(`UPDATE saved_prompts SET name = $2 WHERE id = $1`, [id, name.trim().slice(0, 120)]);
export const deletePrompt = (id: string) => q(`DELETE FROM saved_prompts WHERE id = $1`, [id]);
