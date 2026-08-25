// ── Multi-select activity-type dropdown ──────────────────────
// Same pattern as YearMultiSelect (year-select.js), reusing the same
// .year-select* CSS classes so it renders identically with no new styling.

class SportMultiSelect {
  constructor(container, { dash }) {
    this.container = container;
    this.dash = dash;
    this.open = false;
    this._build();
    this._bindOutsideClick();
  }

  _build() {
    this.container.classList.add('year-select');
    this.container.innerHTML = `
      <button class="year-select-trigger" type="button" aria-haspopup="listbox">
        <span class="year-select-label"></span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="year-select-panel">
        <div class="year-select-list"></div>
        <button class="year-select-clear" type="button">Clear selection</button>
      </div>`;

    this.trigger = this.container.querySelector('.year-select-trigger');
    this.label = this.container.querySelector('.year-select-label');
    this.panel = this.container.querySelector('.year-select-panel');
    this.list = this.container.querySelector('.year-select-list');
    this.clearBtn = this.container.querySelector('.year-select-clear');

    const totals = this.dash.sportTotals;
    this.list.innerHTML = Object.entries(ACTIVITY_TYPES).map(([key, cfg]) => `
      <label class="year-option" data-sport="${key}">
        <span class="year-check"></span>
        <span class="year-option-label">${cfg.icon} ${cfg.label}</span>
        <span class="year-option-count">${totals.get(key) || 0}</span>
      </label>`).join('');

    this.trigger.addEventListener('click', () => this.toggleOpen());
    this.list.addEventListener('click', e => {
      const opt = e.target.closest('[data-sport]');
      if (!opt) return;
      this.dash.toggleSport(opt.dataset.sport);
      this._syncChecks();
      this._syncLabel();
    });
    this.clearBtn.addEventListener('click', () => {
      this.dash.clearSportFilter();
      this._syncChecks();
      this._syncLabel();
    });

    this._syncChecks();
    this._syncLabel();
  }

  toggleOpen(force) {
    this.open = force ?? !this.open;
    this.container.classList.toggle('open', this.open);
  }

  _syncChecks() {
    this.list.querySelectorAll('[data-sport]').forEach(opt => {
      opt.classList.toggle('checked', this.dash.activeSports.has(opt.dataset.sport));
    });
  }

  _syncLabel() {
    const n = this.dash.activeSports.size;
    if (n === 0) this.label.textContent = 'All activities';
    else if (n === 1) this.label.textContent = ACTIVITY_TYPES[[...this.dash.activeSports][0]]?.label || '1 type';
    else this.label.textContent = `${n} types`;
  }

  // Re-syncs checkboxes/label when something outside this component
  // changes the selection (e.g. the page-level "Clear filters" action).
  refresh() {
    this._syncChecks();
    this._syncLabel();
  }

  _bindOutsideClick() {
    document.addEventListener('click', e => {
      if (!this.open) return;
      if (!this.container.contains(e.target)) this.toggleOpen(false);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.open) this.toggleOpen(false);
    });
  }
}

// Node-only export for the test suite (tests/js/) — a no-op in the browser,
// where this file loads as a plain <script> and `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SportMultiSelect };
}
