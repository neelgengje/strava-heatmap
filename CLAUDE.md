# Strava Heatmap — Claude Context

## Project Goal
Build a local web app that visualizes hiking activity data from Strava on an interactive map, with California and US national park boundary overlays. Highlight hikes that crossed multiple parks.

## Status
- [ ] GitHub repo created: neelgengje/strava-heatmap
- [ ] Project files not yet created — start implementation from scratch

## Implementation Plan
See `PLAN.md` for the full detailed plan. Summary:

**Stack:** Python/Flask backend + Vanilla JS + Leaflet.js frontend

**File structure to create:**
```
strava-heatmap/
├── app.py
├── .env.example
├── .gitignore
├── requirements.txt
├── routes/auth.py, activities.py, parks.py
├── services/strava.py, cache.py, decoder.py, spatial.py
├── scripts/download_parks.py
├── data/parks/   (directory, files downloaded by script)
└── static/index.html, css/main.css, js/map.js, layers.js, sidebar.js, api.js
```

**Key decisions already made:**
- Use `summary_polyline` from Strava list endpoint (no extra API calls needed)
- Decode polylines server-side with `polyline` Python lib
- Park boundaries: NPS ArcGIS (national) + CDPR shapefile (CA state parks)
- Heatmap via `leaflet-heat`; polylines via Leaflet Canvas renderer
- Shapely for spatial intersection (which hikes crossed which parks)
- Token storage in `data/tokens.json` (flat file, not session)

**User:** Juhi Panchal — avid hiker in Bay Area/California, all hikes on Strava. GitHub username: neelgengje.

## What to Do Next (after restart)
1. Create all project files per the plan
2. Start with: `.gitignore`, `requirements.txt`, `.env.example`, `app.py`
3. Then routes → services → scripts → static files
4. Tell user to register Strava API app and set up `.env` before testing
