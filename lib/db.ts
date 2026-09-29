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
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
