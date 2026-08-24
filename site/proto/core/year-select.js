// ── Multi-select year dropdown ──────────────────────────────
// A trigger button showing the current selection, and a checklist panel —
// check any combination of years; "Clear" empties the selection, which
// Dashboard treats as "no filter" (all years).

class YearMultiSelect {
  constructor(container, { years, yearTotals, dash }) {
    this.container = container;
    this.years = years; // ascending, e.g. ['2018', ..., '2026']
    this.yearTotals = yearTotals;
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

    this.list.innerHTML = [...this.years].reverse().map(y => `
      <label class="year-option" data-year="${y}">
        <span class="year-check"></span>
        <span class="year-option-label">${y}</span>
        <span class="year-option-count">${this.yearTotals.get(y) || 0}</span>
      </label>`).join('');

    this.trigger.addEventListener('click', () => this.toggleOpen());
    this.list.addEventListener('click', e => {
      const opt = e.target.closest('[data-year]');
      if (!opt) return;
      this.dash.toggleYear(opt.dataset.year);
      this._syncChecks();
      this._syncLabel();
    });
    this.clearBtn.addEventListener('click', () => {
      this.dash.clearYearFilter();
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
    this.list.querySelectorAll('[data-year]').forEach(opt => {
      opt.classList.toggle('checked', this.dash.activeYears.has(opt.dataset.year));
    });
  }

  _syncLabel() {
    const n = this.dash.activeYears.size;
    if (n === 0) this.label.textContent = 'All years';
    else if (n === 1) this.label.textContent = [...this.dash.activeYears][0];
    else this.label.textContent = `${n} years`;
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
