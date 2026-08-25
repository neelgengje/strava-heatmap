"""Tests for sync.py: the pure geometry/normalization logic, and the
--backfill-hr resumability contract end-to-end. No real network calls are
ever made — every requests.get is mocked or monkeypatched.
"""
import json
from unittest.mock import Mock, patch

import pytest

import sync


def _mock_response(status_code, json_data=None):
    resp = Mock()
    resp.status_code = status_code
    resp.json.return_value = json_data if json_data is not None else {}
    resp.raise_for_status = Mock()
    if status_code >= 400:
        resp.raise_for_status.side_effect = Exception(f'HTTP {status_code}')
    return resp


# ── simplify_latlng / RDP ────────────────────────────────────────────────

def test_simplify_latlng_short_input_passthrough():
    pts = [[37.0, -122.0], [37.001, -122.001]]
    assert sync.simplify_latlng(pts) == pts


def test_simplify_latlng_collinear_points_reduce_to_endpoints():
    pts = [[37.0 + i * 0.0001, -122.0] for i in range(20)]
    out = sync.simplify_latlng(pts, epsilon_m=4)
    assert out[0] == pts[0]
    assert out[-1] == pts[-1]
    assert len(out) < len(pts)


def test_simplify_latlng_preserves_a_real_corner():
    # An L-shaped path: straight north, then straight east. The corner is
    # the one interior point that actually carries shape and must survive.
    north = [[37.0 + i * 0.0002, -122.0] for i in range(10)]
    east = [[north[-1][0], -122.0 + i * 0.0002] for i in range(1, 10)]
    pts = north + east
    out = sync.simplify_latlng(pts, epsilon_m=4)
    corner = north[-1]
    assert any(abs(p[0] - corner[0]) < 1e-9 and abs(p[1] - corner[1]) < 1e-9 for p in out)
    assert len(out) < len(pts)


def test_simplify_latlng_tighter_epsilon_keeps_more_points():
    pts = [[37.0 + i * 0.0001, -122.0 + (i % 3) * 0.00002] for i in range(50)]
    loose = sync.simplify_latlng(pts, epsilon_m=50)
    tight = sync.simplify_latlng(pts, epsilon_m=0.5)
    assert len(loose) <= len(tight)


# ── normalize_activity ────────────────────────────────────────────────────

def _fake_summary(**overrides):
    base = {
        'id': 123,
        'name': 'Test Hike',
        'start_date_local': '2026-01-15T10:00:00Z',
        'distance': 10000,             # meters
        'total_elevation_gain': 300,   # meters
        'moving_time': 3600,           # seconds
        'sport_type': 'Hike',
        'map': {'summary_polyline': 'a~l~Fjk~uOwHJy@P'},
    }
    base.update(overrides)
    return base


def test_normalize_activity_unknown_sport_type_returns_none():
    assert sync.normalize_activity(_fake_summary(sport_type='Surfing')) is None


def test_normalize_activity_missing_polyline_returns_none():
    assert sync.normalize_activity(_fake_summary(map={'summary_polyline': ''})) is None


def test_normalize_activity_maps_sport_type_to_category():
    a = sync.normalize_activity(_fake_summary(sport_type='TrailRun'))
    assert a['category'] == 'TrailRun'


def test_normalize_activity_converts_units():
    a = sync.normalize_activity(_fake_summary(distance=1609.34, total_elevation_gain=100))
    assert a['distance_mi'] == 1.0
    assert a['elev_gain_ft'] == round(100 * 3.28084)


def test_normalize_activity_zero_moving_time_does_not_divide_by_zero():
    a = sync.normalize_activity(_fake_summary(moving_time=0))
    assert a['speed_mph'] == 0
    assert a['pace_min_mi'] == 0


def test_normalize_activity_avg_max_hr_present():
    a = sync.normalize_activity(_fake_summary(average_heartrate=143.364, max_heartrate=178.0))
    assert a['avg_hr'] == 143
    assert a['max_hr'] == 178


def test_normalize_activity_no_heartrate_data():
    a = sync.normalize_activity(_fake_summary())
    assert a['avg_hr'] is None
    assert a['max_hr'] is None


def test_normalize_activity_zero_avg_heartrate_treated_as_absent():
    a = sync.normalize_activity(_fake_summary(average_heartrate=0))
    assert a['avg_hr'] is None


def test_normalize_activity_never_sets_calories_key():
    # calories isn't on the summary payload; its ABSENCE is the backfill's
    # resumability marker, so normalize_activity must never invent a value
    # (not even None) for it.
    a = sync.normalize_activity(_fake_summary())
    assert 'calories' not in a


# ── compute_stats ──────────────────────────────────────────────────────────

def test_compute_stats_aggregates_across_categories_and_years():
    acts = [
        {'category': 'Hike', 'distance_mi': 5.0, 'elev_gain_ft': 1000, 'date': '2025-01-01'},
        {'category': 'Hike', 'distance_mi': 3.0, 'elev_gain_ft': 500, 'date': '2026-01-01'},
        {'category': 'Run', 'distance_mi': 2.0, 'elev_gain_ft': 0, 'date': '2026-06-01'},
    ]
    stats = sync.compute_stats(acts)
    assert stats['total'] == 3
    assert stats['miles'] == 10
    assert stats['elevation'] == 1500
    assert stats['years'] == 2
    assert stats['by_type']['Hike']['count'] == 2
    assert stats['by_type']['Run']['count'] == 1


# ── fetch_stream / fetch_activity_detail (network mocked) ──────────────────

def test_fetch_stream_includes_heartrate_when_present():
    payload = [
        {'type': 'distance', 'data': [0, 10, 20]},
        {'type': 'altitude', 'data': [100, 101, 102]},
        {'type': 'latlng', 'data': [[37, -122], [37.001, -122], [37.002, -122]]},
        {'type': 'heartrate', 'data': [120, 125, 130]},
    ]
    with patch('sync.requests.get', return_value=_mock_response(200, payload)):
        stream = sync.fetch_stream(999, {})
    assert stream['heartrate'] == [120, 125, 130]


def test_fetch_stream_heartrate_absent_is_empty_list_not_missing_key():
    payload = [
        {'type': 'distance', 'data': [0, 10]},
        {'type': 'altitude', 'data': [100, 101]},
        {'type': 'latlng', 'data': [[37, -122], [37.001, -122]]},
    ]
    with patch('sync.requests.get', return_value=_mock_response(200, payload)):
        stream = sync.fetch_stream(999, {})
    assert stream['heartrate'] == []
    assert 'heartrate' in stream  # presence, not value, is the resumability marker


def test_fetch_stream_429_raises_rate_limited():
    with patch('sync.requests.get', return_value=_mock_response(429)):
        with pytest.raises(sync.RateLimited):
            sync.fetch_stream(999, {})


def test_fetch_stream_other_error_returns_none():
    with patch('sync.requests.get', return_value=_mock_response(500)):
        assert sync.fetch_stream(999, {}) is None


def test_fetch_activity_detail_returns_json_on_200():
    with patch('sync.requests.get', return_value=_mock_response(200, {'calories': 1369})):
        detail = sync.fetch_activity_detail(999, {})
    assert detail['calories'] == 1369


def test_fetch_activity_detail_429_raises_rate_limited():
    with patch('sync.requests.get', return_value=_mock_response(429)):
        with pytest.raises(sync.RateLimited):
            sync.fetch_activity_detail(999, {})


# ── backfill_hr: the resumability contract, end-to-end ─────────────────────

@pytest.fixture
def isolated_backfill(tmp_path, monkeypatch):
    """Point sync.py's output paths at a scratch directory and pre-seed
    activities.json + one stream file, so backfill_hr() can run for real
    without touching the actual site/data/ the live app reads."""
    activities_out = tmp_path / 'activities.json'
    streams_dir = tmp_path / 'streams'
    streams_dir.mkdir()

    activities = [
        {'id': 1, 'name': 'Has HR, no calories yet', 'avg_hr': 140, 'max_hr': 170},
        {'id': 2, 'name': 'No HR at all', 'avg_hr': None, 'max_hr': None},
        {'id': 3, 'name': 'Already fully backfilled', 'avg_hr': 150, 'max_hr': 180, 'calories': 900},
    ]
    activities_out.write_text(json.dumps(activities))
    # Activity 3's stream already carries heartrate — Phase C must skip it.
    (streams_dir / '3.json').write_text(json.dumps({
        'distance': [0, 1], 'altitude': [1, 2], 'latlng': [[0, 0], [0, 1]], 'heartrate': [150, 151],
    }))

    monkeypatch.setattr(sync, 'ACTIVITIES_OUT', str(activities_out))
    monkeypatch.setattr(sync, 'STREAMS_DIR', str(streams_dir))
    return activities_out, streams_dir


def _empty_activities_page(url, headers=None, params=None):
    return _mock_response(200, [])


def test_backfill_hr_skips_calorie_refetch_for_already_backfilled_activity(isolated_backfill):
    activities_out, streams_dir = isolated_backfill
    detail_call_ids = []

    def fake_get(url, headers=None, params=None):
        if 'athlete/activities' in url:
            return _empty_activities_page(url)
        if url.endswith('/streams'):
            return _mock_response(200, [
                {'type': 'distance', 'data': [0, 1]}, {'type': 'altitude', 'data': [1, 2]},
                {'type': 'latlng', 'data': [[0, 0], [0, 1]]}, {'type': 'heartrate', 'data': [140, 141]},
            ])
        aid = int(url.rstrip('/').split('/')[-1])
        detail_call_ids.append(aid)
        return _mock_response(200, {'calories': 500 + aid})

    with patch('sync.requests.get', side_effect=fake_get):
        sync.backfill_hr(headers={})

    result = {a['id']: a for a in json.loads(activities_out.read_text())}
    assert result[1]['calories'] == 501  # had no calories key -> fetched
    assert result[2]['calories'] == 502  # no HR, but calories doesn't require HR
    assert result[3]['calories'] == 900  # already had it -> must NOT be re-fetched
    assert 3 not in detail_call_ids


def test_backfill_hr_skips_hr_stream_for_activities_with_no_hr_data(isolated_backfill):
    activities_out, streams_dir = isolated_backfill

    def fake_get(url, headers=None, params=None):
        if 'athlete/activities' in url:
            return _empty_activities_page(url)
        if url.endswith('/streams'):
            return _mock_response(200, [
                {'type': 'distance', 'data': [0, 1]}, {'type': 'altitude', 'data': [1, 2]},
                {'type': 'latlng', 'data': [[0, 0], [0, 1]]}, {'type': 'heartrate', 'data': [140]},
            ])
        return _mock_response(200, {'calories': 1})

    with patch('sync.requests.get', side_effect=fake_get):
        sync.backfill_hr(headers={})

    # Activity 2 has avg_hr=None -> no HR at all -> Phase C must never fetch a stream for it.
    assert not (streams_dir / '2.json').exists()
    # Activity 1 has avg_hr set and no cached stream -> Phase C should fetch it.
    assert (streams_dir / '1.json').exists()


def test_backfill_hr_does_not_refetch_stream_that_already_has_heartrate(isolated_backfill):
    activities_out, streams_dir = isolated_backfill
    stream_urls_hit = []

    def fake_get(url, headers=None, params=None):
        if 'athlete/activities' in url:
            return _empty_activities_page(url)
        if url.endswith('/streams'):
            stream_urls_hit.append(url)
            return _mock_response(200, [
                {'type': 'distance', 'data': [999]}, {'type': 'altitude', 'data': [999]},
                {'type': 'latlng', 'data': [[9, 9]]}, {'type': 'heartrate', 'data': [999]},
            ])
        return _mock_response(200, {'calories': 1})

    with patch('sync.requests.get', side_effect=fake_get):
        sync.backfill_hr(headers={})

    assert not any(u.endswith('/3/streams') for u in stream_urls_hit)
    saved = json.loads((streams_dir / '3.json').read_text())
    assert saved['heartrate'] == [150, 151]  # untouched


def test_backfill_hr_stream_merge_preserves_existing_coords_source(isolated_backfill):
    """Phase C must not clobber a cached stream's distance/altitude/latlng
    with whatever the refetch happens to return — those already fed
    simplify_latlng() to produce activities.json's `coords`."""
    activities_out, streams_dir = isolated_backfill
    (streams_dir / '1.json').write_text(json.dumps({
        'distance': [0, 5], 'altitude': [10, 20], 'latlng': [[1, 1], [2, 2]],
    }))

    def fake_get(url, headers=None, params=None):
        if 'athlete/activities' in url:
            return _empty_activities_page(url)
        if url.endswith('/streams'):
            return _mock_response(200, [
                {'type': 'distance', 'data': [999]}, {'type': 'altitude', 'data': [999]},
                {'type': 'latlng', 'data': [[9, 9]]}, {'type': 'heartrate', 'data': [140]},
            ])
        return _mock_response(200, {'calories': 1})

    with patch('sync.requests.get', side_effect=fake_get):
        sync.backfill_hr(headers={})

    saved = json.loads((streams_dir / '1.json').read_text())
    assert saved['distance'] == [0, 5]      # preserved, not overwritten
    assert saved['latlng'] == [[1, 1], [2, 2]]
    assert saved['heartrate'] == [140]      # only this got added


def test_backfill_hr_rate_limit_stops_cleanly_and_flushes_partial_progress(isolated_backfill):
    """The core resumability property: a 429 mid-phase must not raise, must
    not lose already-fetched progress, and must leave not-yet-attempted
    activities retryable (no 'calories' key at all) for the next run."""
    activities_out, streams_dir = isolated_backfill
    detail_calls = {'n': 0}

    def fake_get(url, headers=None, params=None):
        if 'athlete/activities' in url:
            return _empty_activities_page(url)
        if url.endswith('/streams'):
            return _mock_response(429)
        detail_calls['n'] += 1
        if detail_calls['n'] == 1:
            return _mock_response(200, {'calories': 111})
        return _mock_response(429)

    with patch('sync.requests.get', side_effect=fake_get):
        sync.backfill_hr(headers={})  # must not raise

    result = {a['id']: a for a in json.loads(activities_out.read_text())}
    assert result[1]['calories'] == 111   # processed before the rate limit hit
    assert 'calories' not in result[2]    # never attempted -> stays retryable


def test_backfill_hr_phase_a_fills_avg_max_hr_for_records_missing_the_key(tmp_path, monkeypatch):
    activities_out = tmp_path / 'activities.json'
    streams_dir = tmp_path / 'streams'
    streams_dir.mkdir()
    # This record predates the avg_hr/max_hr fields entirely (no key at all) —
    # simulates one of the 419 pre-existing activities before this feature shipped.
    activities_out.write_text(json.dumps([{'id': 2, 'name': 'Pre-migration activity'}]))
    monkeypatch.setattr(sync, 'ACTIVITIES_OUT', str(activities_out))
    monkeypatch.setattr(sync, 'STREAMS_DIR', str(streams_dir))

    def fake_get(url, headers=None, params=None):
        if 'athlete/activities' in url:
            if params.get('page', 1) == 1:
                return _mock_response(200, [{'id': 2, 'average_heartrate': 155.7, 'max_heartrate': 190.0}])
            return _mock_response(200, [])
        if url.endswith('/streams'):
            return _mock_response(200, [
                {'type': 'distance', 'data': []}, {'type': 'altitude', 'data': []},
                {'type': 'latlng', 'data': []}, {'type': 'heartrate', 'data': []},
            ])
        return _mock_response(200, {'calories': 1})

    with patch('sync.requests.get', side_effect=fake_get):
        sync.backfill_hr(headers={})

    result = {a['id']: a for a in json.loads(activities_out.read_text())}
    assert result[2]['avg_hr'] == 156
    assert result[2]['max_hr'] == 190


# ── fetch_calories_if_unknown / merge_prior_hr_calories ─────────────────────
# These back main()'s new-activity loop and its --full safety net — the
# same resumability contract as backfill_hr(), but exercised directly here
# since main() itself (argparse + real auth) isn't practical to test whole.

def test_fetch_calories_if_unknown_skips_call_when_prior_already_has_it():
    a = {'id': 1}
    prior_by_id = {1: {'id': 1, 'calories': 900}}
    with patch('sync.requests.get') as mock_get:
        sync.fetch_calories_if_unknown(a, prior_by_id, headers={})
    mock_get.assert_not_called()
    assert 'calories' not in a  # untouched — the caller is expected to merge it in separately


def test_fetch_calories_if_unknown_fetches_when_prior_lacks_it():
    a = {'id': 2}
    prior_by_id = {}
    with patch('sync.requests.get', return_value=_mock_response(200, {'calories': 555})):
        sync.fetch_calories_if_unknown(a, prior_by_id, headers={})
    assert a['calories'] == 555


def test_fetch_calories_if_unknown_propagates_rate_limited():
    a = {'id': 3}
    with patch('sync.requests.get', return_value=_mock_response(429)):
        with pytest.raises(sync.RateLimited):
            sync.fetch_calories_if_unknown(a, {}, headers={})


def test_merge_prior_hr_calories_fills_missing_calories_from_prior():
    all_acts = [{'id': 1}]  # freshly normalized -> no calories key at all
    prior_by_id = {1: {'id': 1, 'calories': 700}}
    sync.merge_prior_hr_calories(all_acts, prior_by_id)
    assert all_acts[0]['calories'] == 700


def test_merge_prior_hr_calories_does_not_overwrite_freshly_fetched_calories():
    all_acts = [{'id': 1, 'calories': 111}]  # already fetched this run
    prior_by_id = {1: {'id': 1, 'calories': 999}}
    sync.merge_prior_hr_calories(all_acts, prior_by_id)
    assert all_acts[0]['calories'] == 111  # not clobbered by the stale prior value


def test_merge_prior_hr_calories_fills_missing_avg_max_hr_together():
    all_acts = [{'id': 1, 'avg_hr': None}]
    prior_by_id = {1: {'id': 1, 'avg_hr': 150, 'max_hr': 180}}
    sync.merge_prior_hr_calories(all_acts, prior_by_id)
    assert all_acts[0]['avg_hr'] == 150
    assert all_acts[0]['max_hr'] == 180


def test_merge_prior_hr_calories_no_prior_record_is_a_no_op():
    all_acts = [{'id': 99}]
    sync.merge_prior_hr_calories(all_acts, prior_by_id={})
    assert 'calories' not in all_acts[0]


def test_backfill_hr_limit_caps_phases_b_and_c(isolated_backfill):
    activities_out, streams_dir = isolated_backfill
    detail_calls = {'n': 0}

    def fake_get(url, headers=None, params=None):
        if 'athlete/activities' in url:
            return _empty_activities_page(url)
        if url.endswith('/streams'):
            return _mock_response(200, [
                {'type': 'distance', 'data': []}, {'type': 'altitude', 'data': []},
                {'type': 'latlng', 'data': []}, {'type': 'heartrate', 'data': []},
            ])
        detail_calls['n'] += 1
        return _mock_response(200, {'calories': 1})

    with patch('sync.requests.get', side_effect=fake_get):
        sync.backfill_hr(headers={}, limit=1)

    # Only activities 1 and 2 are missing calories; --limit 1 caps Phase B
    # to just the first of them.
    assert detail_calls['n'] == 1
