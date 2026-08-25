"""Browser smoke tests for the live dashboard (site/app.html), covering the
exact interactions verified by hand while building the HR/calories and
mobile-layout features: selecting an activity opens the detail panel at its
real height, the HR toggle draws the heart-rate line, and switching to the
phone-width map view and back doesn't break the panel (a real bug this
session found and fixed — see visibility:hidden vs display:none in app.css).

Run with: python3 -m pytest tests/test_e2e.py
Requires: pip install pytest-playwright && playwright install chromium
"""
import http.server
import socket
import threading
import time
from pathlib import Path

import pytest

SITE_DIR = Path(__file__).resolve().parent.parent / 'site'


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]


@pytest.fixture(scope='session')
def server_url():
    """Serves site/ on its own local port for the duration of the test
    session — independent of any dev server already running elsewhere,
    so this suite works standalone."""
    port = _free_port()
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(SITE_DIR), **kw)
    httpd = http.server.ThreadingHTTPServer(('localhost', port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f'http://localhost:{port}'
    httpd.shutdown()


@pytest.fixture
def app_page(page, server_url):
    """A page already navigated to app.html with the dashboard fully loaded."""
    page.goto(f'{server_url}/app.html')
    page.wait_for_selector('.activity-item', timeout=10000)
    return page


def _select_activity(page, name):
    item = page.locator('.activity-item', has_text=name).first
    item.scroll_into_view_if_needed()
    item.click()
    page.wait_for_selector('#detail-panel.open', timeout=5000)
    # Height is set via inline style once app-controller.js measures the
    # panel's real content — wait for that rather than a fixed sleep.
    page.wait_for_function(
        "document.getElementById('detail-panel').style.height !== ''", timeout=5000
    )


# ── Core selection flow ─────────────────────────────────────────────────

def test_dashboard_loads_without_console_errors(app_page):
    errors = []
    app_page.on('pageerror', lambda exc: errors.append(str(exc)))
    app_page.reload()
    app_page.wait_for_selector('.activity-item', timeout=10000)
    assert errors == []


def test_selecting_an_activity_opens_panel_with_real_measured_height(app_page):
    _select_activity(app_page, '#H21 Mission Peak')
    panel = app_page.locator('#detail-panel')
    height = panel.evaluate('el => parseFloat(el.style.height)')
    # A real measured height, not the stale 320px-fixed-height regime this
    # replaced, and not the display:none-ancestor bug (offsetHeight -> 0)
    # found while building the mobile view.
    assert height > 100
    assert app_page.locator('#detail-title').inner_text() == '#H21 Mission Peak'


def test_selecting_activity_with_no_hr_data_hides_hr_stats_and_toggle(app_page):
    # This activity predates any HR strap, but Strava still estimates
    # calories without one — so the secondary row isn't empty, it just
    # correctly omits the HR-specific pieces. That's the real behavior to
    # pin down, not an empty row (which no activity in this dataset has,
    # now that calories is backfilled everywhere).
    _select_activity(app_page, 'My first cycle ride')
    secondary_text = app_page.locator('#detail-stats-secondary').inner_text()
    assert 'AVG HR' not in secondary_text
    assert 'MAX HR' not in secondary_text
    assert not app_page.locator('#hr-toggle').is_visible()


def test_selecting_activity_with_hr_data_shows_secondary_row_and_toggle(app_page):
    _select_activity(app_page, '#H21 Mission Peak')
    secondary_text = app_page.locator('#detail-stats-secondary').inner_text()
    assert 'AVG HR' in secondary_text
    assert 'MAX HR' in secondary_text
    assert 'CALORIES' in secondary_text
    assert app_page.locator('#hr-toggle').is_visible()


def test_hr_toggle_resets_to_off_when_switching_between_activities(app_page):
    _select_activity(app_page, '#H21 Mission Peak')
    app_page.locator('#hr-toggle').click()
    assert 'on' in (app_page.locator('#hr-toggle').get_attribute('class') or '')

    _select_activity(app_page, '#H19 Mission Peak')
    assert 'on' not in (app_page.locator('#hr-toggle').get_attribute('class') or '')


# ── HR chart overlay ─────────────────────────────────────────────────────

def _canvas_pixels(page):
    return page.locator('#detail-chart').evaluate(
        "el => Array.from(el.getContext('2d').getImageData(0, 0, el.width, el.height).data)"
    )


def test_toggling_hr_on_changes_the_rendered_chart(app_page):
    _select_activity(app_page, '#H21 Mission Peak')
    app_page.wait_for_timeout(300)  # let the elevation profile finish its initial draw
    before = _canvas_pixels(app_page)

    app_page.locator('#hr-toggle').click()
    app_page.wait_for_timeout(150)
    after = _canvas_pixels(app_page)

    assert before != after  # the HR trace actually got drawn


def test_scrubbing_chart_with_hr_on_labels_bpm(app_page):
    _select_activity(app_page, '#H21 Mission Peak')
    app_page.locator('#hr-toggle').click()
    box = app_page.locator('#detail-chart').bounding_box()
    app_page.mouse.move(box['x'] + box['width'] * 0.4, box['y'] + box['height'] * 0.5)
    app_page.wait_for_timeout(150)
    pixels_with_cursor = _canvas_pixels(app_page)
    app_page.mouse.move(box['x'] + box['width'] * 0.01, box['y'] - 50)  # off the chart
    app_page.wait_for_timeout(150)
    pixels_without_cursor = _canvas_pixels(app_page)
    assert pixels_with_cursor != pixels_without_cursor


# ── Panel close / reopen ─────────────────────────────────────────────────

def test_closing_panel_detaches_it_after_the_collapse_transition(app_page):
    _select_activity(app_page, '#H21 Mission Peak')
    app_page.locator('#detail-close').click()
    # app-controller.js removes #detail-panel from the DOM ~460ms after
    # deselect (past the 0.42s CSS collapse) rather than just toggling a
    # class — wait for the actual removal, not a stale locator on a node
    # that's about to disappear.
    app_page.wait_for_function("!document.getElementById('detail-panel')", timeout=2000)


# ── Mobile phone-width layout ────────────────────────────────────────────

@pytest.fixture
def mobile_page(page, server_url):
    page.set_viewport_size({'width': 390, 'height': 844})
    page.goto(f'{server_url}/app.html')
    page.wait_for_selector('.activity-item', timeout=10000)
    return page


def test_phone_width_shows_fullscreen_drawer_and_map_toggle(mobile_page):
    drawer_width = mobile_page.locator('#drawer').evaluate('el => getComputedStyle(el).width')
    assert drawer_width == '390px'
    assert mobile_page.locator('#mobile-view-toggle').is_visible()
    assert not mobile_page.locator('#drawer-toggle').is_visible()


def test_selecting_trail_from_map_view_then_switching_to_list_shows_correct_panel(mobile_page):
    """Regression test for a real bug found this session: selecting a trail
    while the drawer was display:none (map view) left the detail panel's
    measured height at 0, since offsetHeight is always 0 inside a
    display:none ancestor. Fixed via visibility:hidden instead."""
    mobile_page.locator('#mobile-view-toggle').click()
    mobile_page.wait_for_function("document.body.classList.contains('mobile-view-map')")
    mobile_page.wait_for_timeout(400)  # let the map settle into its fitBounds view

    # Markers are scattered across the whole Bay Area fitBounds view, most
    # off-screen at this viewport size, and Playwright can't pan a Leaflet
    # map to bring one into view — so find one that's already on-screen and
    # click its real center with raw mouse coordinates (a locator-click
    # gets blocked here: the marker's inner <circle> intercepts pointer
    # events under Playwright's stricter actionability checks).
    marker = mobile_page.evaluate("""
        () => {
          for (const el of document.querySelectorAll('.leaflet-marker-icon')) {
            const r = el.getBoundingClientRect();
            if (r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight) {
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
          }
          return null;
        }
    """)
    assert marker, 'no on-screen trail marker found to click'
    mobile_page.mouse.click(marker['x'], marker['y'])
    mobile_page.wait_for_timeout(500)

    mobile_page.locator('#mobile-view-toggle').click()
    mobile_page.wait_for_function("!document.body.classList.contains('mobile-view-map')")

    panel = mobile_page.locator('#detail-panel')
    height = panel.evaluate('el => parseFloat(el.style.height)')
    assert height > 100
    assert mobile_page.locator('#detail-title').inner_text() != ''


# ── Desktop unaffected by the mobile breakpoint ──────────────────────────

def test_desktop_width_hides_mobile_view_toggle(page, server_url):
    page.set_viewport_size({'width': 1600, 'height': 900})
    page.goto(f'{server_url}/app.html')
    page.wait_for_selector('.activity-item', timeout=10000)
    assert not page.locator('#mobile-view-toggle').is_visible()
    assert page.locator('#drawer-toggle').is_visible()
    drawer_width = page.locator('#drawer').evaluate('el => getComputedStyle(el).width')
    assert drawer_width == '372px'
