# Trail Atlas

A personal activity visualizer that maps your Strava hikes, rides, runs, and trail runs on an interactive map. Routes you repeat glow brighter through overlapping trail lines, creating a natural heatmap of your most-traveled paths.

## Features

- **Multi-activity support** — Hikes, bike rides, runs, and trail runs, each with distinct color coding
- **Interactive map** — Smooth pinch-to-zoom, click any trail to highlight it and see details
- **Elevation profile** — Hover along the chart to see a marker trace the route on the map in real-time
- **Activity filtering** — Filter by type, search by name, or narrow by year
- **Landing page** — Overview of your total stats and activity breakdown
- **Strava OAuth** — Securely connects to your Strava account to sync activities

## Screenshots

| Landing Page | Map View | Elevation Profile |
|---|---|---|
| Stats + activity cards | Neon trail lines on Voyager basemap | Interactive hover with map marker |

## Setup

### Prerequisites

- Python 3.9+
- A [Strava API application](https://www.strava.com/settings/api) (free to create)
- A [Thunderforest API key](https://www.thunderforest.com/) (free tier available, optional — app falls back to CartoDB)

### Install

```bash
git clone https://github.com/neelgengje/strava-heatmap.git
cd strava-heatmap
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Configure

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```
STRAVA_CLIENT_ID=your_client_id
STRAVA_CLIENT_SECRET=your_client_secret
FLASK_SECRET_KEY=any_random_string
THUNDERFOREST_API_KEY=your_key_or_leave_blank
```

Set your Strava app's **Authorization Callback Domain** to `localhost` in the Strava API settings.

### Run

```bash
python app.py
```

Open [http://localhost:5001](http://localhost:5001) in your browser.

1. Click **Connect with Strava** to authorize
2. Click **Sync** to fetch your activities
3. Explore the map

## Tech Stack

- **Backend:** Python / Flask
- **Frontend:** Vanilla JS, Leaflet.js
- **Map tiles:** CartoDB Voyager
- **Data:** Strava API v3, cached locally as JSON

## Project Structure

```
app.py                  Flask backend — OAuth, activity sync, API routes
static/
  landing.html          Landing page
  app.html              Map application
  css/
    shared.css          Design tokens, nav bar, shared styles
    landing.css         Landing page styles
    app.css             Map app styles (sidebar, drawer, controls)
  js/
    config.js           Activity type definitions and color palettes
    landing.js          Landing page stats
    app.js              Map rendering, filtering, elevation profile
data/                   Local cache (gitignored)
  tokens.json           Strava OAuth tokens
  activities.json       Cached activity data
```

## Activity Types

| Type | Color | Strava Sport Types |
|---|---|---|
| Hikes | Hot pink | Hike, Walk, Hiking, BackcountrySki, NordicSki |
| Rides | Electric indigo | Ride, MountainBikeRide, GravelRide, EBikeRide |
| Runs | Neon orange | Run, VirtualRun |
| Trail Runs | Vivid purple | TrailRun |
