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

BACKFILL_WRITE_EVERY = 25  # how often --backfill-hr flushes activities.json mid-run

os.makedirs('data', exist_ok=True)
os.makedirs(STREAMS_DIR, exist_ok=True)


class RateLimited(Exception):
    """Raised on a 429 from Strava. Backfill loops catch this, flush whatever
    progress they've made, and stop — safe to just re-run the same command
    later, since progress is tracked by which fields are already present."""
    pass


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
        # Free on this same summary payload — no extra call needed.
        'avg_hr':       round(a['average_heartrate']) if a.get('average_heartrate') else None,
        'max_hr':       round(a['max_heartrate']) if a.get('max_heartrate') else None,
        # 'calories' is intentionally NOT set here — it isn't on the summary
        # payload (only the per-activity detail endpoint has it). Its
        # *presence* as a key is the backfill's resumability marker, so it
        # only gets set once a detail fetch for this activity actually
        # completes (see the new-activity loop in main() and backfill_hr()).
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
    """Fetch altitude + distance + latlng + heartrate stream for one activity."""
    r = requests.get(
        f'https://www.strava.com/api/v3/activities/{activity_id}/streams',
        headers=headers,
        params={'keys': 'altitude,distance,latlng,heartrate', 'key_type': 'distance'},
    )
    if r.status_code == 429:
        raise RateLimited()
    if r.status_code != 200:
        return None
    streams = {s['type']: s['data'] for s in r.json()}
    return {
        'distance':  streams.get('distance', []),
        'altitude':  streams.get('altitude', []),
        'latlng':    streams.get('latlng', []),
        # [] (not missing) when this activity has no HR data — that
        # distinguishes "fetched, nothing there" from "never fetched" for
        # the backfill's resumability check.
        'heartrate': streams.get('heartrate', []),
    }


def fetch_activity_detail(activity_id, headers):
    """Fetch the full activity detail — used only for `calories`, which
    isn't on the summary list payload `fetch_new_activities` uses."""
    r = requests.get(
        f'https://www.strava.com/api/v3/activities/{activity_id}',
        headers=headers,
    )
    if r.status_code == 429:
        raise RateLimited()
    if r.status_code != 200:
        return None
    return r.json()


# ── One-time HR/calorie backfill ────────────────────────────────────────────
# Existing activities predate avg/max HR, calories, and the HR stream. Three
# phases, each resumable by checking whether a record already carries the
# field that phase is responsible for — a failed fetch never sets that field,
# so re-running after an interruption or a 429 just continues where it left
# off instead of restarting.

def backfill_hr(headers, limit=None):
    if not os.path.exists(ACTIVITIES_OUT):
        print(f'{ACTIVITIES_OUT} not found — run a normal sync first.')
        sys.exit(1)
    with open(ACTIVITIES_OUT) as f:
        activities = json.load(f)
    by_id = {a['id']: a for a in activities}

    def save():
        with open(ACTIVITIES_OUT, 'w') as f:
            json.dump(activities, f)

    # ── Phase A: avg/max HR — free, comes off the summary list (~3 calls) ──
    print('Phase A: backfilling avg/max heart rate from the activity list…')
    page, updated = 1, 0
    while True:
        r = requests.get(
            'https://www.strava.com/api/v3/athlete/activities',
            headers=headers,
            params={'per_page': 200, 'page': page},
        )
        if r.status_code == 429:
            print('  Rate limited during Phase A — re-run `python sync.py --backfill-hr` to continue.')
            break
        r.raise_for_status()
        batch = r.json()
        if not batch or not isinstance(batch, list):
            break
        for summary in batch:
            a = by_id.get(summary['id'])
            if a is None or 'avg_hr' in a:
                continue
            a['avg_hr'] = round(summary['average_heartrate']) if summary.get('average_heartrate') else None
            a['max_hr'] = round(summary['max_heartrate']) if summary.get('max_heartrate') else None
            updated += 1
        if len(batch) < 200:
            break
        page += 1
    save()
    print(f'Phase A done: {updated} activities updated.')

    # ── Phase B: calories — one detail call per activity missing it (~419) ──
    todo = [a for a in activities if 'calories' not in a]
    if limit:
        todo = todo[:limit]
    print(f'Phase B: fetching calories for {len(todo)} activities…')
    for i, a in enumerate(todo, 1):
        try:
            detail = fetch_activity_detail(a['id'], headers)
        except RateLimited:
            save()
            print(f'  Rate limited at {i}/{len(todo)} — re-run `python sync.py --backfill-hr` to continue.')
            break
        if detail is not None:
            a['calories'] = round(detail['calories']) if detail.get('calories') is not None else None
        if i % BACKFILL_WRITE_EVERY == 0:
            save()
            print(f'  {i}/{len(todo)} calories fetched…')
        if i % 50 == 0:
            time.sleep(5)
    else:
        save()  # loop finished without breaking (or todo was empty) — final flush
    print('Phase B done.')

    # ── Phase C: per-second HR stream — skip activities with no HR at all ──
    todo = [a for a in activities if a.get('avg_hr') is not None]
    if limit:
        todo = todo[:limit]
    print(f'Phase C: fetching heart-rate streams for up to {len(todo)} activities…')
    fetched = skipped = 0
    for i, a in enumerate(todo, 1):
        stream_path = os.path.join(STREAMS_DIR, f"{a['id']}.json")
        existing = None
        if os.path.exists(stream_path):
            with open(stream_path) as f:
                existing = json.load(f)
            if 'heartrate' in existing:
                skipped += 1
                continue
        try:
            stream = fetch_stream(a['id'], headers)
        except RateLimited:
            print(f'  Rate limited at {i}/{len(todo)} — re-run `python sync.py --backfill-hr` to continue.')
            break
        if stream is None:
            continue
        # Merge, don't overwrite: keep whatever distance/altitude/latlng is
        # already on disk (coords were already derived from that latlng) and
        # only add the new heartrate array.
        merged = existing or {}
        merged['heartrate'] = stream.get('heartrate', [])
        merged.setdefault('distance', stream.get('distance', []))
        merged.setdefault('altitude', stream.get('altitude', []))
        merged.setdefault('latlng', stream.get('latlng', []))
        with open(stream_path, 'w') as f:
            json.dump(merged, f)
        fetched += 1
        if i % 50 == 0:
            print(f'  {i}/{len(todo)} — pausing 5s for rate limit…')
            time.sleep(5)
    print(f'Phase C done: {fetched} streams updated, {skipped} already had heart rate.')


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Sync Strava activities to site/data/')
    parser.add_argument('--full', action='store_true', help='Full re-sync from scratch')
    parser.add_argument('--rebuild-coords', action='store_true',
                         help='Re-derive coords for every cached activity from its already-'
                              'downloaded stream file (no API calls) instead of the summary_polyline')
    parser.add_argument('--backfill-hr', action='store_true',
                         help='One-time backfill of avg/max heart rate, calories, and the '
                              'per-second heart-rate stream for existing activities. Resumable '
                              '— safe to re-run after a rate limit or interruption.')
    parser.add_argument('--limit', type=int, default=None,
                         help='With --backfill-hr, cap the calorie/stream phases to this many '
                              'activities — use for a smoke test before the full run.')
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

    if args.backfill_hr:
        backfill_hr(headers, limit=args.limit)
        return

    # Load prior output, keyed by id — used below as a safety net so calorie/
    # HR backfill data survives a `--full` re-sync, which re-derives every
    # activity fresh from the summary payload (and that payload has no
    # `calories` field at all).
    prior_by_id = {}
    if os.path.exists(ACTIVITIES_OUT):
        with open(ACTIVITIES_OUT) as f:
            prior_by_id = {a['id']: a for a in json.load(f)}

    # Load existing cache
    cached = [] if args.full else list(prior_by_id.values())
    if cached:
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
        rate_limited_at = None
        for i, a in enumerate(new_acts, 1):
            stream_path = os.path.join(STREAMS_DIR, f"{a['id']}.json")
            try:
                if os.path.exists(stream_path):
                    with open(stream_path) as f:
                        stream = json.load(f)
                else:
                    stream = fetch_stream(a['id'], headers)
                    if stream:
                        with open(stream_path, 'w') as f:
                            json.dump(stream, f)
                if stream and stream.get('latlng'):
                    a['coords'] = simplify_latlng(stream['latlng'])

                # Calories aren't on the summary payload fetch_new_activities used —
                # one extra call per new activity (cheap, there are usually only a
                # handful). If this fails, 'calories' just stays unset and the next
                # sync or `--backfill-hr` run picks it up.
                #
                # Skip entirely if we already know it: under --full, every activity
                # looks "new" (known_ids is empty), so without this check a --full
                # re-sync would redo all ~419 calorie fetches every time instead of
                # just the genuinely new ones — the merge safety-net below would
                # still restore the value, but only after paying for the call.
                prior = prior_by_id.get(a['id'])
                if prior and 'calories' in prior:
                    pass
                else:
                    detail = fetch_activity_detail(a['id'], headers)
                    if detail is not None:
                        a['calories'] = round(detail['calories']) if detail.get('calories') is not None else None
            except RateLimited:
                rate_limited_at = i
                break

            # Strava rate limit: 200 requests per 15 min. Sleep briefly between fetches.
            if i % 50 == 0:
                print(f'  {i}/{len(new_acts)} — pausing 5s for rate limit…')
                time.sleep(5)

        if rate_limited_at:
            print(f'  Rate limited at {rate_limited_at}/{len(new_acts)} — remaining activities '
                  f'will pick up missing calories/streams on the next sync or `--backfill-hr` run.')
        print('Streams done.')

    all_acts = new_acts + cached  # newest-first

    # Safety net: carry forward calorie/HR fields fetch_new_activities can't
    # produce on its own (calories isn't on the summary payload; a `--full`
    # re-sync re-derives every activity from scratch and would otherwise lose
    # whatever --backfill-hr had already filled in).
    for a in all_acts:
        prior = prior_by_id.get(a['id'])
        if not prior:
            continue
        if 'calories' not in a and 'calories' in prior:
            a['calories'] = prior['calories']
        if a.get('avg_hr') is None and prior.get('avg_hr') is not None:
            a['avg_hr'] = prior['avg_hr']
            a['max_hr'] = prior['max_hr']

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
