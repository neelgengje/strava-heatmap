# Agent instructions: fork this dashboard for a new user

This file is for an AI coding agent, not a human reading a tutorial. If you are that
agent and someone has pointed you at this repo asking you to "set up my own version,"
follow the phases below in order. Each phase ends with a command whose output tells
you whether to proceed. Use your ask-user tool at every point marked **ASK USER**;
do not guess these answers or invent your own defaults.

Do not skip Phase 1. This repo ships with the original owner's personal Strava data
committed to it, and every fork must wipe that data before syncing new data over it.

---

## Phase 0 — confirm the environment

Run:

```bash
python3 --version   # need 3.9+
git status           # must be a clean working tree before you start deleting files
```

If `git status` shows uncommitted changes that aren't yours to discard, stop and tell
the user, since Phase 1 deletes files.

---

## Phase 1 — strip the previous owner's data

This repo tracks `site/data/activities.json`, `site/data/stats.json`, and every file
under `site/data/streams/*.json` in git. Those are one specific person's activities,
photos of their local trails effectively. Plain `python sync.py` treats existing data
as a cache and will **merge** the new user's activities into the old owner's, silently
producing a hybrid dataset. You must delete these first:

```bash
rm -f site/data/activities.json site/data/stats.json
rm -f site/data/streams/*.json
```

Verify:

```bash
ls site/data/streams/ | wc -l   # should print 0
```

Do not delete `site/css/`, `site/js/`, `site/index.html`, `site/app.html` — those are
the application code, not data.

---

## Phase 2 — ask what kind of deployment the user wants

**ASK USER** (single question, required before continuing):

> Do you want this dashboard as a local HTML file you open yourself, or deployed to a
> public website?
> - Local only — view it on your own machine, no hosting
> - Deployed to a website — recommend Cloudflare Pages (free, matches this repo's
>   design: static files, auto-deploys on `git push`, no server). GitHub Pages is a
>   fine alternative if they already use it for other projects.

Both paths need everything in Phases 3–6 below (Strava API access and a local sync
script run are required either way — "local" only changes the very last step). Do not
imply there's a shortcut that skips the Strava app or the Python sync.

Record the answer; you'll act on it in Phase 7.

---

## Phase 3 — collect Strava API credentials

**ASK USER**, explain first, then ask:

> To pull your activities, you need your own Strava API application (free, takes
> 2 minutes). Go to https://www.strava.com/settings/api and create one. For
> "Authorization Callback Domain," enter exactly: `localhost` — no `http://`, no
> port, no trailing slash. Then paste me your Client ID and Client Secret.

Ask for:
1. Strava Client ID
2. Strava Client Secret

Do not print these back into chat or logs beyond what's needed to write the `.env`
file. Write them into a new `.env` file at the repo root:

```
STRAVA_CLIENT_ID=<their client id>
STRAVA_CLIENT_SECRET=<their client secret>
```

(`FLASK_SECRET_KEY` and `THUNDERFOREST_API_KEY` in `.env.example` are unused by this
codebase — nothing in `sync.py` or `site/` reads them. Do not ask the user for a
Thunderforest key; it's a stale leftover in the example file.)

Confirm `.env` is gitignored before moving on:

```bash
git check-ignore .env   # must print ".env" — if it prints nothing, stop and warn the user
```

---

## Phase 4 — ask what activities to include

**ASK USER** (multiSelect):

> Which activity types should count toward your dashboard? (You can pick more than
> one — this repo currently supports these categories.)
> - Hikes (Strava: Hike, Walk, BackcountrySki, NordicSki)
> - Rides (Strava: Ride, MountainBikeRide, GravelRide, EBikeRide, VirtualRide)
> - Runs (Strava: Run, VirtualRun)
> - Trail Runs (Strava: TrailRun)
> - Kayak (Strava: Kayaking)
> - Stand Up Paddle (Strava: StandUpPaddling)
> - Other — I want to add a Strava sport type not listed here

If the user picks "Other," ask for the exact Strava `sport_type` string(s) (they can
find these on individual activity pages, or you can rely on their description — e.g.
"Swim", "AlpineSki") and pick a display label and hex color together with the user
before writing code.

If the user wants to **exclude** a type that's currently mapped (e.g. they only want
Runs and Rides, not Hikes), that's a filtering decision, not a data decision — leave
`sync.py`'s `SPORT_TYPE_MAP` as-is and don't remove hike support from `config.js`. It's
simpler to let unwanted activity types just not appear if the user never did that
Strava sport, and the site's UI filter already lets the user filter by type at view
time. Only edit the two mapping files below if the user's Strava history contains a
sport type genuinely not covered by the current map, or asks for a custom category.

If editing is needed, both of these must be changed together (they use the same
category keys) or activities will either drop out of the sync or lose their color/icon
in the UI:

- `sync.py` — `SPORT_TYPE_MAP` (around line 44): maps Strava `sport_type` strings to
  a category key.
- `site/js/config.js` — `ACTIVITY_TYPES` (near the top): defines label, icon, color,
  and stats shown per category key.

Also update the activity-type table in `README.md` if you change either.

---

## Phase 5 — units and branding (optional, ask, don't assume)

**ASK USER**:

> Two cosmetic things before we sync your data:
> 1. This dashboard shows distance in miles and elevation in feet (hardcoded — there's
>    no built-in metric mode). Is imperial fine, or do you need metric units?
> 2. Do you want to rename the site from "Trail Atlas" to something else, and update
>    the page title/branding?

If they want metric: the unit conversions live in `sync.py`'s `normalize_activity()`
function (`distance / 1609.34` for miles, `* 3.28084` for feet) plus the field names
`distance_mi`/`elev_gain_ft` are read throughout `site/js/`. Converting cleanly means
changing the conversion factors (drop them, i.e. divide by 1000 for km instead) *and*
every display string in `site/js/` and `site/*.html` that prints "mi" or "ft" — this
touches several files. Confirm the user actually wants this (non-trivial) before
starting; if they say "just leave it in miles," skip this entirely.

If they want rebranding: search for "Trail Atlas" and the previous owner's name across
`site/index.html`, `site/app.html`, and `README.md`, and replace with their name/title.
Also replace `og-image.png`/`favicon.svg` only if they supply new ones — don't
regenerate assets on your own judgment.

---

## Phase 6 — install dependencies and run the sync

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Run a smoke test first, not a full sync — Strava's API allows 200 requests per 15
minutes and roughly 2000/day, and this sync makes ~2 calls per activity (stream +
detail). A first-time full history sync on an active athlete can burn through the
daily cap.

```bash
python sync.py
```

This opens a browser window for Strava login on first run (the local callback server
listens on `localhost:5001` — this must match the callback domain from Phase 3) and
then fetches **all** activities, since there's no prior cache after Phase 1's wipe.
Let it run. If it prints something like:

```
Rate limited at N/M — remaining activities will pick up missing calories/streams
on the next sync or `--backfill-hr` run.
```

that's expected and resumable, not a failure — just re-run `python sync.py` after
15 minutes (or the next day if the daily cap was hit). Do not try to "fix" a 429;
re-running picks up exactly where it left off.

After a successful run, confirm output exists:

```bash
python3 -c "import json; d=json.load(open('site/data/activities.json')); print(len(d), 'activities')"
```

---

## Phase 7 — verify locally

The site is static and fetches JSON via `fetch()`, which fails under a bare `file://`
URL in Chrome/Edge due to CORS-on-local-files restrictions. Serve it:

```bash
cd site && python3 -m http.server 8000
```

Open `http://localhost:8000/index.html`, then click through to the map view and
confirm activities render. Then stop the server (Ctrl+C) and `cd` back to the repo
root.

Run the data-independent test suites (these don't assume the original owner's data,
unlike the visual/E2E suites — see note below):

```bash
python -m pytest tests/test_sync.py tests/test_data_integrity.py
```

Do **not** run `tests/test_visual.py` or `tests/test_e2e.py` as a pass/fail gate for
a new user's data — their snapshots and fixtures were captured against the original
owner's specific activities and will legitimately fail on different data. If the user
wants those suites working for their own fork, that means running them with
`--update-snapshots` to regenerate baselines against their own data and reviewing the
new screenshots — treat that as a separate, optional task, not part of this setup.

---

## Phase 8 — deploy (only the step that differs by Phase 2's answer)

### If the user chose "local only"

Nothing further to do. Tell them how to view it going forward:

```bash
cd site && python3 -m http.server 8000
```

And how to pull new activities later:

```bash
python sync.py   # incremental — only fetches activities newer than what's cached
```

### If the user chose "deployed to a website" (Cloudflare Pages)

There is no config file for this in the repo (no `wrangler.toml`) — it's entirely
dashboard-driven:

1. **ASK USER** to confirm they have (or will create) a GitHub repo containing their
   fork, and that they're logged into a Cloudflare account. Do not create a Cloudflare
   account or GitHub repo on their behalf without explicit confirmation — account
   creation and repo creation are actions to confirm, not assume.
2. Push their forked repo to GitHub if not already there.
3. In the Cloudflare dashboard: Workers & Pages → Create → Pages → Connect to Git →
   select their repo.
4. Build settings: **Framework preset: None. Build command: (leave empty). Build
   output directory: `site`.**
5. Deploy. Cloudflare gives a `*.pages.dev` URL; a custom domain can be attached
   afterward in the project's Custom domains tab if the user has one — ask if they
   want to do that now or later.
6. Ongoing updates: running `python sync.py` locally and then `git push` triggers a
   new Cloudflare Pages deploy automatically (~30s). Tell the user this replaces
   manual redeploys going forward.

### If the user chose GitHub Pages instead

1. Confirm their fork lives in a GitHub repo.
2. Repo Settings → Pages → Source: deploy from a branch → select `main` and set the
   folder to `/site` if GitHub Pages offers a subdirectory picker; otherwise it needs
   `site/` promoted to repo root or a `docs/` rename, since GitHub Pages only serves
   from repo root or `/docs`. Decide with the user which restructuring they're willing
   to do before touching the repo layout — don't restructure silently.

---

## Phase 9 — hand off

Summarize for the user in plain language, not a wall of command output:
- How many activities synced and which categories they cover
- Where the site is viewable now (local URL or deployed URL)
- The one command to run after every new activity (`python sync.py`, then `git push`
  if deployed)
- Anything from Phase 4/5 you deferred (e.g. metric units not implemented, a custom
  Strava sport type not yet mapped) so it isn't silently forgotten
