// People who can use TAG-BOT. Same accounts table as ev-bot (ev_users), so a shared DATABASE_URL shares logins.
// Email + password, four roles, one-time invite links, and an optional link to each person's own admin login.
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import supertokens from "supertokens-node";
import { config } from "./config";
import { q } from "./db";
import { initSupertokens, adminAccess } from "./admin";

// Same as ev-bot: everyone signed in has full access; admin only adds the Users tab.
export const ROLES = ["member", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const can = (u: { role: string }, need: Role) => need !== "admin" || u.role === "admin";

export type User = {
  id: string; email: string; name: string; role: Role; admin_user_id: string | null; admin_email: string | null;
  active: boolean; has_password: boolean; created_by: string | null; created_at: string; last_login_at: string | null;
};
const COLS = `id, email, name, role, admin_user_id, admin_email, active, (pw_hash IS NOT NULL) AS has_password,
  created_by, created_at, last_login_at`;
const norm = (e: string) => String(e || "").trim().toLowerCase();
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

// ---------- passwords (same format as ev-bot) ----------
function hashPw(pw: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(pw, salt, 64).toString("hex")}`;
}
function checkPw(pw: string, stored: string | null) {
  if (!stored) return false;
  const [, salt, hex] = stored.split("$");
  if (!salt || !hex) return false;
  const a = scryptSync(pw, salt, 64), b = Buffer.from(hex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
const pwProblem = (pw: string) => (!pw || pw.length < 10 ? "Use at least 10 characters." : null);

// ---------- session cookie: user id + issue time, signed; the user is re-checked in the DB every request ----------
const COOKIE = "tgb_session";
const secret = () => process.env.SESSION_SECRET || config.mcpAccessKey();
const mac = (v: string) => createHmac("sha256", secret()).update(v).digest("base64url");
const DAYS = 14;

export function sessionCookie(userId: string) {
  const v = Buffer.from(`${userId}|${Date.now()}`).toString("base64url");
  return `${COOKIE}=${v}.${mac(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * DAYS}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function currentUser(req: Request): Promise<User | null> {
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [v, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!v || !sig) return null;
  const good = mac(v);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  const [id, at] = Buffer.from(v, "base64url").toString().split("|");
  if (!id || Date.now() - Number(at) > DAYS * 86400_000) return null;
  const [u] = await q<User>(`SELECT ${COLS} FROM ev_users WHERE id=$1 AND active`, [id]);
  return u ?? null;
}

// ---------- sign-in ----------
export async function needsSetup() {
  const [r] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM ev_users`);
  return r.n === 0;
}

export async function login(email: string, pw: string) {
  const [u] = await q<User & { pw_hash: string | null }>(`SELECT ${COLS}, pw_hash FROM ev_users WHERE email=$1`, [norm(email)]);
  if (!u || !u.active || !checkPw(pw, u.pw_hash)) throw new Error("Wrong email or password.");
  await q(`UPDATE ev_users SET last_login_at=now() WHERE id=$1`, [u.id]);
  return u;
}

// First admin, only while the table is empty, and only with SETUP_CODE from Vercel.
export async function setupFirstAdmin(input: { name: string; email: string; password: string; code: string }) {
  const want = process.env.SETUP_CODE;
  if (!want) throw new Error("Add SETUP_CODE in Vercel to create the first admin.");
  const a = Buffer.from(input.code || ""), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Wrong setup code.");
  if (!(await needsSetup())) throw new Error("Setup is already done. Sign in instead.");
  const email = norm(input.email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid email.");
  if (!input.name?.trim()) throw new Error("Enter your name.");
  const p = pwProblem(input.password);
  if (p) throw new Error(p);
  const id = "u_" + randomBytes(6).toString("hex");
  await q(
    `INSERT INTO ev_users (id, email, name, role, admin_user_id, pw_hash, created_by, last_login_at) VALUES ($1,$2,$3,'admin',$4,$5,'setup',now())`,
    [id, email, input.name.trim(), await lookupAdminUserId(email), hashPw(input.password)]
  );
  return id;
}

// ---------- invites (one link, works once, 48 hours; also used to reset a password) ----------
async function newInvite(userId: string) {
  const token = randomBytes(24).toString("base64url");
  await q(`UPDATE ev_users SET invite_hash=$2, invite_expires_at=now() + interval '48 hours' WHERE id=$1`, [userId, sha(token)]);
  return token;
}
async function byInvite(token: string) {
  const [u] = await q<User>(`SELECT ${COLS} FROM ev_users WHERE invite_hash=$1 AND invite_expires_at > now() AND active`, [sha(token || "")]);
  if (!u) throw new Error("This invite link has expired or was already used. Ask an admin for a new one.");
  return u;
}
export const inviteInfo = async (token: string) => {
  const u = await byInvite(token);
  return { name: u.name, email: u.email };
};
export async function acceptInvite(token: string, pw: string) {
  const u = await byInvite(token);
  const p = pwProblem(pw);
  if (p) throw new Error(p);
  await q(`UPDATE ev_users SET pw_hash=$2, invite_hash=NULL, invite_expires_at=NULL, last_login_at=now() WHERE id=$1`, [u.id, hashPw(pw)]);
  return u;
}

export async function changePassword(userId: string, current: string, next: string) {
  const [u] = await q<{ pw_hash: string | null }>(`SELECT pw_hash FROM ev_users WHERE id=$1`, [userId]);
  if (!checkPw(current, u?.pw_hash ?? null)) throw new Error("Current password is wrong.");
  const p = pwProblem(next);
  if (p) throw new Error(p);
  await q(`UPDATE ev_users SET pw_hash=$2 WHERE id=$1`, [userId, hashPw(next)]);
}

// ---------- admin login link ----------
async function lookupAdminUserIds(email: string): Promise<string[]> {
  try {
    initSupertokens();
    return (await supertokens.listUsersByAccountInfo(config.sessionTenantId(), { email: norm(email) })).map((x) => x.id);
  } catch {
    return [];
  }
}
const lookupAdminUserId = async (email: string) => (await lookupAdminUserIds(email))[0] ?? null;
/** Of the logins on this email, the one admin accepts (else the first). */
async function pickAdminLogin(email: string): Promise<string | null> {
  const ids = await lookupAdminUserIds(email);
  if (ids.length <= 1) return ids[0] ?? null;
  for (const x of ids) if ((await adminAccess(x)).ok) return x;
  return ids[0];
}

/** Who admin sees as making the change: the person's own admin login, or the shared one if they aren't linked. */
export function adminLoginFor(u: User): string {
  if (u.admin_user_id) return u.admin_user_id;
  if (!config.sharedSessionFallback()) throw new Error(`${u.name} isn't linked to an admin login yet. Ask a TAG-BOT admin to link them in Users.`);
  return config.sessionUserId();
}

// ---------- user management (admins) ----------
export const listUsers = () => q<User>(`SELECT ${COLS} FROM ev_users ORDER BY active DESC, name`);

export async function addUser(input: { email: string; name: string; role: Role; admin_user_id?: string | null }, by: User) {
  const email = norm(input.email);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid email.");
  if (!input.name?.trim()) throw new Error("Enter their name.");
  if (!ROLES.includes(input.role)) throw new Error("Pick a role.");
  const [dupe] = await q(`SELECT id FROM ev_users WHERE email=$1`, [email]);
  if (dupe) throw new Error("That email already has an account.");
  const adminId = input.admin_user_id?.trim() || (await pickAdminLogin(email));
  const id = "u_" + randomBytes(6).toString("hex");
  await q(`INSERT INTO ev_users (id, email, name, role, admin_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, email, input.name.trim(), input.role, adminId, by.name]);
  return { id, invite_token: await newInvite(id), admin_user_id: adminId, linked_automatically: !input.admin_user_id && !!adminId };
}

export async function updateUser(id: string, patch: { role?: Role; active?: boolean; admin_user_id?: string }, by: User) {
  if (id === by.id && (patch.active === false || (patch.role && patch.role !== "admin"))) throw new Error("You can't remove your own admin access.");
  if (patch.role && !ROLES.includes(patch.role)) throw new Error("Unknown role.");
  if (patch.admin_user_id && !/^[0-9a-f-]{36}$/i.test(patch.admin_user_id.trim())) throw new Error("Admin user ID should look like 2290bf05-5cae-…");
  await q(
    `UPDATE ev_users SET role=COALESCE($2,role), active=COALESCE($3,active),
       admin_user_id=CASE WHEN $4::boolean THEN NULLIF($5,'') ELSE admin_user_id END
     WHERE id=$1`,
    [id, patch.role ?? null, patch.active ?? null, patch.admin_user_id !== undefined, patch.admin_user_id?.trim() ?? ""]
  );
}

export const resetInvite = async (id: string) => ({ invite_token: await newInvite(id) });

/** Link by email: their TAG-BOT email or a different admin email. If an email has several logins, the one admin accepts wins. */
export async function relinkAdmin(id: string, adminEmail?: string) {
  const [u] = await q<{ email: string }>(`SELECT email FROM ev_users WHERE id=$1`, [id]);
  if (!u) throw new Error("No such user.");
  const email = norm(adminEmail || u.email);
  const ids = await lookupAdminUserIds(email);
  if (!ids.length) throw new Error(`No admin login found for ${email}. Check the email they use for admin, or paste their admin user ID.`);
  const tests = await Promise.all(ids.map(async (x) => ({ id: x, ...(await adminAccess(x)) })));
  const pick = tests.find((t) => t.ok) ?? tests[0];
  await q(`UPDATE ev_users SET admin_user_id=$2, admin_email=$3 WHERE id=$1`, [id, pick.id, email]);
  return { admin_user_id: pick.id, can_write: pick.ok, status: pick.status };
}

export async function testAdmin(id: string) {
  const [u] = await q<User>(`SELECT ${COLS} FROM ev_users WHERE id=$1`, [id]);
  if (!u) throw new Error("No such user.");
  const login = u.admin_user_id || config.sessionUserId();
  return { name: u.name, linked: !!u.admin_user_id, ...(await adminAccess(login)) };
}
