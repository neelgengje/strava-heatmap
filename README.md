# Trail Atlas

**[neelgengje.com](https://neelgengje.com)**

A personal activity visualizer that maps 8 years of Strava data — 379 activities, 2,806 miles, 345K ft of elevation — on an interactive map. Routes you repeat glow brighter through overlapping trail lines, creating a natural heatmap of your most-traveled paths.

![Trail Atlas Map](https://neelgengje.com/og-image.png)

## Features

- **Multi-activity support** — Hikes, bike rides, runs, and trail runs, each with distinct color coding
- **Interactive map** — Smooth pinch-to-zoom, click any trail to highlight it and see details
- **Elevation profile** — Hover along the chart to see a live marker trace the route on the map
- **Activity filtering** — Filter by type, search by name, or narrow by year
- **Landing page** — Stats overview and activity breakdown
- **No login required** — Fully public static site, no server

## How it works

Activities are synced locally with `sync.py`, which pulls from the Strava API and writes static JSON files. The site is pure HTML/CSS/JS — no backend, no database. Deployed on Cloudflare Pages and auto-updates on every `git push`.

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
    landing.css       Landing page styles
    app.css           Map app styles (sidebar, drawer, controls)
  js/
    config.js         Activity type definitions and color palettes
    landing.js        Landing page — reads stats.json
    app.js            Map rendering, filtering, elevation profile
  data/
    activities.json   All activity data (coords, stats, metadata)
    stats.json        Aggregated totals for the landing page
    streams/          Per-activity elevation + GPS streams
```

## Activity Types

| Type | Color | Strava Sport Types |
|---|---|---|
| Hikes | Hot pink | Hike, Walk, BackcountrySki, NordicSki |
| Rides | Electric indigo | Ride, MountainBikeRide, GravelRide, EBikeRide |
| Runs | Neon orange | Run, VirtualRun |
| Trail Runs | Vivid purple | TrailRun |

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

## Testing

Five independent suites, no build step for the site itself either way.

**Setup (one-time):**

```bash
pip install -r requirements-dev.txt
playwright install chromium
npm install              # only for tests/js/*-select.test.js, which need jsdom
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
| JS pure functions & DOM components | `tests/js/*.test.js` | `config.js`/`data.js`/`engine.js`/`app-controller.js`'s non-DOM logic (Node's built-in test runner, no npm needed) plus `year-select.js`/`sport-select.js`'s real DOM behavior via jsdom |

Run a single suite or test the usual pytest/node ways, e.g. `python -m pytest tests/test_sync.py -k backfill` or `node --test tests/js/config.test.js`.
