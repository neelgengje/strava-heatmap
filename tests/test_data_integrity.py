"""Sanity checks on the actual committed data in site/data/ — not sync.py's
logic (see test_sync.py for that), but the real output it produced. No
network calls; this is meant to be cheap enough to run on every change that
touches site/data/, catching a corrupt sync before it's committed rather
than after (the length-mismatch bug class here is exactly what a manual
spot-check of ~20 files caught earlier in this project's history — this
turns that spot-check into a full, automated sweep of all of them).
"""
import json
from pathlib import Path

import pytest

SITE_DATA = Path(__file__).resolve().parent.parent / 'site' / 'data'
ACTIVITIES_JSON = SITE_DATA / 'activities.json'
STREAMS_DIR = SITE_DATA / 'streams'

REQUIRED_FIELDS = {
    'id', 'name', 'date', 'distance_mi', 'elev_gain_ft', 'moving_time',
    'sport_type', 'category', 'speed_mph', 'pace_min_mi', 'coords',
    'avg_hr', 'max_hr', 'calories',
}


@pytest.fixture(scope='module')
def activities():
    if not ACTIVITIES_JSON.exists():
        pytest.skip('site/data/activities.json not present in this checkout')
    return json.loads(ACTIVITIES_JSON.read_text())


@pytest.fixture(scope='module')
def stream_files():
    if not STREAMS_DIR.exists():
        pytest.skip('site/data/streams/ not present in this checkout')
    return sorted(STREAMS_DIR.glob('*.json'))


def test_activities_json_is_a_nonempty_list(activities):
    assert isinstance(activities, list)
    assert len(activities) > 0


def test_every_activity_has_a_unique_id(activities):
    ids = [a['id'] for a in activities]
    assert len(ids) == len(set(ids)), 'duplicate activity id found'


def test_every_activity_has_every_required_field(activities):
    missing = {}
    for a in activities:
        gap = REQUIRED_FIELDS - set(a.keys())
        if gap:
            missing[a.get('id', '?')] = gap
    assert not missing, f'{len(missing)} activities missing fields: {dict(list(missing.items())[:5])}...'


def test_avg_hr_and_max_hr_are_consistent_pairs(activities):
    # Both null together, or both present together — never one without the other.
    bad = [a['id'] for a in activities if (a['avg_hr'] is None) != (a['max_hr'] is None)]
    assert not bad, f'activities with only one of avg_hr/max_hr set: {bad[:10]}'


def test_max_hr_is_never_below_avg_hr(activities):
    bad = [a['id'] for a in activities if a['avg_hr'] is not None and a['max_hr'] < a['avg_hr']]
    assert not bad, f'activities with max_hr < avg_hr: {bad[:10]}'


def test_every_stream_file_is_valid_json_with_the_expected_keys(stream_files):
    bad = []
    for f in stream_files:
        try:
            data = json.loads(f.read_text())
        except json.JSONDecodeError:
            bad.append((f.name, 'invalid JSON'))
            continue
        missing = {'distance', 'altitude', 'latlng'} - set(data.keys())
        if missing:
            bad.append((f.name, f'missing keys: {missing}'))
    assert not bad, f'{len(bad)} bad stream files, e.g. {bad[:5]}'


def test_every_stream_file_has_consistent_array_lengths(stream_files):
    """The bug class this guards against: distance/altitude/latlng/heartrate
    are meant to be parallel arrays sampled at the same points. A length
    mismatch silently misaligns the HR line against distance on the chart
    while still looking plausible — exactly the failure mode flagged (and
    manually spot-checked on a sample of 20) while building the HR feature.
    This checks all of them, not a sample."""
    mismatches = []
    for f in stream_files:
        data = json.loads(f.read_text())
        lengths = {k: len(v) for k, v in data.items() if isinstance(v, list)}
        if len(set(lengths.values())) > 1:
            mismatches.append((f.name, lengths))
    assert not mismatches, f'{len(mismatches)} stream files with mismatched array lengths: {mismatches[:5]}'


def test_activities_with_hr_data_have_a_matching_stream_file(activities):
    """Every activity with avg_hr set should have been through the HR
    stream backfill — flags any that were missed."""
    missing = []
    for a in activities:
        if a['avg_hr'] is None:
            continue
        stream_path = STREAMS_DIR / f"{a['id']}.json"
        if not stream_path.exists():
            missing.append(a['id'])
            continue
        data = json.loads(stream_path.read_text())
        if 'heartrate' not in data:
            missing.append(a['id'])
    assert not missing, f'{len(missing)} HR-having activities with no heartrate stream: {missing[:10]}'


def test_coords_are_valid_lat_lng_pairs_in_the_bay_area_or_known_trip_range(activities):
    # Loose sanity bound, not a precise geofence — catches a badly corrupted
    # coordinate (e.g. swapped lat/lng, or a raw Strava polyline that never
    # got decoded) without false-failing on real trips outside the Bay Area.
    bad = []
    for a in activities:
        coords = a['coords']
        if not coords:
            bad.append((a['id'], 'empty coords'))
            continue
        lat, lng = coords[0]
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            bad.append((a['id'], (lat, lng)))
    assert not bad, f'activities with out-of-range coordinates: {bad[:10]}'
