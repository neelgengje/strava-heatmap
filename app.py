"""
Trail Atlas — Strava activity visualizer
- Real Strava OAuth + multi-activity fetch
- Run: python app.py  →  open http://localhost:5001
"""
import os, json, time
from flask import Flask, jsonify, redirect, request, url_for
from dotenv import load_dotenv
import requests
import polyline as pl

load_dotenv()

app = Flask(__name__, static_folder='static', static_url_path='')

CLIENT_ID     = os.environ['STRAVA_CLIENT_ID']
CLIENT_SECRET = os.environ['STRAVA_CLIENT_SECRET']
REDIRECT_URI  = 'http://localhost:5001/auth/callback'
TOKENS_FILE   = 'data/tokens.json'
CACHE_FILE    = 'data/activities.json'

SPORT_TYPE_MAP = {
    'Hike': 'Hike', 'Walk': 'Hike', 'Hiking': 'Hike',
    'BackcountrySki': 'Hike', 'NordicSki': 'Hike',
    'Ride': 'Ride', 'MountainBikeRide': 'Ride',
    'GravelRide': 'Ride', 'EBikeRide': 'Ride', 'VirtualRide': 'Ride',
    'Run': 'Run',
    'TrailRun': 'TrailRun', 'VirtualRun': 'Run',
}

os.makedirs('data', exist_ok=True)

# ---------- token helpers ----------

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
    if tokens['expires_at'] - time.time() < 3600:
        r = requests.post('https://www.strava.com/oauth/token', data={
            'client_id': CLIENT_ID,
            'client_secret': CLIENT_SECRET,
            'grant_type': 'refresh_token',
            'refresh_token': tokens['refresh_token'],
        })
        tokens = r.json()
        save_tokens(tokens)
    return tokens

# ---------- strava fetch ----------

def normalize_activity(a):
    """Strava activity → cache record. Returns None if it should be skipped."""
    category = SPORT_TYPE_MAP.get(a.get('sport_type'))
    if not category:
        return None
    poly = (a.get('map') or {}).get('summary_polyline', '')
    if not poly:
        return None
    coords = [[lat, lng] for lat, lng in pl.decode(poly)]
    moving_time = a.get('moving_time', 0)
    distance_mi = round(a['distance'] / 1609.34, 1)
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

def fetch_activities(known_ids=None):
    """Fetch activities from Strava, newest-first. Stops at the first activity
    whose ID is in `known_ids` (incremental sync). Pass an empty set / None
    for a full pull."""
    tokens = fresh_tokens()
    if not tokens:
        return None
    headers = {'Authorization': f"Bearer {tokens['access_token']}"}
    known_ids = known_ids or set()
    new_acts, page, hit_known = [], 1, False
    while not hit_known:
        r = requests.get(
            'https://www.strava.com/api/v3/athlete/activities',
            headers=headers,
            params={'per_page': 200, 'page': page},
        )
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

def load_cached():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE) as f:
            return json.load(f)
    return None

# ---------- routes ----------

@app.route('/')
def landing():
    return app.send_static_file('landing.html')

@app.route('/app')
def main_app():
    return app.send_static_file('app.html')

@app.route('/api/config')
def config():
    return jsonify({
        'thunderforest_key': os.environ.get('THUNDERFOREST_API_KEY', ''),
        'authenticated': load_tokens() is not None,
    })

@app.route('/auth/login')
def auth_login():
    url = (
        f"https://www.strava.com/oauth/authorize"
        f"?client_id={CLIENT_ID}"
        f"&redirect_uri={REDIRECT_URI}"
        f"&response_type=code"
        f"&approval_prompt=auto"
        f"&scope=activity:read_all"
    )
    return redirect(url)

@app.route('/auth/callback')
def auth_callback():
    code = request.args.get('code')
    if not code:
        return 'Authorization failed', 400
    r = requests.post('https://www.strava.com/oauth/token', data={
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'code': code,
        'grant_type': 'authorization_code',
    })
    save_tokens(r.json())
    return redirect('/app')

@app.route('/auth/logout')
def auth_logout():
    if os.path.exists(TOKENS_FILE):
        os.remove(TOKENS_FILE)
    if os.path.exists(CACHE_FILE):
        os.remove(CACHE_FILE)
    return redirect('/')

@app.route('/api/activities/sync')
def sync_activities():
    full = request.args.get('full') == '1'
    cached = [] if full else (load_cached() or [])
    known_ids = {a['id'] for a in cached}
    new_acts = fetch_activities(known_ids=known_ids)
    if new_acts is None:
        return jsonify({'error': 'not authenticated'}), 401
    merged = new_acts + cached  # both are newest-first
    with open(CACHE_FILE, 'w') as f:
        json.dump(merged, f)
    return jsonify({'count': len(merged), 'new': len(new_acts), 'full': full})

@app.route('/api/sport-types')
def sport_types():
    """Single source of truth for sport_type → category mapping."""
    return jsonify(SPORT_TYPE_MAP)

@app.route('/api/activities/<int:activity_id>/streams')
def activity_streams(activity_id):
    tokens = fresh_tokens()
    if not tokens:
        return jsonify({'error': 'not authenticated'}), 401
    headers = {'Authorization': f"Bearer {tokens['access_token']}"}
    r = requests.get(
        f'https://www.strava.com/api/v3/activities/{activity_id}/streams',
        headers=headers,
        params={'keys': 'altitude,distance,latlng', 'key_type': 'distance'},
    )
    if r.status_code != 200:
        return jsonify({'error': 'stream fetch failed'}), r.status_code
    streams = {s['type']: s['data'] for s in r.json()}
    return jsonify({
        'distance': streams.get('distance', []),
        'altitude': streams.get('altitude', []),
        'latlng':   streams.get('latlng', []),
    })

@app.route('/api/activities/stats')
def activity_stats():
    data = load_cached()
    if data is None:
        return jsonify({'total': 0, 'miles': 0, 'elevation': 0, 'years': 0, 'by_type': {}})
    by_type = {}
    years = set()
    for a in data:
        cat = a.get('category', 'Hike')
        if cat not in by_type:
            by_type[cat] = {'count': 0, 'miles': 0, 'elevation': 0}
        by_type[cat]['count'] += 1
        by_type[cat]['miles'] += a['distance_mi']
        by_type[cat]['elevation'] += a['elev_gain_ft']
        years.add(a['date'][:4])
    return jsonify({
        'total': len(data),
        'miles': round(sum(a['distance_mi'] for a in data)),
        'elevation': round(sum(a['elev_gain_ft'] for a in data)),
        'years': len(years),
        'by_type': by_type,
        'authenticated': load_tokens() is not None,
    })

@app.route('/api/activities')
def activities():
    data = load_cached()
    if data is None:
        return jsonify({'error': 'not synced'}), 404

    # Compute frequency per activity name
    from collections import Counter
    freq = Counter(a['name'] for a in data)
    result = [{**a, 'frequency': freq[a['name']], 'multi_park': False, 'parks': []} for a in data]
    return jsonify(result)

if __name__ == '__main__':
    app.run(debug=True, port=5001)
