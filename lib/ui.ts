// Saved prompts, shared by the team. (Sign-in lives in users.ts.)
import { randomBytes } from "crypto";
import { q } from "./db";

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
