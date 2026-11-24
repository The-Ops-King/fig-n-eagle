# Hot Swap

Makes sure someone is always lined up to take a closer's call when the closer can't make it, and routes the handoff in Slack.

## What it does

| When | What happens |
|---|---|
| **6 PM ET, night before** | Builds tomorrow's roster from GHL availability, **blocks each on-call hour on that person's GHL calendar** (so overnight bookings can't take it), posts "Tomorrow's hot-swap plan", and DMs the manager any gaps so cover can be lined up tonight. |
| **7 AM ET, morning of** | Re-checks today. Keeps everyone already assigned, fills any gaps with people who became free overnight, posts "Today's hot-swap roster", and DMs the manager what's still open. |
| **"Can't make my hour"** | Frees the hour in GHL, picks the next free person, blocks it for them, updates the roster, posts in the thread. If nobody's free, tags the manager. |
| **"Cover an open hour"** | Anyone in the pool can take an open hour if their GHL calendar is free. |
| **Hot swap request** (`/hotswap`, the global shortcut, or the roster button) | Closer picks one of their next calls. The bot tags whoever is on call that hour. **First to click "I've got it" wins**: the GHL appointment is reassigned to them (they get the credit). No claim after 3 min: it escalates to the whole pool plus the manager. Calls starting within 3 min, or hours with nobody on call, go to everyone immediately. |

Every request is logged in `swap_requests` (requested, claimed, by whom, how fast, reassignment errors), which gives you the SLA data.

### How "free" is decided
For each person, the bot asks GHL for bookable slots on their own calendar (`availabilityCalendarId`) for that user. That already accounts for working hours, existing appointments and blocks. An hour counts only if they're free for the **whole** hour. People are picked to keep the same person on consecutive hours (max 3 in a row), spread hours evenly, then favor whoever has fewer calls that day.

## Files
```
api/slack/interactions.js  buttons, modals, global shortcut
api/slack/commands.js      /hotswap
api/cron/tick.js           hourly; runs 'plan' at schedule.planHour and 'confirm' at schedule.confirmHour (local time)
lib/                       ghl, slack, db, roster planner, time zones, orchestration
config/<client>.json       everything client-specific (pool, hours, headcount, channel)
db/schema.sql              run once
scripts/preview.js         read-only dry run against live GHL
slack-manifest.yaml        Slack app definition
```

## Setup (one time)
1. **Vercel project**: import this repo, set **Root Directory = `hot-swap`**.
2. **Database**: Vercel → Storage → add **Neon Postgres** to the project (sets `DATABASE_URL`). Run `db/schema.sql` in the Neon SQL editor.
3. **GHL token**: in the sub-account, Settings → Private Integrations → new token with `calendars.readonly`, `calendars/events.readonly`, `calendars/events.write`, `contacts.readonly`, `users.readonly`. Use a dedicated token for this app.
4. **Slack app**: api.slack.com/apps → Create New App → From manifest → paste `slack-manifest.yaml` with your Vercel domain in place of `YOUR-DEPLOYMENT`. Install to the workspace. Invite the bot to the hot-transfer channel (`/invite @Hot Swap`).
5. **Env vars** (Vercel → Settings → Environment Variables), see `.env.example`:
   `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `CRON_SECRET`, `GHL_PIT_FIG_N_EAGLE`, `HOT_SWAP_CLIENT=fig-n-eagle`.
6. **Config**: `config/fig-n-eagle.json` has `slack.channelId` (currently #sd-call-transfer) and Slack IDs for David and Rosaline already set. For anyone else whose GHL email isn't their Slack email, set `slackUserId`.
7. Deploy. Then trigger a run by hand:
   `curl -H "Authorization: Bearer $CRON_SECRET" "https://<domain>/api/cron/tick?phase=confirm"` (today) or `?phase=plan` (tomorrow).

## Day-to-day config (`config/<client>.json`)
- `pool`: who can be on call. Add setters with `"role": "setter"` and their own GHL calendar as `availabilityCalendarId`. Set `"active": false` to pause someone.
- `coverage.firstHour` / `lastHour`: local hours (8 → 20 means 8 AM through the 8 PM hour, i.e. 8 AM ET to 5 PM PT).
- `coverage.days`: 0 = Sunday … 6 = Saturday.
- `coverage.headcount`: people per hour (`byHour` overrides `default`).
- `schedule.planHour` / `confirmHour`: local hours for the night-before plan and the morning confirm.
- `claim.escalateAfterMinutes`: when an unclaimed request goes to everyone.

## Adding another client
Copy `config/fig-n-eagle.json` to `config/<client>.json`, fill it in, and deploy a second Vercel project from the same repo with `HOT_SWAP_CLIENT=<client>` and that client's GHL token. The code is shared; the config, token, channel and data are separate.

## Not verified yet (test before relying on it)
1. **GHL block slot by user** (`POST /calendars/events/block-slots` with `assignedUserId`, no `calendarId`) actually stops round robin on calendars A/B from booking that person in that hour.
2. **Reassignment** (`PUT /calendars/events/appointments/{id}` with `assignedUserId`, `ignoreFreeSlotValidation`) changes the owner. Check what happens to the Zoom link and the confirmation messages the prospect gets.
3. **Cron plan**: the hourly cron needs Vercel Pro or Team (Hobby allows only daily crons). It checks local time itself, so daylight saving is handled.
4. The Slack and GHL flows (request, claim, release, volunteer) are only covered by unit tests for the planner, time zones and signature checks. Run them end to end on a test appointment before going live.

## Phase 2
- Zoom Server-to-Server app: on claim, add the receiver as alternative host on the original meeting so the prospect keeps their link.
- Ghost detection from the Zoom integration: if the assigned closer hasn't joined 3 min after start, auto-create a hot swap.
