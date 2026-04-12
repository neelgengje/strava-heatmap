"""
Prototype: strava-heatmap
- Real Strava OAuth + activity fetch
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
SPORT_TYPES   = {'Hike', 'Walk', 'TrailRun', 'Hiking', 'BackcountrySki', 'NordicSki'}

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

def fetch_activities():
    tokens = fresh_tokens()
    if not tokens:
        return None
    headers = {'Authorization': f"Bearer {tokens['access_token']}"}
    activities, page = [], 1
    while True:
        r = requests.get(
            'https://www.strava.com/api/v3/athlete/activities',
            headers=headers,
            params={'per_page': 200, 'page': page},
        )
        batch = r.json()
        if not batch or not isinstance(batch, list):
            break
        for a in batch:
            if a.get('sport_type') not in SPORT_TYPES:
                continue
            poly = (a.get('map') or {}).get('summary_polyline', '')
            if not poly:
                continue
            coords = [[lat, lng] for lat, lng in pl.decode(poly)]
            activities.append({
                'id':           a['id'],
                'name':         a['name'],
                'date':         a['start_date_local'][:10],
                'distance_mi':  round(a['distance'] / 1609.34, 1),
                'elev_gain_ft': round(a.get('total_elevation_gain', 0) * 3.28084),
                'sport_type':   a['sport_type'],
                'coords':       coords,
            })
        if len(batch) < 200:
            break
        page += 1
    with open(CACHE_FILE, 'w') as f:
        json.dump(activities, f)
    return activities

def load_cached():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE) as f:
            return json.load(f)
    return None

# ---------- routes ----------

@app.route('/')
def index():
    return app.send_static_file('index.html')

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
    return redirect('/')

@app.route('/auth/logout')
def auth_logout():
    if os.path.exists(TOKENS_FILE):
        os.remove(TOKENS_FILE)
    if os.path.exists(CACHE_FILE):
        os.remove(CACHE_FILE)
    return redirect('/')

@app.route('/api/activities/sync')
def sync_activities():
    activities = fetch_activities()
    if activities is None:
        return jsonify({'error': 'not authenticated'}), 401
    return jsonify({'count': len(activities)})

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
