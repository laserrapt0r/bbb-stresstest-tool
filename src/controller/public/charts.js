// Crosshair and tooltip for the SVG charts. Used by the web UI and inlined into HTML reports.
// Labels come from user input, so everything goes through textContent.
(() => {
  function tooltip(chart) {
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    chart.closest('.viz-root').append(tip);
    return tip;
  }

  function fill(tip, row, xLabel) {
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = `${row.x} ${xLabel}`;
    tip.append(head);
    for (const item of row.series) {
      const line = document.createElement('div');
      line.className = 'row';
      const key = document.createElement('span');
      key.className = 'key-line';
      key.style.background = `var(--series-${item.slot})`;
      const value = document.createElement('strong');
      value.textContent = item.value;
      line.append(key, value);
      if (row.series.length > 1) {
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = item.label;
        line.append(label);
      }
      if (item.verdict) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = item.verdict;
        line.append(note);
      }
      tip.append(line);
    }
  }

  function attach(svg) {
    if (svg.dataset.ready) return;
    svg.dataset.ready = '1';
    const data = JSON.parse(svg.dataset.chart);
    const figure = svg.closest('.chart');
    const crosshair = svg.querySelector('.crosshair');
    const tip = tooltip(figure);
    let index = -1;

    const show = (next) => {
      index = Math.max(0, Math.min(data.xs.length - 1, next));
      const x = data.xs[index];
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.style.visibility = 'visible';
      fill(tip, data.rows[index], data.xLabel);
      tip.hidden = false;
      const root = tip.offsetParent.getBoundingClientRect();
      const box = svg.getBoundingClientRect();
      const left = box.left - root.left + (x / svg.viewBox.baseVal.width) * box.width;
      const room = root.width - left - tip.offsetWidth - 12;
      tip.style.left = `${room > 0 ? left + 12 : Math.max(0, left - tip.offsetWidth - 12)}px`;
      tip.style.top = `${box.top - root.top + 8}px`;
    };
    const hide = () => {
      index = -1;
      crosshair.style.visibility = 'hidden';
      tip.hidden = true;
    };

    svg.addEventListener('pointermove', (event) => {
      const box = svg.getBoundingClientRect();
      const x = ((event.clientX - box.left) / box.width) * svg.viewBox.baseVal.width;
      let nearest = 0;
      data.xs.forEach((value, i) => {
        if (Math.abs(value - x) < Math.abs(data.xs[nearest] - x)) nearest = i;
      });
      show(nearest);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(0));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      show(index + (event.key === 'ArrowLeft' ? -1 : 1));
    });
  }

  window.initCharts = (root = document) => root.querySelectorAll('svg[data-chart]').forEach(attach);
  document.addEventListener('DOMContentLoaded', () => window.initCharts());
})();
