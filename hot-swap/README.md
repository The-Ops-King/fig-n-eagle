# Hot Swap

Makes sure someone is always lined up to take a closer's call when the closer can't make it, and routes the handoff in Slack.

## What it does

| When | What happens |
|---|---|
| **9 PM ET** | DMs the manager only if some of tomorrow's hours are still uncovered. |
| **6 PM ET, night before** | Builds tomorrow's roster from GHL availability and **puts each on-call hour on that person's calendar** as an appointment on the "Hot Swap On-Call" GHL calendar. It syncs to their Google Calendar and makes them busy, so round robin can't book them (including overnight), posts "Tomorrow's hot-swap plan", . If any hour can't be filled, posts one **"still needs cover" board** tagging the pool **once**, with an "I'll cover" button per open hour; it's edited silently as hours fill and deleted when nothing is open. |
| **7 AM ET, morning of** | Re-checks today. Keeps everyone already assigned, fills any gaps with people who became free overnight, posts "Today's hot-swap roster", updates the board, and DMs the manager only if something is still open. |
| **"Can't make my hour"** | Removes their on-call appointment, marks the hour **NOT COVERED** on the roster, and posts an **"I'll cover"** button in the thread tagging whoever is free (or the manager if nobody is). Whoever clicks gets the hour. |
| **"Cover an hour"** | Anyone in the pool can take an hour that still needs people (up to its headcount), if their calendar is free. The hour already under way can be taken any time unless they have a call during the rest of it; its on-call appointment starts now. |
| **Hot swap request** (`/hotswap`, the global shortcut, or the roster button) | Closer picks one of their next calls. The bot tags whoever is on call that hour. **First to click "I've got it" wins**: the deal owner and contact owner move to them (they get the credit) and a note is added to the contact. The appointment stays on its calendar under the original closer, because GHL only lets calendar team members own appointments. No claim after 3 min: it escalates to the whole pool plus the manager. Calls starting within 3 min, or hours with nobody on call, go to everyone immediately. |

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
2. **Database**: Vercel → Storage → add **Neon Postgres** to the project (sets `DATABASE_URL`). Tables are created automatically on first use.
3. **GHL token**: in the sub-account, Settings → Private Integrations → new token with `calendars.readonly`, `calendars.write`, `calendars/events.readonly`, `calendars/events.write`, `contacts.readonly`, `contacts.write`, `opportunities.readonly`, `opportunities.write`, `users.readonly`. Use a dedicated token for this app.
4. **Slack app**: api.slack.com/apps → Create New App → From manifest → paste `slack-manifest.yaml` with your Vercel domain in place of `YOUR-DEPLOYMENT`. Install to the workspace. Invite the bot to the hot-transfer channel (`/invite @Hot Swap`).
5. **Env vars** (Vercel → Settings → Environment Variables), see `.env.example`:
   `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `CRON_SECRET`, `GHL_PIT_FIG_N_EAGLE`, `HOT_SWAP_CLIENT=fig-n-eagle`.
6. **Config**: `config/fig-n-eagle.json` has `slack.channelId` (currently #sd-call-transfer) and Slack IDs for David and Rosaline already set. For anyone else whose GHL email isn't their Slack email, set `slackUserId`.
7. Deploy. The database tables are created automatically on first use. To run the roster now instead of waiting for the schedule, the manager types `/hotswap roster` (today) or `/hotswap plan` (tomorrow) in Slack.

## The "Hot Swap On-Call" GHL calendar
On-call shifts are appointments on a dedicated GHL calendar (`ghl.onCall.calendarId`), booked against an internal contact (`ghl.onCall.contactId`, "Hot Swap On-Call"), with notifications off. Open that calendar in GHL to see everyone's shifts. It isn't in any calendar group, so workflows filtered to specific calendars or groups don't fire. The app adds and removes team members on it automatically to match the pool.

## Who's in the pool
- **Closers, automatically:** every active calendar in the GHL calendar group `pool.closerCalendarGroupId` (Fig & Eagle: *Family Clarity Calls*) is one closer, and their availability is read from that calendar. Onboarding a closer = creating their calendar in that group, which you already do. Deactivating or removing it takes them out.
- **From Slack (manager only):** `/hotswap add @name` adds anyone (e.g. a setter); `/hotswap remove @name` takes someone out and frees their remaining hours. People added without a personal calendar count as available for all coverage hours except where they have appointments. `/hotswap pool` lists everyone.
- The app keeps the Hot Swap On-Call calendar's team in sync with the pool on every roster run.
- Slack is matched to GHL by email. If someone's emails differ, map them in `pool.slackUserIds` (`{ "ghlUserId": "SlackUserId" }`).

## Slash commands
| Command | Who | What |
|---|---|---|
| `/hotswap` | anyone | request a hot swap for one of your upcoming calls |
| `/hotswap pool` | anyone | list the pool |
| `/hotswap help` | anyone | explain commands and buttons |
| `/hotswap today` / `/hotswap tomorrow` | manager | build or refresh the roster now (edits the existing message) |
| `/hotswap add @name` / `/hotswap remove @name` | manager | change the pool |
| `/hotswap insights [days]` | manager | last 7 (or N) days: % of hours fully covered and which hours run short; swaps requested/claimed/never claimed, median time to claim; who hands off, takes, picks up and releases the most |
| `/hotswap dates` | manager | coverage exceptions: turn a date off or set custom hours (holidays), or set a weekly rule for a weekday (weekends). Date rules beat weekly rules, which beat the config. Changes to today/tomorrow apply immediately: on-call appointments outside the new hours are cancelled and new hours are filled. |

## Day-to-day config (`config/<client>.json`)
- `pool.include` / `pool.exclude`: permanent additions/removals in code (Slack commands are usually easier).
- `coverage.firstHour` / `lastHour`: local hours (8 → 20 means 8 AM through the 8 PM hour, i.e. 8 AM ET to 5 PM PT).
- `coverage.days`: 0 = Sunday … 6 = Saturday.
- `coverage.headcount`: people per hour (`byHour` overrides `default`).
- `coverage.minFreeMinutes`: how long someone must be free from the top of an hour to cover it (default 45, one call).
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
