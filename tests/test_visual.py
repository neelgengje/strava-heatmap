"""Visual regression tests: screenshot a few key states and diff against a
stored baseline. Functional tests (test_e2e.py) confirm the right elements
exist and the right classes toggle — they don't catch "the spacing is
uneven again" or "the stats aren't centered anymore," which is exactly the
class of bug this project spent real time on this session (the panel's
single-gap spacing system, the secondary stat row's centering). Pixel
diffing is the only thing in this suite that would catch a regression there.

First run for a given snapshot name has no baseline: it writes one and
skips (not fails) so a fresh checkout doesn't immediately break CI — review
the new baseline image, commit it, and subsequent runs compare against it.

Run:              python3 -m pytest tests/test_visual.py --browser chromium
Update baselines:  python3 -m pytest tests/test_visual.py --update-snapshots
"""
import io
from pathlib import Path

import pytest
from PIL import Image, ImageChops

SNAPSHOT_DIR = Path(__file__).resolve().parent / '__snapshots__'
SNAPSHOT_DIR.mkdir(exist_ok=True)

# Fraction of pixels allowed to differ before a snapshot test fails — a
# small tolerance absorbs font-hinting/anti-aliasing noise between runs,
# not real layout regressions (those move far more than 1% of pixels).
MAX_DIFF_FRACTION = 0.01
PIXEL_CHANGE_THRESHOLD = 10  # summed RGB delta below which a pixel counts as "unchanged" noise


def assert_matches_snapshot(png_bytes, name, request):
    baseline_path = SNAPSHOT_DIR / f'{name}.png'
    update = request.config.getoption('--update-snapshots')

    if update or not baseline_path.exists():
        baseline_path.write_bytes(png_bytes)
        if not update:
            pytest.skip(f'no baseline yet for "{name}" — wrote {baseline_path.name}; re-run to compare')
        return

    baseline = Image.open(baseline_path).convert('RGB')
    current = Image.open(io.BytesIO(png_bytes)).convert('RGB')
    if baseline.size != current.size:
        pytest.fail(f'{name}: screenshot size changed {baseline.size} -> {current.size}')

    diff = ImageChops.difference(baseline, current)
    if diff.getbbox() is None:
        return  # pixel-identical

    total = baseline.size[0] * baseline.size[1]
    changed = sum(1 for px in diff.getdata() if sum(px) > PIXEL_CHANGE_THRESHOLD)
    fraction = changed / total
    if fraction > MAX_DIFF_FRACTION:
        diff_path = SNAPSHOT_DIR / f'{name}.diff.png'
        diff.save(diff_path)
        pytest.fail(
            f'{name}: {fraction:.2%} of pixels differ (threshold {MAX_DIFF_FRACTION:.0%}) — '
            f'see {diff_path.name}, compare against {baseline_path.name}'
        )


def _select(page, name):
    page.locator('.activity-item', has_text=name).first.click()
    page.wait_for_function("document.getElementById('detail-panel').style.height !== ''", timeout=5000)
    # app-controller.js scrollIntoView()s the panel ~460ms after selection
    # (timed to the CSS open transition) — wait past that, or the list's
    # scroll position (and therefore the screenshot) is a race.
    page.wait_for_timeout(600)


@pytest.fixture
def desktop_page(page, server_url):
    page.set_viewport_size({'width': 1000, 'height': 800})
    page.goto(f'{server_url}/app.html')
    page.wait_for_selector('.activity-item', timeout=10000)
    return page


def test_detail_panel_with_hr_data_off(desktop_page, request):
    _select(desktop_page, '#H21 Mission Peak')
    png = desktop_page.locator('#drawer').screenshot()
    assert_matches_snapshot(png, 'detail_panel_hr_data_off', request)


def test_detail_panel_with_hr_toggled_on(desktop_page, request):
    _select(desktop_page, '#H21 Mission Peak')
    desktop_page.locator('#hr-toggle').click()
    desktop_page.wait_for_timeout(150)
    png = desktop_page.locator('#drawer').screenshot()
    assert_matches_snapshot(png, 'detail_panel_hr_toggled_on', request)


def test_detail_panel_no_hr_data(desktop_page, request):
    _select(desktop_page, 'My first cycle ride')
    png = desktop_page.locator('#drawer').screenshot()
    assert_matches_snapshot(png, 'detail_panel_no_hr_data', request)


@pytest.fixture
def mobile_page(page, server_url):
    page.set_viewport_size({'width': 390, 'height': 844})
    page.goto(f'{server_url}/app.html')
    page.wait_for_selector('.activity-item', timeout=10000)
    return page


def test_mobile_fullscreen_list_view(mobile_page, request):
    png = mobile_page.screenshot()
    assert_matches_snapshot(png, 'mobile_fullscreen_list', request)


def test_mobile_fullscreen_map_view(mobile_page, request):
    mobile_page.locator('#mobile-view-toggle').click()
    mobile_page.wait_for_function("document.body.classList.contains('mobile-view-map')")
    mobile_page.wait_for_timeout(400)  # let the map settle into its fitBounds view
    png = mobile_page.screenshot()
    assert_matches_snapshot(png, 'mobile_fullscreen_map', request)
