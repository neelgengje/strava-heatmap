"""
Trail Atlas — Strava sync tool
Pulls your Strava activities and writes static JSON files for the website.

Usage:
  python sync.py          # incremental (only new activities)
  python sync.py --full   # full re-sync from scratch

On first run: opens your browser for Strava login. After that, tokens are
cached in data/tokens.json and refresh automatically.

Output:
  site/data/activities.json
  site/data/stats.json
  site/data/streams/<id>.json  (one per activity, fetched incrementally)
"""

import argparse
import json
import math
import os
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import polyline as pl
import requests
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID     = os.environ['STRAVA_CLIENT_ID']
CLIENT_SECRET = os.environ['STRAVA_CLIENT_SECRET']
REDIRECT_URI  = 'http://localhost:5001/auth/callback'

TOKENS_FILE    = 'data/tokens.json'
ACTIVITIES_OUT = 'site/data/activities.json'
STATS_OUT      = 'site/data/stats.json'
STREAMS_DIR    = 'site/data/streams'

SPORT_TYPE_MAP = {
    'Hike': 'Hike', 'Walk': 'Hike', 'Hiking': 'Hike',
    'BackcountrySki': 'Hike', 'NordicSki': 'Hike',
    'Ride': 'Ride', 'MountainBikeRide': 'Ride',
    'GravelRide': 'Ride', 'EBikeRide': 'Ride', 'VirtualRide': 'Ride',
    'Run': 'Run', 'VirtualRun': 'Run',
    'TrailRun': 'TrailRun',
    'Kayaking': 'Kayak',
    'StandUpPaddling': 'SUP',
}

os.makedirs('data', exist_ok=True)
os.makedirs(STREAMS_DIR, exist_ok=True)


# ── Token management ──────────────────────────────────────────────────────────

def load_tokens():
    if os.path.exists(TOKENS_FILE):
        with open(TOKENS_FILE) as f:
            return json.load(f)
    return None

def save_tokens(data):
    with open(TOKENS_FILE, 'w') as f:
        json.dump(data, f)

def fresh_tokens():
    tokens = load_tokens()
    if not tokens:
        return None
    if tokens.get('expires_at', 0) - time.time() < 3600:
        print('Refreshing Strava token…')
        r = requests.post('https://www.strava.com/oauth/token', data={
            'client_id': CLIENT_ID,
            'client_secret': CLIENT_SECRET,
            'grant_type': 'refresh_token',
            'refresh_token': tokens['refresh_token'],
        })
        r.raise_for_status()
        tokens = r.json()
        save_tokens(tokens)
    return tokens


# ── OAuth (first-run only) ────────────────────────────────────────────────────

class _CallbackHandler(BaseHTTPRequestHandler):
    auth_code = None

    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        if 'code' in params:
            _CallbackHandler.auth_code = params['code'][0]
            body = b'<html><body style="font-family:sans-serif;padding:2rem"><h2>All set! You can close this tab.</h2></body></html>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(400)
            self.end_headers()

    def log_message(self, *args):
        pass  # suppress access log


def authenticate():
    """Open browser for Strava OAuth and wait for the callback."""
    auth_url = (
        'https://www.strava.com/oauth/authorize'
        f'?client_id={CLIENT_ID}'
        f'&redirect_uri={REDIRECT_URI}'
        '&response_type=code'
        '&approval_prompt=auto'
        '&scope=activity:read_all'
    )
    server = HTTPServer(('localhost', 5001), _CallbackHandler)
    print('Opening Strava login in your browser…')
    # Open browser slightly after server starts
    threading.Timer(0.5, webbrowser.open, args=[auth_url]).start()
    # Wait for the callback (one request only)
    while _CallbackHandler.auth_code is None:
        server.handle_request()
    server.server_close()

    code = _CallbackHandler.auth_code
    r = requests.post('https://www.strava.com/oauth/token', data={
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'code': code,
        'grant_type': 'authorization_code',
    })
    r.raise_for_status()
    save_tokens(r.json())
    print('Authenticated successfully.')


# ── Route simplification ────────────────────────────────────────────────────
# Strava's summary_polyline is already a lossy, fixed-precision reduction of
# the real GPS trace — for a switchback-heavy trail that can throw away real
# shape detail. Deriving coords from the full-resolution latlng stream (which
# we fetch anyway for the elevation chart) via our own tolerance-based RDP
# keeps a route's real corners in proportion to how much it actually curves,
# instead of Strava's fixed reduction losing detail on complex routes while
# over-representing straight ones.

METERS_PER_DEGREE_LAT = 111320

def _project_meters(latlng):
    lats = [p[0] for p in latlng]
    mid_lat = sum(lats) / len(lats)
    lng_scale = max(0.15, math.cos(mid_lat * math.pi / 180))
    return [(lng * lng_scale * METERS_PER_DEGREE_LAT, lat * METERS_PER_DEGREE_LAT) for lat, lng in latlng]

def _rdp(points, epsilon):
    """points: list of ((x, y), (lat, lng)) — decides which to keep using the
    projected (x, y) but returns the original (lat, lng), unprojected."""
    if len(points) < 3:
        return points
    (x1, y1), _ = points[0]
    (x2, y2), _ = points[-1]
    dx, dy = x2 - x1, y2 - y1
    length = (dx * dx + dy * dy) ** 0.5 or 1e-9
    max_dist, index = -1, 0
    for i in range(1, len(points) - 1):
        (x, y), _ = points[i]
        d = abs((x - x1) * dy - (y - y1) * dx) / length
        if d > max_dist:
            max_dist, index = d, i
    if max_dist > epsilon:
        left = _rdp(points[:index + 1], epsilon)
        right = _rdp(points[index:], epsilon)
        return left[:-1] + right
    return [points[0], points[-1]]

def simplify_latlng(latlng, epsilon_m=4):
    """Reduce a full-resolution [lat, lng] stream to its geometrically
    significant points, in a locally-projected meter space so epsilon has a
    consistent real-world meaning regardless of the route's latitude."""
    if len(latlng) < 3:
        return [[lat, lng] for lat, lng in latlng]
    paired = list(zip(_project_meters(latlng), latlng))
    return [[lat, lng] for (_, (lat, lng)) in _rdp(paired, epsilon_m)]


# ── Activity fetch & normalize ────────────────────────────────────────────────

def normalize_activity(a):
    category = SPORT_TYPE_MAP.get(a.get('sport_type'))
    if not category:
        return None
    poly = (a.get('map') or {}).get('summary_polyline', '')
    if not poly:
        return None
    coords = [[lat, lng] for lat, lng in pl.decode(poly)]
    moving_time  = a.get('moving_time', 0)
    distance_mi  = round(a['distance'] / 1609.34, 1)
    return {
        'id':           a['id'],
        'name':         a['name'],
        'date':         a['start_date_local'][:10],
        'distance_mi':  distance_mi,
        'elev_gain_ft': round(a.get('total_elevation_gain', 0) * 3.28084),
        'moving_time':  moving_time,
        'sport_type':   a['sport_type'],
        'category':     category,
        'speed_mph':    round(distance_mi / (moving_time / 3600), 1) if moving_time > 0 else 0,
        'pace_min_mi':  round(moving_time / 60 / distance_mi, 1) if distance_mi > 0 else 0,
        'coords':       coords,
    }


def fetch_new_activities(known_ids, headers):
    """Fetch from Strava newest-first, stop at first known ID."""
    new_acts, page, hit_known = [], 1, False
    while not hit_known:
        r = requests.get(
            'https://www.strava.com/api/v3/athlete/activities',
            headers=headers,
            params={'per_page': 200, 'page': page},
        )
        r.raise_for_status()
        batch = r.json()
        if not batch or not isinstance(batch, list):
            break
        for a in batch:
            if a['id'] in known_ids:
                hit_known = True
                break
            normalized = normalize_activity(a)
            if normalized:
                new_acts.append(normalized)
        if len(batch) < 200:
            break
        page += 1
    return new_acts


def compute_stats(activities):
    from collections import defaultdict
    years  = set()
    by_type = defaultdict(lambda: {'count': 0, 'miles': 0.0, 'elevation': 0})
    for a in activities:
        cat = a.get('category', 'Hike')
        by_type[cat]['count']     += 1
        by_type[cat]['miles']     += a['distance_mi']
        by_type[cat]['elevation'] += a['elev_gain_ft']
        years.add(a['date'][:4])
    return {
        'total':     len(activities),
        'miles':     round(sum(a['distance_mi'] for a in activities)),
        'elevation': round(sum(a['elev_gain_ft'] for a in activities)),
        'years':     len(years),
        'by_type':   dict(by_type),
    }


def fetch_stream(activity_id, headers):
    """Fetch altitude + distance + latlng stream for one activity."""
    r = requests.get(
        f'https://www.strava.com/api/v3/activities/{activity_id}/streams',
        headers=headers,
        params={'keys': 'altitude,distance,latlng', 'key_type': 'distance'},
    )
    if r.status_code != 200:
        return None
    streams = {s['type']: s['data'] for s in r.json()}
    return {
        'distance': streams.get('distance', []),
        'altitude': streams.get('altitude', []),
        'latlng':   streams.get('latlng', []),
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Sync Strava activities to site/data/')
    parser.add_argument('--full', action='store_true', help='Full re-sync from scratch')
    parser.add_argument('--rebuild-coords', action='store_true',
                         help='Re-derive coords for every cached activity from its already-'
                              'downloaded stream file (no API calls) instead of the summary_polyline')
    args = parser.parse_args()

    if args.rebuild_coords:
        rebuild_coords()
        return

    # Authenticate if needed
    if not load_tokens():
        authenticate()

    tokens = fresh_tokens()
    if not tokens:
        print('Authentication failed. Run again to retry.')
        sys.exit(1)

    headers = {'Authorization': f"Bearer {tokens['access_token']}"}

    # Load existing cache
    cached = []
    if not args.full and os.path.exists(ACTIVITIES_OUT):
        with open(ACTIVITIES_OUT) as f:
            cached = json.load(f)
        print(f'Loaded {len(cached)} cached activities.')
    else:
        print('Starting full sync…')

    known_ids = {a['id'] for a in cached}

    # Fetch new activities
    print('Fetching new activities from Strava…')
    new_acts = fetch_new_activities(known_ids, headers)
    print(f'Found {len(new_acts)} new activities.')

    # Streams first, before writing activities.json: the full-resolution
    # latlng stream lets us derive coords via our own tolerance-based
    # simplification instead of trusting Strava's summary_polyline, which is
    # already a fixed, lossy reduction that can lose real shape detail on
    # complex routes.
    if new_acts:
        print(f'Fetching elevation streams for {len(new_acts)} new activities…')
        for i, a in enumerate(new_acts, 1):
            stream_path = os.path.join(STREAMS_DIR, f"{a['id']}.json")
            if os.path.exists(stream_path):
                with open(stream_path) as f:
                    stream = json.load(f)
            else:
                stream = fetch_stream(a['id'], headers)
                if stream:
                    with open(stream_path, 'w') as f:
                        json.dump(stream, f)
                # Strava rate limit: 200 requests per 15 min. Sleep briefly between fetches.
                if i % 50 == 0:
                    print(f'  {i}/{len(new_acts)} — pausing 5s for rate limit…')
                    time.sleep(5)
            if stream and stream.get('latlng'):
                a['coords'] = simplify_latlng(stream['latlng'])

        print('Streams done.')

    all_acts = new_acts + cached  # newest-first

    # Write activities.json
    os.makedirs(os.path.dirname(ACTIVITIES_OUT), exist_ok=True)
    with open(ACTIVITIES_OUT, 'w') as f:
        json.dump(all_acts, f)
    print(f'Wrote {ACTIVITIES_OUT} ({len(all_acts)} activities).')

    # Write stats.json
    stats = compute_stats(all_acts)
    with open(STATS_OUT, 'w') as f:
        json.dump(stats, f)
    print(f'Wrote {STATS_OUT}.')

    print('\nAll done! Run `git add site/data && git push` to publish.')


def rebuild_coords():
    """One-time migration: re-derive coords for every activity already in
    activities.json from its local stream file (already downloaded for the
    elevation chart), no Strava API calls needed."""
    if not os.path.exists(ACTIVITIES_OUT):
        print(f'{ACTIVITIES_OUT} not found.')
        sys.exit(1)
    with open(ACTIVITIES_OUT) as f:
        activities = json.load(f)

    updated, missing = 0, 0
    for a in activities:
        stream_path = os.path.join(STREAMS_DIR, f"{a['id']}.json")
        if not os.path.exists(stream_path):
            missing += 1
            continue
        with open(stream_path) as f:
            stream = json.load(f)
        if not stream.get('latlng'):
            missing += 1
            continue
        a['coords'] = simplify_latlng(stream['latlng'])
        updated += 1

    with open(ACTIVITIES_OUT, 'w') as f:
        json.dump(activities, f)
    print(f'Rebuilt coords for {updated} activities ({missing} had no local stream, left as-is).')
    print(f'Wrote {ACTIVITIES_OUT}.')


if __name__ == '__main__':
    main()
