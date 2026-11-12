/**
 * Safe rendering of report dashboards.
 *
 * Dashboard HTML (written by a user or an AI model) runs inside
 * `<iframe sandbox="allow-scripts allow-modals" srcdoc="…">`: an opaque origin with no
 * access to the app's cookies, storage or DOM. The document built here adds a strict CSP
 * (no network at all), the theme tokens, a small SVG chart helper and `window.CDE`
 * with the data. The parent never passes session tokens or API URLs; it posts fresh
 * data with postMessage.
 */
import { FOLDER_STATE_LABELS_TR, ISSUE_PRIORITY_LABELS_TR, ISSUE_STATUS_LABELS_TR } from "../core/types.js";
import type { ReportData } from "./reports.js";
import { SHARED_DEFAULT_LANGUAGE, labelText, sharedIntlLocale, sharedText } from "../platform/i18n.js";

export const REPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'";

/** Sandbox flags of the dashboard iframe (modals are needed for window.print). */
export const REPORT_IFRAME_SANDBOX = "allow-scripts allow-modals";

/** Code → Turkish label maps the chart helper applies to category values. */
export const REPORT_VALUE_LABELS_TR: Record<string, Record<string, string>> = {
  status: { ...ISSUE_STATUS_LABELS_TR },
  priority: { ...ISSUE_PRIORITY_LABELS_TR },
  derivativeStatus: { none: "Yok", pending: "Bekliyor", processing: "İşleniyor", ready: "Hazır", failed: "Hatalı" },
  folderState: { ...FOLDER_STATE_LABELS_TR },
};

const LIGHT = `
  --bg: #f6f7f9; --surface: #ffffff; --surface-2: #f7f8fa; --border: #e5e7eb; --text: #111827; --muted: #5b6472;
  --primary: #3b6fb5; --primary-soft: #eef3fb; --danger: #b91c1c; --danger-soft: #fef2f2; --ok: #15803d; --ok-soft: #ecfdf3;
  --warn: #92400e; --warn-soft: #fff7e6; --radius: 10px;
  --shadow: 0 1px 2px rgba(2, 30, 69, 0.06), 0 2px 10px rgba(2, 30, 69, 0.05);
  --c1: #3b6fb5; --c2: #e07b39; --c3: #1f9e89; --c4: #8e5cc4; --c5: #d1495b; --c6: #b8901a; --c7: #2f9ac0; --c8: #7a8594;
  color-scheme: light;`;
const DARK = `
  --bg: #041530; --surface: #0a1f3d; --surface-2: #0f2748; --border: #22395c; --text: #f6f7f9; --muted: #b8c4d6;
  --primary: #5b9bf0; --primary-soft: #16305a; --danger: #f87171; --danger-soft: #3a1620; --ok: #4ade80; --ok-soft: #0f3326;
  --warn: #fbbf24; --warn-soft: #3a2e0f;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px -12px rgba(0, 0, 0, 0.55);
  --c1: #5b9bf0; --c2: #f29a5c; --c3: #3cc4a9; --c4: #ad86e0; --c5: #f0717f; --c6: #e3c04f; --c7: #5cc3e3; --c8: #9aa5b4;
  color-scheme: dark;`;

/** Theme tokens (same names as the app's theme.css) and base styles for dashboards. */
export const REPORT_THEME_CSS = `
:root {${LIGHT} }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK} } }
:root[data-theme="dark"] {${DARK} }
* { box-sizing: border-box; }
html { overflow-y: hidden; font-family: "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; font-size: 14px; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); line-height: 1.4; }
h1 { font-size: 20px; margin: 0 0 12px; } h2 { font-size: 16px; margin: 0 0 10px; } h3 { font-size: 14px; margin: 0 0 8px; }
.muted { color: var(--muted); } .small { font-size: 12px; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.grid-2 { display: grid; gap: 16px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-3 { display: grid; gap: 16px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.span-2 { grid-column: span 2; } .span-all { grid-column: 1 / -1; }
.kpis { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 16px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px; min-width: 0; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--surface-2); color: var(--muted); }
.badge.ok { background: var(--ok-soft); color: var(--ok); } .badge.warn { background: var(--warn-soft); color: var(--warn); }
.badge.danger { background: var(--danger-soft); color: var(--danger); } .badge.info { background: var(--primary-soft); color: var(--primary); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; background: var(--surface-2); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.cde-chart { min-width: 0; }
.cde-chart svg { display: block; overflow: visible; }
.cde-chart text { fill: var(--muted); font-size: 11px; }
.cde-chart-title { font-weight: 600; margin-bottom: 8px; }
.cde-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--muted); margin-top: 8px; }
.cde-legend span.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.cde-kpi { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 16px; border-left: 4px solid var(--primary); }
.cde-kpi.ok { border-left-color: var(--ok); } .cde-kpi.warn { border-left-color: var(--warn); } .cde-kpi.danger { border-left-color: var(--danger); }
.cde-kpi .v { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.cde-kpi .l { font-size: 12px; color: var(--muted); } .cde-kpi .s { font-size: 12px; color: var(--muted); margin-top: 2px; }
.cde-empty { color: var(--muted); padding: 24px 0; text-align: center; font-size: 13px; }
.cde-error { background: var(--danger-soft); color: var(--danger); padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
.cde-widget-error { background: var(--warn-soft); color: var(--warn); padding: 10px 12px; border-radius: 6px; font-size: 13px; line-height: 1.45; }
.cde-widget-error b { display: block; margin-bottom: 2px; }
@media (max-width: 700px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } .span-2 { grid-column: auto; } }
@media print {
  :root, :root[data-theme="dark"] {${LIGHT} }
  body { background: #fff; padding: 0; }
  .card, .cde-kpi { box-shadow: none; break-inside: avoid; }
}
`;

/**
 * The chart helper that runs inside the iframe. Plain ES5-style JS so that any
 * browser runs it; kept free of template-literal syntax so it can live in this string.
 */
export const REPORT_RUNTIME_JS = String.raw`(function () {
  "use strict";
  var C = window.CDE;
  var NS = "http://www.w3.org/2000/svg";
  var handlers = [];
  var hasOwn = Object.prototype.hasOwnProperty;
  var T = C.texts || {};
  var LOCALE = C.locale || "tr-TR";
  function say(text, name, value) { return String(text || "").replace("{{" + name + "}}", value); }

  function label(field, v) {
    if (v === null || v === undefined || v === "") return T.blank;
    if (v === true) return T.yes;
    if (v === false) return T.no;
    var m = (C.labels || {})[field];
    if (m && hasOwn.call(m, v)) return m[v];
    return String(v);
  }
  function el(target) {
    var e = typeof target === "string" ? document.querySelector(target) : target;
    if (!e) throw new Error(say(T.targetNotFound, "target", target));
    return e;
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  var fmt = {
    number: function (n, d) {
      if (n === null || n === undefined || n === "" || isNaN(Number(n))) return "–";
      return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: d === undefined ? 1 : d }).format(Number(n));
    },
    percent: function (r, d) {
      if (r === null || r === undefined || isNaN(Number(r))) return "–";
      return new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: d === undefined ? 0 : d }).format(Number(r));
    },
    bytes: function (b) {
      b = num(b);
      if (b < 1024) return b + " B";
      var u = ["KB", "MB", "GB", "TB"], i = -1;
      do { b = b / 1024; i++; } while (b >= 1024 && i < u.length - 1);
      return fmt.number(b, 1) + " " + u[i];
    },
    date: function (s) {
      if (!s) return "–";
      s = String(s);
      if (/^\d{4}-\d{2}$/.test(s)) return new Date(s + "-01T12:00:00").toLocaleDateString(LOCALE, { month: "short", year: "numeric" });
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T12:00:00").toLocaleDateString(LOCALE, { day: "2-digit", month: "short", year: "numeric" });
      var d = new Date(s);
      return isNaN(d.getTime()) ? s : d.toLocaleDateString(LOCALE, { day: "2-digit", month: "short", year: "numeric" });
    },
    datetime: function (s) {
      if (!s) return "–";
      var d = new Date(s);
      return isNaN(d.getTime()) ? String(s) : d.toLocaleString(LOCALE, { dateStyle: "short", timeStyle: "short" });
    }
  };
  function catText(field, v, f) {
    if (typeof f === "function") return String(f(v));
    if (typeof f === "string" && fmt[f]) return fmt[f](v);
    if (typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(v)) return fmt.date(v);
    return label(field, v);
  }
  function color(i, opts, key) {
    if (opts && opts.colors && key !== undefined && opts.colors[key]) return opts.colors[key];
    return "var(--c" + ((i % 8) + 1) + ")";
  }
  function s(tag, attrs, parent, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function tip(node, text) { s("title", {}, node, text); }
  /** Axis maximum: four equal, round tick steps (1, 2, 2.5, 5 × 10^n). */
  function niceMax(v) {
    if (!(v > 0)) return 4;
    var step = v / 4, p = Math.pow(10, Math.floor(Math.log(step) / Math.LN10)), n = step / p;
    step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
    if (v >= 4 && step < 1) step = 1;
    return step * 4;
  }
  function clip(t, max) { t = String(t); return t.length > max ? t.slice(0, Math.max(1, max - 1)) + "…" : t; }
  function mount(target, opts, render) {
    var root = el(target);
    root.classList.add("cde-chart");
    root.__cdeRender = function () {
      root.innerHTML = "";
      if (opts.title) h("div", "cde-chart-title", root, opts.title);
      root.__cdeWidth = root.clientWidth;
      render(root, Math.max(220, root.clientWidth || 600));
    };
    root.__cdeRender();
    // Layout settles after the first paint (grid columns, the frame's own scrollbar):
    // redraw whenever the container's width really changes.
    if (window.ResizeObserver && !root.__cdeObserved) {
      root.__cdeObserved = true;
      new ResizeObserver(function () {
        if (Math.abs(root.clientWidth - (root.__cdeWidth || 0)) < 2) return;
        requestAnimationFrame(function () { try { root.__cdeRender(); } catch (e) { showError(e); } });
      }).observe(root);
    }
    return root;
  }
  function empty(root, text) { h("div", "cde-empty", root, text || T.noData); }
  /** Rows of a query that did not run carry its error (see markErrors). */
  function broken(rows) { return rows && rows.__cdeError ? String(rows.__cdeError) : null; }
  /** The widget of a broken query shows why instead of an empty panel. */
  function failed(target, opts, msg) {
    var root = el(target);
    root.innerHTML = "";
    if (opts && opts.title) h("div", "cde-chart-title", root, opts.title);
    var box = h("div", "cde-widget-error", root);
    h("b", "", box, T.cannotShow);
    box.appendChild(document.createTextNode(msg));
    return root;
  }
  function markErrors() {
    var errs = C.errors || {};
    C.data = C.data || {};
    for (var k in errs) {
      if (!hasOwn.call(errs, k)) continue;
      if (!Array.isArray(C.data[k])) C.data[k] = [];
      try { Object.defineProperty(C.data[k], "__cdeError", { value: errs[k], enumerable: false, configurable: true }); } catch (_) {}
    }
  }
  function legend(root, items) {
    if (items.length < 2) return;
    var lg = h("div", "cde-legend", root);
    items.forEach(function (it) {
      var sp = h("span", "", lg);
      h("span", "sw", sp).style.background = it.color;
      sp.appendChild(document.createTextNode(it.text));
    });
  }

  /** rows → categories × series matrix. */
  function matrix(rows, opts) {
    rows = rows || [];
    var x = opts.x, ys = Array.isArray(opts.y) ? opts.y : [opts.y || "count"];
    var cats = [], catIdx = {}, names = [], nameIdx = {}, values = [];
    function ci(v) { var k = String(v); if (!hasOwn.call(catIdx, k)) { catIdx[k] = cats.length; cats.push(v); } return catIdx[k]; }
    function si(v) { var k = String(v); if (!hasOwn.call(nameIdx, k)) { nameIdx[k] = names.length; names.push(v); values.push([]); } return nameIdx[k]; }
    if (opts.series) {
      rows.forEach(function (r) { var c = ci(r[x]); var i = si(r[opts.series]); values[i][c] = num(values[i][c]) + num(r[ys[0]]); });
    } else {
      ys.forEach(function (y) { si(y); });
      rows.forEach(function (r) { var c = ci(r[x]); ys.forEach(function (y, i) { values[i][c] = num(values[i][c]) + num(r[y]); }); });
    }
    values = values.map(function (arr) { var out = []; for (var i = 0; i < cats.length; i++) out.push(num(arr[i])); return out; });
    var seriesNames = opts.seriesLabels || {};
    return {
      cats: cats,
      catLabels: cats.map(function (c) { return catText(x, c, opts.xFormat); }),
      keys: names,
      names: names.map(function (n) {
        if (hasOwn.call(seriesNames, n)) return seriesNames[n];
        if (opts.series) return label(opts.series, n);
        return n === "count" ? "Adet" : String(n);
      }),
      values: values
    };
  }

  function bar(target, rows, opts) {
    opts = opts || {};
    if (broken(rows)) return failed(target, opts, broken(rows));
    return mount(target, opts, function (root, W) {
      var m = matrix(rows, opts);
      if (!m.cats.length) return empty(root);
      var stacked = !!opts.stacked && m.values.length > 1;
      var vf = opts.format ? function (v) { return catText("", v, opts.format); } : function (v) { return fmt.number(v); };
      var max = 0;
      for (var c = 0; c < m.cats.length; c++) {
        var tot = 0;
        for (var i = 0; i < m.values.length; i++) { tot += m.values[i][c]; if (!stacked) max = Math.max(max, m.values[i][c]); }
        if (stacked) max = Math.max(max, tot);
      }
      max = niceMax(max);
      var horizontal = opts.horizontal !== undefined ? !!opts.horizontal : m.cats.length > 8 || m.catLabels.some(function (l) { return l.length > 14; });
      if (horizontal) {
        var band = opts.barHeight || (m.values.length > 1 && !stacked ? 12 * m.values.length + 10 : 26);
        var H = m.cats.length * band + 24;
        var L = Math.min(W * 0.4, 12 + 6.5 * Math.max.apply(null, m.catLabels.map(function (l) { return Math.min(l.length, 34); })));
        var R = 48, plot = W - L - R;
        var svg = s("svg", { width: W, height: H, role: "img" }, root);
        for (var t = 0; t <= 4; t++) {
          var gx = L + (plot * t) / 4;
          s("line", { x1: gx, x2: gx, y1: 0, y2: H - 20, style: "stroke:var(--border)" }, svg);
          s("text", { x: gx, y: H - 6, "text-anchor": "middle" }, svg, fmt.number((max * t) / 4, 2));
        }
        m.cats.forEach(function (cat, c) {
          var y0 = c * band + 3;
          s("text", { x: L - 6, y: y0 + band / 2, "text-anchor": "end", "dominant-baseline": "middle" }, svg, clip(m.catLabels[c], 34));
          var acc = 0;
          m.values.forEach(function (vals, i) {
            var v = vals[c], w = (plot * v) / max;
            var bh = stacked || m.values.length === 1 ? band - 8 : (band - 8) / m.values.length;
            var y = stacked || m.values.length === 1 ? y0 : y0 + i * bh;
            var r = s("rect", { x: L + (stacked ? (plot * acc) / max : 0), y: y, width: Math.max(0, w), height: Math.max(1, bh - 1), rx: 2, style: "fill:" + color(i, opts, m.keys[i]) }, svg);
            tip(r, m.catLabels[c] + (m.values.length > 1 ? " · " + m.names[i] : "") + ": " + vf(v));
            acc += v;
            if (!stacked && m.values.length === 1) s("text", { x: L + w + 4, y: y + bh / 2, "dominant-baseline": "middle" }, svg, vf(v));
          });
          if (stacked) s("text", { x: L + (plot * acc) / max + 4, y: y0 + (band - 8) / 2, "dominant-baseline": "middle" }, svg, vf(acc));
        });
      } else {
        var H2 = opts.height || 240, B = 34, Lft = 44, plotH = H2 - B - 8, plotW = W - Lft - 8;
        var svg2 = s("svg", { width: W, height: H2, role: "img" }, root);
        for (var t2 = 0; t2 <= 4; t2++) {
          var gy = 8 + plotH - (plotH * t2) / 4;
          s("line", { x1: Lft, x2: W - 8, y1: gy, y2: gy, style: "stroke:var(--border)" }, svg2);
          s("text", { x: Lft - 6, y: gy, "text-anchor": "end", "dominant-baseline": "middle" }, svg2, fmt.number((max * t2) / 4, 2));
        }
        var bw = plotW / m.cats.length;
        var maxChars = Math.max(3, Math.floor(bw / 6.5));
        m.cats.forEach(function (cat, c) {
          var x0 = Lft + c * bw;
          s("text", { x: x0 + bw / 2, y: H2 - B + 16, "text-anchor": "middle" }, svg2, clip(m.catLabels[c], maxChars));
          var acc = 0, n = m.values.length;
          m.values.forEach(function (vals, i) {
            var v = vals[c], hh = (plotH * v) / max;
            var inner = Math.min(bw * 0.7, 64), w = stacked || n === 1 ? inner : inner / n;
            var x = x0 + (bw - inner) / 2 + (stacked || n === 1 ? 0 : i * w);
            var y = 8 + plotH - hh - (stacked ? (plotH * acc) / max : 0);
            var r = s("rect", { x: x, y: y, width: Math.max(1, w - 1), height: Math.max(0, hh), rx: 2, style: "fill:" + color(i, opts, m.keys[i]) }, svg2);
            tip(r, m.catLabels[c] + (n > 1 ? " · " + m.names[i] : "") + ": " + vf(v));
            acc += v;
            if (n === 1 && m.cats.length <= 16) s("text", { x: x + w / 2, y: y - 4, "text-anchor": "middle" }, svg2, vf(v));
          });
        });
      }
      legend(root, m.names.map(function (n, i) { return { text: n, color: color(i, opts, m.keys[i]) }; }));
    });
  }

  function line(target, rows, opts) {
    opts = opts || {};
    if (broken(rows)) return failed(target, opts, broken(rows));
    return mount(target, opts, function (root, W) {
      var m = matrix(rows, opts);
      if (!m.cats.length) return empty(root);
      var H = opts.height || 240, B = 34, L = 44, plotH = H - B - 8, plotW = W - L - 12;
      var max = 0;
      m.values.forEach(function (vals) { vals.forEach(function (v) { max = Math.max(max, v); }); });
      max = niceMax(max);
      var svg = s("svg", { width: W, height: H, role: "img" }, root);
      for (var t = 0; t <= 4; t++) {
        var gy = 8 + plotH - (plotH * t) / 4;
        s("line", { x1: L, x2: W - 12, y1: gy, y2: gy, style: "stroke:var(--border)" }, svg);
        s("text", { x: L - 6, y: gy, "text-anchor": "end", "dominant-baseline": "middle" }, svg, fmt.number((max * t) / 4, 2));
      }
      var n = m.cats.length;
      function px(c) { return n === 1 ? L + plotW / 2 : L + (plotW * c) / (n - 1); }
      function py(v) { return 8 + plotH - (plotH * v) / max; }
      var step = Math.max(1, Math.ceil((n * 70) / plotW));
      m.cats.forEach(function (cat, c) {
        if (c % step === 0 || c === n - 1) s("text", { x: px(c), y: H - B + 16, "text-anchor": "middle" }, svg, clip(m.catLabels[c], 12));
      });
      m.values.forEach(function (vals, i) {
        var col = color(i, opts, m.keys[i]);
        var pts = vals.map(function (v, c) { return px(c) + "," + py(v); }).join(" ");
        if (opts.area && m.values.length === 1)
          s("polygon", { points: px(0) + "," + py(0) + " " + pts + " " + px(n - 1) + "," + py(0), style: "fill:" + col + ";opacity:0.15" }, svg);
        s("polyline", { points: pts, style: "fill:none;stroke-width:2;stroke:" + col }, svg);
        vals.forEach(function (v, c) {
          var d = s("circle", { cx: px(c), cy: py(v), r: n > 40 ? 2 : 3.5, style: "fill:" + col }, svg);
          tip(d, m.catLabels[c] + (m.values.length > 1 ? " · " + m.names[i] : "") + ": " + fmt.number(v));
        });
      });
      legend(root, m.names.map(function (nm, i) { return { text: nm, color: color(i, opts, m.keys[i]) }; }));
    });
  }

  function pie(target, rows, opts) {
    opts = opts || {};
    if (broken(rows)) return failed(target, opts, broken(rows));
    return mount(target, opts, function (root, W) {
      var lf = opts.label, vf = opts.value || "count";
      var items = [];
      (rows || []).forEach(function (r) { var v = num(r[vf]); if (v > 0) items.push({ key: r[lf], v: v }); });
      var total = items.reduce(function (a, b) { return a + b.v; }, 0);
      if (!total) return empty(root);
      var size = Math.min(opts.size || 200, W), R = size / 2 - 4, r0 = opts.donut === false ? 0 : R * 0.58;
      var svg = s("svg", { width: size, height: size, role: "img", style: "margin:0 auto" }, root);
      var cx = size / 2, cy = size / 2, a = -Math.PI / 2;
      items.forEach(function (it, i) {
        var col = color(i, opts, it.key), frac = it.v / total, text = catText(lf, it.key, opts.labelFormat);
        var node;
        if (frac >= 0.9999) {
          node = s("circle", { cx: cx, cy: cy, r: (R + r0) / 2, style: "fill:none;stroke:" + col + ";stroke-width:" + (R - r0 || R) }, svg);
          if (!r0) node.setAttribute("style", "fill:" + col);
        } else {
          var a2 = a + frac * 2 * Math.PI, large = frac > 0.5 ? 1 : 0;
          var p = "M" + (cx + R * Math.cos(a)) + " " + (cy + R * Math.sin(a)) +
            " A" + R + " " + R + " 0 " + large + " 1 " + (cx + R * Math.cos(a2)) + " " + (cy + R * Math.sin(a2));
          p += r0
            ? " L" + (cx + r0 * Math.cos(a2)) + " " + (cy + r0 * Math.sin(a2)) + " A" + r0 + " " + r0 + " 0 " + large + " 0 " + (cx + r0 * Math.cos(a)) + " " + (cy + r0 * Math.sin(a)) + " Z"
            : " L" + cx + " " + cy + " Z";
          node = s("path", { d: p, style: "fill:" + col + ";stroke:var(--surface);stroke-width:1" }, svg);
          a = a2;
        }
        tip(node, text + ": " + fmt.number(it.v) + " (" + fmt.percent(frac) + ")");
        it.text = text + " · " + fmt.number(it.v) + " (" + fmt.percent(frac) + ")";
        it.color = col;
      });
      if (r0) {
        s("text", { x: cx, y: cy - 4, "text-anchor": "middle", style: "font-size:20px;font-weight:700;fill:var(--text)" }, svg, fmt.number(total));
        s("text", { x: cx, y: cy + 14, "text-anchor": "middle" }, svg, opts.totalLabel || "Toplam");
      }
      var lg = h("div", "cde-legend", root);
      items.forEach(function (it) { var sp = h("span", "", lg); h("span", "sw", sp).style.background = it.color; sp.appendChild(document.createTextNode(it.text)); });
    });
  }

  function kpi(target, opts) {
    opts = opts || {};
    var root = el(target);
    root.innerHTML = "";
    var box = h("div", "cde-kpi" + (opts.tone ? " " + opts.tone : ""), root);
    h("div", "l", box, opts.label || "");
    var v = opts.value;
    h("div", "v", box, typeof opts.format === "string" && fmt[opts.format] ? fmt[opts.format](v) : typeof v === "number" ? fmt.number(v) : v === null || v === undefined ? "–" : String(v));
    if (opts.sub) h("div", "s", box, opts.sub);
    return root;
  }

  function table(target, rows, opts) {
    opts = opts || {};
    if (broken(rows)) return failed(target, opts, broken(rows));
    var root = el(target);
    root.innerHTML = "";
    if (opts.title) h("div", "cde-chart-title", root, opts.title);
    rows = rows || [];
    if (!rows.length) return empty(root, opts.empty || T.noRecords), root;
    var cols = opts.columns || Object.keys(rows[0]).map(function (k) { return { field: k }; });
    cols = cols.map(function (c) { return typeof c === "string" ? { field: c } : c; });
    var limit = opts.limit || 200;
    var wrap = h("div", "", root);
    wrap.style.overflowX = "auto";
    var t = h("table", "", wrap), tr = h("tr", "", h("thead", "", t));
    cols.forEach(function (c) {
      var isNum = c.format === "number" || c.format === "bytes" || typeof rows[0][c.field] === "number";
      h("th", isNum ? "num" : "", tr, c.label || c.field);
    });
    var tb = h("tbody", "", t);
    rows.slice(0, limit).forEach(function (r) {
      var row = h("tr", "", tb);
      cols.forEach(function (c) {
        var v = r[c.field], text;
        if (typeof c.format === "function") text = String(c.format(v, r));
        else if (c.format && fmt[c.format]) text = fmt[c.format](v);
        else if (typeof v === "number") text = fmt.number(v, 2);
        else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) text = fmt.datetime(v);
        else text = label(c.field, v);
        h("td", typeof v === "number" || c.format === "number" || c.format === "bytes" ? "num" : "", row, text);
      });
    });
    if (rows.length > limit) h("div", "muted small", root, say(rows.length - limit === 1 ? T.moreOne : T.moreOther, "count", rows.length - limit));
    return root;
  }

  function sum(rows, field) { return (rows || []).reduce(function (a, r) { return a + num(r[field || "count"]); }, 0); }
  function find(rows, field, value) { return (rows || []).filter(function (r) { return r[field] === value; })[0] || null; }

  function showError(e) {
    var msg = (e && e.message) || String(e);
    var box = document.getElementById("cde-error") || h("div", "cde-error", null);
    box.id = "cde-error";
    box.textContent = say(T.panelError, "message", msg);
    if (!box.parentNode && document.body) document.body.insertBefore(box, document.body.firstChild);
    try { parent.postMessage({ type: "cde:error", message: String(msg).slice(0, 500) }, "*"); } catch (_) {}
  }
  function run(fn) { try { fn(C.data, C); } catch (e) { showError(e); } }
  markErrors();

  C.label = label;
  C.fmt = fmt;
  C.bar = bar;
  C.line = line;
  C.pie = pie;
  C.donut = function (t, r, o) { o = o || {}; o.donut = true; return pie(t, r, o); };
  C.kpi = kpi;
  C.table = table;
  C.sum = sum;
  C.find = find;
  C.onData = function (fn) {
    handlers.push(fn);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { run(fn); });
    else run(fn);
  };

  window.addEventListener("error", function (ev) { showError(ev.error || ev.message); });
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "cde:data") {
      C.data = m.data || {};
      C.errors = m.errors || {};
      C.generatedAt = m.generatedAt || C.generatedAt;
      if (m.labels && typeof m.labels === "object") {
        var merged = {};
        for (var lk in C.labels || {}) if (hasOwn.call(C.labels, lk)) merged[lk] = C.labels[lk];
        for (var lk2 in m.labels) if (hasOwn.call(m.labels, lk2)) merged[lk2] = m.labels[lk2];
        C.labels = merged;
      }
      markErrors();
      if (handlers.length) handlers.forEach(run);
      else parent.postMessage({ type: "cde:reload" }, "*");
    } else if (m.type === "cde:print") {
      window.print();
    }
  });
  var rerender = function () {
    var nodes = document.querySelectorAll(".cde-chart");
    for (var i = 0; i < nodes.length; i++) if (nodes[i].__cdeRender) try { nodes[i].__cdeRender(); } catch (e) { showError(e); }
  };
  var timer = 0;
  window.addEventListener("resize", function () { clearTimeout(timer); timer = setTimeout(rerender, 120); });
  window.addEventListener("beforeprint", rerender);
  window.addEventListener("afterprint", rerender);
  var lastH = 0;
  function postHeight() {
    // Body height, not the document's: the document is never shorter than the frame itself.
    var hgt = document.body ? Math.ceil(document.body.getBoundingClientRect().height) : 0;
    if (hgt !== lastH) { lastH = hgt; parent.postMessage({ type: "cde:height", height: hgt }, "*"); }
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(postHeight);
    if (document.body) ro.observe(document.body);
    else document.addEventListener("DOMContentLoaded", function () { ro.observe(document.body); });
  }
  window.addEventListener("load", postHeight);
  document.addEventListener("DOMContentLoaded", postHeight);
})();`;

export interface ReportSrcdocOptions {
  /** Dashboard HTML (body fragment). */
  html: string;
  data: ReportData;
  errors?: Record<string, string>;
  project: { id: string; code: string; name: string };
  generatedAt: string;
  /** Default follows the viewer's OS setting. */
  theme?: "light" | "dark" | "auto";
  /** Extra code → label maps (merged over the built-in ones). */
  labels?: Record<string, Record<string, string>>;
  /** Language of the viewer: labels, number and date formats and the helper's own texts (default Turkish). */
  lang?: string;
  /**
   * CSP nonce of the embedding page. An about:srcdoc frame inherits the page's policy, which allows
   * inline scripts only with this nonce, so every <script> of the frame gets it. Inline event
   * attributes (onclick=…) stay blocked: dashboards use addEventListener.
   */
  nonce?: string;
}

/** Adds nonce="…" to every <script> tag without one (no-op without a well-formed nonce). */
export function addScriptNonce(html: string, nonce: string | undefined): string {
  if (!nonce || !/^[A-Za-z0-9+/=_-]+$/.test(nonce)) return html;
  return html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
}

/** JSON that is safe to place inside an inline <script>. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp("\u2028", "g"), "\\u2028")
    .replace(new RegExp("\u2029", "g"), "\\u2029");
}

/**
 * Removes document-level wrappers and tags that could weaken the frame (meta refresh,
 * an extra CSP, <base>) from dashboard HTML. Scripts stay: the sandbox and CSP contain them.
 */
export function cleanDashboardHtml(html: string): string {
  return html
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?(html|head|body)\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
}

/** The complete srcdoc document of a dashboard iframe. */
export function buildReportSrcdoc(o: ReportSrcdocOptions): string {
  const lang = o.lang ?? SHARED_DEFAULT_LANGUAGE;
  const labels: Record<string, Record<string, string>> = {};
  for (const [field, map] of Object.entries(REPORT_VALUE_LABELS_TR))
    labels[field] = Object.fromEntries(Object.keys(map).map((code) => [code, labelText(lang, "reportValue", `${field}.${code}`)]));
  for (const [k, v] of Object.entries(o.labels ?? {})) labels[k] = { ...(labels[k] ?? {}), ...v };
  const text = (key: string, params?: Record<string, string>) => sharedText(lang, `reports.frame.${key}`, params);
  const boot = {
    data: o.data,
    errors: o.errors ?? {},
    project: { id: o.project.id, code: o.project.code, name: o.project.name },
    generatedAt: o.generatedAt,
    labels,
    locale: sharedIntlLocale(lang),
    // Templates keep their {{placeholders}}; the helper fills them in the frame.
    texts: {
      blank: text("blank"),
      yes: labelText(lang, "yesNo", "yes"),
      no: labelText(lang, "yesNo", "no"),
      noData: text("noData"),
      noRecords: text("noRecords"),
      moreOne: text("more_one", { count: "{{count}}" }),
      moreOther: text("more_other", { count: "{{count}}" }),
      cannotShow: text("cannotShow"),
      panelError: text("panelError", { message: "{{message}}" }),
      targetNotFound: text("targetNotFound", { target: "{{target}}" }),
    },
  };
  const themeAttr = o.theme && o.theme !== "auto" ? ` data-theme="${o.theme}"` : "";
  const htmlLang = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : SHARED_DEFAULT_LANGUAGE;
  return [
    `<!doctype html><html lang="${htmlLang}"${themeAttr}><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<style>${REPORT_THEME_CSS}</style>`,
    addScriptNonce(`<script>window.CDE = ${scriptJson(boot)};</script>`, o.nonce),
    addScriptNonce(`<script>${REPORT_RUNTIME_JS}</script>`, o.nonce),
    `</head><body>`,
    addScriptNonce(cleanDashboardHtml(o.html), o.nonce),
    `</body></html>`,
  ].join("\n");
}

/**
 * Hints about dashboard code that will not work in the frame or tries to leave it.
 * Advisory only: the sandbox and CSP are the security boundary.
 */
export function reportHtmlWarnings(html: string, lang: string = SHARED_DEFAULT_LANGUAGE): string[] {
  const out: string[] = [];
  const warn = (key: string) => out.push(sharedText(lang, `reports.warnings.${key}`));
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|new\s+(XMLHttpRequest|WebSocket|EventSource)\b/.test(html))
    warn("network");
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html))
    warn("inlineHandlers");
  if (/(src|href)\s*=\s*["']?\s*(https?:)?\/\//i.test(html) || /@import|url\(\s*["']?https?:/i.test(html))
    warn("externalResources");
  if (
    /\blocation\s*(\.\s*(href|assign|replace)\b|=[^=])|\b(top|parent)\s*\.\s*location\b|\bwindow\s*\.\s*open\s*\(|RTCPeerConnection/.test(
      html,
    )
  )
    warn("navigation");
  return out;
}
