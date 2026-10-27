// Builds docs/report/performance-test-report.html from the run folders in results/.
// Usage: node docs/report/build-report.js
// Each test's data comes from the newest results/<run>/ folder that contains it, so a
// stress rerun doesn't require rerunning the load tests. The report lists the runs used.
// The analysis text lives in analysis.js; every number in tables and charts is read from results/.
const fs = require('fs');
const path = require('path');
const text = require('./analysis.js');

const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS = path.join(ROOT, 'results');
const OUT = path.join(__dirname, 'performance-test-report.html');

// ---------- data ----------

const RUNS = fs.readdirSync(RESULTS, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
const usedRuns = {};

// Newest run folder that has this test's summary.
function runFor(test) {
  const run = RUNS.find((r) => fs.existsSync(path.join(RESULTS, r, `${test}-summary.json`)));
  if (!run) throw new Error(`No results/<run>/${test}-summary.json found`);
  usedRuns[test] = run;
  return run;
}
function summary(test) {
  return JSON.parse(fs.readFileSync(path.join(RESULTS, runFor(test), `${test}-summary.json`), 'utf8'));
}
function metric(s, name) {
  return s.metrics[name];
}
function serverCsv(test) {
  const file = path.join(RESULTS, runFor(test), `${test}-server-metrics.csv`);
  if (!fs.existsSync(file)) return [];
  const [, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  return lines.map((l) => {
    const [t, cpu, mem] = l.split(',').map(Number);
    return { t, cpu, mem };
  });
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const max = (xs) => Math.max(...xs);

const MODULES = [
  {
    id: 'product-search', name: 'Product Search', users: 50,
    requests: [
      { tag: 'search', label: 'Keyword search', share: '70%', limit: 500 },
      { tag: 'search (no match)', label: 'Search, no results', share: '10%', limit: 500 },
      { tag: 'product details', label: 'Product details', share: '20%', limit: 500 },
    ],
  },
  {
    id: 'login', name: 'Login', users: 30,
    requests: [
      { tag: 'login', label: 'Login', share: '85%', limit: 800 },
      { tag: 'whoami', label: 'Profile (whoami)', share: '85%', limit: 500 },
      { tag: 'login (wrong password)', label: 'Login, wrong password', share: '15%', limit: 800 },
    ],
  },
  {
    id: 'basket', name: 'Basket', users: 30,
    requests: [
      { tag: 'basket view', label: 'View basket', share: '40%', limit: 800 },
      { tag: 'basket add', label: 'Add item', share: '20%', limit: 800 },
      { tag: 'basket update', label: 'Change quantity', share: '20%', limit: 800 },
      { tag: 'basket remove', label: 'Remove item', share: '20%', limit: 800 },
    ],
  },
];

for (const m of MODULES) {
  const s = summary(m.id);
  m.summary = s;
  m.reqs = metric(s, 'http_reqs');
  m.failed = metric(s, 'http_req_failed').value;
  m.checks = metric(s, 'checks');
  m.overall = metric(s, 'http_req_duration');
  m.server = serverCsv(m.id);
  for (const r of m.requests) r.d = metric(s, `http_req_duration{name:${r.tag}}`);
  m.pass = m.failed < 0.01 && m.checks.value > 0.99 && m.requests.every((r) => r.d['p(95)'] < r.limit);
}

function stressSteps(test) {
  const s = summary(test);
  const steps = Object.keys(s.metrics)
    .map((k) => /^http_reqs\{step:(\d+)rps\}$/.exec(k))
    .filter(Boolean)
    .map((mm) => Number(mm[1]))
    .sort((a, b) => a - b);
  return {
    summary: s,
    dropped: (metric(s, 'dropped_iterations') || { count: 0 }).count,
    server: serverCsv(test),
    steps: steps.map((rate) => {
      const d = metric(s, `http_req_duration{step:${rate}rps}`);
      const f = metric(s, `http_req_failed{step:${rate}rps}`);
      const n = metric(s, `http_reqs{step:${rate}rps}`);
      return {
        rate, p95: d['p(95)'], med: d.med, avg: d.avg, max: d.max,
        errors: f.value, count: n.count, achieved: n.count / 60,
        pass: d['p(95)'] < 500 && f.value < 0.01,
      };
    }),
  };
}
const stress = stressSteps('stress');
const overload = stressSteps('stress-overload');
const smoke = summary('smoke');

// ---------- formatting ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ms = (v) => (v >= 100000 ? `${Math.round(v / 1000)} s` : v >= 10000 ? `${(v / 1000).toFixed(1)} s` : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(v < 10 ? 1 : 0)} ms`);
const pct = (v, digits = 2) => `${(v * 100).toFixed(digits)}%`;
const num = (v) => Math.round(v).toLocaleString('en-US');
const status = (ok, okText = 'Pass', badText = 'Fail') =>
  `<span class="status ${ok ? 'good' : 'bad'}">${ok ? '&#10003;' : '&#10007;'} ${ok ? okText : badText}</span>`;

// ---------- charts (inline SVG; hover a mark for its value) ----------

const W = 720;

// Smallest round number >= v that splits into 4 round gridline steps.
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].map((k) => k * p).find((x) => x >= v);
}

// Horizontal bars of p95 per request type, each with a tick at its limit.
function p95Bars(requests, title) {
  const rowH = 34, left = 170, right = 90, top = 34;
  const h = top + requests.length * rowH + 30;
  const xMax = niceMax(Math.max(...requests.map((r) => Math.max(r.d['p(95)'], r.limit))) * 1.05);
  const x = (v) => left + (v / xMax) * (W - left - right);
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = (xMax / 4) * i;
    g += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${top - 6}" y2="${h - 26}"/>`;
    g += `<text class="axis" x="${x(v)}" y="${h - 10}" text-anchor="middle">${v} ms</text>`;
  }
  requests.forEach((r, i) => {
    const y = top + i * rowH;
    const v = r.d['p(95)'];
    g += `<text class="label" x="${left - 10}" y="${y + 15}" text-anchor="end">${esc(r.label)}</text>`;
    g += `<g class="hover"><rect class="hit" x="${left}" y="${y}" width="${W - left - right}" height="${rowH - 6}"/>`;
    g += `<path class="bar s1" d="M${left},${y + 4} H${x(v) - 4} a4,4 0 0 1 4,4 V${y + 18} a4,4 0 0 1 -4,4 H${left} Z"/>`;
    g += `<title>${esc(r.label)}: p95 ${ms(v)} (limit ${r.limit} ms), median ${ms(r.d.med)}, max ${ms(r.d.max)}</title></g>`;
    g += `<text class="value" x="${x(v) + 6}" y="${y + 17}">${ms(v)}</text>`;
    g += `<line class="limit" x1="${x(r.limit)}" x2="${x(r.limit)}" y1="${y}" y2="${y + 26}"/>`;
  });
  for (const limit of new Set(requests.map((r) => r.limit))) {
    g += `<text class="axis" x="${x(limit)}" y="${top - 12}" text-anchor="middle">limit ${limit} ms</text>`;
  }
  return figure(title, `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}">${g}</svg>`,
    'Bars show the 95th-percentile response time; the vertical tick on each row marks that request\'s pass/fail limit.');
}

// Line chart. series: [{name, cls, points: [[x, y], ...]}]; one y-axis only.
function lineChart({ title, series, xLabel, yUnit, yFmt = (v) => v, xFmt = (v) => v, refY, refLabel, logY = false, xTicks, note }) {
  const h = 296, left = 64, right = 120, top = 36, bottom = 44;
  const xs = series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = series.flatMap((s) => s.points.map((p) => p[1])).concat(refY ? [refY] : []);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = 0, yMax = niceMax(max(ys) * 1.05);
  let ticks = [0, 1, 2, 3, 4].map((i) => (yMax / 4) * i);
  if (logY) {
    yMin = 10 ** Math.floor(Math.log10(Math.max(1, Math.min(...ys.filter((v) => v > 0)))));
    yMax = 10 ** Math.ceil(Math.log10(max(ys)));
    ticks = [];
    for (let v = yMin; v <= yMax; v *= 10) ticks.push(v);
  }
  const x = (v) => left + ((v - xMin) / (xMax - xMin || 1)) * (W - left - right);
  const y = (v) => logY
    ? top + (1 - (Math.log10(Math.max(v, yMin)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * (h - top - bottom)
    : top + (1 - (v - yMin) / (yMax - yMin)) * (h - top - bottom);
  let g = '';
  for (const v of ticks) {
    g += `<line class="grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text class="axis" x="${left - 8}" y="${y(v) + 4}" text-anchor="end">${yFmt(v)}</text>`;
  }
  for (const v of xTicks || [xMin, (xMin + xMax) / 2, xMax]) {
    g += `<text class="axis" x="${x(v)}" y="${h - bottom + 18}" text-anchor="middle">${xFmt(v)}</text>`;
  }
  g += `<text class="axis" x="${(left + W - right) / 2}" y="${h - 6}" text-anchor="middle">${esc(xLabel)}</text>`;
  g += `<text class="axis" x="12" y="${top - 22}">${esc(yUnit)}</text>`;
  if (refY) {
    g += `<line class="limit dashed" x1="${left}" x2="${W - right}" y1="${y(refY)}" y2="${y(refY)}"/>`;
    g += `<text class="axis" x="${W - right + 6}" y="${y(refY) + 4}">${esc(refLabel)}</text>`;
  }
  const showDots = series.every((s) => s.points.length <= 20);
  const labelYs = [];
  for (const s of series) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
    g += `<path class="line ${s.cls}" d="${d}"/>`;
    for (const p of s.points) {
      g += `<g class="hover"><circle class="hit" cx="${x(p[0])}" cy="${y(p[1])}" r="${showDots ? 10 : 4}"/>`;
      if (showDots) g += `<circle class="dot ${s.cls}" cx="${x(p[0])}" cy="${y(p[1])}" r="4.5"/>`;
      g += `<title>${esc(s.name)} at ${xFmt(p[0])}: ${yFmt(p[1])}</title></g>`;
    }
    // Direct label at the end of the line, nudged apart if two would overlap.
    const last = s.points[s.points.length - 1];
    let ly = y(last[1]) + 4;
    while (labelYs.some((o) => Math.abs(o - ly) < 14)) ly += 14;
    labelYs.push(ly);
    g += `<text class="label" x="${W - right + 8}" y="${ly}">${esc(s.name)}</text>`;
  }
  const legend = series.length > 1
    ? `<div class="legend">${series.map((s) => `<span><i class="key ${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return figure(title, legend + `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(title)}">${g}</svg>`, note);
}

function figure(title, body, note) {
  return `<figure><figcaption>${esc(title)}</figcaption>${body}${note ? `<p class="note">${esc(note)}</p>` : ''}</figure>`;
}

const MODULE_CLS = { 'product-search': 's1', login: 's2', basket: 's3' };
const smooth = (pts, n = 3) => pts.map((p, i) => {
  const w = pts.slice(Math.max(0, i - n + 1), i + 1);
  return [p[0], avg(w.map((q) => q[1]))];
});

// ---------- sections ----------

function verdictTable() {
  const rows = MODULES.map((m) => `<tr><td>${m.name}</td><td>${m.users}</td><td>${num(m.reqs.count)}</td>
    <td>${m.reqs.rate.toFixed(1)}/s</td><td>${ms(m.overall['p(95)'])}</td><td>${pct(m.failed)}</td>
    <td>${pct(m.checks.value)}</td><td>${status(m.pass)}</td></tr>`).join('');
  const breaking = stress.steps.find((s) => !s.pass);
  const lastGood = [...stress.steps].reverse().find((s) => s.rate < (breaking ? breaking.rate : Infinity) && s.pass);
  return `<table><thead><tr><th>Test</th><th>Peak users</th><th>Requests</th><th>Throughput</th><th>p95 (all)</th>
    <th>Failed requests</th><th>Checks passed</th><th>Result</th></tr></thead><tbody>${rows}
    <tr><td>Stress (search)</td><td>up to ${num(metric(stress.summary, 'vus_max').value)}</td><td>${num(metric(stress.summary, 'http_reqs').count)}</td>
    <td>${stress.steps[0].rate}-${stress.steps[stress.steps.length - 1].rate}/s target</td><td colspan="3">
    ${breaking ? `Meets target up to ${lastGood ? lastGood.rate : '-'} req/s; fails from ${breaking.rate} req/s` : 'Met target at every step'}</td>
    <td>${status(!breaking, 'No break', 'Breaking point found')}</td></tr></tbody></table>`;
}

function moduleSection(m) {
  const rows = m.requests.map((r) => `<tr><td>${r.label}</td><td>${r.share}</td><td>${ms(r.d.avg)}</td><td>${ms(r.d.med)}</td>
    <td>${ms(r.d['p(90)'])}</td><td>${ms(r.d['p(95)'])}</td><td>${ms(r.d.max)}</td><td>&lt; ${r.limit} ms</td>
    <td>${status(r.d['p(95)'] < r.limit)}</td></tr>`).join('');
  const cpu = m.server.map((p) => p.cpu);
  const mem = m.server.map((p) => p.mem);
  return `<section><h3>${m.name}</h3>
    <p class="kpis"><span><b>${num(m.reqs.count)}</b> requests</span><span><b>${m.reqs.rate.toFixed(1)}/s</b> average throughput</span>
    <span><b>${pct(m.failed)}</b> failed</span><span><b>${pct(m.checks.value)}</b> checks passed (${num(m.checks.passes)})</span>
    ${cpu.length ? `<span><b>${avg(cpu).toFixed(0)}% / ${max(cpu).toFixed(0)}%</b> server CPU avg / peak</span>
    <span><b>${num(max(mem))} MB</b> peak server memory</span>` : ''}</p>
    <table><thead><tr><th>Request</th><th>Share</th><th>Avg</th><th>Median</th><th>p90</th><th>p95</th><th>Max</th><th>Limit (p95)</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${p95Bars(m.requests, `${m.name}: 95th-percentile response time by request`)}
    ${text.modules[m.id]}</section>`;
}

function serverCharts() {
  const withData = MODULES.filter((m) => m.server.length);
  return lineChart({
    title: 'Juice Shop CPU during each load test (100% = one full core)',
    series: withData.map((m) => ({ name: m.name, cls: MODULE_CLS[m.id], points: smooth(m.server.map((p) => [p.t, p.cpu])) })),
    xLabel: 'Seconds into the test', yUnit: 'CPU %', yFmt: (v) => `${Math.round(v)}%`, xFmt: (v) => `${Math.round(v)} s`,
    xTicks: [0, 60, 120, 180, 240], refY: 100, refLabel: 'one core',
    note: '3-sample moving average. Ramp-up runs for the first 60 s, steady load to 240 s, then ramp-down.',
  });
}

function stressSection() {
  const rows = stress.steps.map((s) => `<tr><td>${s.rate}/s</td><td>${s.achieved.toFixed(1)}/s</td><td>${ms(s.med)}</td>
    <td>${ms(s.p95)}</td><td>${ms(s.max)}</td><td>${pct(s.errors)}</td><td>${status(s.pass)}</td></tr>`).join('');
  const steps = stress.steps.map((s) => s.rate);
  const latency = lineChart({
    title: 'Stress test: search response time at each request rate',
    series: [
      { name: 'p95', cls: 's1', points: stress.steps.map((s) => [s.rate, s.p95]) },
      { name: 'median', cls: 's2', points: stress.steps.map((s) => [s.rate, s.med]) },
    ],
    xLabel: 'Target request rate (requests per second)', yUnit: 'Response time', yFmt: ms, xFmt: (v) => `${v}/s`,
    xTicks: steps, refY: 500, refLabel: '500 ms target', logY: max(stress.steps.map((s) => s.p95)) / 500 > 20,
    note: 'Log scale when values span several orders of magnitude.',
  });
  const throughput = lineChart({
    title: 'Stress test: requests completed versus requests sent',
    series: [
      { name: 'target', cls: 's2', points: stress.steps.map((s) => [s.rate, s.rate]) },
      { name: 'completed', cls: 's1', points: stress.steps.map((s) => [s.rate, s.achieved]) },
    ],
    xLabel: 'Target request rate (requests per second)', yUnit: 'Requests per second', yFmt: (v) => `${Math.round(v)}/s`,
    xFmt: (v) => `${v}/s`, xTicks: steps,
    note: 'When the completed line falls below the target line, the server is no longer keeping up.',
  });
  const cpu = stress.server.length ? lineChart({
    title: 'Stress test: Juice Shop CPU over time (100% = one full core)',
    series: [{ name: 'CPU', cls: 's1', points: smooth(stress.server.map((p) => [p.t, p.cpu])) }],
    xLabel: 'Seconds into the test (one rate step per minute)', yUnit: 'CPU %', yFmt: (v) => `${Math.round(v)}%`,
    xFmt: (v) => `${Math.round(v)} s`, xTicks: steps.map((_, i) => i * 60), refY: 100, refLabel: 'one core',
  }) : '';
  const mem = stress.server.length ? lineChart({
    title: 'Stress test: Juice Shop memory over time',
    series: [{ name: 'Memory', cls: 's1', points: stress.server.map((p) => [p.t, p.mem]) }],
    xLabel: 'Seconds into the test (one rate step per minute)', yUnit: 'MB', yFmt: (v) => `${num(v)} MB`,
    xFmt: (v) => `${Math.round(v)} s`, xTicks: steps.map((_, i) => i * 60),
  }) : '';
  return `<table><thead><tr><th>Target rate</th><th>Completed</th><th>Median</th><th>p95</th><th>Max</th><th>Errors</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="note">Dropped iterations (requests k6 could not start because every virtual user was waiting on a response): ${num(stress.dropped)}.
    A step passes when p95 &lt; 500 ms and errors &lt; 1%.</p>
    ${latency}${throughput}${cpu}${mem}`;
}

function overloadSection() {
  const rows = overload.steps.map((s) => `<tr><td>${s.rate}/s</td><td>${s.achieved.toFixed(1)}/s</td><td>${ms(s.med)}</td>
    <td>${ms(s.p95)}</td><td>${pct(s.errors)}</td></tr>`).join('');
  const memChart = overload.server.length ? lineChart({
    title: 'Overload run: Juice Shop memory over time',
    series: [{ name: 'Memory', cls: 's1', points: overload.server.map((p) => [p.t, p.mem]) }],
    xLabel: 'Seconds into the test', yUnit: 'MB', yFmt: (v) => `${num(v)} MB`, xFmt: (v) => `${Math.round(v)} s`,
    xTicks: [0, 60, 120, 180, 240, 300, 360],
  }) : '';
  return `<table><thead><tr><th>Target rate</th><th>Completed</th><th>Median</th><th>p95</th><th>Errors</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="note">Dropped iterations: ${num(overload.dropped)}. Requests time out after 30 s, which is why p95 sits at 30 s from 400/s.</p>${memChart}`;
}

// ---------- page ----------

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Juice Shop Performance Report</title>
<style>
:root { color-scheme: light;
  --surface: #fcfcfb; --surface-2: #f3f2ef; --border: #dcdad3; --text: #0b0b0b; --text-2: #52514e; --text-3: #75736d;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --good: #0ca30c; --good-text: #006300; --bad: #d03b3b; --bad-text: #b01f1f; --ink: #0b0b0b; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme: dark;
  --surface: #1a1a19; --surface-2: #242422; --border: #3a3936; --text: #f0efec; --text-2: #c3c2b7; --text-3: #9a988f;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --good-text: #4cc94c; --bad-text: #ef7b7b; --ink: #f0efec; } }
:root[data-theme="dark"] { color-scheme: dark;
  --surface: #1a1a19; --surface-2: #242422; --border: #3a3936; --text: #f0efec; --text-2: #c3c2b7; --text-3: #9a988f;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --good-text: #4cc94c; --bad-text: #ef7b7b; --ink: #f0efec; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--text); font: 15px/1.55 "Segoe UI", Arial, sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 4px; } h2 { font-size: 21px; margin: 40px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h3 { font-size: 17px; margin: 28px 0 8px; } p, li { color: var(--text); } .sub { color: var(--text-2); margin: 0 0 24px; }
.scroll { overflow-x: auto; margin: 12px 0; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { background: var(--surface-2); color: var(--text-2); font-weight: 600; }
td { font-variant-numeric: tabular-nums; }
.status { font-weight: 600; white-space: nowrap; } .status.good { color: var(--good-text); } .status.bad { color: var(--bad-text); }
.kpis { display: flex; flex-wrap: wrap; gap: 8px 20px; color: var(--text-2); font-size: 13.5px; } .kpis b { color: var(--text); }
figure { margin: 20px 0; } figcaption { font-weight: 600; margin-bottom: 6px; }
svg { width: 100%; height: auto; display: block; }
.note { color: var(--text-3); font-size: 12.5px; margin: 4px 0 0; }
.legend { display: flex; gap: 16px; font-size: 13px; color: var(--text-2); margin-bottom: 4px; }
.key { display: inline-block; width: 14px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
.key.s1 { background: var(--s1); } .key.s2 { background: var(--s2); } .key.s3 { background: var(--s3); }
.grid { stroke: var(--border); stroke-width: 1; } .axis { fill: var(--text-3); font-size: 11px; }
.label { fill: var(--text-2); font-size: 12px; } .value { fill: var(--text); font-size: 12px; font-weight: 600; }
.bar.s1 { fill: var(--s1); } .limit { stroke: var(--ink); stroke-width: 2; } .dashed { stroke-dasharray: 5 4; stroke-width: 1.5; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; } .line.s1 { stroke: var(--s1); } .line.s2 { stroke: var(--s2); } .line.s3 { stroke: var(--s3); }
.dot { stroke: var(--surface); stroke-width: 2; } .dot.s1 { fill: var(--s1); } .dot.s2 { fill: var(--s2); } .dot.s3 { fill: var(--s3); }
.hit { fill: transparent; } .hover:hover .bar, .hover:hover .dot { opacity: .8; }
code { background: var(--surface-2); padding: 1px 5px; border-radius: 4px; font-size: 13px; }
@media print { :root, :root:not([data-theme="light"]), :root[data-theme="dark"] { color-scheme: light;
  --surface: #ffffff; --surface-2: #f3f2ef; --border: #dcdad3; --text: #0b0b0b; --text-2: #52514e; --text-3: #75736d;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --good-text: #006300; --bad-text: #b01f1f; --ink: #0b0b0b; }
  body { font-size: 12px; } main { max-width: none; padding: 0; } h2 { break-after: avoid; } figure, table { break-inside: avoid; } }
</style></head>
<body><main>
<h1>Juice Shop Performance Test Report</h1>
<p class="sub">OWASP Juice Shop v20.3.0 &middot; k6 v2.3.0 &middot; ${text.date}</p>

<h2>1. Summary</h2>
${text.summary}
${verdictTable()}

<h2>2. Scope and approach</h2>
${text.approach}

<h2>3. Load test results by module</h2>
${MODULES.map(moduleSection).join('')}
<h3>Server CPU across the three modules</h3>
${serverCharts()}
${text.serverCpu}

<h2>4. Stress test: finding the breaking point</h2>
${text.stressIntro}
${stressSection()}
${text.stressAnalysis}

<h2>5. Overload run: what happens past the limit</h2>
${text.overloadIntro}
${overloadSection()}
${text.overloadAnalysis}

<h2>6. Bottlenecks and issues found</h2>
${text.bottlenecks}

<h2>7. Recommendations</h2>
${text.recommendations}

<h2>8. Limitations and workarounds</h2>
${text.limitations}

<h2>9. Reproducing these results</h2>
${text.reproduce}
<p class="note">Smoke test before the runs: ${pct(metric(smoke, 'checks').value)} of ${metric(smoke, 'checks').passes} checks passed, p95 ${ms(metric(smoke, 'http_req_duration')['p(95)'])}.
Generated by docs/report/build-report.js from these run folders:
${Object.entries(usedRuns).map(([t, r]) => `<code>${t}</code>: results/${r}`).join(', ')}.</p>
</main></body></html>`;

// Wrap every table so a wide one scrolls sideways on a phone instead of widening the page.
fs.writeFileSync(OUT, html.replace(/<table>/g, '<div class="scroll"><table>').replace(/<\/table>/g, '</table></div>'));
console.log(`Wrote ${OUT}`);
