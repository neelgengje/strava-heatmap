# Strava Hiking Heatmap — Implementation Plan

## Context
The user is an avid hiker who uploads activities to Strava. They want a local webpage that:
1. Pulls all their hiking/walking/trail-run activities from Strava
2. Displays a heatmap of GPS tracks on an interactive map
3. Overlays California state park and US national park boundaries
4. Highlights hikes that crossed multiple parks

## Architecture

**Backend:** Python/Flask — handles Strava OAuth, API fetching, polyline decoding, and spatial intersection analysis  
**Frontend:** Vanilla JS + Leaflet.js (free, no API key) — map rendering, heatmap, overlays  
**Storage:** Local JSON files (`data/`) — tokens, cached activities, decoded coords

## File Structure

```
strava-heatmap/
├── app.py                      # Flask entry point
├── .env                        # STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET (gitignored)
├── .env.example
├── .gitignore
├── requirements.txt
├── routes/
│   ├── auth.py                 # /auth/login, /auth/callback, /auth/logout, /auth/status
│   ├── activities.py           # /api/activities (GeoJSON), /api/activities/sync
│   └── parks.py                # /api/parks/national, /api/parks/state
├── services/
│   ├── strava.py               # Strava API client: token refresh, paginated fetch
│   ├── cache.py                # Read/write tokens.json and activities.json
│   ├── decoder.py              # Decode Google-encoded polylines via `polyline` lib
│   └── spatial.py              # Shapely intersection: hike route vs. park polygons
├── scripts/
│   └── download_parks.py       # One-time: fetch NPS GeoJSON + convert CA State Parks shapefile
├── data/
│   ├── tokens.json             # OAuth tokens (auto-generated, gitignored)
│   ├── activities.json         # Cached activities with decoded coords (gitignored)
│   └── parks/
│       ├── national_parks_ca.geojson
│       └── ca_state_parks.geojson
└── static/
    ├── index.html
    ├── css/main.css
    └── js/
        ├── map.js              # Leaflet init, OSM tiles, layer control
        ├── layers.js           # Heatmap layer, polyline tracks, park overlays
        ├── sidebar.js          # Activity list, multi-park hikes panel
        └── api.js              # fetch() wrappers for Flask endpoints
```

## Key Implementation Details

### Strava OAuth
- Flow: `/auth/login` → Strava authorize page → `/auth/callback` → token saved to `data/tokens.json`
- Scope: `activity:read_all`
- Auto-refresh: check `expires_at` before every API call; silently refresh if within 1 hour of expiry

### Activity Sync
- Fetch all activities via `GET /athlete/activities` with `per_page=200`, paginate until < 200 results returned
- Filter: keep only `sport_type` in `{Hike, Walk, TrailRun, Hiking}`
- Use **summary_polyline** from list response (no extra API calls needed for heatmap)
- Decode polylines server-side with `polyline.decode()` → store `[[lng, lat], ...]` arrays in cache

### Park Boundaries
- **US National Parks (CA):** Query NPS ArcGIS FeatureServer (Layer 2) with `STATE='CA'` filter → save `national_parks_ca.geojson`
- **CA State Parks:** Download official CDPR shapefile ZIP from parks.ca.gov, convert to GeoJSON via `geopandas` with reprojection to WGS84; simplify geometries with `shapely.simplify(tolerance=0.001)` to reduce file size ~80%
- Both downloaded once by `scripts/download_parks.py`; served statically at runtime

### Spatial Intersection (multi-park hike detection)
- Load park geometries into Shapely at app startup (module-level, loaded once)
- For each activity: build `shapely.LineString` from decoded coords, buffer park polygons by `0.0005°` (~50m) to account for GPS drift
- `intersecting_parks: [park_name, ...]` stored in each activity's cache entry
- Activities with `len(intersecting_parks) >= 2` = multi-park hikes

### Frontend Map
- **Heatmap:** `leaflet-heat` — all GPS points as `[lat, lng, intensity]` (overview mode)
- **Polyline tracks:** Canvas renderer for performance; multi-park hikes colored orange (`#ff6600`), others blue (`#3388ff`), opacity 0.5
- **Park overlays:** Two toggleable GeoJSON layers (national = dark green, state = light green), with name tooltips
- **Auto-switch:** zoom < 11 → heatmap; zoom ≥ 11 → polylines
- **Sidebar tabs:** "All Hikes" list (scrollable) + "Multi-Park Hikes" panel

## Requirements (`requirements.txt`)
```
Flask==3.0.3
requests==2.32.3
polyline==2.0.2
shapely==2.0.5
geopandas==1.0.1
python-dotenv==1.0.1
```

## GitHub Repository
- Username: `neelgengje`
- Repo name: `strava-heatmap` (public or private)
- Create via `gh repo create neelgengje/strava-heatmap`

## Setup Steps (for the user)

1. **Register Strava API app** at `https://www.strava.com/settings/api`  
   - Callback domain: `localhost`  
   - Note Client ID + Client Secret

2. **Create `.env`** with:
   ```
   STRAVA_CLIENT_ID=your_id
   STRAVA_CLIENT_SECRET=your_secret
   FLASK_SECRET_KEY=any_random_string
   ```

3. **Install dependencies:**
   ```bash
   python3 -m venv venv && source venv/bin/activate
   pip install -r requirements.txt
   ```

4. **Download park boundaries (one-time):**
   ```bash
   python scripts/download_parks.py
   ```

5. **Run the app:**
   ```bash
   python app.py
   # Open http://localhost:5000
   ```

6. Click "Connect with Strava" → approve → click "Sync Activities"

## Verification
- After sync, map should show colored polylines across Bay Area/CA trails
- Toggle park overlays on/off — green polygons appear for state/national parks
- "Multi-Park Hikes" tab lists hikes that crossed 2+ parks, highlighted orange on map
- Clicking a polyline shows popup with hike name, date, distance, parks crossed
- Zoom out to see heatmap density; zoom in to see individual trails
