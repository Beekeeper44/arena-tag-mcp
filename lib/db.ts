// Neon: tag run registry + per-item audit log. Tables are created on first use.
import { neon } from "@neondatabase/serverless";
import { config } from "./config";

let _sql: ReturnType<typeof neon> | null = null;
let ready: Promise<void> | null = null;

function sql() {
  if (!_sql) _sql = neon(config.databaseUrl());
  return _sql;
}

export async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema();
  return (await sql().query(text, params)) as T[];
}

async function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      const s = sql();
      await s.query(`
        CREATE TABLE IF NOT EXISTS tag_runs (
          id              text PRIMARY KEY,
          status          text NOT NULL,
          action          text NOT NULL,          -- set | clear | undo
          tag             text,
          mode            text NOT NULL,          -- overwrite | skip_tagged
          filters         jsonb NOT NULL,
          post_filters    jsonb NOT NULL,
          requested_by    text NOT NULL,
          preview         jsonb,
          preview_count   int NOT NULL,
          staged_by       text,
          staged_at       timestamptz,
          staged_count    int,
          approved_by     text,
          live_at         timestamptz,
          finished_at     timestamptz,
          dry_run         boolean,
          result          jsonb,
          undo_of         text,
          created_at      timestamptz NOT NULL DEFAULT now(),
          expires_at      timestamptz NOT NULL
        )`);
      await s.query(`
        CREATE TABLE IF NOT EXISTS tag_run_items (
          run_id        text NOT NULL REFERENCES tag_runs(id),
          item_id       text NOT NULL,
          previous_tag  text,
          new_tag       text,
          label         text,
          ev            numeric,
          status        text NOT NULL DEFAULT 'pending',
          http_status   int,
          returned_tag  text,
          error         text,
          updated_at    timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (run_id, item_id)
        )`);
      await s.query(`ALTER TABLE tag_runs ADD COLUMN IF NOT EXISTS admin_as text`);
      // Same table as ev-bot: point DATABASE_URL at ev-bot's Neon database and everyone's ev-bot login works here.
      await s.query(`
        CREATE TABLE IF NOT EXISTS ev_users (
          id                text PRIMARY KEY,
          email             text NOT NULL UNIQUE,
          name              text NOT NULL,
          role              text NOT NULL,      -- viewer | editor | approver | admin
          admin_user_id     text,               -- their own Arena admin login (SuperTokens user id)
          pw_hash           text,
          invite_hash       text,
          invite_expires_at timestamptz,
          mcp_key_hash      text,
          active            boolean NOT NULL DEFAULT true,
          created_by        text,
          created_at        timestamptz NOT NULL DEFAULT now(),
          last_login_at     timestamptz
        )`);
      await s.query(`ALTER TABLE ev_users ADD COLUMN IF NOT EXISTS admin_email text`);
      await s.query(`
        CREATE TABLE IF NOT EXISTS saved_prompts (
          id          text PRIMARY KEY,
          name        text NOT NULL,
          text        text NOT NULL,
          created_by  text NOT NULL,
          created_at  timestamptz NOT NULL DEFAULT now()
        )`);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
