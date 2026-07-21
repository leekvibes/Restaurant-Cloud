'use strict';

// ---------------------------------------------------------------------------
// CHARTS — inline SVG, no library.
//
// Everything here renders on the server into the HTML. There is no charting
// dependency, no bundle to ship and nothing to initialise on load, which is
// why pages stay instant. The trade is that these are deliberately simple:
// lines, areas, bars and sparklines. Anything needing zoom or live redraw
// wants a real library, and that is the moment to add one — not before.
//
// Two rules everything here follows:
//
//   A chart of nothing draws nothing. An empty series returns a message, not
//   an axis with a flat line at zero, because a flat line reads as "no change"
//   when the truth is "no data".
//
//   A single point is not a trend. Sparklines need three.
// ---------------------------------------------------------------------------

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (cents) => '$' + (Math.round(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortMoney = (cents) => {
  const v = Math.round(cents) / 100;
  if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k';
  return '$' + v.toFixed(0);
};

/** Nothing to draw. Say so rather than drawing an empty axis. */
const empty = (msg, h = 120) =>
  `<div class="chart-empty" style="height:${h}px">${esc(msg)}</div>`;

/**
 * A sparkline: no axes, no labels, just the shape.
 * @param values numbers, oldest first
 */
function spark(values, opts = {}) {
  const v = (values || []).filter((x) => Number.isFinite(x));
  if (v.length < 3) return '<span class="spark-none">—</span>';
  // Every value zero means nothing was logged, not that the figure held
  // steady at nothing. Drawing the flat line would say the opposite.
  if (v.every((x) => x === 0)) return '<span class="spark-none">—</span>';
  const w = opts.width || 90, h = opts.height || 26;
  const lo = Math.min(...v), hi = Math.max(...v), span = (hi - lo) || 1;
  const x = (i) => (i / (v.length - 1)) * w;
  const y = (n) => h - 2 - ((n - lo) / span) * (h - 4);
  const pts = v.map((n, i) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(' ');
  const up = v[v.length - 1] >= v[0];
  const stroke = opts.color || (opts.invert ? (up ? '#dc2626' : '#059669') : (up ? '#059669' : '#dc2626'));
  const area = `${x(0)},${h} ${pts} ${x(v.length - 1)},${h}`;
  return `<svg class="spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polygon points="${area}" fill="${stroke}" opacity=".10"/>
    <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/**
 * A line or area chart with a hover readout.
 * @param series [{label, values:[{x,y}], color, area}]
 * @param opts   {height, fmt, empty}
 */
function lineChart(series, opts = {}) {
  const sets = (series || []).filter((s) => s.values && s.values.length);
  if (!sets.length) return empty(opts.empty || 'Nothing to chart yet', opts.height || 180);
  const pointCount = Math.max(...sets.map((s) => s.values.length));
  if (pointCount < 2) return empty(opts.empty || 'One day is not a trend yet', opts.height || 180);

  const W = 1000, H = opts.height || 180, padL = 8, padR = 8, padT = 12, padB = 22;
  const all = sets.flatMap((s) => s.values.map((p) => p.y)).filter((v) => v != null && Number.isFinite(v));
  const lo = opts.zero === false ? Math.min(...all) : Math.min(0, ...all);
  const hi = Math.max(...all, lo + 1);
  const span = (hi - lo) || 1;
  const x = (i) => padL + (i / (pointCount - 1)) * (W - padL - padR);
  const y = (n) => padT + (1 - (n - lo) / span) * (H - padT - padB);

  const grid = [0, 0.5, 1].map((f) => {
    const gy = padT + f * (H - padT - padB);
    return `<line class="ch-grid" x1="${padL}" x2="${W - padR}" y1="${gy.toFixed(1)}" y2="${gy.toFixed(1)}"/>`;
  }).join('');

  const paths = sets.map((s, si) => {
    // A null y is a day with no service — not a day that took nothing. The
    // line breaks there rather than diving to the axis, because a closed
    // Monday drawn at zero reads as a catastrophic Monday.
    const runs = [];
    let run = [];
    s.values.forEach((p, i) => {
      if (p.y == null) { if (run.length) runs.push(run); run = []; return; }
      run.push(`${x(i).toFixed(1)},${y(p.y).toFixed(1)}`);
    });
    if (run.length) runs.push(run);
    const pts = runs.map((r) => r.join(' ')).join('  ');
    const colour = s.color || ['#2563eb', '#d97706', '#059669', '#7c3aed'][si % 4];
    const fill = s.area
      ? runs.filter((r) => r.length > 1).map((r) => {
        const first = r[0].split(',')[0], last = r[r.length - 1].split(',')[0];
        return `<polygon points="${first},${H - padB} ${r.join(' ')} ${last},${H - padB}" fill="${colour}" opacity=".10"/>`;
      }).join('')
      : '';
    // One point with gaps either side has no line to draw, so it gets a dot.
    const lone = runs.filter((r) => r.length === 1)
      .map((r) => `<circle cx="${r[0].split(',')[0]}" cy="${r[0].split(',')[1]}" r="2.75" fill="${colour}"/>`).join('');
    return `${fill}${runs.filter((r) => r.length > 1).map((r) =>
      `<polyline points="${r.join(' ')}" fill="none" stroke="${colour}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}${lone}`;
  }).join('');

  // One hover target per x, carrying every series' value for that point.
  const fmt = opts.fmt || money;
  const hits = Array.from({ length: pointCount }, (_, i) => {
    const label = (sets[0].values[i] || {}).x || '';
    const readout = sets.map((s) => (s.values[i] && s.values[i].y != null)
      ? `${esc(s.label)}: ${fmt(s.values[i].y, s)}` : `${esc(s.label)}: no service`).join(' · ');
    const cx = x(i);
    const dots = sets.map((s, si) => (s.values[i] && s.values[i].y != null)
      ? `<circle cx="${cx.toFixed(1)}" cy="${y(s.values[i].y).toFixed(1)}" r="3.5" fill="${s.color || ['#2563eb', '#d97706', '#059669', '#7c3aed'][si % 4]}"/>` : '').join('');
    return `<g class="ch-hit"><rect x="${(cx - (W / pointCount) / 2).toFixed(1)}" y="0" width="${(W / pointCount).toFixed(1)}" height="${H}" fill="transparent"/>
      <line class="ch-rule" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${padT}" y2="${H - padB}"/>
      ${dots}<title>${esc(label)} — ${esc(readout)}</title></g>`;
  }).join('');

  const ticks = sets[0].values.map((p, i) => {
    const every = Math.ceil(pointCount / 7);
    if (i % every !== 0 && i !== pointCount - 1) return '';
    return `<text class="ch-tick" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(p.x)}</text>`;
  }).join('');

  const legend = sets.length > 1
    ? `<div class="ch-legend">${sets.map((s, si) => `<span><i style="background:${s.color || ['#2563eb', '#d97706', '#059669', '#7c3aed'][si % 4]}"></i>${esc(s.label)}</span>`).join('')}</div>`
    : '';

  return `<div class="chart">${legend}
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg" style="height:${H}px">
      ${grid}${paths}${hits}${ticks}
    </svg></div>`;
}

/** Vertical bars, one per point. */
function barChart(values, opts = {}) {
  const v = (values || []).filter((p) => p && Number.isFinite(p.y));
  if (!v.length) return empty(opts.empty || 'Nothing to chart yet', opts.height || 150);
  const W = 1000, H = opts.height || 150, padT = 10, padB = 22;
  const hi = Math.max(...v.map((p) => p.y), 1);
  const bw = W / v.length;
  const fmt = opts.fmt || money;
  const bars = v.map((p, i) => {
    const h = Math.max(2, ((p.y / hi) * (H - padT - padB)));
    const bx = i * bw + bw * 0.18, w = bw * 0.64;
    return `<g class="ch-bar"><rect x="${bx.toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${opts.color || '#2563eb'}"/>
      <title>${esc(p.x)} — ${fmt(p.y)}</title></g>`;
  }).join('');
  const every = Math.ceil(v.length / 8);
  const ticks = v.map((p, i) => (i % every === 0 || i === v.length - 1)
    ? `<text class="ch-tick" x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(p.x)}</text>` : '').join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg" style="height:${H}px">${bars}${ticks}</svg></div>`;
}

/** Horizontal share bars — a category breakdown that stays readable at ten rows. */
function shareBars(rows, opts = {}) {
  const r = (rows || []).filter((x) => x && Number.isFinite(x.value) && x.value > 0);
  if (!r.length) return empty(opts.empty || 'Nothing to break down yet', 80);
  const total = r.reduce((a, x) => a + x.value, 0) || 1;
  const fmt = opts.fmt || money;
  return `<div class="sharebars">${r.map((x, i) => {
    const pct = (x.value / total) * 100;
    const colour = x.color || ['#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626'][i % 6];
    return `<div class="sb-row">
      <div class="sb-h"><span class="sb-n">${esc(x.label)}</span>
        <span class="sb-v">${fmt(x.value)}<i>${pct.toFixed(0)}%</i></span></div>
      <div class="sb-track"><span style="width:${pct.toFixed(1)}%;background:${colour}"></span></div>
    </div>`;
  }).join('')}</div>`;
}

/** A delta chip: +8.2% in green, -4% in red, or "no prior period". */
function delta(now, before, opts = {}) {
  if (!Number.isFinite(before) || before === 0) return `<span class="dl dl-none">${esc(opts.noneLabel || 'no prior period')}</span>`;
  const pct = ((now - before) / Math.abs(before)) * 100;
  if (Math.abs(pct) < 0.5) return '<span class="dl dl-flat">flat</span>';
  // On a cost, up is bad. On revenue, up is good.
  const good = opts.invert ? pct < 0 : pct > 0;
  return `<span class="dl ${good ? 'dl-up' : 'dl-down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%</span>`;
}

module.exports = { spark, lineChart, barChart, shareBars, delta, money, shortMoney, empty };
