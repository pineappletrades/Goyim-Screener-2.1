/* Goyim Screener v2 pages: Charts, Research, Compare, Screener, Calendar, Alerts and the bottom watchlist bar.
   Uses helpers from app.js ($, $$, esc, fmt, pct, money, call, toast, show, S) and icon() from icons.js. */
(function () {
  "use strict";

  const P = {
    chart: { ticker: "", data: null, view: null, ma: [], drag: null, hover: null },
    research: { ticker: "", data: null, range: 20, loading: false },
    compare: { tickers: ["", "", "", ""], data: null, range: 20, loading: false },
    screener: { db: null, filters: {}, sort: { key: "market_cap", dir: -1 }, open: null, enriched: {}, enrichKey: "",
                enriching: false, limit: 200, poll: null, perfKey: "perf_1m", activeScreen: null },
    calendar: { mode: "week", anchor: null, filter: "both", data: null, loading: false },
    alerts: { data: null, draft: null },
    bar: { rows: [], collapsed: false, sort: null, timer: null, needs: null },
  };
  const caps = () => (S.state && S.state.capabilities) || {};
  const capSrc = (k) => (caps().sources || {})[k] || "another data source";
  const cssCache = {};
  const cssVar = (name) => {
    const key = (document.documentElement.dataset.theme || "") + name;
    if (!(key in cssCache)) cssCache[key] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return cssCache[key];
  };
  const ic = (name, size = 16) => (typeof icon === "function" ? icon(name, size) : "");
  const big = (n) => {
    if (n == null || isNaN(n)) return "–";
    const a = Math.abs(n), s = n < 0 ? "-" : "";
    if (a >= 1e12) return s + "$" + (a / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
    if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(0) + "M";
    if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(0) + "K";
    return s + "$" + a.toFixed(2);
  };
  const cls = (n) => (n == null || isNaN(n) ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");
  const pctCell = (n) => `<span class="${cls(n)}">${pct(n)}</span>`;
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const parseDay = (s) => new Date(s + "T12:00:00");
  const cleanT = (t) => String(t || "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
  const needBox = (what, src, extra = "") => `<div class="needs">${ic("plug", 18)}<div><b>${esc(what)} needs ${esc(src)}.</b>
      <span class="muted"> Add the key on Data sources and it switches on. ${extra}</span></div>
      <button class="btn ghost" data-go="sources">Data sources</button></div>`;

  function bindGo(root) {
    $$("[data-go]", root).forEach((b) => (b.onclick = () => show(b.dataset.go)));
  }
  function tickerForm(id, value, label, btn = "Load") {
    return `<form class="tk-form" id="${id}" autocomplete="off">
      <span class="search-ic">${ic("search", 18)}</span>
      <input name="t" value="${esc(value)}" placeholder="${esc(label)}" aria-label="${esc(label)}" maxlength="10">
      <button class="btn primary" type="submit">${esc(btn)}</button></form>`;
  }

  /* =====================================================================
     CHARTS: daily candles up to 10 years, 5 moving-average lines
     ===================================================================== */
  const MA_DEFAULTS = [
    { on: true, type: "EMA", len: 9, color: "#4FC3F7" },
    { on: true, type: "EMA", len: 21, color: "#2BD47D" },
    { on: false, type: "EMA", len: 50, color: "#FF7AB6" },
    { on: true, type: "EMA", len: 150, color: "#F2A93B" },
    { on: true, type: "EMA", len: 200, color: "#9A8CFF" },
  ];
  const RANGES = [["3M", 63], ["6M", 126], ["1Y", 252], ["2Y", 504], ["5Y", 1260], ["10Y", 99999]];

  function chartCfg() {
    const saved = ((S.state.settings || {}).chart || {}).lines;
    if (!P.chart.ma.length) P.chart.ma = (saved && saved.length === 5 ? saved : MA_DEFAULTS).map((x) => ({ ...x, vals: null }));
    return P.chart.ma;
  }
  let saveChartT = null;
  function saveChartCfg() {
    clearTimeout(saveChartT);
    saveChartT = setTimeout(() => {
      const lines = P.chart.ma.map(({ on, type, len, color }) => ({ on, type, len, color }));
      S.state.settings.chart = Object.assign({}, S.state.settings.chart, { lines, ticker: P.chart.ticker });
      call("save_chart_settings", S.state.settings.chart);
    }, 500);
  }

  function computeMA(closes, n, type) {
    const out = new Array(closes.length).fill(null);
    if (type === "SMA") {
      let sum = 0;
      for (let i = 0; i < closes.length; i++) {
        sum += closes[i];
        if (i >= n) sum -= closes[i - n];
        if (i >= n - 1) out[i] = sum / n;
      }
    } else {
      const k = 2 / (n + 1);
      let e = closes[0];
      for (let i = 0; i < closes.length; i++) { e = i ? closes[i] * k + e * (1 - k) : closes[0]; out[i] = i >= Math.min(n, closes.length) - 1 ? e : null; }
    }
    return out;
  }
  function recomputeMAs() {
    const d = P.chart.data;
    if (!d) return;
    P.chart.ma.forEach((m) => (m.vals = m.on ? computeMA(d.c, m.len, m.type) : null));
  }

  function renderCharts() {
    const root = $("#chartsBody");
    const c = caps();
    const ma = chartCfg();
    if (!P.chart.ticker) P.chart.ticker = ((S.state.settings || {}).chart || {}).ticker || (S.state.watchlist || [])[0] || "SPY";
    root.innerHTML = `
      <div class="pg-head">
        <h1>Charts</h1>
        ${tickerForm("chartForm", P.chart.ticker, "Ticker")}
        <div class="seg" id="chartRanges">${RANGES.map(([l, n]) => `<button data-n="${n}">${l}</button>`).join("")}</div>
        <button class="btn ghost" id="chartAlert">${ic("alerts")} Add alert</button>
      </div>
      ${c.bars_10y ? "" : needBox("Charts", capSrc("bars_10y"))}
      <div class="chart-card">
        <div class="chart-top"><div id="chartTitle"></div><div id="chartLegend" class="ma-legend"></div></div>
        <div class="canvas-wrap" id="cvWrap"><canvas id="cv"></canvas><canvas id="cvO" class="cv-over"></canvas><div id="cvTip" class="tip" hidden></div>
          <div id="cvMsg" class="cv-msg muted"></div></div>
        <div class="muted small cv-hint" id="cvHint">Scroll to zoom · drag to move · daily candles</div>
      </div>
      <div class="ma-panel">
        ${ma.map((m, i) => `
          <div class="ma-row ${m.on ? "" : "off"}" data-i="${i}">
            <label class="switch" title="Show line"><input type="checkbox" data-k="on" ${m.on ? "checked" : ""} aria-label="Show line ${i + 1}"><span></span></label>
            <input type="color" data-k="color" value="${esc(m.color)}" aria-label="Line ${i + 1} colour">
            <select data-k="type" aria-label="Line ${i + 1} type"><option ${m.type === "EMA" ? "selected" : ""}>EMA</option><option ${m.type === "SMA" ? "selected" : ""}>SMA</option></select>
            <input type="number" data-k="len" min="2" max="400" value="${m.len}" aria-label="Line ${i + 1} length">
            <input type="range" data-k="slide" min="2" max="400" value="${m.len}" aria-label="Line ${i + 1} length slider">
            <span class="ma-val num" id="maVal${i}">–</span>
          </div>`).join("")}
        <div class="ma-presets"><span class="muted small">Presets</span>
          <button class="tab" data-preset="9,21,50,150,200">9 · 21 · 50 · 150 · 200</button>
          <button class="tab" data-preset="10,20,50,100,200">10 · 20 · 50 · 100 · 200</button>
          <button class="tab" data-preset="8,21,34,55,89">8 · 21 · 34 · 55 · 89</button>
        </div>
      </div>`;
    bindGo(root);
    $("#chartForm").onsubmit = (e) => { e.preventDefault(); loadChart(cleanT(e.target.t.value)); };
    $$("#chartRanges button").forEach((b) => (b.onclick = () => setRange(+b.dataset.n)));
    $("#chartAlert").onclick = () => {
      const m = P.chart.ma.find((x) => x.on) || P.chart.ma[4];
      P.alerts.draft = { ticker: P.chart.ticker, kind: "ma_touch", ma_type: m.type, length: m.len };
      show("alerts");
    };
    $$(".ma-row").forEach((row) => {
      const i = +row.dataset.i, m = P.chart.ma[i];
      row.oninput = (e) => {
        const k = e.target.dataset.k;
        if (k === "on") { m.on = e.target.checked; row.classList.toggle("off", !m.on); }
        else if (k === "color") m.color = e.target.value;
        else if (k === "type") m.type = e.target.value;
        else if (k === "len" || k === "slide") {
          const v = Math.max(2, Math.min(400, parseInt(e.target.value, 10) || 2));
          m.len = v;
          if (k === "slide") $("[data-k=len]", row).value = v; else $("[data-k=slide]", row).value = v;
        }
        if (P.chart.data) m.vals = m.on ? computeMA(P.chart.data.c, m.len, m.type) : null;
        drawCanvas(); saveChartCfg();
      };
    });
    $$("[data-preset]").forEach((b) => (b.onclick = () => {
      b.dataset.preset.split(",").forEach((n, i) => { P.chart.ma[i].len = +n; P.chart.ma[i].type = "EMA"; P.chart.ma[i].on = true; });
      saveChartCfg(); renderCharts();
    }));
    bindCanvas();
    if (P.chart.data && P.chart.data.ticker === P.chart.ticker) { recomputeMAs(); drawCanvas(); }
    else if (c.bars_10y) loadChart(P.chart.ticker);
    else drawCanvas();
  }

  async function loadChart(t) {
    if (!t) return;
    P.chart.ticker = t;
    const f = $("#chartForm"); if (f) f.t.value = t;
    const msg = $("#cvMsg"); if (msg) msg.textContent = `Loading ${t}…`;
    const r = await call("get_chart", t);
    if (!r || !r.ok) {
      P.chart.data = null;
      if ($("#cvMsg")) $("#cvMsg").textContent = (r && r.error) || "Couldn't load the chart";
      drawCanvas();
      return;
    }
    P.chart.data = r;
    const hint = $("#cvHint");
    if (hint) hint.textContent = "Scroll to zoom · drag to move · daily candles" +
      (r.weekly_until ? ` (${r.older_bars || "longer"} bars before ${r.weekly_until}: Public gives daily bars for 5 years)` : "");
    const n = r.c.length;
    P.chart.view = { s: Math.max(0, n - 252), e: n };
    if (P.chart.focus) {                       // opened from a backtest row: centre ~6 months around that day
      const at = r.t.findIndex((x) => x >= P.chart.focus);
      if (at >= 0) { const s0 = Math.max(0, at - 70); P.chart.view = { s: s0, e: Math.min(n, s0 + 150) }; P.chart.hover = at; }
      P.chart.focus = null;
    }
    recomputeMAs();
    if ($("#cvMsg")) $("#cvMsg").textContent = "";
    saveChartCfg();
    drawCanvas();
  }

  function setRange(n) {
    const d = P.chart.data;
    if (!d) return;
    const len = d.c.length;
    P.chart.view = { s: Math.max(0, len - n), e: len };
    drawCanvas();
  }

  function chartGeom(cv) {
    const W = cv.clientWidth, H = cv.clientHeight;
    return { W, H, left: 8, right: 64, top: 10, priceH: Math.round(H * 0.76), volTop: Math.round(H * 0.8), bottom: 22 };
  }

  /* Redraws are batched to one per screen frame, so dragging/hovering/sliders stay smooth. */
  let drawPending = false;
  function drawCanvas() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(() => { drawPending = false; drawNow(); });
  }
  function drawNow() {
    const cv = $("#cv");
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr)), hh = Math.max(1, Math.round(rect.height * dpr));
    const ov = $("#cvO");
    let resized = false;
    for (const c of [cv, ov]) if (c && (c.width !== w || c.height !== hh)) { c.width = w; c.height = hh; resized = true; }   // resizing is slow; only when needed
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const go = ov.getContext("2d");
    go.setTransform(dpr, 0, 0, dpr, 0, 0);
    go.clearRect(0, 0, rect.width, rect.height);
    const d = P.chart.data;
    const title = $("#chartTitle"), legend = $("#chartLegend");
    if (!d) { g.clearRect(0, 0, rect.width, rect.height); P.chart.baseKey = null; if (title) title.innerHTML = ""; if (legend) legend.innerHTML = ""; return; }
    const G = chartGeom(cv);
    const { s, e } = P.chart.view;
    const n = e - s, plotW = G.W - G.left - G.right, bw = plotW / n;
    const col = { text: cssVar("--text"), muted: cssVar("--muted"), line: cssVar("--line-soft"), up: cssVar("--pass"), dn: cssVar("--fail") };
    let hi = -Infinity, lo = Infinity, vmax = 0;
    for (let i = s; i < e; i++) {
      hi = Math.max(hi, d.h[i]); lo = Math.min(lo, d.l[i]); vmax = Math.max(vmax, d.v[i]);
      P.chart.ma.forEach((m) => { if (m.vals && m.vals[i] != null) { hi = Math.max(hi, m.vals[i]); lo = Math.min(lo, m.vals[i]); } });
    }
    const padP = (hi - lo) * 0.06 || 1; hi += padP; lo -= padP;
    const y = (v) => G.top + ((hi - v) / (hi - lo)) * (G.priceH - G.top);
    const x = (i) => G.left + (i - s + 0.5) * bw;
    const volH = G.H - G.bottom - G.volTop;
    P.chart.geom = { G, s, e, bw, x, y, hi, lo };

    const last = d.quote && d.quote.last ? d.quote.last : d.c[d.c.length - 1];
    // The candles, lines and axes only redraw when the view changes; hovering just redraws the crosshair layer.
    const baseKey = [d.ticker, d.c.length, s, e, w, hh, document.documentElement.dataset.theme,
      P.chart.ma.map((m) => (m.vals ? m.type + m.len + m.color : "-")).join()].join("|");
    if (baseKey !== P.chart.baseKey || resized) {
    P.chart.baseKey = baseKey;
    g.clearRect(0, 0, rect.width, rect.height);
    // grid + price axis
    g.font = "11px " + cssVar("--num");
    g.textBaseline = "middle";
    const step = niceStep((hi - lo) / 6);
    g.strokeStyle = col.line; g.fillStyle = col.muted; g.lineWidth = 1;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      g.beginPath(); g.moveTo(G.left, yy); g.lineTo(G.W - G.right, yy); g.stroke();
      g.fillText(fmt(v, v >= 1000 ? 0 : 2), G.W - G.right + 8, yy);
    }
    // date axis
    g.textBaseline = "alphabetic";
    let lastLbl = -1e9;
    for (let i = s; i < e; i++) {
      const prev = i > 0 ? d.t[i - 1] : "";
      const newPeriod = n > 400 ? d.t[i].slice(0, 4) !== prev.slice(0, 4) : d.t[i].slice(0, 7) !== prev.slice(0, 7);
      if (!newPeriod || x(i) - lastLbl < 64) continue;
      const dt = parseDay(d.t[i]);
      const lbl = n > 400 ? String(dt.getFullYear()) : dt.toLocaleDateString(undefined, { month: "short" }) + (dt.getMonth() === 0 ? " " + dt.getFullYear() : "");
      g.fillText(lbl, x(i) - 10, G.H - 6);
      lastLbl = x(i);
    }
    // volume
    for (let i = s; i < e; i++) {
      const h = vmax ? (d.v[i] / vmax) * volH : 0;
      g.fillStyle = d.c[i] >= d.o[i] ? col.up : col.dn;
      g.globalAlpha = 0.28;
      g.fillRect(x(i) - Math.max(1, bw * 0.35), G.volTop + volH - h, Math.max(1, bw * 0.7), h);
    }
    g.globalAlpha = 1;
    // candles (or a line when zoomed far out)
    if (bw < 1.6) {
      g.strokeStyle = col.text; g.lineWidth = 1.2; g.beginPath();
      for (let i = s; i < e; i++) (i === s ? g.moveTo : g.lineTo).call(g, x(i), y(d.c[i]));
      g.stroke();
    } else {
      for (let i = s; i < e; i++) {
        const up = d.c[i] >= d.o[i];
        g.strokeStyle = g.fillStyle = up ? col.up : col.dn;
        const xx = Math.round(x(i)) + 0.5;
        g.beginPath(); g.moveTo(xx, y(d.h[i])); g.lineTo(xx, y(d.l[i])); g.stroke();
        const top = y(Math.max(d.o[i], d.c[i])), h = Math.max(1, Math.abs(y(d.o[i]) - y(d.c[i])));
        const w = Math.max(1, bw * 0.66);
        g.fillRect(x(i) - w / 2, top, w, h);
      }
    }
    // moving averages
    P.chart.ma.forEach((m) => {
      if (!m.vals) return;
      g.strokeStyle = m.color; g.lineWidth = 1.6; g.beginPath();
      let started = false;
      for (let i = s; i < e; i++) {
        const v = m.vals[i];
        if (v == null) continue;
        if (!started) { g.moveTo(x(i), y(v)); started = true; } else g.lineTo(x(i), y(v));
      }
      g.stroke();
    });
    // last price tag
    if (e === d.c.length && last >= lo && last <= hi) {
      const yy = y(last);
      g.setLineDash([3, 3]); g.strokeStyle = col.muted; g.beginPath(); g.moveTo(G.left, yy); g.lineTo(G.W - G.right, yy); g.stroke(); g.setLineDash([]);
      g.fillStyle = cssVar("--primary-bg"); roundRect(g, G.W - G.right + 2, yy - 10, G.right - 4, 20, 6); g.fill();
      g.fillStyle = cssVar("--primary-text"); g.textBaseline = "middle"; g.fillText(fmt(last, 2), G.W - G.right + 8, yy);
    }
    }
    // crosshair (overlay layer)
    const hv = P.chart.hover;
    if (hv != null && hv >= s && hv < e) {
      go.strokeStyle = col.muted; go.setLineDash([4, 4]); go.beginPath(); go.moveTo(Math.round(x(hv)) + 0.5, G.top); go.lineTo(Math.round(x(hv)) + 0.5, G.H - G.bottom); go.stroke(); go.setLineDash([]);
    }
    // header
    const idx = hv != null && hv >= s && hv < e ? hv : d.c.length - 1;
    const prevC = d.c[idx - 1];
    const chg = idx === d.c.length - 1 && d.quote && d.quote.prev_close ? (last / d.quote.prev_close - 1) * 100 : prevC ? (d.c[idx] / prevC - 1) * 100 : null;
    const shown = idx === d.c.length - 1 ? last : d.c[idx];
    const rangeChg = (d.c[e - 1] / d.c[s] - 1) * 100;
    const wk = d.weekly_until && d.t[idx] < d.weekly_until;
    if (title) title.innerHTML = `<span class="ct-t">${esc(d.ticker)}</span> <span class="ct-p num">$${fmt(shown)}</span> ${pctCell(chg)}
      <span class="muted small">${wk ? (d.older_bars === "monthly" ? "month of " : d.older_bars === "weekly" ? "week of " : "bar of ") : ""}${esc(d.t[idx])} · O ${fmt(d.o[idx])} H ${fmt(d.h[idx])} L ${fmt(d.l[idx])} C ${fmt(d.c[idx])} · range ${pct(rangeChg)}</span>`;
    if (legend) legend.innerHTML = P.chart.ma.filter((m) => m.vals).map((m) => `<span class="key"><i style="background:${esc(m.color)}"></i>${m.type} ${m.len} <b class="num">${fmt(m.vals[idx])}</b></span>`).join("");
    P.chart.ma.forEach((m, i) => {
      const el = $("#maVal" + i);
      if (!el) return;
      if (!m.vals || m.vals[d.c.length - 1] == null) { el.textContent = "–"; return; }
      const v = m.vals[d.c.length - 1], dist = (last / v - 1) * 100;
      el.innerHTML = `$${fmt(v)} <span class="${cls(dist)}">${pct(dist)}</span>`;
    });
    // range buttons
    $$("#chartRanges button").forEach((b) => b.classList.toggle("on", e === d.c.length && Math.min(+b.dataset.n, d.c.length) === n));
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }
  function idxAt(clientX) {
    const gm = P.chart.geom, cv = $("#cv");
    if (!gm || !cv) return null;
    const rx = clientX - cv.getBoundingClientRect().left;
    return Math.max(gm.s, Math.min(gm.e - 1, Math.floor((rx - gm.G.left) / gm.bw) + gm.s));
  }
  function bindCanvas() {
    const cv = $("#cv");
    if (!cv) return;
    cv.onwheel = (ev) => {
      if (!P.chart.data) return;
      ev.preventDefault();
      const len = P.chart.data.c.length, { s, e } = P.chart.view, n = e - s;
      const at = idxAt(ev.clientX), frac = (at - s) / n;
      const nn = Math.max(20, Math.min(len, Math.round(n * (ev.deltaY > 0 ? 1.15 : 0.87))));
      let ns = Math.round(at - frac * nn);
      ns = Math.max(0, Math.min(len - nn, ns));
      P.chart.view = { s: ns, e: ns + nn };
      drawCanvas();
    };
    cv.onmousedown = (ev) => { if (P.chart.data) P.chart.drag = { x: ev.clientX, s: P.chart.view.s, e: P.chart.view.e }; };
    window.addEventListener("mouseup", () => (P.chart.drag = null));
    cv.onmousemove = (ev) => {
      if (!P.chart.data) return;
      const dr = P.chart.drag;
      if (dr) {
        const gm = P.chart.geom, len = P.chart.data.c.length, n = dr.e - dr.s;
        let shift = Math.round((dr.x - ev.clientX) / gm.bw);
        let ns = Math.max(0, Math.min(len - n, dr.s + shift));
        P.chart.view = { s: ns, e: ns + n };
      }
      const hv = idxAt(ev.clientX);
      if (hv === P.chart.hover && !dr) return;
      P.chart.hover = hv;
      drawCanvas();
    };
    cv.onmouseleave = () => { P.chart.hover = null; drawCanvas(); };
  }


  /* =====================================================================
     BACKTEST: every pullback to the 150/200 EMA and what happened next
     ===================================================================== */
  const HZ = [["5", "1 week"], ["20", "1 month"], ["60", "3 months"], ["120", "6 months"], ["252", "1 year"]];
  P.bt = { ticker: "", data: null, params: null, group: "all", loading: false };

  function btDefaults() {
    const inv = (S.state.profiles || []).find((x) => x.id === "investing") || {};
    const rp = ((inv.rules || {}).ma_touch || {}).params || {};
    return { mode: "touch", kind: inv.ma_type || "EMA", fast: inv.fast || 150, slow: inv.slow || 200,
             tolerance: rp.tolerance ?? 0.5, above_days: rp.above_days ?? 15, hold: rp.hold ?? true, cooldown: 10 };
  }

  function renderBacktest() {
    const root = $("#backtestBody"), B = P.bt;
    if (!B.params) B.params = btDefaults();
    if (!B.ticker) B.ticker = P.chart.ticker || (S.state.watchlist || [])[0] || "AAPL";
    const p = B.params, c = caps();
    root.innerHTML = `
      <div class="pg-head"><h1>Backtest</h1>${tickerForm("btForm", B.ticker, "Ticker", "Run")}
        <span class="muted small">Every time it came back to the ${esc(p.kind)} ${p.fast}/${p.slow}, and what happened next</span></div>
      ${c.bars ? "" : needBox("Backtests", capSrc("bars"))}
      <form class="card bt-set" id="btSet">
        <label>Find<select name="mode"><option value="touch" ${p.mode === "touch" ? "selected" : ""}>Pullbacks that touch a line (uptrend)</option>
          <option value="zone" ${p.mode === "zone" ? "selected" : ""}>Closes between the two lines (any trend)</option></select></label>
        <label>Average<select name="kind"><option ${p.kind === "EMA" ? "selected" : ""}>EMA</option><option ${p.kind === "SMA" ? "selected" : ""}>SMA</option></select></label>
        <label>Fast<input type="number" name="fast" min="2" max="400" value="${p.fast}"></label>
        <label>Slow<input type="number" name="slow" min="2" max="400" value="${p.slow}"></label>
        <label class="touch-only">Touch within<span class="unit-in"><input type="number" name="tolerance" step="0.1" min="0" max="5" value="${p.tolerance}">%</span></label>
        <label class="touch-only">Above both lines<span class="unit-in"><input type="number" name="above_days" min="0" max="20" value="${p.above_days}">of 20 days</span></label>
        <label class="touch-only chk"><input type="checkbox" name="hold" ${p.hold ? "checked" : ""}> Close held the line</label>
        <label>New event after<span class="unit-in"><input type="number" name="cooldown" min="1" max="60" value="${p.cooldown}">days</span></label>
        <div class="bt-btns"><button type="button" class="btn ghost" id="btReset">Use Investing strategy settings</button><button class="btn primary">Run</button></div>
      </form>
      <div id="btInner"></div>`;
    bindGo(root);
    const set = $("#btSet");
    const sync = () => $$(".touch-only", set).forEach((x) => (x.hidden = set.mode.value !== "touch"));
    set.mode.onchange = sync; sync();
    const read = () => ({ mode: set.mode.value, kind: set.kind.value, fast: +set.fast.value, slow: +set.slow.value,
      tolerance: +set.tolerance.value, above_days: +set.above_days.value, hold: set.hold.checked, cooldown: +set.cooldown.value });
    set.onsubmit = (e) => { e.preventDefault(); B.params = read(); loadBacktest(B.ticker); };
    $("#btReset").onclick = () => { B.params = btDefaults(); renderBacktest(); };
    $("#btForm").onsubmit = (e) => { e.preventDefault(); B.params = read(); loadBacktest(cleanT(e.target.t.value)); };
    if (B.data && B.data.ticker === B.ticker) drawBacktest();
    else if (c.bars) loadBacktest(B.ticker);
  }

  async function loadBacktest(t) {
    if (!t) return;
    const B = P.bt;
    B.ticker = t;
    const f = $("#btForm"); if (f) f.t.value = t;
    const el = $("#btInner");
    if (el) el.innerHTML = `<div class="loading">${ic("refresh", 18)} Going through ${esc(t)}'s daily history…</div>`;
    const r = await call("run_backtest", t, B.params);
    B.data = r && r.ok ? r : { ticker: t, error: (r && r.error) || "Backtest failed" };
    if (S.page === "backtest" && B.ticker === t) drawBacktest();
  }

  function drawBacktest() {
    const B = P.bt, d = B.data, el = $("#btInner");
    if (!el) return;
    if (d.error) { el.innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
    const groups = Object.keys(d.summary);
    if (!groups.includes(B.group)) B.group = groups[0] || "all";
    const sm = d.summary[B.group];
    const label = (k) => ({ all: "All", fast: `${d.params.kind} ${d.params.fast}`, slow: `${d.params.kind} ${d.params.slow}`, zone: "Between the lines" }[k]);
    const per = `${parseDay(d.period.start).toLocaleDateString(undefined, { month: "short", year: "numeric" })} – ${parseDay(d.period.end).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
    const pc = (v, colour = true) => (v == null ? `<span class="muted">–</span>` : `<span class="${colour ? cls(v) : ""}">${v > 0 ? "+" : ""}${fmt(v, 1)}%</span>`);
    let html = "";
    if (!d.events.length) {
      html = `<div class="empty"><p><b>No ${d.params.mode === "zone" ? "visits to the zone" : "pullbacks"} found for ${esc(d.ticker)} in ${per}.</b></p>
        <p class="muted">It either never came back to the lines while trending up, or it spent the period below them. Try a wider touch % or fewer required days above the lines.</p></div>`;
    } else {
      const counts = d.params.mode === "zone" ? `${d.events.length} visits` :
        `${d.events.length} pullbacks · ${(d.summary.fast || {}).count || 0} to the ${d.params.fast} · ${(d.summary.slow || {}).count || 0} to the ${d.params.slow}`;
      html += `<div class="bt-head"><div><div class="bt-big num">${counts}</div><div class="muted small">${per} · daily prices from Public (5 years; the first ${d.params.slow} days warm up the averages)</div></div>
        ${groups.length > 1 ? `<div class="seg" id="btGroup">${groups.map((g) => `<button data-g="${g}" class="${g === B.group ? "on" : ""}">${esc(label(g))}</button>`).join("")}</div>` : ""}</div>
        <div class="bt-cards">${HZ.map(([h, l]) => {
          const x = sm.horizons[h], b = d.baseline[h];
          return `<div class="bt-card"><div class="muted small">After ${l}</div>
            <div class="bt-win num">${x.win == null ? "–" : fmt(x.win, 0) + "%"}<span class="muted small"> up</span></div>
            <div class="small">avg ${pc(x.avg)} · median ${pc(x.median)}</div>
            <div class="small muted">best ${pc(x.best, false)} · worst ${pc(x.worst, false)} · ${x.n} trades</div>
            <div class="small bt-base">any day: ${b.win == null ? "–" : fmt(b.win, 0) + "% up"}, avg ${pc(b.avg, false)}</div></div>`;
        }).join("")}</div>
        <div class="bt-risk muted small">Next 60 days on average: deepest drop ${pc(sm.avg_max_drop_60)}, highest gain ${pc(sm.avg_max_gain_60)}.
          ${sm.broke_rate != null ? `Closed more than 3% below the ${d.params.slow} line within a month: <b>${fmt(sm.broke_rate, 0)}%</b> of the time.` : ""}</div>`;
      html += `<div class="chart-card bt-chart">${btChart(d)}<div class="seg-legend"><span class="key"><i style="background:var(--text)"></i>Price</span>
        <span class="key"><i style="background:var(--fast)"></i>${esc(d.params.kind)} ${d.params.fast}</span><span class="key"><i style="background:var(--slow)"></i>${esc(d.params.kind)} ${d.params.slow}</span>
        <span class="key"><i class="dot-k" style="background:var(--pass)"></i>Pullback (green = up after 3 months, red = down)</span></div></div>`;
      const evs = d.events.slice().reverse();
      html += `<div class="card"><h3>Every ${d.params.mode === "zone" ? "visit" : "pullback"} <span class="muted small">newest first · click to open the chart</span></h3>
        <div class="table-wrap"><table class="res bt-tbl"><thead><tr><th>Date</th><th>Line</th><th class="r">Price</th>${HZ.map(([, l]) => `<th class="r">${l}</th>`).join("")}
          <th class="r">Worst drop 60d</th><th class="r">Best gain 60d</th></tr></thead>
        <tbody>${evs.map((e) => `<tr data-d="${e.date}"><td class="num">${esc(parseDay(e.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}</td>
          <td><span class="line-pill ${e.line}">${esc(label(e.line))}</span>${e.broke_slow_20 ? ` <span class="neg small" title="Closed more than 3% below the slow line within 20 days">broke</span>` : ""}</td>
          <td class="r num">$${fmt(e.price)}</td>${HZ.map(([h]) => `<td class="r num">${pc(e.returns[h])}</td>`).join("")}
          <td class="r num">${pc(e.max_drop_60)}</td><td class="r num">${pc(e.max_gain_60)}</td></tr>`).join("")}</tbody></table></div>
        <p class="muted small">Returns are close-to-close from the day of the pullback, before fees and without stops or dividends. Blank = not enough time has passed yet. Past behaviour doesn't guarantee the next one.</p></div>`;
    }
    el.innerHTML = html;
    $$("#btGroup button", el).forEach((b) => (b.onclick = () => { B.group = b.dataset.g; drawBacktest(); }));
    $$(".bt-tbl tbody tr", el).forEach((tr) => (tr.onclick = () => { P.chart.ticker = d.ticker; P.chart.data = null; P.chart.focus = tr.dataset.d; show("charts"); }));
  }

  function btChart(d) {
    const ch = d.chart, W = 1100, H = 300, padT = 10, padB = 22, padR = 60;
    const all = ch.c.concat(ch.f, ch.s).filter((v) => v != null);
    let max = Math.max(...all), min = Math.min(...all);
    const pad = (max - min) * 0.05; max += pad; min -= pad;
    const n = ch.t.length;
    const x = (i) => 4 + (i / Math.max(1, n - 1)) * (W - padR - 8);
    const y = (v) => padT + ((max - v) / (max - min)) * (H - padT - padB);
    const path = (arr) => arr.map((v, i) => (v == null ? "" : (i && arr[i - 1] != null ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1))).join("");
    let out = "";
    const step = niceStep((max - min) / 5);
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) out += `<line x1="0" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line-soft)"/><text x="${W - padR + 6}" y="${y(v) + 4}" class="ax">${fmt(v, v >= 100 ? 0 : 2)}</text>`;
    let ly = "";
    ch.t.forEach((t, i) => { if (t.slice(0, 4) !== ly && i > 0) out += `<text x="${x(i)}" y="${H - 5}" class="ax" text-anchor="middle">${t.slice(0, 4)}</text>`; ly = t.slice(0, 4); });
    out += `<path d="${path(ch.s)}" fill="none" stroke="var(--slow)" stroke-width="1.6"/><path d="${path(ch.f)}" fill="none" stroke="var(--fast)" stroke-width="1.6"/>
      <path d="${path(ch.c)}" fill="none" stroke="var(--text)" stroke-width="1.2" opacity=".85"/>`;
    const pos = (date) => { let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (ch.t[m] < date) lo = m + 1; else hi = m; } return lo; };
    d.events.forEach((e) => {
      const r = e.returns["60"], col = r == null ? "var(--muted)" : r >= 0 ? "var(--pass)" : "var(--fail)";
      out += `<circle cx="${x(pos(e.date))}" cy="${y(e.price)}" r="5" fill="${col}" stroke="var(--panel)" stroke-width="1.5"><title>${e.date} · ${e.line === "fast" ? d.params.fast : e.line === "slow" ? d.params.slow : "zone"} · $${fmt(e.price)} · 3 months later ${r == null ? "n/a" : (r > 0 ? "+" : "") + fmt(r, 1) + "%"}</title></circle>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="qchart" role="img" aria-label="Price with pullbacks marked">${out}</svg>`;
  }

  /* =====================================================================
     RESEARCH: 14 data points, every quarter for up to 10 years
     ===================================================================== */
  const QR = [["2Y", 8], ["5Y", 20], ["10Y", 40]];
  const METRICS = [
    { id: "price", name: "Stock price", src: "valuation", val: (h, v) => v && v.price, f: (x) => "$" + fmt(x), kind: "line", color: "--text" },
    { id: "revenue", name: "Revenue", val: (h) => h.metrics.revenue, f: big },
    { id: "segments", name: "Revenue by segment", special: "segments" },
    { id: "ebitda", name: "EBITDA", val: (h) => h.metrics.ebitda, f: big, note: "Operating income + depreciation & amortization" },
    { id: "gross_profit", name: "Gross profit", val: (h) => h.metrics.gross_profit, f: big },
    { id: "gross_margin", name: "Gross profit margin", val: (h) => h.metrics.gross_margin, f: (x) => fmt(x, 1) + "%", kind: "line", color: "--pass", noYoY: true },
    { id: "net_income", name: "Net income", val: (h) => h.metrics.net_income, f: big },
    { id: "ocf", name: "Cash from operations", val: (h) => h.metrics.ocf, f: big },
    { id: "fcf", name: "Free cash flow", val: (h) => h.metrics.fcf, f: big, note: "Cash from operations − capital expenditure" },
    { id: "eps", name: "Earnings per share (diluted)", val: (h) => h.metrics.eps, f: (x) => "$" + fmt(x) },
    { id: "capex", name: "Capital expenditure", val: (h) => h.metrics.capex, f: big, color: "--fast" },
    { id: "cashdebt", name: "Cash and debt", special: "cashdebt" },
    { id: "pe", name: "Price to earnings (P/E)", src: "valuation", val: (h, v) => v && v.pe, f: (x) => fmt(x, 1) + "×", kind: "line", color: "--fast", noYoY: true, note: "Quarter-end price ÷ trailing 4-quarter EPS. Blank when earnings were negative." },
    { id: "ps", name: "Price to sales (P/S)", src: "valuation", val: (h, v) => v && v.ps, f: (x) => fmt(x, 1) + "×", kind: "line", color: "--slow", noYoY: true, note: "Market cap ÷ trailing 4-quarter revenue" },
  ];

  function qKey(end) {
    const d = parseDay(end); d.setDate(d.getDate() - 15);
    return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
  }
  function qShort(end) {
    const d = parseDay(end);
    return isNaN(d) ? end : d.toLocaleDateString(undefined, { month: "short" }) + " '" + String(d.getFullYear()).slice(2);
  }

  /* Bar/line chart over quarters. series: [{name, values, color, kind}] */
  function qChart(labels, series, f, opts = {}) {
    const W = 560, H = 190, padT = 14, padB = 24, padL = 4, padR = 58;
    const n = labels.length;
    if (!n) return `<div class="muted small nodata">No data</div>`;
    const all = [];
    series.forEach((s) => s.values.forEach((v) => v != null && isFinite(v) && all.push(v)));
    if (opts.stacked) labels.forEach((_, i) => all.push(series.reduce((a, s) => a + (s.values[i] > 0 ? s.values[i] : 0), 0)));
    if (!all.length) return `<div class="muted small nodata">No data reported for these quarters</div>`;
    const anyBar = series.some((s) => s.kind !== "line");
    let max = Math.max(...all), min = Math.min(...all);
    if (anyBar) { max = Math.max(0, max); min = Math.min(0, min); }
    const pad = (max - min) * 0.08 || Math.abs(max) * 0.1 || 1;
    if (!anyBar || min < 0) min -= pad;
    max += pad;
    const y = (v) => padT + ((max - v) / (max - min)) * (H - padT - padB);
    const slot = (W - padL - padR) / n, cx = (i) => padL + slot * i + slot / 2;
    const bars = series.filter((s) => s.kind !== "line"), lines = series.filter((s) => s.kind === "line");
    let out = "";
    const step = niceStep((max - min) / 4);
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
      out += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line-soft)"/>
        <text x="${W - padR + 6}" y="${y(v) + 4}" class="ax">${esc(f(v))}</text>`;
    }
    if (anyBar && min < 0) out += `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-width=".8"/>`;
    const every = Math.ceil(n / 8);
    labels.forEach((l, i) => {
      if ((n - 1 - i) % every === 0) out += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle" class="ax">${esc(qShort(l))}</text>`;
    });
    if (opts.stacked) {
      labels.forEach((l, i) => {
        let acc = 0;
        const w = slot * 0.66;
        bars.forEach((s) => {
          const v = s.values[i];
          if (v == null || v <= 0) return;
          const top = y(acc + v), h = y(acc) - top;
          out += `<rect x="${cx(i) - w / 2}" y="${top}" width="${w}" height="${Math.max(0.5, h)}" fill="${s.color}"><title>${esc(qShort(l))} · ${esc(s.name)}: ${esc(f(v))}</title></rect>`;
          acc += v;
        });
      });
    } else if (bars.length) {
      const groupW = slot * 0.72, w = groupW / bars.length;
      bars.forEach((s, k) => {
        s.values.forEach((v, i) => {
          if (v == null || !isFinite(v)) return;
          const top = Math.min(y(v), y(0)), h = Math.max(1, Math.abs(y(v) - y(0)));
          const fill = s.colorNeg && v < 0 ? s.colorNeg : s.color;
          out += `<rect x="${cx(i) - groupW / 2 + k * w + 0.5}" y="${top}" width="${Math.max(1, w - 1)}" height="${h}" rx="1.5" fill="${fill}" opacity="${(opts.derived || [])[i] ? 0.6 : 0.95}"><title>${esc(qShort(labels[i]))}${bars.length > 1 ? " · " + esc(s.name) : ""}: ${esc(f(v))}${(opts.derived || [])[i] ? " (Q4 worked out from the annual report)" : ""}</title></rect>`;
        });
      });
    }
    lines.forEach((s) => {
      let d = "", started = false;
      s.values.forEach((v, i) => {
        if (v == null || !isFinite(v)) { started = false; return; }
        d += (started ? "L" : "M") + cx(i).toFixed(1) + " " + y(v).toFixed(1);
        started = true;
      });
      out += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
      s.values.forEach((v, i) => {
        if (v == null || !isFinite(v)) return;
        out += `<circle cx="${cx(i)}" cy="${y(v)}" r="${n > 24 ? 2 : 3}" fill="${s.color}"><title>${esc(qShort(labels[i]))}${series.length > 1 ? " · " + esc(s.name) : ""}: ${esc(f(v))}</title></circle>`;
      });
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="qchart" role="img" aria-label="${esc(opts.label || "Quarterly chart")}">${out}</svg>`;
  }

  function lastVal(arr) { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return [arr[i], i]; return [null, -1]; }

  function renderResearch() {
    const root = $("#researchBody");
    const R = P.research;
    if (!R.ticker) R.ticker = (S.state.watchlist || [])[0] || "AAPL";
    const c = caps();
    root.innerHTML = `
      <div class="pg-head">
        <h1>Research</h1>
        ${tickerForm("resForm", R.ticker, "Ticker")}
        <div class="seg" id="resRange">${QR.map(([l, n]) => `<button data-n="${n}" class="${R.range === n ? "on" : ""}">${l}</button>`).join("")}</div>
        <button class="btn ghost" id="resChart">${ic("charts")} Chart</button>
        <button class="btn ghost" id="resCompare">${ic("compare")} Compare</button>
      </div>
      ${c.history ? "" : needBox("Research", capSrc("history"))}
      <div id="resInner"></div>`;
    bindGo(root);
    $("#resForm").onsubmit = (e) => { e.preventDefault(); loadResearch(cleanT(e.target.t.value)); };
    $$("#resRange button").forEach((b) => (b.onclick = () => { R.range = +b.dataset.n; renderResearch(); }));
    $("#resChart").onclick = () => { P.chart.ticker = R.ticker; P.chart.data = null; show("charts"); };
    $("#resCompare").onclick = () => { P.compare.tickers = [R.ticker, "", "", ""]; P.compare.data = null; show("compare"); };
    if (R.data && R.data.ticker === R.ticker) drawResearch();
    else if (c.history || c.valuation_history) loadResearch(R.ticker);
  }

  async function loadResearch(t) {
    if (!t) return;
    const R = P.research;
    R.ticker = t;
    const inner = $("#resInner");
    if (inner) inner.innerHTML = `<div class="loading">${ic("refresh", 18)} Loading ten years of filings for ${esc(t)}…</div>`;
    const r = await call("get_research", t, true);
    R.data = r && r.ok ? r : { ticker: t, error: (r && r.error) || "Couldn't load", history: null, unavailable: {}, errors: {} };
    if (P.research.ticker === t && S.page === "research") drawResearch();
  }

  function drawResearch() {
    const R = P.research, d = R.data, inner = $("#resInner");
    if (!inner) return;
    if (d.error) { inner.innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
    const h = d.history, v = d.valuation;
    const errs = Object.entries(d.errors || {}).map(([k, m]) => `<div class="err"><b>${esc(k)}:</b> ${esc(m)}</div>`).join("");
    if (!h) { inner.innerHTML = errs || `<div class="empty"><p>No quarterly filings found for ${esc(d.ticker)}.</p></div>`; return; }
    const n = Math.min(R.range, h.quarters.length), s = h.quarters.length - n;
    const labels = h.quarters.slice(s);
    const derived = h.quarters.slice(s).map((q) => (h.derived_q4 || []).includes(q));
    const q = d.quote || {};
    const m = h.metrics;
    const ttm = (arr) => { const xs = arr.slice(-4); return xs.length === 4 && xs.every((x) => x != null) ? xs.reduce((a, b) => a + b, 0) : null; };
    const [mcShares] = lastVal(m.shares || []);
    const price = q.last || (v && lastVal(v.price || [])[0]);
    const mcap = price && mcShares ? price * mcShares : null;
    const revT = ttm(m.revenue), epsT = ttm(m.eps), fcfT = ttm(m.fcf);
    const dayChg = q.last && q.prev_close ? (q.last / q.prev_close - 1) * 100 : null;
    let html = researchHeader(d, { price, mcap, revT, shares: mcShares, dayChg }) + errs +
      researchStats(d) + `<h2 class="sec-h">Quarterly financials</h2><div class="metric-grid">`;
    const colorOf = (name) => `var(${name})`;
    for (const M of METRICS) {
      let body = "", head = "";
      if (M.special === "segments") {
        if (d.unavailable && d.unavailable.segments) { html += unavailableCard(M.name, d.unavailable.segments); continue; }
        const segs = (d.segments || []).slice().reverse();
        if (!segs.length) { html += `<div class="mcard"><div class="mc-h"><h3>${M.name}</h3></div><div class="muted small nodata">${d.errors && d.errors.segments ? esc(d.errors.segments) : "No segment breakdown reported"}</div></div>`; continue; }
        const use = segs.slice(-n);
        const names = [];
        use.forEach((r) => r.segments.forEach((x) => !names.includes(x.label) && names.push(x.label)));
        const palette = ["#9A8CFF", "#F2A93B", "#2BD47D", "#4FC3F7", "#FF7AB6", "#F5C451", "#8A8A8E", "#FF5A5F"];
        const series = names.slice(0, 8).map((nm, i) => ({ name: nm, color: palette[i], values: use.map((r) => { const f = r.segments.find((x) => x.label === nm); return f ? f.value : null; }) }));
        body = qChart(use.map((r) => r.end), series, big, { stacked: true, label: M.name }) +
          `<div class="seg-legend">${series.map((s) => `<span class="key"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;
        head = `<span class="muted small">by ${esc(use[use.length - 1].breakdown || "segment")}</span>`;
      } else if (M.special === "cashdebt") {
        const cash = m.cash.slice(s), debt = m.debt.slice(s);
        body = qChart(labels, [{ name: "Cash", values: cash, color: colorOf("--pass") }, { name: "Debt", values: debt, color: colorOf("--fail") }], big, { label: M.name }) +
          `<div class="seg-legend"><span class="key"><i style="background:var(--pass)"></i>Cash</span><span class="key"><i style="background:var(--fail)"></i>Debt</span></div>`;
        const [c1] = lastVal(cash), [d1] = lastVal(debt);
        head = `<span class="num mc-v">${big(c1)} / ${big(d1)}</span>`;
      } else {
        if (M.src === "valuation" && !v) {
          if (d.unavailable && d.unavailable.valuation) { html += unavailableCard(M.name, d.unavailable.valuation); continue; }
        }
        const vals = (M.val(h, v) || []).slice(s);
        const [lv, li] = lastVal(vals);
        let yoy = null;
        if (!M.noYoY && li >= 4 && vals[li - 4] != null && vals[li - 4] !== 0) yoy = (lv - vals[li - 4]) / Math.abs(vals[li - 4]) * 100;
        head = `<span class="num mc-v">${lv == null ? "–" : esc(M.f(lv))}</span>${yoy != null ? `<span class="small ${cls(yoy)}">${pct(yoy)} YoY</span>` : ""}`;
        body = qChart(labels, [{ name: M.name, values: vals, color: colorOf(M.color || "--slow"), colorNeg: "var(--fail)", kind: M.kind }], M.f, { derived, label: M.name });
      }
      html += `<div class="mcard"><div class="mc-h"><h3>${esc(M.name)}</h3>${head}</div>${body}${M.note ? `<div class="muted small">${esc(M.note)}</div>` : ""}</div>`;
    }
    html += `</div><p class="muted small">Quarterly figures from SEC filings${d.segments ? ", segments from Financial Datasets" : ""}. Faded bars are fourth quarters worked out from the annual report minus the first three quarters.</p>`;
    inner.innerHTML = html;
    bindGo(inner);
    $$("[data-url]", inner).forEach((a) => (a.onclick = (e) => { e.preventDefault(); call("open_url", a.dataset.url); }));
  }

  /* Company header and Statistics (TTM), like a fundamentals site's summary page */
  function researchHeader(d, fb) {
    const st = d.stats || {}, p = st.profile || {}, c = caps();
    const price = p.price ?? fb.price, chg = p.change_pct ?? fb.dayChg;
    const row = (k, v) => `<div class="kv"><span>${esc(k)}</span><b class="num">${v}</b></div>`;
    const need = (src) => `<span class="muted small">Needs ${esc(src)}</span>`;
    const site = p.website ? `<a href="#" data-url="${esc(/^https?:/.test(p.website) ? p.website : "https://" + p.website)}">${esc(p.website.replace(/^https?:\/\//, ""))} ${ic("external", 12)}</a>` : "–";
    const nextE = p.next_earnings_date ? esc(parseDay(p.next_earnings_date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))
      : c.next_earnings_date ? "–" : need(capSrc("next_earnings_date"));
    const chgAbs = p.change != null ? `${p.change >= 0 ? "+" : "-"}$${fmt(Math.abs(p.change))} ` : "";
    return `<div class="co-card">
      <div class="co-top">
        <div><div class="co-name">${esc(p.name || d.ticker)}</div>
          <div class="co-sub"><span class="tk-pill">${esc(d.ticker)}</span>${p.exchange ? `<span class="muted">${esc(p.exchange)}</span>` : ""}
            ${p.sector ? `<span class="sector-pill">${esc(p.sector)}</span>` : ""}${p.industry ? `<span class="muted">${esc(p.industry)}</span>` : ""}</div></div>
        <div class="co-price"><div class="num">${price ? "$" + fmt(price) : "–"}</div><div class="${cls(chg)} num">${chgAbs}${chg != null ? "(" + pct(chg, 2) + ")" : ""} <span class="muted small">today</span></div></div>
      </div>
      <div class="kv-cols"><div>
        ${row("Market cap", big(p.market_cap ?? fb.mcap))}${row("Sector", esc(p.sector || "–"))}${row("Industry", esc(p.industry || "–"))}
        ${row("Website", site)}${row("Revenue (TTM)", big(p.revenue_ttm ?? fb.revT))}${row("Shares outstanding", p.shares || fb.shares ? fmt((p.shares || fb.shares) / 1e9, 2) + "B" : "–")}
      </div><div>
        ${row("Current share price", price ? "$" + fmt(price) : "–")}
        ${row("Today's change", `<span class="chg-pill ${cls(chg)}">${chgAbs || "–"}</span>`)}
        ${row("After-hours price", p.after_hours != null ? "$" + fmt(p.after_hours) + ` <span class="${cls(p.after_hours - price)} small">${pct((p.after_hours / price - 1) * 100, 2)}</span>` : `<span class="muted small">None right now</span>`)}
        ${row("52-week range", p.low_52w != null ? "$" + fmt(p.low_52w) + " – $" + fmt(p.high_52w) : "–")}
        ${row("Next earnings date", nextE)}
        ${row("Last earnings report", p.last_earnings_date ? esc(parseDay(p.last_earnings_date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })) : "–")}
      </div></div></div>`;
  }
  function statVal(r) {
    if (r.needs && !caps()[r.needs]) return `<span class="muted small">Needs ${esc(capSrc(r.needs))}</span>`;
    const v = r.value;
    if (v == null || (typeof v === "number" && !isFinite(v))) return "–";
    switch (r.fmt) {
      case "x": return fmt(v, 2) + "×";
      case "%": return `<span class="${r.label.startsWith("Revenue") || r.label.startsWith("EPS") ? cls(v) : ""}">${fmt(v, 2)}%</span>`;
      case "$": return "$" + fmt(v, 2);
      case "big": return big(v);
      default: return esc(v);
    }
  }
  function cagrCard(rows) {
    rows = (rows || []).filter((r) => Object.values(r.values).some((v) => v != null));
    if (!rows.length) return "";
    const yrs = ["1", "3", "5", "10"];
    const cell = (v) => (v == null ? `<td class="r muted">–</td>` : `<td class="r num"><span class="${cls(v)}">${v > 0 ? "+" : ""}${fmt(v, 1)}%</span></td>`);
    return `<div class="stat-card cagr-card"><h3>Growth (CAGR)</h3>
      <table class="cagr"><thead><tr><th></th>${yrs.map((y) => `<th class="r">${y} yr</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.label)}</td>${yrs.map((y) => cell(r.values[y])).join("")}</tr>`).join("")}</tbody></table>
      <div class="muted small">Compound annual growth of the trailing-4-quarter total (price, shares, equity and cash use the value on that date).
        “–” means not enough history, or a loss at the start or end (CAGR isn't meaningful then). Shares going down = buybacks.</div></div>`;
  }
  function researchStats(d) {
    const st = d.stats;
    if (!st || !st.groups) return "";
    return `<h2 class="sec-h">Statistics (TTM)</h2><div class="stat-grid">${st.groups.map((g) => `<div class="stat-card"><h3>${esc(g.title)}</h3>
      ${g.rows.map((r) => `<div class="kv"><span>${esc(r.label)}</span><b class="num">${statVal(r)}</b></div>`).join("")}</div>`).join("")}</div>
      ${cagrCard(st.cagr)}
      <p class="muted small">Worked out from the last four quarterly filings and today's price. ROIC uses the company's own tax rate (21% if it isn't reported). PEG = P/E ÷ EPS growth over the last year.</p>`;
  }
  function unavailableCard(name, src) {
    return `<div class="mcard off"><div class="mc-h"><h3>${esc(name)}</h3></div>
      <div class="nodata"><span class="muted">${ic("plug", 16)} Needs ${esc(src)}</span> <button class="btn ghost" data-go="sources">Connect</button></div></div>`;
  }

  /* =====================================================================
     COMPARE: up to four tickers side by side
     ===================================================================== */
  const CMP_COLORS = ["--slow", "--fast", "--pass", "#4FC3F7"];
  const cmpColor = (i) => (CMP_COLORS[i].startsWith("--") ? `var(${CMP_COLORS[i]})` : CMP_COLORS[i]);

  function renderCompare() {
    const root = $("#compareBody"), C = P.compare;
    const c = caps();
    if (!C.tickers.some(Boolean)) C.tickers = ((S.state.watchlist || []).slice(0, 2).concat(["", "", "", ""])).slice(0, 4);
    root.innerHTML = `
      <div class="pg-head"><h1>Compare</h1>
        <div class="seg" id="cmpRange">${QR.map(([l, n]) => `<button data-n="${n}" class="${C.range === n ? "on" : ""}">${l}</button>`).join("")}</div></div>
      ${c.history ? "" : needBox("Compare", capSrc("history"))}
      <form id="cmpForm" class="cmp-form" autocomplete="off">
        ${C.tickers.map((t, i) => `<label class="cmp-in"><i style="background:${cmpColor(i)}"></i><input name="t${i}" value="${esc(t)}" placeholder="Ticker ${i + 1}" maxlength="10" aria-label="Ticker ${i + 1}"></label>`).join("")}
        <button class="btn primary" type="submit">Compare</button>
      </form>
      <div id="cmpInner"></div>`;
    bindGo(root);
    $("#cmpForm").onsubmit = (e) => { e.preventDefault(); C.tickers = [0, 1, 2, 3].map((i) => cleanT(e.target["t" + i].value)); loadCompare(); };
    $$("#cmpRange button").forEach((b) => (b.onclick = () => { C.range = +b.dataset.n; renderCompare(); }));
    if (C.data) drawCompare();
    else if (c.history && C.tickers.filter(Boolean).length) loadCompare();
  }

  async function loadCompare() {
    const C = P.compare, list = C.tickers.filter(Boolean);
    const inner = $("#cmpInner");
    if (!list.length) { if (inner) inner.innerHTML = ""; return; }
    if (inner) inner.innerHTML = `<div class="loading">${ic("refresh", 18)} Loading ${esc(list.join(", "))}…</div>`;
    const r = await call("get_compare", list);
    C.data = r && r.ok ? r.items : [];
    if (S.page === "compare") drawCompare();
  }

  function cagrOf(it) {
    const rows = (it.stats && it.stats.cagr) || [], get = (k, y) => { const r = rows.find((x) => x.key === k); return r ? r.values[y] : null; };
    return { revC3: get("revenue", "3"), revC5: get("revenue", "5"), revC10: get("revenue", "10"), epsC5: get("eps", "5"),
             fcfC5: get("fcf", "5"), pxC5: get("price", "5"), pxC10: get("price", "10") };
  }
  function drawCompare() {
    const C = P.compare, items = C.data || [], inner = $("#cmpInner");
    if (!inner) return;
    if (!items.length) { inner.innerHTML = ""; return; }
    const ttm = (arr) => { const xs = (arr || []).filter((x) => x != null).slice(-4); return xs.length === 4 ? xs.reduce((a, b) => a + b, 0) : null; };
    const ttmPrev = (arr) => { const xs = (arr || []).filter((x) => x != null); return xs.length >= 8 ? xs.slice(-8, -4).reduce((a, b) => a + b, 0) : null; };
    const rows = items.map((it) => {
      const h = it.history, m = h ? h.metrics : {};
      const price = it.quote && it.quote.last ? it.quote.last : it.valuation ? lastVal(it.valuation.price || [])[0] : null;
      const sh = lastVal(m.shares || [])[0];
      const mcap = price && sh ? price * sh : null;
      const rev = ttm(m.revenue), revP = ttmPrev(m.revenue), eps = ttm(m.eps), epsP = ttmPrev(m.eps);
      const gm = rev && ttm(m.gross_profit) != null ? ttm(m.gross_profit) / rev * 100 : null;
      const ni = ttm(m.net_income);
      const p = it.prices, perf = p && p.c.length > 52 ? (p.c[p.c.length - 1] / p.c[p.c.length - 53] - 1) * 100 : null;
      return {
        t: it.ticker, err: it.error || (!h && Object.values(it.errors || {})[0]),
        price, mcap, rev, revG: rev && revP ? (rev / revP - 1) * 100 : null, gm, nm: rev && ni != null ? ni / rev * 100 : null,
        ni, eps, epsG: eps != null && epsP ? (eps - epsP) / Math.abs(epsP) * 100 : null,
        ocf: ttm(m.ocf), fcf: ttm(m.fcf), cash: lastVal(m.cash || [])[0], debt: lastVal(m.debt || [])[0],
        pe: price && eps > 0 ? price / eps : null, ps: mcap && rev ? mcap / rev : null, perf,
        ...cagrOf(it),
      };
    });
    const lines = [
      ["Price", "price", (x) => "$" + fmt(x), 0], ["Market cap", "mcap", big, 1], ["Revenue (TTM)", "rev", big, 1],
      ["Revenue growth (YoY)", "revG", (x) => pct(x), 1], ["Gross margin", "gm", (x) => fmt(x, 1) + "%", 1],
      ["Net margin", "nm", (x) => fmt(x, 1) + "%", 1], ["Net income (TTM)", "ni", big, 1], ["EPS (TTM)", "eps", (x) => "$" + fmt(x), 1],
      ["EPS growth (YoY)", "epsG", (x) => pct(x), 1], ["Cash from operations (TTM)", "ocf", big, 1], ["Free cash flow (TTM)", "fcf", big, 1],
      ["Cash", "cash", big, 1], ["Debt", "debt", big, -1], ["P/E", "pe", (x) => fmt(x, 1) + "×", -1], ["P/S", "ps", (x) => fmt(x, 1) + "×", -1],
      ["Price change (1Y)", "perf", (x) => pct(x), 1],
      ["Revenue CAGR 3y", "revC3", (x) => pct(x), 1], ["Revenue CAGR 5y", "revC5", (x) => pct(x), 1],
      ["Revenue CAGR 10y", "revC10", (x) => pct(x), 1], ["EPS CAGR 5y", "epsC5", (x) => pct(x), 1],
      ["FCF CAGR 5y", "fcfC5", (x) => pct(x), 1], ["Share price CAGR 5y", "pxC5", (x) => pct(x), 1],
      ["Share price CAGR 10y", "pxC10", (x) => pct(x), 1],
    ];
    let html = `<div class="card cmp-table"><table class="res"><thead><tr><th></th>${rows.map((r, i) => `<th class="r"><span class="cmp-dot" style="background:${cmpColor(C.tickers.indexOf(r.t) >= 0 ? C.tickers.indexOf(r.t) : i)}"></span>${esc(r.t)}</th>`).join("")}</tr></thead><tbody>`;
    for (const [label, k, f, better] of lines) {
      const vals = rows.map((r) => r[k]).filter((x) => x != null && isFinite(x));
      const best = better && vals.length > 1 ? (better > 0 ? Math.max(...vals) : Math.min(...vals.filter((x) => k === "debt" || x > 0))) : null;
      html += `<tr><td class="muted">${label}</td>${rows.map((r) => `<td class="r num ${r[k] != null && r[k] === best ? "best" : ""}">${r[k] == null || !isFinite(r[k]) ? "–" : esc(f(r[k]))}</td>`).join("")}</tr>`;
    }
    html += `</tbody></table>${rows.filter((r) => r.err).map((r) => `<div class="muted small">${esc(r.t)}: ${esc(r.err)}</div>`).join("")}
      <div class="muted small">Highlighted = best of the group. TTM = last four quarters.</div></div>`;

    // price performance (weekly closes, indexed to 100)
    const weeks = Math.round(C.range * 13);
    const priced = items.filter((it) => it.prices && it.prices.c.length);
    if (priced.length) {
      html += `<div class="mcard wide"><div class="mc-h"><h3>Price performance</h3><span class="muted small">indexed to 100</span></div>${perfChart(priced, weeks)}</div>`;
    } else if (!caps().bars_10y) html += unavailableCard("Price performance", capSrc("bars_10y"));

    // quarterly metrics aligned by calendar quarter
    const keys = new Set();
    items.forEach((it) => it.history && it.history.quarters.forEach((q) => keys.add(qKey(q))));
    const allKeys = [...keys].sort().slice(-C.range);
    const keyEnd = {};
    items.forEach((it) => it.history && it.history.quarters.forEach((q) => (keyEnd[qKey(q)] = keyEnd[qKey(q)] || q)));
    const labels = allKeys.map((k) => keyEnd[k]);
    const pick = (it, getter) => {
      if (!it.history) return allKeys.map(() => null);
      const map = {};
      const arr = getter(it) || [];
      it.history.quarters.forEach((q, i) => (map[qKey(q)] = arr[i]));
      return allKeys.map((k) => (map[k] == null ? null : map[k]));
    };
    html += `<div class="metric-grid">`;
    const cm = METRICS.filter((M) => !M.special && M.id !== "price");
    for (const M of cm) {
      const series = items.map((it, i) => ({ name: it.ticker, color: cmpColor(C.tickers.indexOf(it.ticker) >= 0 ? C.tickers.indexOf(it.ticker) : i), kind: "line", values: pick(it, (x) => M.val(x.history, x.valuation)) }));
      html += `<div class="mcard"><div class="mc-h"><h3>${esc(M.name)}</h3></div>${qChart(labels, series, M.f, { label: M.name })}</div>`;
    }
    const fcfM = { f: big };
    html += `<div class="mcard"><div class="mc-h"><h3>Cash</h3></div>${qChart(labels, items.map((it, i) => ({ name: it.ticker, color: cmpColor(i), kind: "line", values: pick(it, (x) => x.history.metrics.cash) })), fcfM.f)}</div>`;
    html += `<div class="mcard"><div class="mc-h"><h3>Debt</h3></div>${qChart(labels, items.map((it, i) => ({ name: it.ticker, color: cmpColor(i), kind: "line", values: pick(it, (x) => x.history.metrics.debt) })), fcfM.f)}</div>`;
    html += `</div><div class="seg-legend">${items.map((it, i) => `<span class="key"><i style="background:${cmpColor(i)}"></i>${esc(it.ticker)}</span>`).join("")}</div>`;
    inner.innerHTML = html;
    bindGo(inner);
  }

  function perfChart(items, weeks) {
    const W = 1100, H = 240, padT = 12, padB = 24, padR = 56;
    const ser = items.map((it, i) => {
      const p = it.prices, s = Math.max(0, p.c.length - weeks);
      const base = p.c[s];
      return { t: it.ticker, i, dates: p.t.slice(s), vals: p.c.slice(s).map((x) => (x / base) * 100) };
    });
    const allDates = [...new Set(ser.flatMap((s) => s.dates))].sort();
    const xi = {}; allDates.forEach((d, i) => (xi[d] = i));
    const all = ser.flatMap((s) => s.vals);
    let max = Math.max(...all), min = Math.min(...all);
    const pad = (max - min) * 0.06 || 1; max += pad; min -= pad;
    const x = (d) => 4 + (xi[d] / Math.max(1, allDates.length - 1)) * (W - padR - 8);
    const y = (v) => padT + ((max - v) / (max - min)) * (H - padT - padB);
    let out = "";
    const step = niceStep((max - min) / 5);
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) out += `<line x1="0" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line-soft)"/><text x="${W - padR + 6}" y="${y(v) + 4}" class="ax">${fmt(v, 0)}</text>`;
    let lastY = "";
    allDates.forEach((d, i) => { if (d.slice(0, 4) !== lastY && i > 0) { out += `<text x="${x(d)}" y="${H - 6}" class="ax" text-anchor="middle">${d.slice(0, 4)}</text>`; } lastY = d.slice(0, 4); });
    ser.forEach((s) => {
      const col = cmpColor(P.compare.tickers.indexOf(s.t) >= 0 ? P.compare.tickers.indexOf(s.t) : s.i);
      out += `<path d="${s.vals.map((v, i) => (i ? "L" : "M") + x(s.dates[i]).toFixed(1) + " " + y(v).toFixed(1)).join("")}" fill="none" stroke="${col}" stroke-width="2"/>`;
      const lv = s.vals[s.vals.length - 1];
      out += `<text x="${x(s.dates[s.dates.length - 1]) - 4}" y="${y(lv) - 6}" text-anchor="end" class="ax" fill="${col}">${esc(s.t)} ${pct(lv - 100, 0)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" class="qchart" role="img" aria-label="Price performance">${out}</svg>`;
  }

  /* =====================================================================
     SCREENER: TradingView-style filters on the local database
     ===================================================================== */
  const PERF_KEYS = [["perf_1w", "1W"], ["perf_1m", "1M"], ["perf_3m", "3M"], ["perf_6m", "6M"], ["perf_ytd", "YTD"], ["perf_1y", "1Y"]];
  const RATING_OPTS = [["4.5", "Strong buy"], ["3.5", "Buy or better"], ["2.5", "Hold or better"]];
  const FILTERS = [
    { id: "country", label: "Country", type: "fixed", text: "United States" },
    { id: "watchlist", label: "Watchlist", type: "watch" },
    { id: "index", label: "Index", type: "na", need: "an index-membership data source (S&P 500 / Nasdaq-100 lists)" },
    { id: "price", label: "Price", type: "range", field: "price", unit: "$" },
    { id: "chg", label: "Chg %", type: "range", field: "chg_pct", unit: "%" },
    { id: "mcap", label: "Market cap", type: "range", field: "market_cap", unit: "$B", scale: 1e9 },
    { id: "pe", label: "P/E", type: "range", field: "pe" },
    { id: "fpe", label: "Forward P/E", type: "range", field: "forward_pe", enrich: "forward_pe", cap: "forward_pe" },
    { id: "epsg", label: "EPS dil growth TTM YoY", type: "range", field: "eps_ttm_yoy", unit: "%" },
    { id: "div", label: "Div yield %", type: "range", field: "div_yield", unit: "%" },
    { id: "sector", label: "Sector", type: "multi", field: "sector" },
    { id: "rating", label: "Analyst rating", type: "rating", field: "analyst_score", enrich: "analyst_score", cap: "analyst_score" },
    { id: "perf", label: "Perf %", type: "perf", unit: "%" },
    { id: "revg", label: "Revenue growth", type: "range", field: "rev_yoy", unit: "%" },
    { id: "peg", label: "PEG", type: "range", field: "peg" },
    { id: "roe", label: "ROE", type: "range", field: "roe", unit: "%" },
    { id: "beta", label: "Beta", type: "range", field: "beta" },
    { id: "recent", label: "Recent earnings date", type: "days", field: "last_earnings_date", dir: -1 },
    { id: "upcoming", label: "Upcoming earnings date", type: "days", field: "next_earnings_date", dir: 1, enrich: "next_earnings_date", cap: "earnings_calendar" },
    { id: "evfcf", label: "EV/FCF", type: "range", field: "ev_fcf" },
    { id: "fcf", label: "FCF FY", type: "range", field: "fcf_fy", unit: "$B", scale: 1e9 },
    { id: "ema150", label: "EMA 150 vs price", type: "ma", fixed: "ema_150" },
    { id: "ema200", label: "EMA 200 vs price", type: "ma", fixed: "ema_200" },
    { id: "sma", label: "SMA vs price", type: "ma", choices: [20, 50, 100, 150, 200], prefix: "sma_" },
    { id: "ema", label: "EMA vs price", type: "ma", choices: [9, 10, 20, 21, 50, 100, 150, 200], prefix: "ema_" },
  ];
  const PRESETS = [
    { name: "Investing setup", filters: { mcap: { min: 5 }, ema150: { pos: "above" }, ema200: { pos: "above" }, revg: { min: 0 }, epsg: { min: 0 }, fcf: { min: 0 } }, builtin: true },
    { name: "Near 150/200 EMA", filters: { mcap: { min: 5 }, ema200: { pos: "within", pct: 3 }, revg: { min: 0 } }, builtin: true },
    { name: "Momentum leaders", filters: { mcap: { min: 10 }, perf: { key: "perf_3m", min: 20 }, ema: { pos: "above", len: 50 } }, builtin: true },
  ];

  function fAvailable(F) {
    if (F.type === "na") return [false, F.need];
    if (F.cap && !caps()[F.cap]) return [false, F.cap === "earnings_calendar" ? capSrc("earnings_calendar") : capSrc(F.cap)];
    return [true, ""];
  }
  function maField(F, v) { return F.fixed || (F.prefix + ((v && v.len) || F.choices[F.choices.length - 1])); }

  function summary(F, v) {
    if (!v) return "";
    const u = F.unit || "", sc = (x) => (u === "$" ? "$" + x : u === "$B" ? "$" + x + "B" : x + (u === "%" ? "%" : ""));
    switch (F.type) {
      case "range": case "perf": {
        const pre = F.type === "perf" ? (PERF_KEYS.find((p) => p[0] === v.key) || [0, "1M"])[1] + " " : "";
        if (v.min != null && v.max != null) return pre + sc(v.min) + " to " + sc(v.max);
        if (v.min != null) return pre + "above " + sc(v.min);
        if (v.max != null) return pre + "below " + sc(v.max);
        return "";
      }
      case "multi": return v.in && v.in.length ? (v.in.length > 2 ? v.in.length + " sectors" : v.in.join(", ")) : "";
      case "watch": return v.mode === "in" ? "In watchlist" : v.mode === "out" ? "Not in watchlist" : "";
      case "rating": return (RATING_OPTS.find((r) => r[0] === v.min) || [0, ""])[1];
      case "days": return F.dir < 0 ? `Past ${v.days} days` : `Next ${v.days} days`;
      case "ma": {
        const nm = F.fixed ? "" : (F.prefix === "sma_" ? "SMA " : "EMA ") + (v.len || F.choices[F.choices.length - 1]) + ": ";
        return nm + (v.pos === "above" ? "Price above" : v.pos === "below" ? "Price below" : `Within ${v.pct}%`);
      }
    }
    return "";
  }

  function passes(row, F, v, enriched) {
    const get = (f) => (F.enrich ? (enriched[row.ticker] || {})[f] : row[f]);
    switch (F.type) {
      case "range": case "perf": {
        const raw = F.type === "perf" ? row[v.key || "perf_1m"] : get(F.field);
        if (raw == null || !isFinite(raw)) return false;
        const x = F.scale ? raw / F.scale : raw;
        return (v.min == null || x >= v.min) && (v.max == null || x <= v.max);
      }
      case "multi": return !v.in || !v.in.length || v.in.includes(row.sector || "Unknown");
      case "watch": return v.mode === "in" ? row.in_watchlist : v.mode === "out" ? !row.in_watchlist : true;
      case "rating": { const sc = get("analyst_score"); return sc != null && sc >= +v.min; }
      case "days": {
        const dt = get(F.field);
        if (!dt) return false;
        const diff = (parseDay(dt) - parseDay(isoDay(new Date()))) / 864e5;
        return F.dir < 0 ? diff <= 0 && diff >= -v.days : diff >= 0 && diff <= v.days;
      }
      case "ma": {
        const ma = row[maField(F, v)], p = row.price;
        if (ma == null || p == null) return false;
        if (v.pos === "above") return p > ma;
        if (v.pos === "below") return p < ma;
        return Math.abs(p / ma - 1) * 100 <= (v.pct || 2);
      }
    }
    return true;
  }

  function activeFilters() {
    const out = [];
    for (const F of FILTERS) {
      const v = P.screener.filters[F.id];
      if (v && summary(F, v) && fAvailable(F)[0]) out.push([F, v]);
    }
    return out;
  }

  function filteredRows() {
    const db = P.screener.db;
    if (!db) return { rows: [], pendingEnrich: [] };
    const act = activeFilters();
    const local = act.filter(([F]) => !F.enrich), remote = act.filter(([F]) => F.enrich);
    let rows = db.rows.filter((r) => local.every(([F, v]) => passes(r, F, v, P.screener.enriched)));
    const pendingEnrich = remote.map(([F]) => F);
    if (remote.length && rows.length <= 150) {
      const key = rows.map((r) => r.ticker).join(",") + "|" + remote.map(([F]) => F.enrich).join(",");
      if (key === P.screener.enrichKey) rows = rows.filter((r) => remote.every(([F, v]) => passes(r, F, v, P.screener.enriched)));
    }
    return { rows, pendingEnrich, local: rows.length };
  }

  async function renderScreener() {
    const root = $("#screenerBody");
    const c = caps();
    if (!P.screener.db) {
      const r = await call("get_screener_db");
      P.screener.db = r && r.db ? r.db : null;
    }
    const st = await call("screener_status");
    const canBuild = c.fundamentals_all && c.quotes;
    const db = P.screener.db;
    const screens = PRESETS.concat(S.state.screens || []);
    const minCap = (S.state.settings || {}).screener_min_cap_b || 2;
    root.innerHTML = `
      <div class="pg-head"><h1>Screener</h1>
        <div class="db-status" id="dbStatus"></div>
        ${(() => { const u = +minCap >= 1000 ? 1000 : +minCap < 1 ? 0.001 : 1; return `<label class="cap-box" title="Smallest company to include">
          <span class="muted small">Over $</span>
          <input id="dbCapNum" type="number" min="0" step="any" value="${+(minCap / u).toFixed(3)}" aria-label="Minimum market cap">
          <select id="dbCapUnit" aria-label="Unit">${[[0.001, "Million"], [1, "Billion"], [1000, "Trillion"]].map(([v, l]) => `<option value="${v}" ${v === u ? "selected" : ""}>${l}</option>`).join("")}</select></label>`; })()}
        <button class="btn ghost" id="dbBuild" ${canBuild ? "" : "disabled"}>${ic("refresh")} Update data</button>
      </div>
      ${canBuild ? "" : needBox("The screener", !c.fundamentals_all ? "SEC EDGAR" : "Public.com", "It builds a local table of every US stock over your size floor.")}
      <div class="screens" id="screens">${screens.map((sc, i) => `<button class="tab ${P.screener.activeScreen === sc.name ? "on" : ""}" data-sc="${i}">${esc(sc.name)}${sc.builtin ? "" : ` <span class="x" data-del="${i}" title="Delete screen">×</span>`}</button>`).join("")}
        <form id="saveScreen" class="save-screen"><input name="n" placeholder="Name this screen" maxlength="40" aria-label="Screen name"><button class="btn ghost" type="submit">${ic("plus")} Save</button></form></div>
      <div class="fbar" id="fbar"></div>
      <div id="fpop" class="fpop" hidden></div>
      <div id="scrResults"></div>`;
    $("#dbBuild").onclick = async () => {
      const capB = (parseFloat($("#dbCapNum").value) || 0) * +$("#dbCapUnit").value;
      if (!(capB > 0)) return toast("Enter a market cap above 0", true);
      if (capB < 0.05) return toast("Use at least $50 Million (smaller companies have unreliable SEC data)", true);
      S.state.settings.screener_min_cap_b = capB;
      const r = await call("build_screener", capB);
      if (r.ok) { toast("Updating screener data…"); pollScreener(); } else toast(r.error, true);
    };
    $("#saveScreen").onsubmit = async (e) => {
      e.preventDefault();
      const name = e.target.n.value.trim();
      if (!name) return toast("Give the screen a name", true);
      const list = (S.state.screens || []).filter((x) => x.name !== name);
      list.push({ name, filters: JSON.parse(JSON.stringify(P.screener.filters)) });
      const r = await call("save_screens", list);
      if (r.ok) { S.state.screens = list; P.screener.activeScreen = name; toast(`Saved "${name}"`); renderScreener(); }
    };
    $$("#screens [data-sc]").forEach((b) => (b.onclick = async (e) => {
      const sc = screens[+b.dataset.sc];
      if (e.target.dataset.del) {
        const list = (S.state.screens || []).filter((x) => x.name !== sc.name);
        await call("save_screens", list); S.state.screens = list;
        if (P.screener.activeScreen === sc.name) P.screener.activeScreen = null;
        return renderScreener();
      }
      P.screener.filters = JSON.parse(JSON.stringify(sc.filters));
      P.screener.activeScreen = sc.name;
      P.screener.enrichKey = "";
      renderScreener();
    }));
    drawDbStatus(st);
    drawFilterBar();
    drawResults();
    if (st && st.running) pollScreener();
  }

  function capLabel(b) {
    b = +b;
    return b >= 1000 ? `$${+(b / 1000).toFixed(3)} Trillion` : b >= 1 ? `$${+b.toFixed(3)} Billion` : `$${+(b * 1000).toFixed(1)} Million`;
  }
  function drawDbStatus(st) {
    const el = $("#dbStatus"), db = P.screener.db;
    if (!el) return;
    if (st && st.running) {
      const p = st.total ? Math.round((st.done / st.total) * 100) : 0;
      el.innerHTML = `<span class="spin">${ic("refresh", 14)}</span> ${esc(st.stage || "Working")} ${st.total ? `${st.done}/${st.total} (${p}%)` : ""} <button class="btn ghost small-btn" id="dbStop">Stop</button>`;
      $("#dbStop").onclick = () => call("stop_screener");
      const b = $("#dbBuild"); if (b) b.disabled = true;
    } else if (db) {
      const when = new Date(db.built);
      el.innerHTML = `${fmt(db.count, 0)} stocks over ${capLabel(db.min_cap_b)} · updated ${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${db.complete === false ? " · partial" : ""}${st && st.error ? ` · <span class="neg">${esc(st.error)}</span>` : ""}`;
    } else el.innerHTML = st && st.error ? `<span class="neg">${esc(st.error)}</span>` : "No screener data yet";
  }

  function pollScreener() {
    clearInterval(P.screener.poll);
    P.screener.poll = setInterval(async () => {
      const st = await call("screener_status");
      if (S.page === "screener") drawDbStatus(st);
      if (!st || !st.running) {
        clearInterval(P.screener.poll);
        const r = await call("get_screener_db");
        P.screener.db = r && r.db ? r.db : null;
        if (S.page === "screener") renderScreener();
        if (st && st.error) toast(st.error, true); else toast("Screener data updated");
      }
    }, 1500);
  }

  function drawFilterBar() {
    const bar = $("#fbar");
    if (!bar) return;
    bar.innerHTML = FILTERS.map((F) => {
      const [ok, need] = fAvailable(F);
      const v = P.screener.filters[F.id], sm = F.type === "fixed" ? F.text : summary(F, v);
      const on = F.type !== "fixed" && sm;
      return `<button class="fchip ${on ? "on" : ""} ${ok ? "" : "na"}" data-f="${F.id}" ${ok ? "" : `title="Needs ${esc(need)}"`}>
        <span>${esc(F.label)}${sm && F.type !== "fixed" ? ": " : F.type === "fixed" ? " " : ""}<b>${esc(sm)}</b></span>${on ? `<span class="x" data-clear="${F.id}" aria-label="Clear">×</span>` : ok ? `<span class="caret">▾</span>` : `<span class="caret">${ic("plug", 12)}</span>`}</button>`;
    }).join("") + `<button class="fchip reset" id="fReset">Reset all</button>`;
    $$(".fchip[data-f]", bar).forEach((b) => (b.onclick = (e) => {
      const F = FILTERS.find((x) => x.id === b.dataset.f);
      if (e.target.dataset.clear) { delete P.screener.filters[F.id]; P.screener.activeScreen = null; closePop(); drawFilterBar(); drawResults(); return; }
      const [ok, need] = fAvailable(F);
      if (!ok) return toast(`${F.label} needs ${need}`, true);
      if (F.type === "fixed") return toast("US stocks only (SEC filers)");
      openPop(F, b);
    }));
    $("#fReset").onclick = () => { P.screener.filters = {}; P.screener.activeScreen = null; closePop(); drawFilterBar(); drawResults(); };
  }

  function closePop() { const p = $("#fpop"); if (p) p.hidden = true; P.screener.open = null; }
  function openPop(F, anchor) {
    const pop = $("#fpop"), host = $("#screenerBody");
    if (P.screener.open === F.id && !pop.hidden) return closePop();
    P.screener.open = F.id;
    const v = P.screener.filters[F.id] || {};
    const num = (name, val, ph) => `<input type="number" step="any" name="${name}" value="${val == null ? "" : val}" placeholder="${ph}">`;
    let body = "";
    if (F.type === "range" || F.type === "perf") {
      body = (F.type === "perf" ? `<div class="seg">${PERF_KEYS.map(([k, l]) => `<button type="button" data-pk="${k}" class="${(v.key || "perf_1m") === k ? "on" : ""}">${l}</button>`).join("")}</div>` : "") +
        `<div class="pop-row">${num("min", v.min, "Min")}<span class="muted">to</span>${num("max", v.max, "Max")}<span class="muted">${esc(F.unit || "")}</span></div>` +
        `<div class="quick">${quickPicks(F).map(([l, a, b]) => `<button type="button" class="tab" data-min="${a ?? ""}" data-max="${b ?? ""}">${esc(l)}</button>`).join("")}</div>`;
    } else if (F.type === "multi") {
      const sectors = [...new Set((P.screener.db ? P.screener.db.rows : []).map((r) => r.sector || "Unknown"))].sort();
      body = `<div class="pop-list">${sectors.map((s) => `<label><input type="checkbox" name="in" value="${esc(s)}" ${(v.in || []).includes(s) ? "checked" : ""}> ${esc(s)}</label>`).join("") || `<span class="muted">Update the screener data first</span>`}</div>`;
    } else if (F.type === "watch") {
      body = `<div class="pop-list">${[["in", "In my watchlist"], ["out", "Not in my watchlist"]].map(([k, l]) => `<label><input type="radio" name="mode" value="${k}" ${v.mode === k ? "checked" : ""}> ${l}</label>`).join("")}</div>`;
    } else if (F.type === "rating") {
      body = `<div class="pop-list">${RATING_OPTS.map(([k, l]) => `<label><input type="radio" name="min" value="${k}" ${v.min === k ? "checked" : ""}> ${l}</label>`).join("")}</div>`;
    } else if (F.type === "days") {
      body = `<div class="quick">${[7, 14, 30, 60, 90].map((d) => `<button type="button" class="tab ${v.days === d ? "on" : ""}" data-days="${d}">${F.dir < 0 ? "Past" : "Next"} ${d} days</button>`).join("")}</div>`;
    } else if (F.type === "ma") {
      body = (F.choices ? `<div class="seg">${F.choices.map((n) => `<button type="button" data-len="${n}" class="${(v.len || F.choices[F.choices.length - 1]) === n ? "on" : ""}">${n}</button>`).join("")}</div>` : "") +
        `<div class="pop-list">${[["above", "Price above"], ["below", "Price below"], ["within", "Price within"]].map(([k, l]) => `<label><input type="radio" name="pos" value="${k}" ${v.pos === k ? "checked" : ""}> ${l}${k === "within" ? ` <input type="number" name="pct" step="0.5" min="0.5" value="${v.pct || 2}" class="mini"> %` : ""}</label>`).join("")}</div>`;
    }
    pop.innerHTML = `<form id="popForm"><div class="pop-h"><b>${esc(F.label)}</b>${F.enrich ? `<span class="muted small">checked live for up to 150 stocks</span>` : ""}</div>${body}
      <div class="pop-foot"><button type="button" class="btn ghost" id="popClear">Clear</button><button class="btn primary" type="submit">Apply</button></div></form>`;
    pop.hidden = false;
    const hr = host.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    pop.style.left = Math.min(ar.left - hr.left, hr.width - 330) + "px";
    pop.style.top = ar.bottom - hr.top + 6 + "px";
    const form = $("#popForm");
    const st = { key: v.key, len: v.len };
    $$("[data-pk]", form).forEach((b) => (b.onclick = () => { st.key = b.dataset.pk; $$("[data-pk]", form).forEach((x) => x.classList.toggle("on", x === b)); }));
    $$("[data-len]", form).forEach((b) => (b.onclick = () => { st.len = +b.dataset.len; $$("[data-len]", form).forEach((x) => x.classList.toggle("on", x === b)); }));
    $$("[data-min]", form).forEach((b) => (b.onclick = () => { form.min.value = b.dataset.min; form.max.value = b.dataset.max; }));
    $$("[data-days]", form).forEach((b) => (b.onclick = () => { apply({ days: +b.dataset.days }); }));
    $("#popClear").onclick = () => { delete P.screener.filters[F.id]; done(); };
    function apply(val) { P.screener.filters[F.id] = val; P.screener.activeScreen = null; done(); }
    function done() { closePop(); drawFilterBar(); drawResults(); }
    form.onsubmit = (e) => {
      e.preventDefault();
      const n = (x) => (x === "" || x == null ? null : +x);
      if (F.type === "range" || F.type === "perf") {
        const val = { min: n(form.min.value), max: n(form.max.value) };
        if (F.type === "perf") val.key = st.key || "perf_1m";
        if (val.min == null && val.max == null) { delete P.screener.filters[F.id]; return done(); }
        apply(val);
      } else if (F.type === "multi") apply({ in: $$("input[name=in]:checked", form).map((x) => x.value) });
      else if (F.type === "watch") { const c = $("input[name=mode]:checked", form); c ? apply({ mode: c.value }) : done(); }
      else if (F.type === "rating") { const c = $("input[name=min]:checked", form); c ? apply({ min: c.value }) : done(); }
      else if (F.type === "days") done();
      else if (F.type === "ma") {
        const c = $("input[name=pos]:checked", form);
        if (!c) return done();
        const val = { pos: c.value, pct: n(form.pct.value) || 2 };
        if (F.choices) val.len = st.len || F.choices[F.choices.length - 1];
        apply(val);
      }
    };
  }
  function quickPicks(F) {
    const m = {
      price: [["Under $20", null, 20], ["$20–100", 20, 100], ["Over $100", 100, null]],
      chg_pct: [["Up today", 0, null], ["Down today", null, 0], ["Up 3%+", 3, null], ["Down 3%+", null, -3]],
      market_cap: [["Over $5B", 5, null], ["$10B–200B", 10, 200], ["Over $200B", 200, null]],
      pe: [["Under 15", 0, 15], ["15–25", 15, 25], ["Under 40", 0, 40]],
      forward_pe: [["Under 15", 0, 15], ["Under 25", 0, 25]],
      eps_ttm_yoy: [["Positive", 0, null], ["Over 15%", 15, null], ["Over 30%", 30, null]],
      div_yield: [["Pays a dividend", 0.01, null], ["Over 2%", 2, null], ["Over 4%", 4, null]],
      rev_yoy: [["Positive", 0, null], ["Over 10%", 10, null], ["Over 25%", 25, null]],
      peg: [["Under 1", 0, 1], ["Under 2", 0, 2]],
      roe: [["Over 10%", 10, null], ["Over 20%", 20, null]],
      beta: [["Under 1", null, 1], ["1–2", 1, 2], ["Over 2", 2, null]],
      ev_fcf: [["Under 15", 0, 15], ["Under 30", 0, 30]],
      fcf_fy: [["Positive", 0, null], ["Over $1B", 1, null]],
    };
    if (F.type === "perf") return [["Up", 0, null], ["Over 10%", 10, null], ["Over 25%", 25, null], ["Down", null, 0]];
    return m[F.field] || [];
  }

  async function maybeEnrich(rows, pending) {
    if (!pending.length || P.screener.enriching) return;
    if (rows.length > 150) return;
    const fields = [...new Set(pending.map((F) => F.enrich))];
    const key = rows.map((r) => r.ticker).join(",") + "|" + pending.map((F) => F.enrich).join(",");
    if (key === P.screener.enrichKey) return;
    P.screener.enriching = true;
    drawResults(true);
    const need = rows.filter((r) => fields.some((f) => !(P.screener.enriched[r.ticker] || {}).hasOwnProperty(f))).map((r) => r.ticker);
    if (need.length) {
      const r = await call("screener_enrich", need, fields);
      if (r && r.ok) Object.entries(r.values).forEach(([t, vals]) => (P.screener.enriched[t] = Object.assign(P.screener.enriched[t] || {}, vals)));
      if (r && r.errors && r.errors.length) toast(r.errors[0], true);
    }
    P.screener.enriching = false;
    P.screener.enrichKey = key;
    if (S.page === "screener") drawResults();
  }

  function drawResults(busy = false) {
    const el = $("#scrResults"), SC = P.screener;
    if (!el) return;
    if (!SC.db) {
      el.innerHTML = `<div class="empty"><p><b>No screener data yet.</b></p><p class="muted">Press <b>Update data</b> to build a table of every US stock over your size floor (fundamentals from SEC, prices from Public). The first build takes a while; after that it refreshes automatically after each market close.</p></div>`;
      return;
    }
    const { rows, pendingEnrich } = filteredRows();
    const enrichOn = pendingEnrich.length > 0;
    const perf = (SC.filters.perf && SC.filters.perf.key) || SC.perfKey;
    const showF = enrichOn || Object.keys(SC.enriched).length;
    const cols = [
      ["ticker", "Ticker"], ["price", "Price", (r) => "$" + fmt(r.price)], ["chg_pct", "Chg %", (r) => pctCell(r.chg_pct)],
      ["market_cap", "Mkt cap", (r) => big(r.market_cap)], ["pe", "P/E", (r) => (r.pe ? fmt(r.pe, 1) : "–")],
      ...(showF && caps().forward_pe ? [["forward_pe", "Fwd P/E", (r) => { const x = (SC.enriched[r.ticker] || {}).forward_pe; return x ? fmt(x, 1) : "–"; }, true]] : []),
      ["eps_ttm_yoy", "EPS gr", (r) => pctCell(r.eps_ttm_yoy)], ["rev_yoy", "Rev gr", (r) => pctCell(r.rev_yoy)],
      ["div_yield", "Div %", (r) => (r.div_yield ? fmt(r.div_yield, 2) + "%" : "–")],
      [perf, "Perf " + (PERF_KEYS.find((p) => p[0] === perf) || [0, ""])[1], (r) => pctCell(r[perf])],
      ["d150", "vs EMA150", (r) => pctCell(r.ema_150 ? (r.price / r.ema_150 - 1) * 100 : null)],
      ["d200", "vs EMA200", (r) => pctCell(r.ema_200 ? (r.price / r.ema_200 - 1) * 100 : null)],
      ["sector", "Sector", (r) => `<span class="muted">${esc(r.sector || "–")}</span>`],
    ];
    const sk = SC.sort.key, dir = SC.sort.dir;
    const val = (r, k) => (k === "d150" ? (r.ema_150 ? r.price / r.ema_150 : null) : k === "d200" ? (r.ema_200 ? r.price / r.ema_200 : null)
      : k === "forward_pe" ? (SC.enriched[r.ticker] || {}).forward_pe : r[k]);
    const sorted = rows.slice().sort((a, b) => {
      const x = val(a, sk), y = val(b, sk);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
    let note = "";
    if (enrichOn) {
      if (rows.length > 150 && SC.enrichKey !== "") note = "";
      if (rows.length > 150) note = `<div class="note">${ic("alerts", 16)} ${esc(pendingEnrich.map((F) => F.label).join(", "))} is checked live (it uses API calls), so narrow the list to 150 stocks or fewer with the other filters first. ${fmt(rows.length, 0)} match so far.</div>`;
      else if (busy || SC.enriching) note = `<div class="note"><span class="spin">${ic("refresh", 14)}</span> Checking ${esc(pendingEnrich.map((F) => F.label).join(", "))} for ${rows.length} stocks…</div>`;
    }
    const shown = sorted.slice(0, SC.limit);
    el.innerHTML = `${note}<div class="res-bar"><b class="num">${fmt(rows.length, 0)}</b> <span class="muted">matches</span>
        <span class="muted small">of ${fmt(SC.db.count, 0)}</span>
        <button class="btn ghost" id="addAllWl" ${rows.length && rows.length <= 100 ? "" : "disabled"} title="${rows.length > 100 ? "Narrow to 100 or fewer first" : ""}">${ic("plus")} Add to watchlist</button></div>
      <div class="table-wrap"><table class="res scr"><thead><tr>${cols.map(([k, l]) => `<th data-k="${k}" class="${k === "ticker" || k === "sector" ? "" : "r"} ${sk === k ? "sorted" : ""}">${esc(l)}${sk === k ? (dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>
      <tbody>${shown.map((r) => `<tr data-t="${esc(r.ticker)}">${cols.map(([k, , f]) => k === "ticker"
        ? `<td><div class="tk">${esc(r.ticker)}${r.in_watchlist ? ` <span class="wl-dot" title="In watchlist"></span>` : ""}</div><div class="muted small nm">${esc(r.name || "")}</div></td>`
        : `<td class="${k === "sector" ? "" : "r num"}">${f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      ${rows.length > SC.limit ? `<button class="btn ghost more" id="more">Show more (${fmt(rows.length - SC.limit, 0)} left)</button>` : ""}`;
    $$("th[data-k]", el).forEach((th) => (th.onclick = () => {
      const k = th.dataset.k;
      SC.sort = { key: k, dir: SC.sort.key === k ? -SC.sort.dir : k === "ticker" || k === "sector" ? 1 : -1 };
      drawResults();
    }));
    $$("tbody tr", el).forEach((tr) => (tr.onclick = () => { P.research.ticker = tr.dataset.t; P.research.data = null; show("research"); }));
    const more = $("#more"); if (more) more.onclick = () => { SC.limit += 300; drawResults(); };
    $("#addAllWl").onclick = async () => {
      const merged = [...new Set((S.state.watchlist || []).concat(rows.map((r) => r.ticker)))];
      const r = await call("save_watchlist", merged);
      if (r.ok) { S.state.watchlist = r.watchlist; SC.db.rows.forEach((x) => (x.in_watchlist = r.watchlist.includes(x.ticker))); toast(`Watchlist now has ${r.watchlist.length} tickers`); drawResults(); }
    };
    if (enrichOn && !busy) maybeEnrich(rows, pendingEnrich);
  }

  /* =====================================================================
     CALENDAR: earnings for major US companies and your watchlist
     ===================================================================== */
  function calRange() {
    const C = P.calendar;
    if (!C.anchor) C.anchor = new Date();
    const a = new Date(C.anchor);
    if (C.mode === "week") {
      const mon = addDays(a, -((a.getDay() + 6) % 7));
      return [mon, addDays(mon, 4)];
    }
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    const start = addDays(first, -((first.getDay() + 6) % 7));
    const last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    const end = addDays(last, (7 - last.getDay()) % 7);
    return [start, end];
  }

  async function renderCalendar() {
    const root = $("#calendarBody"), C = P.calendar;
    const [start, end] = calRange();
    const title = C.mode === "week"
      ? `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
      : C.anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    root.innerHTML = `
      <div class="pg-head"><h1>Earnings calendar</h1>
        <div class="seg" id="calMode"><button data-m="week" class="${C.mode === "week" ? "on" : ""}">Week</button><button data-m="month" class="${C.mode === "month" ? "on" : ""}">Month</button></div>
        <div class="cal-nav"><button class="icon-btn" id="calPrev" aria-label="Previous">‹</button><b id="calTitle">${esc(title)}</b><button class="icon-btn" id="calNext" aria-label="Next">›</button><button class="btn ghost" id="calToday">Today</button></div>
        <select id="calFilter" aria-label="Which companies">
          <option value="both" ${C.filter === "both" ? "selected" : ""}>Watchlist + major (over $10B)</option>
          <option value="watch" ${C.filter === "watch" ? "selected" : ""}>Watchlist only</option>
          <option value="all" ${C.filter === "all" ? "selected" : ""}>All reporting companies</option></select>
      </div>
      <div id="calInner"><div class="loading">${ic("refresh", 18)} Loading…</div></div>`;
    bindGo(root);
    $$("#calMode button").forEach((b) => (b.onclick = () => { C.mode = b.dataset.m; C.data = null; renderCalendar(); }));
    $("#calPrev").onclick = () => { C.anchor = C.mode === "week" ? addDays(C.anchor, -7) : new Date(C.anchor.getFullYear(), C.anchor.getMonth() - 1, 1); C.data = null; renderCalendar(); };
    $("#calNext").onclick = () => { C.anchor = C.mode === "week" ? addDays(C.anchor, 7) : new Date(C.anchor.getFullYear(), C.anchor.getMonth() + 1, 1); C.data = null; renderCalendar(); };
    $("#calToday").onclick = () => { C.anchor = new Date(); C.data = null; renderCalendar(); };
    $("#calFilter").onchange = (e) => { C.filter = e.target.value; drawCalendar(start, end); };
    const key = isoDay(start) + isoDay(end);
    if (!C.data || C.data.key !== key) {
      const r = await call("get_calendar", isoDay(start), isoDay(end));
      C.data = Object.assign({ key }, r || {});
    }
    if (S.page === "calendar") drawCalendar(start, end);
  }

  function drawCalendar(start, end) {
    const C = P.calendar, d = C.data, el = $("#calInner");
    if (!el) return;
    if (!d.available) {
      const past = Object.entries(d.past || {}).filter(([, v]) => v).sort((a, b) => b[1].localeCompare(a[1]));
      el.innerHTML = needBox("The earnings calendar", d.needs || capSrc("earnings_calendar"), "Both have free keys.") +
        (past.length ? `<div class="card"><h3>Last reported (from SEC filings)</h3><div class="past-list">${past.map(([t, v]) => `<div><b>${esc(t)}</b><span class="muted num">${esc(v)}</span></div>`).join("")}</div></div>` : "");
      bindGo(el);
      return;
    }
    if (d.ok === false) { el.innerHTML = `<div class="err">${esc(d.error)}</div>`; return; }
    const evs = (d.events || []).filter((e) => C.filter === "all" || e.watch || (C.filter === "both" && e.major));
    const byDay = {};
    evs.forEach((e) => (byDay[e.date] = byDay[e.date] || []).push(e));
    Object.values(byDay).forEach((l) => l.sort((a, b) => (b.watch - a.watch) || ((b.market_cap || 0) - (a.market_cap || 0))));
    const today = isoDay(new Date());
    const days = [];
    for (let x = new Date(start); x <= end; x = addDays(x, 1)) if (C.mode === "month" || (x.getDay() > 0 && x.getDay() < 6)) days.push(new Date(x));
    const pill = (e) => {
      const beat = e.eps_act != null && e.eps_est != null ? (e.eps_act >= e.eps_est ? "beat" : "miss") : "";
      const tm = { bmo: "Before open", amc: "After close", dmh: "During market" }[String(e.time || "").toLowerCase()] || "";
      return `<button class="ev ${e.watch ? "watch" : ""} ${beat}" data-t="${esc(e.symbol)}" title="${esc(e.symbol)}${tm ? " · " + tm : ""}${e.eps_est != null ? " · EPS est $" + fmt(e.eps_est) : ""}${e.eps_act != null ? " · actual $" + fmt(e.eps_act) : ""}${e.market_cap ? " · " + big(e.market_cap) : ""}">
        <b>${esc(e.symbol)}</b>${tm ? `<span class="tm">${tm === "Before open" ? ic("sun", 12) : tm === "After close" ? ic("moon", 12) : ""}</span>` : ""}
        ${C.mode === "week" ? `<span class="muted small">${e.eps_est != null ? "est $" + fmt(e.eps_est) : ""}${beat ? ` · <span class="${beat === "beat" ? "pos" : "neg"}">${beat}</span>` : ""}</span>` : ""}</button>`;
    };
    const cap = C.mode === "week" ? 40 : 6;
    el.innerHTML = `<div class="cal ${C.mode}">
      ${(C.mode === "month" ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : []).map((w) => `<div class="cal-wd muted small">${w}</div>`).join("")}
      ${days.map((x) => {
        const k = isoDay(x), list = byDay[k] || [];
        const out = C.mode === "month" && x.getMonth() !== C.anchor.getMonth();
        return `<div class="cal-day ${k === today ? "today" : ""} ${out ? "out" : ""}">
          <div class="cd-h">${C.mode === "week" ? x.toLocaleDateString(undefined, { weekday: "short" }) + " " : ""}<span class="num">${x.getDate()}</span>${list.length ? `<span class="muted small">${list.length}</span>` : ""}</div>
          <div class="cd-list">${list.slice(0, cap).map(pill).join("")}${list.length > cap ? `<button class="ev more" data-day="${k}">+${list.length - cap} more</button>` : ""}</div></div>`;
      }).join("")}</div>
      <div class="cal-foot muted small"><span class="key"><i class="wl-dot"></i>Watchlist</span> <span class="key">${ic("sun", 12)} Before open</span> <span class="key">${ic("moon", 12)} After close</span>
        · from ${esc(d.source || "")}${!d.has_caps && C.filter === "both" ? " · build the screener data to know which companies are over $10B" : ""}</div>`;
    $$(".ev[data-t]", el).forEach((b) => (b.onclick = () => { P.research.ticker = b.dataset.t; P.research.data = null; show("research"); }));
    $$(".ev[data-day]", el).forEach((b) => (b.onclick = () => { C.mode = "week"; C.anchor = parseDay(b.dataset.day); C.data = null; renderCalendar(); }));
  }

  /* =====================================================================
     ALERTS: Telegram message when a moving average or price is hit
     ===================================================================== */
  async function renderAlerts() {
    const root = $("#alertsBody"), A = P.alerts;
    const r = await call("list_alerts");
    A.data = r && r.ok ? r : { alerts: [], history: [] };
    const tg = (S.state.telegram || {}).is_set;
    const d0 = Object.assign({ ticker: P.chart.ticker || "", kind: "ma_touch", ma_type: "EMA", length: 200, direction: "above", near_pct: 1, repeat: "once" }, A.draft || {});
    A.draft = null;
    const d = A.data;
    root.innerHTML = `
      <div class="pg-head"><h1>Alerts</h1>
        <span class="market-pill ${d.market_open ? "open" : ""}">${d.market_open ? "Market open · checking every minute" : "Market closed · alerts check during market hours"}</span>
        <button class="btn ghost" id="alCheck">${ic("refresh")} Check now</button></div>
      ${tg ? "" : `<div class="needs">${ic("send", 18)}<div><b>Telegram isn't set up.</b> <span class="muted">Alerts still show here, but they can't message you until you add your bot in Settings.</span></div><button class="btn ghost" data-go="settings">Settings</button></div>`}
      ${d.quotes === false ? needBox("Alerts", capSrc("bars")) : ""}
      ${d.last_error ? `<div class="err">Last check failed: ${esc(d.last_error)}</div>` : ""}
      <div class="al-grid">
        <div>
          <form class="card al-form" id="alForm" autocomplete="off">
            <h3>New alert</h3>
            <div class="al-fields">
              <label>Ticker<input name="ticker" value="${esc(d0.ticker)}" maxlength="10" required></label>
              <label>When<select name="kind">
                ${[["ma_touch", "Touches a moving average"], ["ma_near", "Gets within % of a moving average"], ["price_above", "Price goes above"], ["price_below", "Price goes below"], ["price_cross", "Price crosses"]].map(([k, l]) => `<option value="${k}" ${d0.kind === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
              <label class="ma-only">Type<select name="ma_type"><option ${d0.ma_type === "EMA" ? "selected" : ""}>EMA</option><option ${d0.ma_type === "SMA" ? "selected" : ""}>SMA</option></select></label>
              <label class="ma-only">Length<span class="len-pair"><input type="number" name="length" min="2" max="400" value="${d0.length}"><input type="range" name="lenSlide" min="2" max="400" value="${d0.length}" aria-label="Length slider"></span></label>
              <label class="touch-only">Direction<select name="direction">${[["above", "Pulls back from above"], ["below", "Rallies up from below"], ["either", "Either way"]].map(([k, l]) => `<option value="${k}" ${d0.direction === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
              <label class="near-only">Within %<input type="number" name="near_pct" step="0.1" min="0.1" value="${d0.near_pct}"></label>
              <label class="price-only">Price $<input type="number" name="price" step="0.01" value="${d0.price || ""}"></label>
              <label>And price<span class="len-pair"><select name="and_cond"><option value="">Any</option><option value="below">is below</option><option value="above">is above</option></select><input type="number" name="and_price" step="0.01" placeholder="$"></span></label>
              <label>Repeat<select name="repeat"><option value="once">Once, then switch off</option><option value="daily">At most once a day</option></select></label>
              <label>Expires<input type="date" name="expires"></label>
            </div>
            <label class="note-l">Note in the Telegram message<input name="note" maxlength="140" placeholder="e.g. Add 1/3 position here"></label>
            <div class="al-foot"><span class="muted small" id="alDesc"></span><button class="btn primary" type="submit">${ic("plus")} Create alert</button></div>
          </form>
          <div class="card"><h3>Active alerts <span class="muted small">${d.alerts.length}</span></h3>
            ${d.alerts.length ? `<div class="al-list">${d.alerts.map((a) => `
              <div class="al-row ${a.enabled ? "" : "off"}" data-id="${esc(a.id)}">
                <label class="switch"><input type="checkbox" data-act="toggle" ${a.enabled ? "checked" : ""} aria-label="Alert on"><span></span></label>
                <b class="tk">${esc(a.ticker)}</b>
                <div class="al-desc">${esc(a.description)}${a.note ? `<div class="muted small">“${esc(a.note)}”</div>` : ""}</div>
                <span class="muted small">${a.last_fired ? "Fired " + new Date(a.last_fired).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : a.repeat === "daily" ? "Daily" : "Once"}${a.expires ? " · until " + esc(a.expires) : ""}</span>
                <button class="icon-btn" data-act="chart" title="Open chart">${ic("charts", 16)}</button>
                <button class="icon-btn" data-act="del" title="Delete">${ic("x", 16)}</button>
              </div>`).join("")}</div>` : `<p class="muted">No alerts yet. Create one above, or use “Add alert” on the Charts page.</p>`}
          </div>
        </div>
        <div>
          <div class="card"><h3>Recently fired</h3>
            ${d.history.length ? d.history.slice(0, 20).map((h) => `<div class="tg-msg"><b>${esc(h.ticker)}</b> · ${esc(h.rule)}<div>Price $${fmt(h.price)}</div>${h.note ? `<div>${esc(h.note)}</div>` : ""}<div class="muted small">${new Date(h.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div></div>`).join("")
              : `<p class="muted">Nothing yet. When an alert fires you get a Telegram message and it shows here.</p>`}
            <p class="muted small">${d.last_check ? "Last checked " + new Date(d.last_check).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ". " : ""}Checked every minute during market hours while the app is open. The moving average uses today's live price, so a touch is caught as it happens.</p>
          </div>
        </div>
      </div>`;
    bindGo(root);
    const f = $("#alForm");
    const sync = () => {
      const k = f.kind.value;
      $$(".ma-only", f).forEach((x) => (x.hidden = !k.startsWith("ma")));
      $$(".touch-only", f).forEach((x) => (x.hidden = k !== "ma_touch"));
      $$(".near-only", f).forEach((x) => (x.hidden = k !== "ma_near"));
      $$(".price-only", f).forEach((x) => (x.hidden = !k.startsWith("price")));
      try { $("#alDesc").textContent = describe(formAlert()); } catch (e) { $("#alDesc").textContent = ""; }
    };
    const formAlert = () => {
      const a = { ticker: cleanT(f.ticker.value), kind: f.kind.value, repeat: f.repeat.value, note: f.note.value.trim() };
      if (a.kind.startsWith("ma")) { a.ma_type = f.ma_type.value; a.length = +f.length.value; }
      if (a.kind === "ma_touch") a.direction = f.direction.value;
      if (a.kind === "ma_near") a.near_pct = +f.near_pct.value || 1;
      if (a.kind.startsWith("price")) a.price = +f.price.value || null;
      if (f.and_cond.value && f.and_price.value) { a.and_cond = f.and_cond.value; a.and_price = +f.and_price.value; }
      if (f.expires.value) a.expires = f.expires.value;
      return a;
    };
    f.length.oninput = () => { f.lenSlide.value = f.length.value; sync(); };
    f.lenSlide.oninput = () => { f.length.value = f.lenSlide.value; sync(); };
    f.oninput = sync;
    sync();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const r = await call("save_alert", formAlert());
      if (r.ok) { toast(`Alert set: ${r.alert.ticker}`); renderAlerts(); } else toast(r.error, true);
    };
    $("#alCheck").onclick = async () => {
      const r = await call("check_alerts_now");
      if (r.ok) toast(r.fired ? `${r.fired} alert${r.fired > 1 ? "s" : ""} fired` : "Checked — nothing triggered"); else toast(r.error, true);
      renderAlerts();
    };
    $$(".al-row").forEach((row) => (row.onclick = async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const id = row.dataset.id, a = d.alerts.find((x) => x.id === id);
      if (act.dataset.act === "toggle") { await call("save_alert", { id, ticker: a.ticker, kind: a.kind, price: a.price, length: a.length, enabled: act.checked, state: {} }); row.classList.toggle("off", !act.checked); }
      if (act.dataset.act === "del") { await call("delete_alert", id); renderAlerts(); }
      if (act.dataset.act === "chart") { P.chart.ticker = a.ticker; P.chart.data = null; show("charts"); }
    }));
  }
  function describe(a) {
    const ma = `${a.ma_type || "EMA"} ${a.length}`;
    let s = a.kind === "ma_touch" ? `Touches ${ma} ${({ above: "from above", below: "from below" })[a.direction] || "either way"}`
      : a.kind === "ma_near" ? `Within ${a.near_pct}% of ${ma}`
      : a.kind === "price_above" ? `Price above $${fmt(a.price)}` : a.kind === "price_below" ? `Price below $${fmt(a.price)}` : `Price crosses $${fmt(a.price)}`;
    if (a.and_cond) s += ` and ${a.and_cond} $${fmt(a.and_price)}`;
    return (a.ticker || "…") + ": " + s;
  }

  /* =====================================================================
     BOTTOM WATCHLIST BAR
     ===================================================================== */
  const BAR_COLS = [["day", "Day"], ["week", "Week"], ["month", "Month"], ["m2", "2 Mo"], ["m3", "3 Mo"]];
  async function loadBar(force) {
    const el = $("#wbar");
    if (!force && el && el.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
    if (!force && P.bar.collapsed && P.bar.rows.length) return;
    const r = await call("get_bar");
    if (!force && el && el.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
    if (r && r.rows) { P.bar.rows = r.rows; P.bar.needs = r.needs || null; }
    drawBar();
  }
  function drawBar() {
    const el = $("#wbar"), B = P.bar;
    if (!el) return;
    let rows = B.rows.slice();
    if (B.sort) rows.sort((a, b) => ((b[B.sort] ?? -1e9) - (a[B.sort] ?? -1e9)));
    el.classList.toggle("collapsed", B.collapsed);
    el.innerHTML = `<div class="wb-head">
        <button class="wb-toggle" id="wbToggle" aria-expanded="${!B.collapsed}">${ic("watchlist", 15)} Watchlist <span class="caret">${B.collapsed ? "▴" : "▾"}</span></button>
        ${B.needs ? `<span class="muted small">Prices need ${esc(B.needs)}</span>` : ""}
        <span class="muted small wb-hint">Click a ticker to change it</span>
        <button class="icon-btn sm" id="wbRefresh" title="Refresh">${ic("refresh", 14)}</button></div>
      ${B.collapsed ? "" : `<div class="wb-table"><table><thead><tr><th>Ticker</th><th class="r">Price</th>${BAR_COLS.map(([k, l]) => `<th class="r sortable ${B.sort === k ? "sorted" : ""}" data-s="${k}">${l}${B.sort === k ? " ↓" : ""}</th>`).join("")}<th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-t="${esc(r.ticker)}"><td><input class="wb-t" value="${esc(r.ticker)}" maxlength="10" aria-label="Ticker ${esc(r.ticker)}"></td>
          <td class="r num">${r.price != null ? "$" + fmt(r.price) : "–"}</td>${BAR_COLS.map(([k]) => `<td class="r num">${pctCell(r[k])}</td>`).join("")}
          <td class="r"><button class="wb-x" data-x="${esc(r.ticker)}" aria-label="Remove ${esc(r.ticker)}">×</button></td></tr>`).join("")}
          <tr class="wb-add"><td><input class="wb-t" id="wbNew" placeholder="+ Add" maxlength="10" aria-label="Add ticker"></td><td colspan="7"></td></tr></tbody></table></div>`}`;
    $("#wbToggle").onclick = () => { B.collapsed = !B.collapsed; drawBar(); if (!B.collapsed) loadBar(true); };
    $("#wbRefresh").onclick = () => loadBar(true);
    if (B.collapsed) return;
    $$("th[data-s]", el).forEach((th) => (th.onclick = () => { B.sort = B.sort === th.dataset.s ? null : th.dataset.s; drawBar(); }));
    const commit = async (list) => {
      const r = await call("save_bar", list);
      if (r.ok) { B.rows = r.tickers.map((t) => B.rows.find((x) => x.ticker === t) || { ticker: t }); drawBar(); loadBar(true); }
    };
    $$(".wb-t", el).forEach((inp) => {
      inp.onkeydown = (e) => {
        if (e.key === "Escape") { inp.value = inp.defaultValue; inp.blur(); }
        if (e.key !== "Enter") return;
        e.preventDefault();
        const t = cleanT(inp.value), tickers = B.rows.map((x) => x.ticker);
        if (inp.id === "wbNew") { if (t && !tickers.includes(t)) commit(tickers.concat(t)); return; }
        const old = inp.closest("tr").dataset.t;
        if (!t) return commit(tickers.filter((x) => x !== old));
        if (t !== old) commit(tickers.map((x) => (x === old ? t : x)));
      };
      inp.onblur = () => { if (inp.id !== "wbNew") inp.value = inp.defaultValue; };
    });
    $$("[data-x]", el).forEach((b) => (b.onclick = () => commit(B.rows.map((x) => x.ticker).filter((x) => x !== b.dataset.x))));
    $$("tbody tr[data-t] td.num", el).forEach((td) => (td.onclick = () => { P.chart.ticker = td.parentElement.dataset.t; P.chart.data = null; show("charts"); }));
  }

  /* =====================================================================
     wiring
     ===================================================================== */
  window.PAGES = {
    charts: renderCharts,
    backtest: renderBacktest,
    research: renderResearch,
    compare: renderCompare,
    screener: renderScreener,
    calendar: renderCalendar,
    alerts: renderAlerts,
    search(t) {
      t = cleanT(t);
      if (!t) return false;
      if (S.page === "charts") { loadChart(t); return true; }
      if (S.page === "backtest") { loadBacktest(t); return true; }
      if (S.page === "research") { P.research.ticker = t; renderResearch(); return true; }
      if (S.page === "compare") {
        const i = P.compare.tickers.findIndex((x) => !x);
        if (i >= 0) P.compare.tickers[i] = t; else P.compare.tickers[3] = t;
        P.compare.data = null; renderCompare(); return true;
      }
      if (S.page === "alerts") { P.alerts.draft = { ticker: t }; renderAlerts(); return true; }
      P.research.ticker = t; P.research.data = null; show("research");
      return true;
    },
    boot() {
      loadBar();
      clearInterval(P.bar.timer);
      P.bar.timer = setInterval(() => { if (!document.hidden) loadBar(); }, 60000);
      window.addEventListener("resize", () => { if (S.page === "charts") drawCanvas(); });
      document.addEventListener("click", (e) => {
        const pop = $("#fpop");
        if (pop && !pop.hidden && !pop.contains(e.target) && !e.target.closest(".fchip")) closePop();
      });
      new MutationObserver(() => {
        if (S.page === "charts") drawCanvas();
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    },
  };
})();
