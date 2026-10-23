# arena-tag-mcp

Two ways in, same engine, same Neon run log:

- **TAG-BOT screen** at `https://<project>.vercel.app/`: sign in with email + password (same accounts as ev-bot when `DATABASE_URL` is ev-bot's Neon database), type a request, see the matching slabs, deselect any, **Confirm tags**, then Undo if needed. Saved prompts are shared by everyone who signs in.
- **Claude connector** at `/api/mcp?key=<MCP_ACCESS_KEY>`: the same actions from a Claude chat.

Every search on the screen queries question 4131 fresh (no cache) using its own filters: each name you type goes into the player filter (then set, then parallel if nothing matches), AC/cert numbers go into the number filters, so only matching cards come back. Confirm re-runs those same searches before writing.

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

## People

Accounts live in Neon table `ev_users`, the same table ev-bot uses. Point `DATABASE_URL` at ev-bot's database and everyone's ev-bot login works here; roles are shared too.

Everyone signed in has full access (search, tag, undo). **admin** also gets the Users tab. Same roles as ev-bot: `member` and `admin`.

- **Add a person:** Users → Add person → send the invite link (works once, 48 hours).
- **Admin login:** each person can be linked to their own Arena admin login (found from their email, or "link by email" / "paste ID"). Linked people's tags are written as them in admin; unlinked people write through `ADMIN_SESSION_USER_ID` (their name is still on every run). "test" checks admin accepts the login; a 403 mentioning MFA means set `ADMIN_SESSION_MFA_DONE=true`.
- **New database:** set `SETUP_CODE`, open the app, create the first admin, then delete `SETUP_CODE`.

## Watches

The Cards / Watches toggle switches the source. Watches read Metabase question **45046** (`WATCH_METABASE_CARD_ID`). 45046's SQL ends in `LIMIT 5000` (newest first), so TAG-BOT never pulls it unfiltered when it can avoid it: every word typed is sent through 45046's own filters (Tag, Brand, Model; numbers through PO #, Order #, Reference #), which run inside the SQL before the limit, and the results are merged. The request is then matched against the real values in it: brand (and nicknames like AP, Patek, speedy), model, reference number, dial color, year, condition, value range and current tag. Columns are found by name (BRAND, MODEL, REFERENCE, DIAL_COLOR, SERIAL, YEAR, CONDITION, ESTIMATED_VALUE, TAG, any *_PICTURE_URL / IMAGE column, and the item id as ITEM_ID).

Watch tags are written with `PATCH {ADMIN_API_URL}{WATCH_TAG_PATH}` and body `{"tag": ...}`. Until `WATCH_TAG_PATH` is set, watch runs only work as dry runs. Runs record `kind` (card / watch) so undo uses the right path.

## Searching by tag

Type tag names to find what has them, on Cards or Watches: `sd_rookie_grail`, or several, `sd_rookie_grail, sd_wemby_grail`. Matching is exact (sd_grail does not match sd_grail_2). With only tag names typed, the screen opens on **Remove tag**; switch to **Add tag** to retag them. Combine with other filters: `wembanyama tagged sd_rookie_grail as sd_wemby_grail`, `remove tags vip_ship and sd_watch_grail`. Tags that nothing has are listed as "Nothing found for …".

## No limits on searching

- Every search value runs as its own Metabase query (8 at a time); there is no cap on how many.
- Every match is returned to the screen (it shows 240 at a time with "show more"; all matches stay selected).
- Words that aren't a player, set or parallel are also tried as a **tag** on Cards (and as Tag / Brand / Model on Watches), so plain tags like `vookum` work.
- The only cap left is on writes: `MAX_ITEMS_PER_RUN`. Raise it in Vercel for bigger runs.
- A watch search with nothing to send through a filter (e.g. only "blue dial over $40k") pulls 45046 whole, which its SQL caps at 5,000; the screen says so. Removing `LIMIT 5000` from 45046 fixes that case too.

## Arena Club tile (orders)

Type or paste any number of order numbers (commas, spaces or one per line). Each runs through the Order Number filter of question **45739** "Arena Club Orders Raw" (`ARENA_METABASE_CARD_ID` overrides), so there's no row limit. The orange box lists each order: card count, how many are graded 7.5 or lower, overall-check failures, and a link to the order (`ORDER_URL` column, or `ARENA_ORDER_URL` with `{order}`). Click an order to see only its cards; click again for all. Card borders come from the **Overall Check** question **15214** (`ARENA_CHECK_CARD_ID` overrides), searched by the same order numbers and matched to cards by 8AC number (or the card link): green for ✅PASS, red for ❌FAIL, uncolored if the card isn't in the check. Tiles show centering / corners / edges / surface; the popup shows Overall vs Expected. The 7.5-or-lower count comes from the grade. With no ORDER_URL column, the order link comes from CARD_URL (…/orders/<id>/cards/<id>). Tagging and undo work like Cards (same admin save).

### Grade editor (Arena Club)

Every Arena Club card shows Centering, Corners, Edges, Surface and Overall as boxes you type in right on the card (clicking a box doesn't select or deselect the card), with "overall = expected" on failing cards. Change any of them on any number of cards, then **Save grades (N cards)**. Only changed fields are sent: `PATCH /cards/{id}` `{ "centering": 9, "overall": 8.5 }` (field names `ARENA_FIELD_CENTERING`, `_CORNERS`, `_EDGES`, `_SURFACE`, `ARENA_OVERALL_FIELD`), as the signed-in person's admin login. Grades are 0–10 in half steps (0 counts). Each save is a logged run (action `grades`); undo from Recent runs puts the previous values back. Dry run works the same as for tags.

After grades are saved (and after an undo), TAG-BOT rebuilds the images exactly like the admin review page: `GET /cards/{id}` → `PATCH /cards/generate_label_images` (whole card) → the returned label and print-label links go on the card as `https://assets.arenaclub.com/...?ixlib=react-9.7.0` (from `storage.googleapis.com/arenaxlab/...`), with `frontV2LabelPictureUrl` / `backV2LabelPictureUrl` set to the label and `labelVersion`, trimmed pictures untouched → `PATCH /cards/generate_slab_images` with that card (returns the slab links) → `PATCH /cards/{id}` with the new label, V2 label, print label and slab links (`ARENA_SAVE_IMAGE_LINKS=false` skips this last save). If a step fails, the grade save still stands and the screen lists the cards to open in admin. `ARENA_REGENERATE_IMAGES=false` turns all of this off.

### Approve (make live)

Next to the save button, **Approve (make live)** (on by default, remembered per browser) does what **Approve** on the admin review page does, after the grades are saved and the label and slab are rebuilt: `POST /grades/review` with a new grade record — `status: "approved"`, `kind: "review"`, the grades, `gradingReport`, every picture link (slab also as V2 slab), the card's details (from the card and the card's last review grade), and who reviewed it: `graderId` from `GET /users/{admin user id}/grader`, `gradingTaskId` = the card's `review` task from `GET /grading_tasks?...&where=card_id={id}`, `name` = the TAG-BOT user, `userId` = their linked admin login. With it off, saves wait for Approve on the review page. Undo of an approved save restores the old grades, rebuilds the images and approves the old grades again. The approving login needs review permission in admin (a grader record).

Clicking **Save & approve** (or **Save grades to admin**) opens a confirm popup — "Do you wish to approve these N cards to admin?" — listing each card and its grade changes (old → new). If the tag box has a tag, the popup offers **Also tag these cards as <tag>** (on by default): after the grades are saved and approved, the same cards are tagged with a normal tag run (logged, undoable on its own).

**How grade changes are written (matches the admin review page):** TAG-BOT does not PATCH grades onto `/cards/{id}` (admin returns a server error for that). For each card it loads the card, puts the new grades on it, rebuilds the label (`generate_label_images`) and the slab (`generate_slab_images`) from that card, then approves with `POST /grades/review` carrying the new grades and the new label/slab links. A grade change is therefore always an approval, exactly like the review page. Undo approves the previous grades the same way.

The approval body is exactly the field list the review page sends (captured from a real Approve; 65 fields), filled from the card as it stands with the new grades and the new label/slab, plus reviewer (`graderId`, `name`, `userId`), the card's review task, and real `startedAt` / `finishedAt` / `duration`. After approving, TAG-BOT reloads the card and checks the new grades are on it; if not, the card is reported as "approved, but admin didn't apply the new grades" instead of saved.
