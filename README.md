# Trail Atlas

**[neelgengje.com](https://neelgengje.com)**

A personal activity visualizer that maps years of Strava data on an interactive map.
Routes you repeat glow brighter through overlapping trail lines, creating a natural
heatmap of your most-traveled paths.

![Trail Atlas Map](https://neelgengje.com/og-image.png)

## Features

- **Multi-activity support** — Hikes, rides, runs, trail runs, kayak, and SUP, each with distinct color coding
- **Interactive map** — Smooth pinch-to-zoom, click any trail to highlight it and see details
- **Elevation profile** — Hover along the chart to see a live marker trace the route on the map
- **Heart rate + calories** — Per-second HR streams and calorie totals in the detail panel
- **Activity filtering** — Filter by type, search by name, or narrow by year
- **Landing page** — Stats overview and activity breakdown
- **No login required** — Fully public static site, no server

## How it works

Activities are synced locally with `sync.py`, which pulls from the Strava API and
writes static JSON files. The site is pure HTML/CSS/JS, no backend, no database.
Deployed on Cloudflare Pages and auto-updates on every `git push`.

```
After a hike:
  python sync.py       ← pulls new activities from Strava
  git push origin main ← Cloudflare Pages deploys in ~30s
```

## Tech Stack

- **Frontend:** Vanilla JS, Leaflet.js, CartoDB Voyager tiles
- **Sync:** Python — Strava API v3, incremental fetch, OAuth via local callback
- **Hosting:** Cloudflare Pages (static, always-on, free)
- **Data:** Pre-built JSON files committed to the repo

## Project Structure

```
sync.py               Pull Strava activities → write static JSON
site/
  index.html          Landing page
  app.html            Map application
  css/
    shared.css        Design tokens, nav, shared styles
    landing.css        Landing page styles
    dashboard-core.css Map app core styles
    dashboard-layout.css Map app layout (sidebar, drawer, controls)
    app.css            Map app overrides
  js/
    config.js          Activity type definitions and color palettes
    landing.js          Landing page — reads stats.json
    track.js            Landing page cursor-track animation
    dashboard/
      engine.js          Map rendering engine
      data.js            Data loading/normalization
      app-controller.js  Filtering, selection, elevation profile wiring
      shell.js            Layout/drawer shell
      pins.js              Map pin rendering
      profile.js           Elevation profile chart
      icons.js              Icon rendering
      year-select.js         Year filter dropdown
      sport-select.js        Activity type filter dropdown
  data/
    activities.json     All activity data (coords, stats, metadata)
    stats.json           Aggregated totals for the landing page
    streams/              Per-activity elevation + GPS + heart-rate streams
```

## Activity Types

| Type | Color | Strava Sport Types |
|---|---|---|
| Hikes | Hot pink | Hike, Walk, BackcountrySki, NordicSki |
| Rides | Electric indigo | Ride, MountainBikeRide, GravelRide, EBikeRide, VirtualRide |
| Runs | Neon orange | Run, VirtualRun |
| Trail Runs | Vivid purple | TrailRun |
| Kayak | Cyan | Kayaking |
| Stand Up Paddle | Green | StandUpPaddling |

## Local sync setup

To run `sync.py` yourself you need a [Strava API application](https://www.strava.com/settings/api) and a `.env` file:

```
STRAVA_CLIENT_ID=your_client_id
STRAVA_CLIENT_SECRET=your_client_secret
```

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python sync.py        # opens browser for Strava login on first run
```

## Forking this for your own data

Want to build the same dashboard with your own Strava history? Point an AI coding
agent at [`AGENT_SETUP.md`](AGENT_SETUP.md) — it walks the agent through wiping this
repo's sample data, connecting your Strava account, choosing which activity types to
include, and deploying (locally or to Cloudflare Pages/GitHub Pages).

## Testing

Four independent suites, no build step for the site itself either way.

**Setup (one-time):**

```bash
pip install -r requirements-dev.txt
playwright install chromium
npm install              # only for tests/js/*, which need jsdom
```

**Run everything:**

```bash
python -m pytest tests/          # sync.py logic, E2E, data integrity, visual regression
node --test                      # pure JS + DOM-component tests (site/js/)
```

| Suite | Location | What it covers |
|---|---|---|
| `sync.py` unit/integration | `tests/test_sync.py` | RDP route simplification, activity normalization, the new-activity calorie fetch, and the `--backfill-hr`/`--full` resumability contracts (mocked network — no real Strava calls) |
| Data integrity | `tests/test_data_integrity.py` | Sweeps every committed file in `site/data/` (not a sample) — stream array-length consistency, required fields, HR activities have a matching stream, valid coordinates |
| Browser E2E | `tests/test_e2e.py` | Selecting an activity, the HR chart toggle (mouse *and* real touch events), closing the panel, and the phone-width map/list view — against a real Chromium instance and a throwaway local server |
| Visual regression | `tests/test_visual.py` | Screenshot diffing for the detail panel (HR on/off/absent) and the mobile list/map views — catches spacing/centering regressions functional tests can't. First run per snapshot writes a baseline instead of comparing; review it, then commit `tests/__snapshots__/*.png`. Update deliberately with `--update-snapshots` |
| JS pure functions & DOM components | `tests/js/*.test.js` | `config.js`/`dashboard/data.js`/`dashboard/engine.js`/`dashboard/app-controller.js`'s non-DOM logic, `dashboard/icons.js`, plus `dashboard/year-select.js`/`dashboard/sport-select.js`'s real DOM behavior via jsdom (Node's built-in test runner, no npm needed beyond jsdom itself) |

Run a single suite or test the usual pytest/node ways, e.g. `python -m pytest tests/test_sync.py -k backfill` or `node --test tests/js/config.test.js`.
