# arena-tag-mcp

Two ways in, same engine, same Neon run log:

- **Tag Bot screen** at `https://<project>.vercel.app/`: sign in with your name + `APP_PASSWORD`, type a request, see the matching slabs, deselect any, **Confirm tags**, then Undo if needed. Saved prompts are shared by everyone who signs in.
- **Claude connector** at `/api/mcp?key=<MCP_ACCESS_KEY>`: the same actions from a Claude chat.

Every search on the screen pulls question 4131 fresh (no cache): the same pull is used to recognise player, set and parallel names and to find the cards. Confirm re-checks the selected cards against 4131 again before writing.

MCP server for bulk-tagging warehouse cards in Arena admin from plain directions typed in Claude.

**Recipe:** preview (draft) → stage (approval #1, freeze snapshot) → go live (approval #2, write) → verify / undo.
Every step is recorded in Neon with who asked, who staged and who approved.

## Data path

| Hop | How |
|---|---|
| Find cards | Metabase question 4131 via `/api/card/4131/query/json`, using its own `{{ }}` filters (not capped at 2,000 rows) |
| Write tag | `PATCH {ADMIN_API_URL}/cards/{ITEM_ID}` with body `{"tag":"x"}` or `{"tag":null}` |
| Admin auth | Server mints a SuperTokens session for `ADMIN_SESSION_USER_ID`, sends `Cookie: sAccessToken`, `rid: anti-csrf`, `st-auth-mode: cookie`, `Origin`, and revokes the session after each run |
| Verify | Re-queries 4131 by tag and checks each written `ITEM_ID` |

**Several names in one request:** `player_name`, `set_name`, `parallel_name` and `grade` accept a list (e.g. `["Pikachu","Charizard","Umbreon"]`). Question 4131 takes one value per filter, so the server runs one query per value (max 50 per request, e.g. 25 names × 2 sets) and merges the results by ITEM_ID. Any name that matched nothing is returned in `no_cards_found_for` so Claude can flag it before staging.

A card holds **one** tag. Setting a tag replaces the current one. Previous tags are frozen at stage time, so undo restores them exactly. `mode: skip_tagged` leaves already-tagged cards alone.

## Tools

| Tool | Writes to admin? |
|---|---|
| `find_cards` | No |
| `preview_tag_run` | No |
| `stage_tag_run` | No (freezes the list in Neon) |
| `go_live_tag_run` | **Yes** (unless `DRY_RUN=true`) |
| `undo_tag_run` | **Yes** |
| `verify_tag_run`, `get_tag_run`, `list_tag_runs`, `get_settings`, `check_admin_auth` | No |

## Setup

1. **Neon:** create a database and copy its connection string. Tables create themselves on first call.
2. **Vercel:** create a new project from this folder (push to GitHub and import, or `npx vercel`). Add every var in `.env.example`. Leave `DRY_RUN=true`.
3. **Deploy.** The endpoint is `https://<project>.vercel.app/api/mcp?key=<MCP_ACCESS_KEY>`.
4. **Test with MCP Inspector:** run `npx @modelcontextprotocol/inspector`, choose transport "Streamable HTTP", and paste the URL. Then run, in order:
   - `get_settings`: confirms env loaded and `dry_run: true`
   - `find_cards` with `{"filters":{"player_name":"Chourio"}}`: compare to 4131 in Metabase
   - `check_admin_auth` with any ITEM_ID: must return `status: 200`
   - `preview_tag_run` → `stage_tag_run` → `go_live_tag_run`: should end in `dry_run_completed`
5. **Claude:** Settings → Connectors → Add custom connector → paste the full URL including `?key=`.
6. **Go live:** set `DRY_RUN=false` and redeploy. Tag 5–10 cards with `test_pack`, check them in admin, run `undo_tag_run`, and confirm they revert. Then raise `MAX_ITEMS_PER_RUN`.

## If `check_admin_auth` fails

- **401 / "try refresh token":** admin isn't accepting the minted session. Admin sessions carry email-verification and MFA claims (`st-ev`, `st-mfa`), and a minted session may need them. `ADMIN_SESSION_EXTRA_PAYLOAD` can add them, but that marks a session as MFA-complete without MFA. Decide deliberately whether that's acceptable before using it.
- **403:** the user in `ADMIN_SESSION_USER_ID` lacks permission.
- **Network or core error:** the SuperTokens URI or key is wrong.

## Security

- `SUPERTOKENS_API_KEY` can create a session for any user. Limit who can see this Vercel project.
- The `?key=` URL is the only gate on the endpoint. Treat the full URL as a secret, and rotate `MCP_ACCESS_KEY` if it leaks.
- Only one kind of write exists (the tag PATCH). Runs execute once (atomic claim), expire after `RUN_EXPIRY_HOURS`, and are capped at `MAX_ITEMS_PER_RUN`.

## Using it in Claude

> Tag all Wembanyama Prizm Ruby Wave PSA 10s between $200 and $1,000 as sd_wemby_grail. Skip cards that already have a tag.

Claude previews and shows the count. You confirm the number, and it stages. You say go live, and it writes and reports. Later: "verify run r_…" or "undo run r_…".
