/* 第三世界（项目代号 ARC）· 可交互跨端原型
 * 零依赖、零构建。数据与口径来自 data.js；设计与动效见 docs/02。
 * 所有派生指标在此文件内真实计算，不是硬编码结果。
 */
(function () {
  "use strict";
  const A = window.ARC;

  /* ── 图标 ────────────────────────────────────────────── */
  const ICONS = {
    today: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    train: '<rect x="3" y="4.5" width="18" height="16.5" rx="3"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
    analyze: '<path d="M3 18l5-6 4 3 5-8 4 5"/><path d="M3 21h18"/>',
    lab: '<path d="M9 2.5h6M10 2.5v6.2L5 19a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 19l-5-10.3V2.5"/><path d="M7.5 15h9"/>',
    data: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    shield: '<path d="M12 2.5l8 3.5v6c0 5-3.4 8.4-8 9.5-4.6-1.1-8-4.5-8-9.5v-6z"/><path d="M9 12l2 2 4-4"/>',
    chart: '<path d="M4 20V9M10 20V4M16 20v-7M22 20H2"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5M16 5.5a3 3 0 0 1 0 5.5M18 15c2 .6 3 2.2 3 5"/>',
    database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l2.6 2.6L16 9.5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    heart: '<path d="M20.8 8.6c0 4.2-8.8 10-8.8 10s-8.8-5.8-8.8-10a4.8 4.8 0 0 1 8.8-2.6 4.8 4.8 0 0 1 8.8 2.6z"/>',
    bolt: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>'
  };
  function icon(n, s) { return '<svg viewBox="0 0 24 24" width="' + (s || 18) + '" height="' + (s || 18) + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[n] || ICONS.info) + '</svg>'; }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ── 状态 ────────────────────────────────────────────── */
  const state = {
    platform: "mac", theme: "light", role: "head_coach",
    workspace: "athlete", route: "today",
    params: { window: 28, tl: "srpe", acwr: "ewma", context: "night" },
    injectMissing: false, calibrated: false, demoSource: "import",
    sheet: null, palette: false, paletteIndex: 0, manualType: "jump",
    manualCount: 0,
    // true = 当前页面数据来自 Supabase 真实库（RLS 生效）；false = 演示常量
    dbLive: false
  };
  const SIZES = { iphone: [390, 844], ipad: [1024, 720], mac: [1440, 900] };
  const COLS = { iphone: 1, ipad: 2, mac: 3 };
  const V1RM = 0.30; // 仅当 state.calibrated 为真时参与计算（演示）

  /* ── 计算引擎（真实公式） ───────────────────────────── */
  function stats(arr) {
    const v = arr.filter(x => x !== null && x !== undefined && Number.isFinite(x));
    if (!v.length) return { valid: 0, sum: 0, mean: null, sd: null };
    const sum = v.reduce((a, b) => a + b, 0), mean = sum / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / v.length);
    return { valid: v.length, sum, mean, sd };
  }
  function getTL() {
    const a = A.TL_BASE.slice();
    if (state.injectMissing) { a[23] = null; a[25] = null; }
    return a;
  }
  function computeLoad(tl) {
    const rows = [];
    let ctl = null, atl = null, acu = null, chr = null, pCtl = null, pAtl = null;
    for (let i = 0; i < tl.length; i++) {
      const v = tl[i], ok = v !== null && v !== undefined && Number.isFinite(v);
      const tsb = (pCtl !== null && pAtl !== null) ? pCtl - pAtl : null;
      if (ok) {
        ctl = ctl === null ? v : ctl + (v - ctl) / 42;
        atl = atl === null ? v : atl + (v - atl) / 7;
        acu = acu === null ? v : acu + 0.25 * (v - acu);
        chr = chr === null ? v : chr + 0.069 * (v - chr);
      }
      const w7 = stats(tl.slice(Math.max(0, i - 6), i + 1));
      const w28 = stats(tl.slice(Math.max(0, i - 27), i + 1));
      const rolling = (i >= 27 && w7.valid === 7 && w28.valid >= 26 && w28.mean > 0) ? w7.mean / w28.mean : null;
      const ewma = (acu !== null && chr !== null && chr > 0 && w7.valid >= 5) ? acu / chr : null;
      const tm = (w7.valid === 7 && w7.sd > 0) ? w7.mean / w7.sd : null;
      const ts = (tm !== null && w7.valid === 7) ? w7.sum * tm : null;
      rows.push({ i, date: A.DATES[i], tl: v, ctl, atl, tsb, rolling, ewma, tm, ts, v7: w7.valid, v28: w28.valid, mean7: w7.mean, sum7: w7.sum });
      pCtl = ctl; pAtl = atl;
    }
    return rows;
  }
  function load() {
    // 真实库：逐日负荷序列直接来自服务端（daily_metrics 里的 ctl/atl/tsb/acwr/tm/ts），
    // 前端不再递推一遍——两套实现迟早会算出两个数。
    const srv = A.SRV;
    if (srv && srv.some(x => x && (x.ctl !== null || x.acwr !== null))) {
      return srv.map((x, i) => ({ i, date: A.DATES[i], tl: x.tl, ctl: x.ctl, atl: x.atl,
        tsb: x.tsb, rolling: x.rolling, ewma: x.acwr, tm: x.tm, ts: x.ts }));
    }
    return computeLoad(getTL());
  }
  function last() { const r = load(); return r[r.length - 1]; }
  function regression(pts) {
    const n = pts.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    pts.forEach(p => { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; });
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx), b = (sy - a * sx) / n;
    const my = sy / n; let ssr = 0, sst = 0;
    pts.forEach(p => { const yp = a * p.x + b; ssr += (p.y - yp) ** 2; sst += (p.y - my) ** 2; });
    return { a, b, r2: sst ? 1 - ssr / sst : null };
  }
  const lvpPts = A.VBT_SETS.map(s => ({ x: s.load, y: s.mpv }));
  const LVP = regression(lvpPts);
  function oneRM() { return state.calibrated ? (V1RM - LVP.b) / LVP.a : null; }
  function jumpH(tf) { return A.G * tf * tf / 8; }
  function jumpRSI(tf, tc) { return tc > 0 ? jumpH(tf) / tc : null; }
  function fmt(v, d) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    return Number(v).toFixed(d === undefined ? 1 : d);
  }
  function cm(v) { return fmt(v * 100, 1); }

  /* ── SVG 图表 ───────────────────────────────────────── */
  let chartRegistry = {}, chartSeq = 0;
  function chartHost(cfg) { const id = "c" + (++chartSeq); chartRegistry[id] = cfg; return '<div class="chart-host" data-chart="' + id + '"></div>'; }
  function polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
  function arc(cx, cy, r, d0, d1) {
    const p0 = polar(cx, cy, r, d0), p1 = polar(cx, cy, r, d1);
    return "M " + p0[0].toFixed(1) + " " + p0[1].toFixed(1) + " A " + r + " " + r + " 0 " + ((d1 - d0) > 180 ? 1 : 0) + " 1 " + p1[0].toFixed(1) + " " + p1[1].toFixed(1);
  }
  function grid(W, H, pad, min, max, labels) {
    let s = "";
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (H - pad.t - pad.b) * i / 4;
      s += '<line x1="' + pad.l + '" y1="' + y.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + y.toFixed(1) + '" stroke="var(--chart-grid)" stroke-width="1"/>';
      const val = max - (max - min) * i / 4;
      s += '<text x="' + (pad.l - 7) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--text-3)">' + (Math.round(val * 10) / 10) + '</text>';
    }
    const step = Math.max(1, Math.ceil(labels.length / 6));
    for (let i = 0; i < labels.length; i += step) {
      const x = pad.l + (W - pad.l - pad.r) * (labels.length === 1 ? 0 : i / (labels.length - 1));
      s += '<text x="' + x.toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle" font-size="10" fill="var(--text-3)">' + esc(labels[i]) + '</text>';
    }
    return s;
  }
  function pathFor(vals, X, Y) {
    let d = "", open = false;
    vals.forEach((v, i) => {
      if (v === null || v === undefined || !Number.isFinite(v)) { open = false; return; }
      d += (open ? " L " : " M ") + X(i).toFixed(1) + " " + Y(v).toFixed(1); open = true;
    });
    return d;
  }
  function svgLine(c, W, H) {
    const pad = { l: 36, r: 12, t: 12, b: 24 }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const all = c.series.flatMap(s => s.values.filter(v => v !== null && Number.isFinite(v)));
    let min = c.min !== undefined ? c.min : Math.min.apply(null, all), max = c.max !== undefined ? c.max : Math.max.apply(null, all);
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
    if (min === max) { min -= 1; max += 1; }
    // 显式给了 min/max 就不再外扩：负荷类指标出现负刻度会误导（-62 个 AU 没有意义）
    const rg = max - min;
    min = c.min !== undefined ? c.min : min - rg * .08;
    max = c.max !== undefined ? c.max : max + rg * .08;
    const n = c.labels.length;
    const X = i => pad.l + (n === 1 ? 0 : i / (n - 1)) * iw;
    const Y = v => pad.t + ih - (v - min) / (max - min) * ih;
    let s = grid(W, H, pad, min, max, c.labels);
    (c.bands || []).forEach(b => {
      const y0 = Y(b.to), y1 = Y(b.from);
      s += '<rect x="' + pad.l + '" y="' + Math.min(y0, y1).toFixed(1) + '" width="' + iw + '" height="' + Math.abs(y1 - y0).toFixed(1) + '" fill="' + b.color + '" opacity=".5"/>';
    });
    c.series.forEach(se => {
      const d = pathFor(se.values, X, Y);
      if (se.fill) {
        const first = se.values.findIndex(v => v !== null && Number.isFinite(v));
        let lastI = -1; se.values.forEach((v, i) => { if (v !== null && Number.isFinite(v)) lastI = i; });
        if (first >= 0 && lastI > first) {
          s += '<path d="' + d + ' L ' + X(lastI).toFixed(1) + ' ' + (pad.t + ih) + ' L ' + X(first).toFixed(1) + ' ' + (pad.t + ih) + ' Z" fill="' + se.color + '" opacity=".09"/>';
        }
      }
      s += '<path d="' + d + '" fill="none" stroke="' + se.color + '" stroke-width="' + (se.width || 2) + '" stroke-linecap="round" stroke-linejoin="round"' + (se.dash ? ' stroke-dasharray="5 4"' : '') + '/>';
      let li = -1; se.values.forEach((v, i) => { if (v !== null && Number.isFinite(v)) li = i; });
      if (li >= 0) s += '<circle cx="' + X(li).toFixed(1) + '" cy="' + Y(se.values[li]).toFixed(1) + '" r="8" fill="' + se.color + '" opacity=".14"/><circle cx="' + X(li).toFixed(1) + '" cy="' + Y(se.values[li]).toFixed(1) + '" r="3.4" fill="' + se.color + '"/>';
    });
    for (let i = 0; i < n; i++) {
      const w = iw / n, x = pad.l + i * w;
      const tip = c.labels[i] + "：" + c.series.map(se => se.name + " " + (se.values[i] === null || se.values[i] === undefined ? "—" : fmt(se.values[i], 1))).join(" · ");
      s += '<rect x="' + x.toFixed(1) + '" y="' + pad.t + '" width="' + w.toFixed(1) + '" height="' + ih + '" fill="transparent"><title>' + esc(tip) + '</title></rect>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + s + '</svg>';
  }
  function svgBars(c, W, H) {
    const pad = { l: 36, r: 12, t: 12, b: 24 }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const vals = c.values.filter(v => v !== null && Number.isFinite(v));
    let min = c.min !== undefined ? c.min : Math.min(0, Math.min.apply(null, vals));
    let max = c.max !== undefined ? c.max : Math.max.apply(null, vals);
    if (!Number.isFinite(max) || max === min) max = min + 1;
    const Y = v => pad.t + ih - (v - min) / (max - min) * ih;
    // 柱宽封顶：只有一两根柱时按比例算会撑成一整块色块（n=1 时等于整个绘图区）
    const n = c.labels.length, gap = iw / n, bw = Math.min(gap * .62, 72);
    let s = grid(W, H, pad, min, max, c.labels);
    c.values.forEach((v, i) => {
      const x = pad.l + i * gap + (gap - bw) / 2;
      if (v === null || v === undefined || !Number.isFinite(v)) {
        s += '<rect x="' + x.toFixed(1) + '" y="' + (pad.t + ih - 14) + '" width="' + bw.toFixed(1) + '" height="14" fill="none" stroke="var(--text-3)" stroke-width="1" stroke-dasharray="3 3" rx="3"/>';
        if (bw > 14) s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (pad.t + ih - 20) + '" text-anchor="middle" font-size="10" fill="var(--text-3)">—</text>';
      } else {
        const y = Y(v), h = Math.max(1, pad.t + ih - y);
        s += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3" fill="' + (c.color || "var(--accent)") + '" opacity="' + (c.opacity || .88) + '"><title>' + esc(c.labels[i] + "：" + fmt(v, 0)) + '</title></rect>';
      }
    });
    (c.lines || []).forEach(ln => s += '<path d="' + pathFor(ln.values, i => pad.l + i * gap + gap / 2, Y) + '" fill="none" stroke="' + ln.color + '" stroke-width="2" stroke-linecap="round"/>');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + s + '</svg>';
  }
  function svgScatter(c, W, H) {
    const pad = { l: 44, r: 16, t: 14, b: 28 }, iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const xs = c.points.map(p => p.x), ys = c.points.map(p => p.y);
    const x0 = Math.min.apply(null, xs) - 10, x1 = Math.max.apply(null, xs) + 18;
    const y0 = 0, y1 = Math.max.apply(null, ys) * 1.15;
    const X = v => pad.l + (v - x0) / (x1 - x0) * iw, Y = v => pad.t + ih - (v - y0) / (y1 - y0) * ih;
    let s = "";
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ih * i / 4;
      s += '<line x1="' + pad.l + '" y1="' + y.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + y.toFixed(1) + '" stroke="var(--chart-grid)"/>';
      s += '<text x="' + (pad.l - 7) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--text-3)">' + ((y1 - (y1 - y0) * i / 4)).toFixed(2) + '</text>';
    }
    [40, 60, 80, 100, 120].forEach(v => {
      const x = X(v);
      s += '<line x1="' + x.toFixed(1) + '" y1="' + pad.t + '" x2="' + x.toFixed(1) + '" y2="' + (pad.t + ih) + '" stroke="var(--chart-grid)" stroke-dasharray="2 4"/>';
      s += '<text x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="var(--text-3)">' + v + ' kg</text>';
    });
    const r = c.reg;
    s += '<path d="M ' + X(x0).toFixed(1) + ' ' + Y(r.a * x0 + r.b).toFixed(1) + ' L ' + X(x1).toFixed(1) + ' ' + Y(r.a * x1 + r.b).toFixed(1) + '" stroke="var(--accent)" stroke-width="2" fill="none"/>';
    if (c.oneRM) {
      s += '<line x1="' + X(c.oneRM).toFixed(1) + '" y1="' + pad.t + '" x2="' + X(c.oneRM).toFixed(1) + '" y2="' + (pad.t + ih) + '" stroke="var(--indigo)" stroke-width="1.6" stroke-dasharray="5 4"/>';
      s += '<text x="' + (X(c.oneRM) + 5).toFixed(1) + '" y="' + (pad.t + 13) + '" font-size="10" fill="var(--indigo)">1RM ' + fmt(c.oneRM, 1) + ' kg</text>';
    }
    c.points.forEach(p => {
      s += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="5" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"><title>' + esc(p.x + " kg · MPV " + p.y.toFixed(2) + " m/s") + '</title></circle>';
    });
    s += '<text x="' + (W - pad.r) + '" y="' + (pad.t + 12) + '" text-anchor="end" font-size="11" font-weight="600" fill="var(--text-2)">R² = ' + fmt(r.r2, 3) + '</text>';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + s + '</svg>';
  }
  function svgGauge(c, W, H) {
    const each = W / c.items.length, r = Math.min(each * .34, H * .34), cy = H * .56;
    let s = "";
    c.items.forEach((it, k) => {
      const cx = each * (k + .5);
      s += '<path d="' + arc(cx, cy, r, -120, 120) + '" fill="none" stroke="var(--surface-3)" stroke-width="11" stroke-linecap="round"/>';
      s += '<path d="' + arc(cx, cy, r, -120, -120 + 240 * (0.8 / 2)) + '" fill="none" stroke="var(--green)" stroke-width="11" opacity=".18"/>';
      s += '<path d="' + arc(cx, cy, r, -120 + 240 * (0.8 / 2), -120 + 240 * (1.3 / 2)) + '" fill="none" stroke="var(--green)" stroke-width="11" opacity=".28"/>';
      if (it.value !== null && Number.isFinite(it.value)) {
        const deg = -120 + 240 * Math.min(2, Math.max(0, it.value)) / 2;
        s += '<path d="' + arc(cx, cy, r, -120, deg) + '" fill="none" stroke="' + (it.color || "var(--accent)") + '" stroke-width="11" stroke-linecap="round"/>';
      }
      s += '<text x="' + cx.toFixed(1) + '" y="' + (cy + 4).toFixed(1) + '" text-anchor="middle" font-size="22" font-weight="680" fill="var(--text-1)">' + (it.value === null || !Number.isFinite(it.value) ? "—" : fmt(it.value, 2)) + '</text>';
      s += '<text x="' + cx.toFixed(1) + '" y="' + (cy + 24).toFixed(1) + '" text-anchor="middle" font-size="11" fill="var(--text-2)">' + esc(it.name) + '</text>';
      s += '<text x="' + cx.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="10" fill="var(--text-3)">' + esc(it.sub || "") + '</text>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + s + '</svg>';
  }
  function svgStack(c, W, H) {
    const pad = { l: 52, r: 46, t: 8, b: 20 }, iw = W - pad.l - pad.r;
    const rowH = (H - pad.t - pad.b) / c.rows.length, bh = Math.min(16, rowH * .55);
    let s = "";
    c.rows.forEach((row, i) => {
      const y = pad.t + i * rowH + (rowH - bh) / 2;
      s += '<text x="' + (pad.l - 8) + '" y="' + (y + bh * .75).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--text-3)">' + esc(row.label) + '</text>';
      if (row.parts === null) {
        s += '<rect x="' + pad.l + '" y="' + y.toFixed(1) + '" width="' + iw + '" height="' + bh + '" fill="none" stroke="var(--text-3)" stroke-dasharray="3 3" rx="4"/>';
        s += '<text x="' + (pad.l + iw / 2) + '" y="' + (y + bh * .78).toFixed(1) + '" text-anchor="middle" font-size="10" fill="var(--text-3)">— 缺测</text>';
      } else {
        const total = row.parts.reduce((a, b) => a + b.v, 0) || 1;
        let x = pad.l;
        row.parts.forEach(p => {
          const w = iw * p.v / total;
          s += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + bh + '" fill="' + p.color + '" opacity=".85"><title>' + esc(p.name + " " + p.v + " min") + '</title></rect>';
          x += w;
        });
        s += '<text x="' + (W - pad.r + 6) + '" y="' + (y + bh * .78).toFixed(1) + '" font-size="10" fill="var(--text-2)">' + Math.round(total) + 'm</text>';
      }
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + s + '</svg>';
  }
  function renderChart(c, W, H) {
    if (c.kind === "line") return svgLine(c, W, H);
    if (c.kind === "bars") return svgBars(c, W, H);
    if (c.kind === "scatter") return svgScatter(c, W, H);
    if (c.kind === "gauge") return svgGauge(c, W, H);
    if (c.kind === "stack") return svgStack(c, W, H);
    return "";
  }
  function mountCharts() {
    const LV = window.ARC_LIVE;
    document.querySelectorAll("#content [data-chart]").forEach(el => {
      const base = chartRegistry[el.dataset.chart]; if (!base) return;
      const W = Math.max(200, el.clientWidth || 360), H = Math.max(120, el.clientHeight || 200);
      const c = LV ? LV.applyView(base, LV.state) : base;
      if (LV) LV.attachBase(el, base);
      el.innerHTML = renderChart(c, W, H);
      if (LV) LV.decorate(el, c);
    });
  }

  /* ── 组件片段 ───────────────────────────────────────── */
  function chip(text, act, extra) { return '<button class="chip" data-act="' + (act || "sheet") + '" ' + (extra || "") + '>' + text + '</button>'; }
  function drill(id, label) { return chip("ⓘ 口径 · " + esc(label || (A.METRICS[id] ? A.METRICS[id].short : id)), "sheet", 'data-sheet="metric" data-id="' + esc(id) + '"'); }
  function trio(id, win, src) {
    return drill(id) + chip("窗口 · " + esc(win), "sheet", 'data-sheet="window"') + chip("来源 · " + esc(src), "sheet", 'data-sheet="metric" data-id="' + esc(id) + '"');
  }
  function badge(text, tone) { return '<span class="badge ' + (tone || "") + '">' + esc(text) + "</span>"; }
  function row(it) {
    const act = it.route ? "nav" : (it.sheet ? "sheet" : "none");
    const attrs = it.route ? 'data-route="' + esc(it.route) + '"' : (it.sheet ? 'data-sheet="' + esc(it.sheet) + '"' + (it.sheetId ? ' data-id="' + esc(it.sheetId) + '"' : "") : "");
    return '<div class="list-row" role="button" tabindex="0" data-act="' + act + '" ' + attrs + '>' +
      '<span class="row-ico ' + (it.tone || "") + '">' + (it.glyph ? it.glyph : icon(it.icon || "info", 17)) + '</span>' +
      '<span class="row-body"><span class="row-title">' + esc(it.title) + '</span><span class="row-sub">' + esc(it.sub || "") + '</span></span>' +
      (it.btn ? '<button class="btn sm" data-act="' + esc(it.btn.act) + '" data-id="' + esc(it.btn.id || "") + '">' + esc(it.btn.label) + '</button>' : "") +
      (it.badge ? badge(it.badge, it.badgeTone) : "") +
      (it.value !== undefined ? '<span class="row-value ' + (it.na ? "na" : "") + '">' + esc(it.value) + "</span>" : "") +
      '</div>';
  }
  function metricCard(m) {
    const act = m.go ? "nav" : "sheet";
    const attrs = m.go ? 'data-route="' + esc(m.go) + '"' : 'data-sheet="metric" data-id="' + esc(m.metricId || "ctl") + '"';
    return '<div class="metric-card" role="button" tabindex="0" data-act="' + act + '" ' + attrs + '>' +
      '<div class="metric-label">' + esc(m.label) + '</div>' +
      '<div class="metric-value ' + (m.na ? "na" : "") + '">' + esc(m.value) + (m.unit ? '<span class="metric-unit">' + esc(m.unit) + "</span>" : "") + '</div>' +
      '<div class="metric-delta">' + esc(m.delta || "") + '</div>' +
      '<div class="metric-chips">' + (m.chips || (m.metricId ? trio(m.metricId, m.win || "28 日", m.src || "device") : "")) + '</div></div>';
  }

  /* ── 区块工厂 ───────────────────────────────────────── */
  function spanCls(n) { const c = Math.min(n || 1, COLS[state.platform]); return "span-" + c; }
  function S_hero(o) { return { type: "hero", ...o }; }
  function S_metrics(items, span) { return { type: "metrics", items, span: span || 3 }; }
  function S_chart(title, sub, chart, span, o) { return { type: "chart", title, sub, chart, span: span || 2, ...(o || {}) }; }
  function S_cards(title, sub, items, span, o) { return { type: "cards", title, sub, items, span: span || 1, ...(o || {}) }; }
  function S_table(title, sub, columns, rows, span, o) { return { type: "table", title, sub, columns, rows, span: span || 3, ...(o || {}) }; }
  function S_note(title, body, tone, span, action) { return { type: "note", title, body, tone, span: span || 3, action }; }
  function S_flow(title, sub, steps, span) { return { type: "flow", title, sub, steps, span: span || 1 }; }
  function S_heat(title, sub, span) { return { type: "heat", title, sub, span: span || 2 }; }
  function S_protocols(title, sub, span) { return { type: "protocols", title, sub, span: span || 1 }; }
  function S_kv(title, sub, pairs, span) { return { type: "kv", title, sub, pairs, span: span || 1 }; }
  function S_matrix(title, sub, span) { return { type: "matrix", title, sub, span: span || 3 }; }
  function S_livebar() { return { type: "livebar", span: 3 }; }
  function S_scores(ids) { return { type: "scores", ids: ids || [], span: 3 }; }
  function S_fusion() { return { type: "fusion", span: 3 }; }

  function renderSection(s, idx) {
    const delay = 'style="animation-delay:' + Math.min(idx * 26, 180) + 'ms"';
    const cls = spanCls(s.span);
    const head = s.title ? '<div class="section-head"><h3 class="section-title">' + esc(s.title) + '</h3>' + (s.sub ? '<span class="section-sub">' + esc(s.sub) + "</span>" : "") + "</div>" : "";
    if (s.type === "hero") {
      return '<div class="card hero span-3" ' + delay + '>' +
        '<div class="hero-kicker">' + esc(s.kicker) + '</div>' +
        '<h2 class="hero-title">' + esc(s.title) + '</h2>' +
        '<p class="hero-lead">' + esc(s.lead) + '</p>' +
        '<div class="hero-evidence">' + s.evidence.map(e => '<div class="ev"><div class="ev-label">' + esc(e.label) + '</div><div class="ev-value">' + esc(e.value) + '</div><div class="ev-detail">' + esc(e.detail) + "</div></div>").join("") + '</div>' +
        '<div class="hero-actions">' + (s.actions || []).map(a => '<button class="btn ' + (a.primary ? "primary" : "") + '" data-act="' + (a.sheet ? "sheet" : "nav") + '" ' + (a.sheet ? 'data-sheet="' + a.sheet + '"' + (a.id ? ' data-id="' + a.id + '"' : "") : 'data-route="' + a.route + '"') + '>' + esc(a.label) + '</button>').join("") + '</div></div>';
    }
    if (s.type === "metrics") {
      return '<div class="' + spanCls(s.span) + '" ' + delay + '><div class="metrics">' + s.items.map(metricCard).join("") + '</div></div>';
    }
    if (s.type === "chart") {
      const headWithTools = s.title ? '<div class="section-head"><h3 class="section-title">' + esc(s.title) + '</h3>' + (s.sub ? '<span class="section-sub">' + esc(s.sub) + "</span>" : "") +
        '<div class="section-tools">' + (s.drillId ? drill(s.drillId) : "") + '</div></div>' : "";
      return '<div class="card ' + cls + '" ' + delay + '>' + headWithTools +
        chartHost(s.chart) +
        (s.legend ? '<div class="chart-legend">' + s.legend.map(l => '<span class="lg"><i style="background:' + l.color + '"></i>' + esc(l.name) + '</span>').join("") + '</div>' : "") +
        (s.note ? '<div class="chart-axis-note">' + esc(s.note) + "</div>" : "") + '</div>';
    }
    if (s.type === "cards") {
      return '<div class="card ' + cls + '" ' + delay + '>' + head + '<div class="list">' + s.items.map(row).join("") + '</div>' +
        (s.note ? '<div class="card-note">' + esc(s.note) + "</div>" : "") + '</div>';
    }
    if (s.type === "table") {
      return '<div class="card ' + cls + '" ' + delay + '>' + head +
        '<div class="table-wrap"><table class="tbl"><thead><tr>' + s.columns.map(c => '<th>' + esc(c) + '</th>').join("") + '</tr></thead><tbody>' +
        s.rows.map(r => '<tr>' + r.map(c => '<td>' + (c && c.indexOf && c.indexOf('<') >= 0 ? c : esc(c)) + '</td>').join("") + '</tr>').join("") +
        '</tbody></table></div>' + (s.note ? '<div class="card-note">' + esc(s.note) + "</div>" : "") + '</div>';
    }
    if (s.type === "note") {
      return '<div class="note ' + (s.tone || "") + ' ' + cls + '" ' + delay + '>' +
        (s.title ? '<div class="note-title">' + (s.tone === "warn" ? "⚠ " : "ℹ ") + esc(s.title) + '</div>' : "") +
        '<div>' + s.body + '</div>' +
        (s.action ? '<div style="margin-top:10px"><button class="btn sm" data-act="' + (s.action.sheet ? "sheet" : "nav") + '" ' + (s.action.sheet ? 'data-sheet="' + s.action.sheet + '"' : 'data-route="' + s.action.route + '"') + '>' + esc(s.action.label) + '</button></div>' : "") + '</div>';
    }
    if (s.type === "flow") {
      return '<div class="card ' + cls + '" ' + delay + '>' + head + '<div class="flow">' + s.steps.map((st, i) => '<div class="flow-step"><span class="flow-n">' + (i + 1) + '</span><div><div class="flow-t">' + esc(st.t) + '</div><div class="flow-d">' + esc(st.d) + "</div></div></div>").join("") + '</div></div>';
    }
    if (s.type === "heat") {
      const tl = getTL();
      const cells = tl.map((v, i) => {
        const cls = v === null ? "missing" : ([5, 19].indexOf(i) >= 0 ? "suspect" : "valid");
        const tip = A.DATES_FULL[i] + " · " + (cls === "missing" ? "缺测" : cls === "suspect" ? "quality_flag=suspect" : "TL " + v + " · 有效");
        return '<div class="heat-cell ' + cls + '" title="' + esc(tip) + '" data-act="sheet" data-sheet="manual" data-date="' + esc(A.DATES_FULL[i]) + '">' + (cls === "missing" ? "—" : A.DATES[i].split("/")[1]) + '</div>';
      }).join("");
      return '<div class="card ' + cls + '" ' + delay + '>' + head + '<div class="heat">' + cells + '</div>' +
        '<div class="heat-legend"><span><i style="background:color-mix(in srgb, var(--green) 22%, var(--surface))"></i>有效</span><span><i style="background:rgba(255,149,0,.16)"></i>suspect 可疑</span><span><i style="border-style:dashed"></i>缺测（不补 0）</span></div>' +
        '<div class="card-note">点按任一日期可手动补录；补录写入 source=manual，与 import 来源在计算时互斥筛选。</div></div>';
    }
    if (s.type === "protocols") {
      return '<div class="card ' + cls + '" ' + delay + '>' + head +
        A.TEST_PROTOCOLS.map(g => '<div style="margin-bottom:12px"><div style="font-size:11px;color:var(--text-3);margin-bottom:6px">' + esc(g.group) + '</div><div class="protocol-grid">' +
          g.items.map(it => '<button class="protocol" data-act="sheet" data-sheet="newtest" data-id="' + esc(it) + '">' + esc(it) + '</button>').join("") + '</div></div>').join("") + '</div>';
    }
    if (s.type === "kv") {
      return '<div class="card ' + cls + '" ' + delay + '>' + head + '<dl class="kv">' + s.pairs.map(p => '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>').join("") + '</dl></div>';
    }
    if (s.type === "matrix") {
      const P = A.PERMISSIONS;
      const sym = v => v === "full" ? '<span style="color:var(--green);font-weight:700">●</span>' : v === "limited" ? '<span style="color:var(--orange);font-weight:700">◐</span>' : '<span style="color:var(--text-3)">—</span>';
      const rows = P.rows.map(r => [esc(r.module)].concat(P.columns.map((c, i) => sym(r.v[i]))));
      return '<div class="card ' + cls + '" ' + delay + '>' + head +
        '<div class="table-wrap"><table class="tbl"><thead><tr><th>模块</th>' + P.columns.map(c => '<th>' + esc((A.ROLES.find(x => x.id === c) || {}).label) + '</th>').join("") + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join("") + '</tr>').join("") +
        '</tbody></table></div><div class="card-note">● 完全 · ◐ 受限 · — 无。当前角色：<b>' + esc(roleLabel(state.role)) + '</b>。无权限入口显示锁定态 + 原因，不静默隐藏。</div></div>';
    }
    if (s.type === "livebar") {
      return '<div class="' + spanCls(s.span) + '" ' + delay + '>' + (window.ARC_LIVE ? window.ARC_LIVE.barHtml() : "") + '</div>';
    }
    if (s.type === "scores") {
      return '<div class="' + spanCls(s.span) + '" ' + delay + '>' + (window.ARC_LIVE ? window.ARC_LIVE.scoreCardsHtml(s.ids) : "") + '</div>';
    }
    if (s.type === "fusion") {
      return '<div class="' + spanCls(s.span) + '" ' + delay + '>' + (window.ARC_LIVE ? window.ARC_LIVE.fusionSectionHtml() : "") + '</div>';
    }
    return "";
  }

  /* ── 页面构建 ───────────────────────────────────────── */
  const L = () => last();
  function tlLabels() { return A.DATES.slice(-14); }
  function planVsDone() {
    const tl = getTL().slice(-14);
    return tl.map(v => v === null ? null : v);
  }
  function chartTL() {
    const r = load().slice(-14);
    return { kind: "bars", labels: tlLabels(), values: r.map(x => x.tl), color: "var(--accent)", opacity: .55,
      lines: [{ values: r.map(x => x.ctl), color: "var(--blue)" }, { values: r.map(x => x.atl), color: "var(--orange)" }] };
  }
  function chartLoadTrend() {
    const r = load();
    return { kind: "line", labels: A.DATES, min: -20, max: 170,
      series: [
        { name: "CTL", values: r.map(x => x.ctl), color: "var(--blue)", width: 2.2, fill: true },
        { name: "ATL", values: r.map(x => x.atl), color: "var(--orange)", width: 1.8 },
        { name: "TSB", values: r.map(x => x.tsb), color: "var(--indigo)", width: 1.6, dash: true }
      ] };
  }
  function chartHRV() {
    return { kind: "line", labels: A.DATES, min: 40, max: 82,
      bands: [{ from: 52, to: 68, color: "var(--green)" }],
      series: [{ name: "RMSSD", values: A.RMSSD_BASE, color: "var(--green)", width: 2.2, fill: true },
               { name: "28 日基线", values: A.DATES.map(() => 60.4), color: "var(--text-3)", width: 1.2, dash: true }] };
  }
  function chartSleepStack() {
    return { kind: "stack", rows: A.SLEEP.map(s => ({ label: s.date, parts: s.stages ? [
      { v: s.stages[0], color: "var(--indigo)", name: "深睡" },
      { v: s.stages[1], color: "var(--blue)", name: "浅睡" },
      { v: s.stages[2], color: "var(--green)", name: "REM" },
      { v: s.stages[3], color: "var(--orange)", name: "清醒" }] : null })) };
  }
  function chartPower() {
    const labels = ["1s", "5s", "30s", "1min", "5min", "20min", "60min"];
    return { kind: "line", labels, min: 200, max: 900,
      series: [{ name: "最佳功率", values: [820, 740, 520, 418, 342, 298, 262], color: "var(--accent)", width: 2.2, fill: true }] };
  }
  function chartZoneStack() {
    return { kind: "stack", rows: [
      { label: "Z1 恢复", parts: [{ v: 186, color: "var(--green)", name: "Z1" }, { v: 40, color: "var(--surface-3)", name: "其余" }] },
      { label: "Z2 有氧", parts: [{ v: 242, color: "var(--blue)", name: "Z2" }, { v: 40, color: "var(--surface-3)", name: "其余" }] },
      { label: "Z3 节奏", parts: [{ v: 96, color: "var(--indigo)", name: "Z3" }, { v: 40, color: "var(--surface-3)", name: "其余" }] },
      { label: "Z4 阈值", parts: [{ v: 58, color: "var(--orange)", name: "Z4" }, { v: 40, color: "var(--surface-3)", name: "其余" }] },
      { label: "Z5 VO₂", parts: [{ v: 21, color: "var(--red)", name: "Z5" }, { v: 40, color: "var(--surface-3)", name: "其余" }] }
    ] };
  }
  function chartVL() {
    return { kind: "bars", labels: A.VBT_SETS.map(s => s.load + "kg"), values: A.VBT_SETS.map(s => s.vl), color: "var(--orange)", min: 0, max: 30 };
  }
  function chartJump() {
    const picks = A.JUMPS.filter(j => j.tf !== null).slice(0, 6).reverse();
    const h = j => (j.height !== null && j.height !== undefined ? j.height : jumpH(j.tf) * 100);
    return { kind: "bars", labels: picks.map(j => j.type + " " + j.date), values: picks.map(h), color: "var(--indigo)", min: 0, max: Math.max(20, Math.ceil(Math.max.apply(null, picks.map(h).concat([20])) * 1.25)) };
  }
  function chartTeamLoad() {
    var _v = A.ATHLETES.map(a => a.load7 || 0);
    return { kind: "bars", labels: A.ATHLETES.map(a => a.name.replace(" ", "")), values: _v, color: "var(--indigo)", min: 0, max: Math.max(200, Math.ceil(Math.max.apply(null, _v.concat([0])) * 1.15)) };
  }
  function chartRepVelocity() {
    return { kind: "bars", labels: ["R1", "R2", "R3", "R4", "R5", "R6"], values: [0.72, 0.70, 0.67, 0.63, 0.59, 0.55], color: "var(--accent)", min: 0, max: 0.9 };
  }

  const P = {};
  function page(route, title, question, eyebrow, sections, opts) {
    P[route] = { title, question, eyebrow, sections, chips: (opts && opts.chips) || [], actions: (opts && opts.actions) || [] };
  }
  // 数据来源标签：连了真库就不能再挂「DEMO 演示数据」，那会让人误判眼前数字的性质
  function dataChip() {
    return state.dbLive
      ? '<span class="chip live">真实数据 · RLS 生效</span>'
      : '<span class="chip demo">DEMO 演示数据</span>';
  }
  const curWindow = () => (window.ARC_LIVE ? window.ARC_LIVE.state.window : state.params.window);
  const analyzeChips = () => [
    '<button class="chip strong" data-act="sheet" data-sheet="window">口径 · ' + (state.params.tl === "srpe" ? "sRPE" : state.params.tl.toUpperCase()) + '</button>',
    '<button class="chip" data-live-window data-act="sheet" data-sheet="window">窗口 · ' + curWindow() + ' 日</button>',
    '<button class="chip" data-act="sheet" data-sheet="window">ACWR · ' + (state.params.acwr === "ewma" ? "EWMA" : "rolling") + '</button>', dataChip()
  ];

  /* ── 页面定义：每次渲染都重建，保证口径/缺测/标定等状态即时反映 ── */
  function buildPages() {
  /* 今日 */
  (function () {
    const l = L();
    // 真实库：HRV 与今日计划直接取服务端 arc_daily_summary()，缺测就显示「—」不推算
    const SM = A.SUMMARY;
    const TODAY = (function () {
      if (!SM) return { hrv: "64", hrvNote: "基线 60.4 ms · 未显著偏离",
                        planCount: "1", planText: "力量 · 下肢 VBT · 68 min" };
      const r = SM.recovery || {};
      const base = r.baseline == null ? null : Math.exp(Number(r.baseline));
      const z = r.z == null ? null : Number(r.z);
      return {
        hrv: r.rmssd == null ? "—" : String(Math.round(Number(r.rmssd))),
        hrvNote: r.rmssd == null
          ? "今日未记录 HRV（不推算、不补 0）"
          : (base == null
              ? "基线样本不足，尚未建立个人基准"
              : "基线 " + base.toFixed(1) + " ms · " + (z == null ? "偏离不可算"
                  : (Math.abs(z) < 1 ? "基线内" : (z > 0 ? "高于基线 " + z.toFixed(1) + " SWC" : "低于基线 " + Math.abs(z).toFixed(1) + " SWC")))),
        planCount: String((SM.plan || []).length),
        planText: (SM.plan || []).length
          ? SM.plan.map(function (p) {
              return (p.title || "训练") + (p.duration_min ? " · " + p.duration_min + " min" : "");
            }).join(" / ")
          : "今天没有排课"
      };
    })();
    /* 今日主结论：真实库只搬服务端结论，缺分量就说缺，不自己编一条「维持既定强度」 */
    const RD = (SM && SM.readiness) || null;
    const RVP = (A.RULE_PACK && A.RULE_PACK.version) || "v1.0";
    const RM = (A.RULE_PACK && A.RULE_PACK.payload) || {};
    const aBand = RM.acwr ? RM.acwr.low + "–" + RM.acwr.high : "0.80–1.30";
    const HERO = !SM
      ? {
          kicker: "规则引擎 · rule-engine v1.0 · 2026-11-13",
          title: "维持既定强度：本周目标日 TL 118",
          lead: "依据三条可解释规则生成。未使用任何无解释的评分或颜色等级；任一输入不足时结论会降级为「数据不足」，不生成建议。",
          evidence: [
            { label: "R-01 负荷增量", value: "ACWR " + fmt(l.ewma, 2), detail: "EWMA 主口径 · 区间 0.80–1.30" },
            { label: "R-04 恢复偏离", value: "lnRMSSD 4.16", detail: "28 日基线 4.08 ± 0.21 · 基线内" },
            { label: "R-07 单调性", value: "TM " + fmt(l.tm, 2), detail: "7 日有效天 7/7 · 阈值 < 2.0" }
          ]
        }
      : {
          kicker: "服务端计算 · 规则版本 " + RVP + " · " + (SM.date || "") +
                  (SM.timezone ? " · " + SM.timezone : ""),
          title: RD && RD.score !== null && RD.score !== undefined
            ? "就绪度 " + Math.round(RD.score) + " · " + (RD.score >= 70 ? "可执行既定强度" : "低于常态区间，强度由教练确认")
            : "今日数据不足 · 不生成训练强度结论",
          lead: RD && RD.score !== null && RD.score !== undefined
            ? "由三个分量加权得出（负荷 " + Math.round((RD.weights && RD.weights.load || 0) * 100) + "% / HRV " +
              Math.round((RD.weights && RD.weights.hrv || 0) * 100) + "% / 睡眠 " +
              Math.round((RD.weights && RD.weights.sleep || 0) * 100) + "%，覆盖率 " +
              Math.round((RD.coverage === undefined ? 1 : RD.coverage) * 100) + "%）。缺分量时按剩余权重重新归一，全缺则不出分。"
            : "缺少可用输入（HRV / 睡眠 / 负荷序列），按设计返回空值而不是默认 0——0 分会被误读成「极差」。",
          evidence: [
            { label: "R-01 负荷增量", value: "ACWR " + (SM.load && SM.load.acwr != null ? fmt(SM.load.acwr, 2) : "—"),
              detail: "EWMA 主口径 · 区间 " + aBand },
            { label: "R-04 恢复偏离", value: (SM.recovery && SM.recovery.z != null) ? "z " + Number(SM.recovery.z).toFixed(2) : "—",
              detail: (SM.recovery && SM.recovery.rmssd != null)
                ? "RMSSD " + Math.round(Number(SM.recovery.rmssd)) + " ms" +
                  (SM.recovery.baseline != null ? " · 基线 " + Math.round(Math.exp(Number(SM.recovery.baseline))) + " ms" : " · 基线未建立")
                : "今日未记录 HRV" },
            { label: "R-07 单调性", value: (SM.load && SM.load.tm != null) ? "TM " + fmt(SM.load.tm, 2) : "—",
              detail: (SM.load && SM.load.tm == null) ? "7 日有效天不足，单调性不可算" : "阈值 < " + (RM.monotony_max || 2) }
          ]
        };
    page("today", "今日", "今天该练什么，身体状态够不够？", "TODAY / 单一主状态", [
      S_hero(Object.assign({}, HERO, {
        actions: [{ label: "查看依据", sheet: "rule", id: "R-01" }, { label: "应用为周期块", route: "train/plan", primary: true }] })),
      S_metrics([
        { label: "负荷 · ACWR(EWMA)", value: fmt(l.ewma, 2), delta: "急性 / 慢性负荷比 · 28 日", metricId: "acwr.ewma", win: "EWMA", src: "device", go: "analyze/load" },
        { label: "恢复 · HRV", value: TODAY.hrv, unit: "ms", delta: TODAY.hrvNote, metricId: "hrv.rmssd", win: "28 日", src: "device", go: "analyze/recovery" },
        { label: "今日计划", value: TODAY.planCount, unit: "课", delta: TODAY.planText, go: "train/session" }
      ], 3),
      S_cards("今日三个入口", "不做图表堆叠，只给下一步动作", [
        { icon: "bolt", title: "开始 VBT 采集", sub: "IMU 拉取 / 手动填入 · 来源互斥", value: "进入", route: "lab/vbt" },
        { icon: "plus", title: "新建跳跃测试", sub: "CMJ / SJ / DJ / RSI 10-5", value: "进入", sheet: "newtest" },
        { icon: "database", title: "设备与缺测", sub: "5 台在用 · 2 天缺测", value: "进入", route: "data/quality" }
      ], 2),
      S_note("今日页边界", "此页只回答<b>一个问题</b>：今天该练什么。长期趋势进 <b>分析</b>，采集写入进 <b>测试</b>，设备与授权进 <b>数据</b>，团队聚合进 <b>教练工作台</b>。", "info", 1, { label: "查看完整边界表", route: "data/metrics" })
    ], { chips: [dataChip(), '<button class="chip" data-act="sheet" data-sheet="rule" data-id="R-12">规则版本 v1.0</button>'] });
  })();

  /* 训练 */
  (function () {
    // 概览四个数：真实库一律现算，缺测就显示「—」或用 0 明确标注，不套演示值
    const LIVE = state.dbLive;
    const last7 = (A.SRV || []).slice(-7);
    const tl7 = last7.reduce((s, d) => s + (d.tl || 0), 0);
    const valid7 = last7.filter(d => d.tl !== null).length;
    const week = A.WEEK_PLAN || [];
    const doneN = week.filter(w => w.status === "已完成").length;
    const missingN = (A.SRV || []).filter(d => d.tl === null).length;
    const CM = A.CYCLE_META;
    const overviewMetrics = LIVE ? [
      { label: "本周累计 TL", value: String(Math.round(tl7)), delta: "7 日有效天 " + valid7 + "/7", metricId: "tl.srpe", win: "7 日", src: "device", go: "train/calendar" },
      { label: "计划完成率", value: week.length ? String(Math.round(doneN / week.length * 100)) : "—", unit: week.length ? "%" : "", delta: week.length ? "本周 " + doneN + "/" + week.length + " 课" : "本周未排课", go: "train/calendar" },
      { label: "当前周期阶段", value: CM ? CM.phase : "—", delta: CM ? CM.start + " – " + CM.end : "未建周期 · 不推断阶段", go: "train/plan" },
      { label: "缺测天数", value: String(missingN), unit: "天", delta: "28 日窗口内 · 显示「—」", go: "data/quality" }
    ] : [
      { label: "本周累计 TL", value: "546", delta: "7 日有效天 7/7", metricId: "tl.srpe", win: "7 日", src: "device", go: "train/calendar" },
      { label: "计划完成率", value: "92", unit: "%", delta: "本周 6/7 课", go: "train/calendar" },
      { label: "当前周期阶段", value: "Build", delta: "11/03 – 11/23 · 目标 118/日", go: "train/plan" },
      { label: "缺测天数", value: "2", unit: "天", delta: "28 日窗口内 · 显示「—」", go: "data/quality" }
    ];
    page("train", "训练", "练了什么、接下来练什么？", "TRAIN / 概览", [
      S_metrics(overviewMetrics),
      S_chart("计划与完成", "近 14 日日负荷 TL；折线为 CTL / ATL", chartTL(), 2, { drillId: "ctl",
        legend: [{ name: "日 TL", color: "var(--accent)" }, { name: "CTL 42 日", color: "var(--blue)" }, { name: "ATL 7 日", color: "var(--orange)" }],
        note: "缺测日为虚线空位并显示「—」，不按 0 补齐。" }),
      S_cards("周期块", "由规则引擎生成，可解释、可审批", A.PLAN_BLOCKS.map(b => ({ icon: "chart", title: b.phase + " · " + b.range, sub: "目标周 TL " + b.target + (b.targetDay ? " · 约 " + b.targetDay + "/日" : "") + (b.actual === null || b.actual === undefined ? "" : " · 实际 " + b.actual), value: b.status, badge: b.status, badgeTone: b.tone === "active" ? "info" : b.tone === "done" ? "ok" : b.tone === "warn" ? "bad" : "mute", route: "train/plan" })), 1),
      S_cards("近期训练", "点按进入单次训练详情与 TL 下钻", A.SESSIONS.slice(0, 5).map(s => ({ icon: "today", title: s.name, sub: s.date + " · " + s.sport + " · " + s.dur, value: s.tl ? "TL " + s.tl : "休息", route: "train/session" })), 2),
      S_note("训练页边界", "训练页承载<b>计划、日历、课库与执行记录</b>；长期趋势计算不在这里，进 <b>分析 · 负荷与周期</b>。", "", 1)
    ], { chips: [dataChip()], actions: [{ label: "＋ 新建训练", sheet: "newtest" }, { label: "打开课库", route: "train/library" }] });

    page("train/calendar", "训练日历", "这一周 / 月计划与完成的差在哪？", "TRAIN / 二级", [
      S_chart("近 14 日计划 vs 完成", "柱=实际日 TL；折线=CTL / ATL", chartTL(), 2, { drillId: "tl.srpe", legend: [{ name: "实际 TL", color: "var(--accent)" }, { name: "CTL", color: "var(--blue)" }, { name: "ATL", color: "var(--orange)" }] }),
      S_table("周期阶段标签", "每阶段设定目标周 TL（AU）", ["阶段", "区间", "目标周 TL", "状态"], A.PLAN_BLOCKS.map(b => [esc(b.phase), esc(b.range), esc(b.target), esc(b.status)]), 1),
      S_cards("训练记录", "按日期倒序 · 点按看单次详情", A.SESSIONS.map(s => ({ icon: "train", title: s.name, sub: s.date + " · " + s.sport + " · " + s.dur + " · " + s.method, value: s.tl || "—", route: "train/session" })), 2),
      S_note("日历规则", "计划与完成并列展示，<b>差值不估算</b>；缺测日为空位。按完成度排序属于教练工作台能力，不在个人日历内。", "", 1)
    ], { chips: [dataChip()] });

    page("train/session", "单次训练详情", "这一课产生了多少 TL，依据是什么？", "TRAIN / 二级", [
      S_metrics([
        { label: "时长", value: "68", unit: "min", delta: "力量 · 下肢 VBT", go: "train/calendar" },
        { label: "TL（sRPE）", value: "96", delta: "RPE 7 × 时长 · 口径已固定", metricId: "tl.srpe", win: "单次", src: "device" },
        { label: "sRPE", value: "7", unit: "/10", delta: "手动录入 · source=manual", go: "data/import" },
        { label: "TSS", value: "—", delta: "不可计算 · 无功率数据", metricId: "tl.tss", win: "单次", src: "—", na: true }
      ]),
      S_chart("样本流：心率 / 速度", "本课原始样本流（DEMO）", { kind: "line", labels: ["0", "10", "20", "30", "40", "50", "60", "68"], min: 60, max: 180,
        series: [{ name: "心率 bpm", values: [92, 118, 142, 136, 152, 148, 138, 104], color: "var(--red)", width: 2.2, fill: true }] }, 2,
        { drillId: "tl.srpe", legend: [{ name: "心率", color: "var(--red)" }], note: "样本级下钻在指标口径 Sheet 内提供，不在此页堆叠表格。" }),
      S_kv("本课计算口径", "每个值都能回答四问", [
        ["TL 方法", "<b>sRPE v1.0</b> · 一次选定并固定，不与 TRIMP / TSS 混用"],
        ["公式", "<span class=\"formula\">TL = sRPE(0–10) × 时长(min) = 7 × 68 ≈ 476 → 归一为 96</span>"],
        ["输入", "RPE=7（manual）· 时长 68 min（device）· HR 时序（device）"],
        ["TSS", "<b>不可计算</b> · 本课无功率数据，不回退 TRIMP 冒充"],
        ["证据", "E6 (Foster 2001) · E7 (Allen & Coggan)"]
      ], 1),
      S_cards("关联", "页面级跳转，不使用第三层嵌套", [
        { icon: "analyze", title: "查看长期负荷趋势", sub: "analyze/load · CTL/ATL/TSB", route: "analyze/load" },
        { icon: "lab", title: "查看本课 VBT 采集", sub: "lab/vbt · IMU 拉取记录", route: "lab/vbt" },
        { icon: "data", title: "查看原始样本与质量标记", sub: "data/quality · source / quality_flag", route: "data/quality" }
      ], 3)
    ], { chips: [dataChip(), '<button class="chip" data-act="sheet" data-sheet="metric" data-id="tl.srpe">ⓘ TL 口径</button>'] });

    /* 周期计划：真实库按 plan_blocks 画「目标日 TL」阶梯，不再画一条假想的 118 */
    page("train/plan", "周期计划", "未来几周目标负荷与阶段怎么排？", "TRAIN / 二级", (function () {
      const LIVE = state.dbLive;
      const CP = A.CYCLE_META || null;
      const PG = (CP && CP.progress) || null;
      const blocks = A.PLAN_BLOCKS || [];
      const week = A.WEEK_PLAN || [];

      // 目标日 TL = 该周目标上限 / 7，按块区间落到每一天；没有块的日子就是「无目标」
      const seg = blocks.filter(b => b.startRaw && b.targetNum !== null);
      const tgtDaily = (A.DATES_FULL || []).map(d => {
        const hit = seg.filter(x => d >= x.startRaw && d <= x.endRaw)[0];
        return hit ? Math.round(hit.targetNum / 7) : null;
      });
      const allVals = getTL().concat(tgtDaily).filter(v => v !== null && v !== undefined);
      const ymax = Math.max(60, Math.ceil((allVals.length ? Math.max.apply(null, allVals) : 60) * 1.25));

      if (!LIVE) {
        return [
          S_chart("目标日 TL 与实际", "块级目标由规则引擎给出，需二次确认才写入", { kind: "line", labels: A.DATES, min: 0, max: 170,
            series: [{ name: "实际日 TL", values: getTL(), color: "var(--accent)", width: 2 },
                     { name: "Build 目标 118", values: A.DATES.map(() => 118), color: "var(--indigo)", width: 1.4, dash: true }] }, 2,
            { drillId: "acwr.ewma", legend: [{ name: "实际", color: "var(--accent)" }, { name: "目标", color: "var(--indigo)" }] }),
          S_table("周期块时间轴", "Base / Build / Peak / Taper / Deload", ["阶段", "区间", "目标日 TL", "规则版本", "状态"], A.PLAN_BLOCKS.map(b => [esc(b.phase), esc(b.range), esc(b.target), "rule-engine v1.0", esc(b.status)]), 3,
            { note: "周期块为可解释规则输出，不输出黑盒评分；回滚与灰度在教练工作台 · 规则与口径版本。" }),
          S_flow("从建议到落地", "应用建议需二次确认", [
            { t: "规则引擎输出建议", d: "输入 CTL 斜率 / ACWR / TSB / TM / TS / 有效天数，命中 R-01。" },
            { t: "查看依据", d: "O7 规则解释 Sheet 展示输入值、阈值、版本号与可调整参数。" },
            { t: "预填目标日 TL", d: "在本页生成待确认的周期块，不直接覆盖现有计划。" },
            { t: "审批后生效", d: "head_coach 角色审批；写操作记入审计日志。" }
          ], 2),
          S_note("权限", "队医 / 康复与科研角色对周期计划<b>只读或拒绝编辑</b>；原型可在顶栏切换角色验证锁定态。", "warn", 1)
        ];
      }

      if (!CP) {
        return [
          S_note("还没有周期计划",
            "库里的 <b>plan_cycles</b> / <b>plan_blocks</b> 是空的。<b>不画假想目标线</b>——没有计划就是没有计划，" +
            "这里不生成任何建议值。周期需要教练在工作台创建，或先到课库把模板排到具体日期。", "info", 3),
          S_table("当前能确认的事实", "全部来自真实库", ["项", "值", "说明"], [
            ["课库模板", String((A.LIBRARY || []).length) + " 个", "session_templates"],
            ["本周排课", String(week.length) + " 节", "session_assignments（本周一起算）"],
            ["训练记录", String((A.SESSIONS || []).length) + " 条", "activities"]
          ], 1, { note: "有排课和训练记录也能用；缺的是「未来几周的目标负荷区间」。" })
        ];
      }

      const ad = (PG && PG.assignments) || {};
      const ld = (PG && PG.load) || {};
      const pct = v => (v === null || v === undefined) ? "—" : Math.round(Number(v) * 100) + "%";
      const num = v => (v === null || v === undefined) ? "—" : fmt(Number(v), 0);

      const out = [];

      out.push(S_metrics([
        { label: "计划遵守率", value: pct(ad.adherence), delta: "完成 " + (ad.done || 0) + " / 排课 " + (ad.planned || 0) + (ad.skipped ? " · 跳过 " + ad.skipped : ""), go: "train/plan" },
        { label: "负荷完成比", value: ld.ratio === null || ld.ratio === undefined ? "—" : fmt(Number(ld.ratio), 2), delta: "实际 " + num(ld.actual) + " / 计划 " + num(ld.planned) + " AU", metricId: "tl.srpe", win: "周期内", src: "device" },
        { label: "本周课表", value: String(week.length), unit: "节", delta: week.length ? week.filter(w => w.status === "已完成").length + " 节已完成" : "本周还没排课", go: "train/library" },
        { label: "周期区间", value: CP.start + "–" + CP.end, delta: CP.name + " · " + CP.phase, go: "train/calendar" }
      ], 3));

      out.push(S_chart("目标日 TL 与实际", "目标线来自 plan_blocks（周目标上限 ÷ 7），无块的日子不连线",
        { kind: "line", labels: A.DATES, min: 0, max: ymax,
          series: [{ name: "实际日 TL", values: getTL(), color: "var(--accent)", width: 2 },
                   { name: "目标日 TL", values: LIVE ? tgtDaily : A.DATES.map(() => 118), color: "var(--indigo)", width: 1.4, dash: true }] }, 2,
        { drillId: "acwr.ewma", legend: [{ name: "实际", color: "var(--accent)" }, { name: "目标", color: "var(--indigo)" }] }));

      out.push(S_table("周期块时间轴", "target_load_min / max 为周负荷区间，实际值取自 activities",
        ["阶段", "区间", "目标周 TL", "实际周 TL", "状态"], blocks.map(b => [
          esc(b.phase), esc(b.range), esc(b.target),
          b.actual === null ? '<span class="mini">未统计</span>' : esc(b.actual),
          '<span class="badge ' + (b.tone === "done" ? "ok" : b.tone === "warn" ? "bad" : b.tone === "active" ? "info" : "mute") + '">' + esc(b.status) + '</span>'
        ]), 3, { note: "「偏离区间」只表示实际周负荷落在目标区间之外，不等于训练出错——赛周、伤病、临时调整都会造成偏离。" }));

      out.push(week.length
        ? S_cards("本周课表", "session_assignments · 周一起算", week.map(w => ({
            icon: "train", title: w.date + " · " + w.title,
            sub: [w.purpose, w.dur, w.rpe ? "RPE " + w.rpe : null].filter(Boolean).join(" · "),
            value: w.status, badge: w.status,
            badgeTone: w.status === "已完成" ? "ok" : w.status === "已跳过" ? "mute" : "info",
            route: "train/session"
          })), 2)
        : S_note("本周没有排课", "把课库模板排到具体日期后，这里会按天列出。空着就是空着——不补默认课程。", "", 2));

      out.push(S_note("口径", "目标区间在 <b>plan_blocks</b>，实际负荷只取 <b>activities.training_load</b> 一个事实源；" +
        "执行度由服务端 <b>arc_cycle_progress()</b> 汇总，前端不做二次求和。规则版本见「规则与口径版本」。", "info", 1,
        { label: "查看规则版本", route: "admin/rules" }));

      return out;
    })(), { chips: [dataChip()], actions: [{ label: "查看规则依据", sheet: "rule", id: "R-01" }, { label: "打开课库", route: "train/library" }] });

    page("train/library", "课库与模板", "有哪些可复用的结构化课？", "TRAIN / 二级", (function () {
      const LIVE = state.dbLive;
      const lib = A.LIBRARY || [];
      const PURPOSE_ICON = { "力量": "lab", "爆发力": "bolt", "速度": "bolt", "体能": "train", "恢复": "heart", "测试": "bolt" };

      if (!LIVE) {
        return [
          S_cards("结构化课", "分类：跑步 / 骑行 / 力量 / 测试", [
            { icon: "train", title: "节奏跑 20' + 6×400m", sub: "跑步 · 72 min · 目标 Z4", badge: "可下发", badgeTone: "info" },
            { icon: "train", title: "阈值间歇 4×8min", sub: "骑行 · 81 min · 目标 95% FTP", badge: "可下发", badgeTone: "info" },
            { icon: "lab", title: "下肢 VBT 5×5 @ 80kg", sub: "力量 · 68 min · VL 阈值 20%", badge: "可下发", badgeTone: "info" },
            { icon: "bolt", title: "跳跃测试组合 CMJ/SJ/DJ", sub: "测试 · 35 min · 需登记 fps", badge: "模板", badgeTone: "mute" },
            { icon: "heart", title: "恢复日 Z1 + 活动度", sub: "跑步 · 40 min · RPE ≤ 3", badge: "模板", badgeTone: "mute" }
          ], 2),
          S_protocols("从课库发起测试", "点按协议进入对应采集页", 1),
          S_note("边界", "课库只负责<b>复用与下发</b>；测试的实际采集在 <b>lab/*</b>，长期对比在 <b>analyze/*</b>。", "", 3)
        ];
      }

      if (!lib.length) {
        return [
          S_note("课库是空的", "库里的 <b>session_templates</b> 没有任何模板。课库不会预置示例课——" +
            "这里显示的每一节课都必须是教练真实写下、能下发的。", "info", 3),
          S_protocols("从课库发起测试", "点按协议进入对应采集页", 1),
          S_note("边界", "课库只负责<b>复用与下发</b>；测试的实际采集在 <b>lab/*</b>，长期对比在 <b>analyze/*</b>。", "", 3)
        ];
      }

      const rows = [];
      lib.forEach(t => {
        if (!t.items.length) { rows.push(["—", t.title, "—", "—", "—", '<span class="mini">无条目</span>']); return; }
        t.items.forEach(i => rows.push([
          esc(i.seq), esc(i.exercise),
          i.sets && i.reps ? i.sets + "×" + i.reps : (i.sets || "—"),
          i.load !== null ? i.load + " kg" : (i.pct !== null ? i.pct + " %1RM" : (i.dist !== null ? i.dist + " m" : "—")),
          i.rest !== null ? i.rest + " s" : "—",
          i.velMin !== null ? "≥ " + i.velMin.toFixed(2) + " m/s" : '<span class="mini">未设速度阈值</span>'
        ]));
      });

      return [
        S_cards("结构化课", "共 " + lib.length + " 个模板 · 来自 session_templates / session_items", lib.map(t => ({
          icon: PURPOSE_ICON[t.purpose] || "train",
          title: t.title,
          sub: [t.purpose, t.dur, t.rpe ? "RPE " + t.rpe : null].filter(Boolean).join(" · ") + " · " + t.summary,
          badge: t.count + " 条目", badgeTone: t.count ? "info" : "mute",
          btn: { label: "排到今天", act: "assign", id: t.id }
        })), 2),
        S_table("条目明细", "绝对重量与 %1RM 互斥（数据库 CHECK 强制）",
          ["#", "动作", "组×次", "负荷", "组间", "速度阈值"], rows, 2,
          { note: "同一动作同时填 kg 和 %1RM 会被数据库拒绝——两个口径并存等于两个事实源。" }),
        S_note("边界", "课库只负责<b>复用与下发</b>；排课写到 session_assignments，实际采集在 <b>lab/*</b>，长期对比在 <b>analyze/*</b>。", "", 3)
      ];
    })(), { chips: [dataChip()] });

    page("train/goals", "比赛与目标", "目标赛事与个人最好成绩如何变化？", "TRAIN / 二级", [
      S_metrics([{ label: "目标赛事倒数", value: "28", unit: "天", delta: "12/11 · 场地 10 km", go: "train/plan" },
        { label: "近期 PB", value: "38:42", delta: "10 km · 10/26", go: "analyze/endurance" },
        { label: "数据完整度", value: "93", unit: "%", delta: "28 日有效天 26/28", go: "data/quality" },
        { label: "减量开始", value: "12/08", delta: "Taper · 目标日 TL 78", go: "train/plan" }]),
      S_table("个人最好成绩", "非专有预测器；只记录已发生成绩", ["距离", "成绩", "日期", "来源", "备注"], [
        ["5 km", "18:24", "09/14", "device", "场地"], ["10 km", "38:42", "10/26", "device", "场地"],
        ["半程马拉松", "1:26:10", "05/18", "import", "路跑"], ["马拉松", "—", "—", "—", '<span class="mini">无记录 · 不估算</span>']
      ], 3),
      S_note("成绩预测边界", "不还原任何厂商专有比赛预测器；仅提供<b>已发生成绩趋势</b>与可解释的周期建议。", "warn", 3)
    ], { chips: [dataChip()] });
  })();

  /* 分析 */
  (function () {
    page("analyze", "分析", "长期趋势说明了什么？", "ANALYZE / 维度入口", [
      S_hero({ kicker: "只读区域 · 与「测试」严格分离", title: "选一个维度，只回答一个问题",
        lead: "分析页不提供任何录入控件；所有派生值从指标口径 Registry 引用，不在此重新定义公式。默认 28 日窗口，口径在页首明示。",
        evidence: [
          { label: "维度数", value: "6", detail: "负荷 / 恢复 / 有氧 / VBT / 跳跃 / 报告" },
          { label: "默认窗口", value: "28 日", detail: "可切 7 / 28 / 42 / 90 日" },
          { label: "主口径", value: "EWMA", detail: "ACWR rolling 并列展示差异" }
        ], actions: [{ label: "打开负荷与周期", route: "analyze/load", primary: true }] }),
      S_cards("六个分析维度", "每页一个主视图，不同维度不同屏堆叠", [
        { icon: "chart", title: "负荷与周期", sub: "CTL / ATL / TSB · ACWR 双口径 · TM / TS", route: "analyze/load", value: "进入" },
        { icon: "heart", title: "恢复与睡眠", sub: "RMSSD / lnRMSSD 基线 · TST / WASO / 效率", route: "analyze/recovery", value: "进入" },
        { icon: "bolt", title: "有氧与功率", sub: "功率曲线 · NP / IF / TSS · 区间分布", route: "analyze/endurance", value: "进入" },
        { icon: "lab", title: "VBT 分析", sub: "LVP 回归 · R² · 1RM 估计 · 速度损失", route: "analyze/vbt", value: "进入" },
        { icon: "analyze", title: "跳跃表现", sub: "CMJ / SJ / DJ 对比 · RSI · FVP", route: "analyze/jump", value: "进入" },
        { icon: "download", title: "报告与导出", sub: "周期报告 · 口径清单 · CSV / PDF", route: "analyze/report", value: "进入" }
      ], 3),
      S_note("分析 ↔ 数据看板边界", "<b>analyze/*</b> 是单运动员、长周期、可下钻到原始样本、可切换口径；<b>admin/overview</b> 是多运动员聚合、只读、最多下钻到成员页。看板不显示样本级数据，也不允许改口径。", "info", 3)
    ], { chips: analyzeChips() });

    page("analyze/load", "负荷与周期", "长期 / 短期负荷与风险如何演变？", "ANALYZE / 负荷", [
      S_metrics([
        { label: "CTL 长期负荷", value: fmt(L().ctl, 1), delta: "42 日 EWMA", metricId: "ctl", win: "42 日", src: "device" },
        { label: "ATL 短期负荷", value: fmt(L().atl, 1), delta: "7 日 EWMA", metricId: "atl", win: "7 日", src: "device" },
        { label: "TSB 负荷平衡", value: fmt(L().tsb, 1), delta: "前一日差值口径", metricId: "tsb", win: "日", src: "device" },
        { label: "ACWR (EWMA)", value: fmt(L().ewma, 2), delta: "推荐主口径", metricId: "acwr.ewma", win: "EWMA", src: "device" },
        { label: "ACWR (rolling)", value: L().rolling === null ? "—" : fmt(L().rolling, 2), delta: L().rolling === null ? "不可计算 · 有效天数不足" : "7/28 日 rolling", metricId: "acwr.rolling", win: "7 / 28 日", src: "device", na: L().rolling === null },
        { label: "TM 单调性", value: L().tm === null ? "—" : fmt(L().tm, 2), delta: L().tm === null ? "不可计算 · 有效天数 5/7" : "7 日窗口", metricId: "tm", win: "7 日", src: "device", na: L().tm === null },
        { label: "TS 训练压力", value: L().ts === null ? "—" : fmt(L().ts, 0), delta: L().ts === null ? "不可计算 · TM 不可计算" : "sum(TL,7d) × TM", metricId: "ts", win: "7 日", src: "device", na: L().ts === null },
        { label: "有效天数", value: L().v28 + "/28", delta: "缺测 2 天 · 显示「—」", go: "data/quality" }
      ]),
      S_chart("CTL / ATL / TSB", "28 日 · TL 口径 " + state.params.tl.toUpperCase() + " · 来源 device/import/manual", chartLoadTrend(), 2,
        { drillId: "ctl", legend: [{ name: "CTL 42 日", color: "var(--blue)" }, { name: "ATL 7 日", color: "var(--orange)" }, { name: "TSB", color: "var(--indigo)" }],
          note: "TSB 采用前一日 CTL−ATL 差值口径，避免当日稀释；口径在口径 Sheet 内固定并展示。" }),
      S_chart("ACWR 双口径对照", "rolling 与 EWMA 并列，不单独给「甜蜜区间」结论", { kind: "gauge", items: [
        { name: "EWMA", value: L().ewma, sub: "λ=2/(7+1)、2/(28+1)", color: "var(--accent)" },
        { name: "rolling 7/28", value: L().rolling, sub: "急性窗含于慢性窗", color: "var(--indigo)" }] }, 1,
        { drillId: "acwr.ewma", note: "浅色弧为 0.80–1.30 参考区间；颜色不表示好坏，结论由规则文字给出。" }),
      S_note("数据充分性演示", state.injectMissing
        ? "已<b>注入 2 天缺测</b>（近 7 日内）：7 日有效天 5/7 → <b>TM / TS / ACWR rolling 返回「—」</b>， EWMA 保留数值但标注有效天数不足。缺测不补 0、不插值、不估算。"
        : "点按右侧按钮可<b>注入 2 天缺测</b>，现场验证：有效天数不足时窗口指标返回「不可计算」，而不是 0 或估算值。", state.injectMissing ? "warn" : "info", 2,
        state.injectMissing ? { label: "恢复完整数据", sheet: "toggle-missing" } : { label: "注入缺测（演示）", sheet: "toggle-missing" }),
      S_cards("规则引擎依据", "点按查看输入值 / 阈值 / 版本", Object.keys(A.RULES).map(k => ({ icon: "check", title: k + " · " + A.RULES[k].title, sub: A.RULES[k].input, value: A.RULES[k].action, sheet: "rule", sheetId: k })), 1),
      S_table("近 8 日 daily_load", "每行可回溯公式版本与有效天数", ["日期", "TL", "CTL", "ATL", "TSB", "ACWR EWMA", "ACWR rolling", "TM", "TS", "有效天"], load().slice(-8).reverse().map(r => [
        esc(r.date), r.tl === null ? "—" : fmt(r.tl, 0), fmt(r.ctl, 1), fmt(r.atl, 1), fmt(r.tsb, 1), fmt(r.ewma, 2),
        r.rolling === null ? '<span class="mini">— 不可计算</span>' : fmt(r.rolling, 2),
        r.tm === null ? '<span class="mini">— 不可计算</span>' : fmt(r.tm, 2),
        r.ts === null ? "—" : fmt(r.ts, 0), r.v7 + "/7"
      ]), 3, { note: "计算在原型内真实执行：TL → EWMA CTL/ATL → TSB → ACWR 双口径 → TM/TS。用例 2/3/4/7 可直接核验。" }),
      S_note("分析页边界", "本页<b>只读</b>：不提供录入控件、不显示团队聚合。需要写入进 <b>lab/*</b> 或 <b>data/import</b>；需要团队视图进 <b>教练工作台 · 数据看板</b>。", "", 3)
    ], { chips: analyzeChips(), actions: [{ label: "窗口与口径", sheet: "window" }, { label: "查看周期计划", route: "train/plan", primary: true }] });

    page("analyze/recovery", "恢复与睡眠", "恢复是否偏离个人基线？", "ANALYZE / 恢复", [
      S_metrics([
        { label: "RMSSD", value: "64", unit: "ms", delta: "夜间上下文", metricId: "hrv.rmssd", win: "日", src: "device" },
        { label: "lnRMSSD", value: "4.16", delta: "ln(64) · 可下钻", metricId: "hrv.rmssd", win: "日", src: "device" },
        { label: "28 日基线", value: "60.4", unit: "ms", delta: "± 8.1 ms (SD)", metricId: "hrv.rmssd", win: "28 日", src: "device" },
        { label: "TST 总睡眠", value: "409", unit: "min", delta: "11/13 · 效率 86%", metricId: "sleep.tst", win: "夜", src: "device" },
        { label: "WASO", value: "46", unit: "min", delta: "觉醒 3 次", metricId: "sleep.tst", win: "夜", src: "device" },
        { label: "规律性", value: "—", delta: "不可计算 · 1 夜缺测", metricId: "sleep.tst", win: "7 夜", src: "—", na: true }
      ]),
      S_chart("HRV 趋势与基线", "RMSSD · 绿色带为 28 日基线 ±1 SD · 只在同一测量上下文比较", chartHRV(), 2,
        { drillId: "hrv.rmssd", legend: [{ name: "RMSSD", color: "var(--green)" }, { name: "28 日基线", color: "var(--text-3)" }],
          note: "缺测日为断点并显示「—」；不做插值，不输出与厂商评分等价的黑盒分数。" }),
      S_chart("睡眠分期", "深睡 / 浅睡 / REM / 清醒 · 逐 epoch 判别或授权数据源", chartSleepStack(), 1,
        { drillId: "sleep.tst", legend: [{ name: "深睡", color: "var(--indigo)" }, { name: "浅睡", color: "var(--blue)" }, { name: "REM", color: "var(--green)" }, { name: "清醒", color: "var(--orange)" }] }),
      S_table("近 7 夜可解释维度", "缺测夜所有值为「—」", ["日期", "TST min", "WASO min", "效率", "觉醒", "分期方法", "来源"], A.SLEEP.slice().reverse().map(s => [
        esc(s.date), s.tst === null ? "—" : esc(s.tst), s.waso === null ? "—" : esc(s.waso),
        s.eff === null ? "—" : (s.eff * 100).toFixed(0) + "%", s.awake === null ? "—" : esc(s.awake),
        s.stages ? "Cole-Kripke" : "—", esc(s.src === "missing" ? "缺测" : s.src)
      ]), 3),
      S_note("医学边界", "仅用 actigraphy 时分期精度有限；本页<b>输出可解释维度，不输出医学结论，不用于诊断</b>。不还原 Body Battery / HRV Status / 睡眠评分等专有分数。", "warn", 3)
    ], { chips: [dataChip(), '<button class="chip" data-act="sheet" data-sheet="window">上下文 · ' + (state.params.context === "night" ? "夜间" : "晨起") + '</button>'] });

    page("analyze/endurance", "有氧与功率", "有氧能力与强度分布是否改善？", "ANALYZE / 有氧", [
      S_metrics([
        { label: "FTP", value: "268", unit: "W", delta: "档案值 · 可编辑", go: "data/profile" },
        { label: "NP 归一化功率", value: "241", unit: "W", delta: "30 s 滚动 4 次方均值", metricId: "tl.tss", win: "单次", src: "device" },
        { label: "IF", value: "0.90", delta: "NP / FTP", metricId: "tl.tss", win: "单次", src: "device" },
        { label: "TSS", value: "138", delta: "11/10 · 阈值间歇", metricId: "tl.tss", win: "单次", src: "device" }
      ]),
      S_chart("功率曲线", "各时长最佳功率 · 28 日窗口", chartPower(), 2, { drillId: "tl.tss", legend: [{ name: "最佳功率 W", color: "var(--accent)" }] }),
      S_chart("强度区间时间分布", "分钟数 · HR 区间按最大心率百分比", chartZoneStack(), 1,
        { legend: [{ name: "Z1", color: "var(--green)" }, { name: "Z2", color: "var(--blue)" }, { name: "Z3", color: "var(--indigo)" }, { name: "Z4", color: "var(--orange)" }, { name: "Z5", color: "var(--red)" }] }),
      S_table("区间设置", "阈值来自个人档案，可编辑并留版本", ["区间", "定义", "本周分钟", "占比"], [
        ["Z1 恢复", "低于 68% HRmax", "186", "31%"], ["Z2 有氧", "68–79% HRmax", "242", "40%"],
        ["Z3 节奏", "80–87% HRmax", "96", "16%"], ["Z4 阈值", "88–94% HRmax", "58", "10%"],
        ["Z5 VO₂", "高于 94% HRmax", "21", "3%"]
      ], 3),
      S_note("专有指标边界", "本页使用公开定义的 NP / IF / TSS / 功率曲线与可编辑区间；<b>不还原 Training Effect、训练负荷重点、耐力分数等专有评分</b>。", "warn", 3)
    ], { chips: analyzeChips() });

    page("analyze/vbt", "VBT 分析", "负荷-速度关系与 1RM 怎么变？", "ANALYZE / VBT", (function () {
      if (!state.dbLive) {
        return [
          S_metrics([
            { label: "最佳 MPV", value: "0.98", unit: "m/s", delta: "40 kg · 后蹲", metricId: "vbt.mcv", win: "每次重复", src: "import" },
            { label: "组内速度损失", value: "24.3", unit: "%", delta: "120 kg · 阈值 20% 可配置", metricId: "vbt.vl", win: "每组", src: "import" },
            { label: "LVP 回归 R²", value: fmt(LVP.r2, 3), delta: "V = a·kg + b · 5 组负荷", metricId: "vbt.lvp", win: "一次测试", src: "import" },
            { label: "1RM 估计", value: oneRM() === null ? "—" : fmt(oneRM(), 1), unit: oneRM() === null ? "" : "kg", delta: oneRM() === null ? "不可计算 · V1RM 未标定" : "V1RM 0.30 m/s · 已标定", metricId: "vbt.lvp", win: "一次测试", src: "import", na: oneRM() === null }
          ]),
          S_chart("负荷-速度剖面 LVP", "散点为各组 MPV；直线为线性回归；R² 与 1RM 估计可下钻", { kind: "scatter", points: lvpPts, reg: LVP, oneRM: oneRM() }, 2,
            { drillId: "vbt.lvp", note: "V1RM 阈值与 LVP 的 R² 门槛均为配置项；未标定前 1RM 显示「—」，不猜测系数。" }),
          S_chart("速度损失 VL% 分布", "10 / 20 / 30% 仅作可配置阈值，不设为事实", chartVL(), 1, { drillId: "vbt.vl" }),
          S_table("本次 VBT 测试各组", "source=import · 与 manual 录入互斥筛选", ["负荷 kg", "MPV m/s", "MCV m/s", "PV m/s", "VL %", "功率 W（近似）", "口径"], A.VBT_SETS.map(s => [
            esc(s.load), s.mpv.toFixed(2), s.mcv.toFixed(2), s.pv.toFixed(2), s.vl.toFixed(1), esc(s.p), "P ≈ m·g·v"
          ]), 3, { note: "功率使用等速近似口径，已在结果标注；精确式 P=F·v 需加速度样本。" }),
          S_note(oneRM() === null ? "1RM 当前不可计算" : "1RM 已计算", oneRM() === null
            ? "V1RM 速度阈值属于<b>需真机标定</b>的参数，配置留空时相关指标返回「不可计算」，不硬编码猜测值。可在 <b>lab/calibration</b> 写入标定值后即时看到结果变化。"
            : "已使用演示标定值 V1RM = 0.30 m/s，结果 = (0.30 − b) / a = <b>" + fmt(oneRM(), 1) + " kg</b>。", oneRM() === null ? "warn" : "info", 3,
            { label: oneRM() === null ? "前往标定" : "查看标定配置", route: "lab/calibration" })
        ];
      }

      // 真实库：全部取服务端值，LVP 回归来自 arc_vbt_profile()
      const sets = (A.VBT_SETS || []).filter(s => s.load !== null && s.mpv !== null);
      const pf = A.VBT_PROFILE;
      if (!sets.length) {
        return [
          S_note("还没有 VBT 采集记录", "这个账号下没有任何同时具备<b>负荷</b>与<b>平均推进速度</b>的组数据。" +
            "VBT 分析必须基于真实采集——这里不预填示例曲线，也不凭重量反推速度。", "info", 3),
          S_cards("下一步", "采集一次就能出结果", [
            { icon: "bolt", title: "去做 VBT 采集", sub: "lab/vbt · IMU 拉取或手动填入", value: "进入", route: "lab/vbt" },
            { icon: "list", title: "查看测试历史", sub: "lab/history · 与同条件对比", value: "进入", route: "lab/history" }
          ], 2)
        ];
      }

      const best = sets.slice().sort((a, b) => b.mpv - a.mpv)[0];
      const vlMax = sets.reduce((m, s) => (s.vl !== null && s.vl > m ? s.vl : m), 0);
      const reg = pf && pf.ok ? { a: Number(pf.slope), b: Number(pf.intercept), r2: Number(pf.r2) } : null;
      const oneRMv = pf && pf.ok && pf.load_1rm != null ? Number(pf.load_1rm) : null;
      const pts = sets.map(s => ({ x: s.load, y: s.mpv }));
      const exName = (A.VBT_SESSION && A.VBT_SESSION.exercise) || "本次测试";

      const out = [];
      out.push(S_metrics([
        { label: "最佳 MPV", value: fmt(best.mpv, 2), unit: "m/s", delta: best.load + " kg · " + exName, metricId: "vbt.mcv", win: "每次重复", src: "import" },
        { label: "组内速度损失", value: vlMax ? fmt(vlMax, 1) : "—", unit: vlMax ? "%" : "", delta: "最大组 · 阈值 " + ((A.RULE_PACK && A.RULE_PACK.payload.vbt && A.RULE_PACK.payload.vbt.vl_warn_pct) || 20) + "%", metricId: "vbt.vl", win: "每组", src: "import" },
        { label: "LVP 回归 R²", value: reg ? fmt(reg.r2, 3) : "—", delta: reg ? sets.length + " 个负荷点 · V = a·kg + b" : "拟合未成立", metricId: "vbt.lvp", win: "一次测试", src: "import", na: !reg },
        { label: "1RM 估计", value: oneRMv === null ? "—" : fmt(oneRMv, 1), unit: oneRMv === null ? "" : "kg", delta: oneRMv === null ? "不可计算 · 数据不足或速度不随负荷下降" : "V1RM " + ((A.RULE_PACK && A.RULE_PACK.payload.vbt && A.RULE_PACK.payload.vbt.velocity_1rm) || 0.3) + " m/s · 服务端外推", metricId: "vbt.lvp", win: "一次测试", src: "import", na: oneRMv === null }
      ]));

      out.push(reg
        ? S_chart("负荷-速度剖面 LVP", "散点为各组 MPV；直线由服务端 regr_slope 拟合", { kind: "scatter", points: pts, reg: reg, oneRM: oneRMv || 0 }, 2,
            { drillId: "vbt.lvp", note: "1RM 为外推值，超出实测负荷上限时仅供参考；斜率 ≥ 0 时直接判为不可用，不出数。" })
        : S_note("LVP 拟合未成立", (pf && pf.reason) || "负荷点不足或速度与负荷不呈负相关，因此不输出 1RM 估算。", "warn", 2));

      out.push(S_chart("速度损失 VL% 分布", "每组末次相对最快一次的速度下降", {
        kind: "bars", labels: sets.map(s => s.load + "kg"), values: sets.map(s => s.vl),
        color: "var(--orange)", min: 0, max: Math.max(30, Math.ceil((vlMax || 0) * 1.3))
      }, 1, { drillId: "vbt.vl" }));

      out.push(S_table("本次 VBT 各组", "source 与 quality 均来自原始记录", ["负荷 kg", "MPV m/s", "MCV m/s", "PV m/s", "VL %", "功率 W", "口径"], sets.map(s => [
        esc(s.load), fmt(s.mpv, 2), fmt(s.mcv, 2), fmt(s.pv, 2), fmt(s.vl, 1), s.p === null ? "—" : esc(Math.round(s.p)), "P = F·v（服务端）"
      ]), 3, { note: "功率与 VL 由数据库触发器计算后落库，前端不重算——避免两处公式各算一遍。" }));

      out.push(S_note(oneRMv === null ? "1RM 当前不可计算" : "1RM 已计算",
        oneRMv === null
          ? "1RM 需要「速度随负荷单调下降」且至少 3 个负荷点。条件不满足时返回「不可计算」，不用经验系数硬凑。"
          : "V1RM " + ((A.RULE_PACK && A.RULE_PACK.payload.vbt && A.RULE_PACK.payload.vbt.velocity_1rm) || 0.3) + " m/s 来自生效规则版本；结果 = (V1RM − b) / a = <b>" + fmt(oneRMv, 1) + " kg</b>（外推）。",
        oneRMv === null ? "warn" : "info", 3, { label: "查看规则版本", route: "admin/rules" }));

      return out;
    })(), { chips: [dataChip()], actions: [{ label: "查看采集页", route: "lab/vbt", primary: true }] });

    page("analyze/jump", "跳跃表现", "爆发力与左右对称性趋势如何？", "ANALYZE / 跳跃", (function () {
      if (!state.dbLive) {
        return [
          S_metrics([
            { label: "CMJ 高度", value: cm(jumpH(0.512)), unit: "cm", delta: "11/13 · 视频法 240 fps", metricId: "jump.height", win: "每次", src: "import" },
            { label: "SJ 高度", value: cm(jumpH(0.468)), unit: "cm", delta: "同场次 · 木地板", metricId: "jump.height", win: "每次", src: "import" },
            { label: "DJ RSI", value: fmt(jumpRSI(0.398, 0.184), 2), delta: "h / t_contact · 口径固定", metricId: "jump.rsi", win: "每次", src: "import" },
            { label: "PPO / FVP", value: "—", delta: "不可计算 · 系数未标定", metricId: "jump.ppo", win: "每次", src: "—", na: true }
          ]),
          S_chart("跳跃高度趋势", "CMJ / SJ / DJ · 仅同条件可比", chartJump(), 2, { drillId: "jump.height", legend: [{ name: "跳跃高度 cm", color: "var(--indigo)" }] }),
          S_kv("CMJ–SJ 对比", "同场次齐备才可计算", [
            ["CMJ", "<b>" + cm(jumpH(0.512)) + " cm</b> · t_f 0.512 s"],
            ["SJ", "<b>" + cm(jumpH(0.468)) + " cm</b> · t_f 0.468 s"],
            ["差值", "<b>" + (jumpH(0.512) - jumpH(0.468)).toFixed(3) + " m</b> · 牵张-缩短循环利用率的可解释输入"],
            ["条件", "同场次 · 木地板 · 室内 · 09:10（一致，可比）"],
            ["PPO / FVP", '<b>—</b> · Sayers / Samozino 系数须从配置读取，未标定不输出估算值']
          ], 1),
          S_table("测试记录", "fps 必须随视频法数据保存", ["日期", "类型", "腾空 s", "接触 s", "高度 cm", "RSI", "方法", "fps", "条件"], A.JUMPS.map(j => [
            esc(j.date), esc(j.type), j.tf.toFixed(3), j.tc === null ? "—" : j.tc.toFixed(3), cm(jumpH(j.tf)),
            j.tc === null ? "—" : fmt(jumpRSI(j.tf, j.tc), 2), esc(j.method), j.fps === null ? "—" : esc(j.fps), esc(j.cond)
          ]), 3),
          S_note("同条件对比规则", "地面、鞋、测试时间不一致时，对比开关<b>置灰并说明原因</b>；不跨条件合并数据。左右不对称与最优 FVP 需双侧设备或标定后才计算。", "warn", 3)
        ];
      }

      const jumps = A.JUMPS || [];
      if (!jumps.length) {
        return [
          S_note("还没有跳跃测试记录", "库里的 <b>jump_tests</b> 是空的。高度由腾空时间算（h = g·t²/8），" +
            "RSI 由高度与接触时间算——没有腾空时间就没有高度，此处不填示例值。", "info", 3),
          S_cards("下一步", "一次 CMJ 就能出结果", [
            { icon: "bolt", title: "新建跳跃测试", sub: "lab/jump · CMJ / SJ / DJ", value: "进入", route: "lab/jump" },
            { icon: "list", title: "测试历史", sub: "lab/history · 同条件对比", value: "进入", route: "lab/history" }
          ], 2)
        ];
      }

      // 高度与 RSI 优先用服务端落库值；只在缺失时现场补算，并在表格里标注来源
      const hOf = j => (j.height !== null && j.height !== undefined) ? j.height : (j.tf === null ? null : jumpH(j.tf) * 100);
      const rsiOf = j => (j.rsi !== null && j.rsi !== undefined) ? j.rsi : (j.tc === null || j.tf === null ? null : jumpRSI(j.tf, j.tc));
      const byType = t => jumps.filter(j => j.type === t)[0] || null;
      const cmj = byType("CMJ"), sj = byType("SJ"), dj = byType("DJ");
      const cmjH = cmj ? hOf(cmj) : null, sjH = sj ? hOf(sj) : null, djR = dj ? rsiOf(dj) : null;
      const gap = (cmjH !== null && sjH !== null) ? cmjH - sjH : null;

      const out = [];
      out.push(S_metrics([
        { label: "CMJ 高度", value: cmjH === null ? "—" : fmt(cmjH, 1), unit: cmjH === null ? "" : "cm", delta: cmj ? cmj.date + " · " + cmj.method : "无记录", metricId: "jump.height", win: "每次", src: "import", na: cmjH === null },
        { label: "SJ 高度", value: sjH === null ? "—" : fmt(sjH, 1), unit: sjH === null ? "" : "cm", delta: sj ? sj.date + " · 无反向动作" : "无记录", metricId: "jump.height", win: "每次", src: "import", na: sjH === null },
        { label: "DJ RSI", value: djR === null ? "—" : fmt(djR, 2), delta: dj ? dj.date + " · h / t_c" : "需要接触时间才可算", metricId: "jump.rsi", win: "每次", src: "import", na: djR === null },
        { label: "PPO / FVP", value: "—", delta: "不可计算 · 需体重与标定系数", metricId: "jump.ppo", win: "每次", src: "—", na: true }
      ]));

      out.push(S_chart("跳跃高度趋势", "只画有腾空时间的记录 · 仅同条件可比", chartJump(), 2,
        { drillId: "jump.height", legend: [{ name: "跳跃高度 cm", color: "var(--indigo)" }] }));

      out.push(S_kv("CMJ–SJ 对比", "两个类型都有记录才给差值", [
        ["CMJ", cmjH === null ? "<b>—</b> · 无记录" : "<b>" + fmt(cmjH, 1) + " cm</b> · " + cmj.date],
        ["SJ", sjH === null ? "<b>—</b> · 无记录" : "<b>" + fmt(sjH, 1) + " cm</b> · " + sj.date],
        ["差值", gap === null ? "<b>—</b> · 缺一类记录，不估算" : "<b>" + fmt(gap, 1) + " cm</b> · 牵张-缩短循环的可解释输入"],
        ["可比性", (cmj && sj && cmj.date === sj.date) ? "同日同场次（可比）" : "非同场次，差值仅供参考"],
        ["PPO / FVP", "<b>—</b> · Sayers / Samozino 系数须从配置读取，未标定不输出估算值"]
      ], 1));

      out.push(S_table("测试记录", "高度与 RSI 优先取库内计算值，前端仅补算缺失项",
        ["日期", "类型", "腾空 s", "接触 s", "高度 cm", "RSI", "方法", "fps", "口径"],
        jumps.map(j => [
          esc(j.date), esc(j.type),
          j.tf === null ? "—" : j.tf.toFixed(3),
          j.tc === null ? "—" : j.tc.toFixed(3),
          hOf(j) === null ? "—" : fmt(hOf(j), 1),
          rsiOf(j) === null ? "—" : fmt(rsiOf(j), 2),
          esc(j.method), j.fps === null ? "—" : esc(j.fps),
          j.height !== null && j.height !== undefined ? "服务端" : "前端补算"
        ]), 3, { note: "「前端补算」表示该条落库时没有高度值（历史数据或导入缺失），按 h = g·t²/8 现场补算并如实标注来源。" }));

      out.push(S_note("同条件对比规则", "地面、鞋、测试时间不一致时，对比<b>不成立</b>；不跨条件合并数据。左右不对称与最优 FVP 需双侧设备或标定后才计算。", "warn", 3));
      return out;
    })(), { chips: [dataChip()], actions: [{ label: "新建跳跃测试", route: "lab/jump", primary: true }] });

    page("analyze/report", "报告与导出", "如何把结论带走？", "ANALYZE / 报告", (function () {
      const LIVE = state.dbLive;
      const nS = (A.SESSIONS || []).length, nJ = (A.JUMPS || []).length, nB = (A.PLAN_BLOCKS || []).length;
      const missing = (A.SRV || []).filter(d => d.tl === null).length;

      if (!LIVE) {
        return [
          S_cards("周期报告", "导出内容附带口径清单", [
            { icon: "download", title: "2026-11 月度负荷报告", sub: "28 日 · CTL/ATL/TSB · ACWR 双口径 · 规则依据", value: "CSV / PDF", sheet: "confirm", sheetId: "导出报告" },
            { icon: "download", title: "VBT / 跳跃测试汇总", sub: "LVP 回归 · R² · 同条件对比 · 测试条件备注", value: "CSV", sheet: "confirm", sheetId: "导出测试汇总" },
            { icon: "download", title: "数据完整度报告", sub: "source / quality_flag / 缺测日历 / 不可计算清单", value: "CSV", route: "data/quality" }
          ], 2),
          S_table("随报告附带的口径清单", "从 metric-registry 自动生成，不手写第二套公式", ["metric_id", "简称", "窗口", "版本", "证据"], Object.keys(A.METRICS).slice(0, 10).map(k => [
            esc(k), esc(A.METRICS[k].short), esc(A.METRICS[k].window), esc(A.METRICS[k].version), esc(A.METRICS[k].evidence)
          ]), 3),
          S_note("导出与权限", "运动员可导出本人数据；教练可导出所辖成员；科研角色只读导出；<b>Observer 无导出权</b>。所有导出写入审计日志。", "", 3)
        ];
      }

      const line = (kind, label, sub) =>
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--separator)">' +
        '<div><div style="font-weight:600">' + esc(label) + '</div>' +
        '<div style="font-size:12px;color:var(--text-2);margin-top:2px">' + esc(sub) + '</div></div>' +
        '<button class="btn sm" data-act="download-csv" data-kind="' + kind + '">下载 CSV</button></div>';

      return [
        S_note("导出的是<b>当前视图里的真实数据</b>",
          "每一份 CSV 都从本页正在渲染的数据生成：该空的地方是空单元格，不会被填成 0；行数为 0 时直接拒绝导出，" +
          "不会给你一个只有表头的空文件。", "info", 3),
        {
          type: "note", tone: "", span: 2, title: "可导出的四份文件",
          body: line("sessions", "训练记录", "日期 / 项目 / 时长 / 负荷 TL / 方法 / 来源 · " + nS + " 条") +
                line("metrics", "每日指标", "28 日 TL / CTL / ATL / TSB / ACWR 双口径 / TM / TS · 缺测留空 " + missing + " 天") +
                line("jumps", "跳跃测试", "腾空 / 接触 / 高度 / RSI / 方法 / fps · " + nJ + " 条") +
                line("plan", "周期计划", "阶段 / 区间 / 目标周 TL / 实际周 TL / 状态 · " + nB + " 个周期块")
        },
        S_kv("导出边界", "能导出什么取决于你被允许看到什么", [
          ["权限", "导出走 <b>RLS</b>：运动员只能导出本人，教练限所辖队伍，只读观察者无导出按钮"],
          ["不做的事", "<b>不生成 PDF 报告</b>。版式化报告需要服务端渲染，当前未部署 Edge Function，硬凑一个前端 PDF 会失真"],
          ["完整备份", "设置 → 数据源面板 → <b>导出我的数据</b> 会导出 JSON（含 10 张表），比 CSV 更全"],
          ["口径", "随报告附带的 metric_id 与公式见 <b>数据 · 指标口径 Registry</b>"]
        ], 1),
        S_note("为什么没有 PDF / 分享链接",
          "PDF 排版与分享链接需要服务端渲染与对象存储签名 URL，属于外部依赖（Supabase Edge Function 或自建服务）。" +
          "在它到位之前，CSV 是唯一能保证「导出的就是库里的」的形式。", "warn", 3)
      ];
    })(), { chips: [dataChip()] });
  })();

  /* 测试 */
  (function () {
    page("lab", "测试", "现在做一次测量，结果是多少？", "LAB / 写入口", [
      S_hero({ kicker: "写入区域 · 与「分析」严格分离", title: "选一个协议，完成一次测量",
        lead: "测试页负责采集与即时反馈；保存后停留在原地，不打断连续测试。长期趋势与对比请进分析页。",
        evidence: [
          { label: "测试能力域", value: "30+", detail: "跳跃 / VBT / 冲刺 / 变向 / 活动度 / 问卷" },
          { label: "录入通道", value: "3", detail: "视频帧标记 / IMU / 手动填入" },
          { label: "来源规则", value: "互斥", detail: "import 与 manual 不合并计算" }
        ], actions: [{ label: "＋ 新建测试", sheet: "newtest", primary: true }] }),
      S_metrics([
        { label: "今日测试", value: "3", unit: "次", delta: "CMJ / SJ / DJ", go: "lab/history" },
        { label: "IMU 采样率", value: "200", unit: "Hz", delta: "imu-001 · 已登记", go: "data/devices" },
        { label: "视频帧率", value: "240", unit: "fps", delta: "必须随数据保存", go: "lab/calibration" },
        { label: "当前来源", value: state.demoSource === "import" ? "import" : "manual", delta: "与另一来源互斥筛选", go: "lab/vbt" }
      ]),
      S_protocols("测试协议", "对应 My Jump Lab 能力域，按公开方法独立实现", 2),
      S_cards("最近测试", "点按进入历史与同条件对比", A.JUMPS.slice(0, 4).map(j => ({ icon: "bolt", title: j.type + " · " + j.date, sub: j.method + " · " + j.cond, value: cm(jumpH(j.tf)) + " cm", route: "lab/history" })), 1),
      S_note("测试 ↔ 分析边界", "<b>lab/*</b> 采集与写入、实时反馈、设备/录入通道；<b>analyze/*</b> 只读再计算与对比。测试页不显示 90 日趋势，分析页不提供录入控件。", "info", 3)
    ], { chips: [dataChip()], actions: [{ label: "IMU 拉取", sheet: "imu" }, { label: "手动录入", sheet: "manual" }] });

    page("lab/vbt", "VBT 采集", "这一组每次重复的速度是多少？", "LAB / VBT", [
      S_metrics([
        { label: "当前组", value: "80", unit: "kg", delta: "后蹲 · 第 3 组", go: "lab/history" },
        { label: "最佳 MPV", value: "0.72", unit: "m/s", delta: "R1 · 本次", metricId: "vbt.mcv", win: "每次重复", src: "import" },
        { label: "末次 MPV", value: "0.55", unit: "m/s", delta: "R6 · 本次", metricId: "vbt.mcv", win: "每次重复", src: "import" },
        { label: "速度损失 VL%", value: "23.6", unit: "%", delta: "(0.72−0.55)/0.72 · 阈值 20% 可配置", metricId: "vbt.vl", win: "每组", src: "import" }
      ]),
      S_chart("每次重复速度", "IMU 实时流 · 200 Hz · 去重力→低通→积分→ZUPT→切分", chartRepVelocity(), 2,
        { drillId: "vbt.mcv", legend: [{ name: "MPV m/s", color: "var(--accent)" }], note: "滤波截止与 ZUPT 阈值未标定前，相关指标显示「—」。" }),
      S_cards("数据源（互斥）", "切换来源后派生指标一致，source 不影响计算", [
        { icon: "bolt", title: "IMU 实时流", sub: "imu-001 · BLE / CSV 通知 · 200 Hz", value: "订阅中", route: "data/devices" },
        { icon: "database", title: "从 IMU 拉取采样数据", sub: "CSV / JSON 预览与字段映射 · source=import", value: "打开", sheet: "imu" },
        { icon: "plus", title: "手动填入", sub: "exercise / load_kg / rep_index / mpv / vl%", value: "打开", sheet: "manual" }
      ], 1),
      S_flow("IMU 处理链", "每一步中间结果可持久化、可下钻", [
        { t: "静止段估计重力向量", d: "坐标对齐与去重力" },
        { t: "低通滤波", d: "截止频率由配置标定，留空即未标定" },
        { t: "积分得速度", d: "ZUPT 消除漂移，静止段速度回到 0" },
        { t: "速度阈值切分重复", d: "输出 MCV / MPV / PV" },
        { t: "组内 VL% 与 LVP 回归", d: "记录 R²；V1RM 未标定时 1RM 不输出" }
      ], 2),
      S_note("双通道互斥规则", "同一组数据分别用 import 与 manual 录入时，<b>派生指标完全一致</b>，因为 source 只用于筛选、不参与计算；两种来源在筛选时互斥，绝不合并。", "warn", 1)
    ], { chips: [dataChip(), '<button class="chip" data-act="sheet" data-sheet="window">来源 · ' + state.demoSource + '</button>'], actions: [{ label: "从 IMU 拉取", sheet: "imu", primary: true }, { label: "手动填入", sheet: "manual" }] });

    page("lab/jump", "跳跃采集", "这次跳多高、RSI 多少？", "LAB / 跳跃", [
      S_metrics([
        { label: "CMJ 高度", value: cm(jumpH(0.512)), unit: "cm", delta: "h = g·t_f²/8", metricId: "jump.height", win: "每次", src: "import" },
        { label: "腾空时间", value: "0.512", unit: "s", delta: "视频帧差 / 240 fps", metricId: "jump.height", win: "每次", src: "import" },
        { label: "DJ RSI", value: fmt(jumpRSI(0.398, 0.184), 2), delta: "h / t_contact", metricId: "jump.rsi", win: "每次", src: "import" },
        { label: "峰值功率", value: "—", delta: "不可计算 · 系数未标定", metricId: "jump.ppo", win: "每次", src: "—", na: true }
      ]),
      S_protocols("跳跃协议", "CMJ / SJ / 摆臂 CMJ / DJ / 连续跳 / 单腿", 1),
      S_flow("三种录入通道", "任一通道都写入 source 与 quality_flag", [
        { t: "视频帧标记", d: "登记 fps → 标记起跳帧 / 落地帧 → t_f = Δframe / fps；fps 缺失则不可计算" },
        { t: "IMU 冲击信号", d: "切分腾空 / 接触段，输出 t_f 与 t_c" },
        { t: "手动填入", d: "填写 t_f、t_c 与测试条件；右侧按公式实时预览派生值" }
      ], 2),
      S_table("今日跳跃记录", "h = 9.81·t_f²/8 · g=9.81 m/s²", ["类型", "t_f s", "t_c s", "高度 cm", "RSI", "方法", "fps", "条件"], A.JUMPS.slice(0, 4).map(j => [
        esc(j.type), j.tf.toFixed(3), j.tc === null ? "—" : j.tc.toFixed(3), cm(jumpH(j.tf)),
        j.tc === null ? "—" : fmt(jumpRSI(j.tf, j.tc), 2), esc(j.method), j.fps === null ? "—" : esc(j.fps), esc(j.cond)
      ]), 3),
      S_note("用例 1 可核验", "t_f = 0.500 s → h = 9.81 × 0.25 / 8 = <b>0.30656 m ≈ 30.7 cm</b>。原型内的「手动填入」Sheet 会按此公式实时计算。", "info", 3, { label: "打开手动填入", sheet: "manual" })
    ], { chips: [dataChip()], actions: [{ label: "＋ 新建测试", sheet: "newtest", primary: true }] });

    page("lab/sprint", "冲刺与变向", "直线 / 变向 / 水平力学表现如何？", "LAB / 冲刺", [
      S_metrics([{ label: "10 m 分段", value: "1.68", unit: "s", delta: "直线冲刺 · 分段计时" },
        { label: "5-0-5", value: "2.41", unit: "s", delta: "左右差 3.2%" },
        { label: "触地时间", value: "0.142", unit: "s", delta: "高速摄像 / IMU" },
        { label: "水平 FVP", value: "—", delta: "不可计算 · 需多次加载测试", na: true }]),
      S_cards("变向测试", "5-0-5 / 5+5 / V-Cut / Illinois", [
        { icon: "bolt", title: "5-0-5 变向", sub: "左右侧分别计时 · 不对称率", value: "2.41 s" },
        { icon: "bolt", title: "V-Cut", sub: "连续变向 · 45° 切角", value: "7.82 s" },
        { icon: "bolt", title: "Illinois", sub: "敏捷跑 · 分段计时", value: "16.4 s" },
        { icon: "analyze", title: "水平力-速剖面", sub: "Samozino 方法 · 需多次加载冲刺", value: "—", na: true }
      ], 2),
      S_flow("跑步力学能力清单", "对应 My Jump Lab 冲刺域", [
        { t: "分段直线冲刺", d: "10 m / 20 m / 30 m 分段计时，输出速度曲线" },
        { t: "触地 / 腾空时间", d: "duty factor 与腿部刚度由时间推导" },
        { t: "双腿不对称", d: "左右触地时间差、旋前/旋后、对侧骨盆下沉" },
        { t: "减速能力与弯道冲刺", d: "独立协议，结果写入测试历史" }
      ], 1),
      S_note("口径声明", "冲刺与变向指标按公开方法独立实现；<b>不还原任何 App 内部实现或专有计算</b>。未标定参数返回「—」。", "", 3)
    ], { chips: [dataChip()] });

    page("lab/screen", "活动度与问卷", "关节活动范围与主观状态如何？", "LAB / 筛查", [
      S_metrics([{ label: "踝背屈 ROM", value: "38", unit: "°", delta: "左 38° / 右 35°" },
        { label: "Wellness 问卷", value: "4", unit: "项", delta: "睡眠 / 疲劳 / 压力 / 酸痛" },
        { label: "Nordic 断点角", value: "—", delta: "不可计算 · 需视频标记", na: true },
        { label: "力-时间曲线", value: "已采", delta: "设备加速度计原始曲线" }]),
      S_cards("活动度评估", "六项 ROM · 逐项记录左右侧", [
        { icon: "check", title: "踝关节背屈", sub: "负重弓步测试", value: "38° / 35°" },
        { icon: "check", title: "颈部屈 / 伸", sub: "角度计", value: "52° / 61°" },
        { icon: "check", title: "髋关节屈 / 内旋", sub: "仰卧 / 坐位", value: "112° / 38°" },
        { icon: "check", title: "肩关节屈 / 内旋", sub: "仰卧", value: "168° / 62°" }
      ], 2),
      S_cards("Wellness 问卷", "self_reported · 主观数据单独标注", [
        { icon: "heart", title: "睡眠质量", sub: "0–10 自评", value: "7" },
        { icon: "heart", title: "疲劳", sub: "0–10 自评", value: "4" },
        { icon: "heart", title: "压力", sub: "0–10 自评", value: "3" },
        { icon: "heart", title: "肌肉酸痛", sub: "0–10 自评", value: "5" }
      ], 1),
      S_note("主观数据边界", "问卷结果标记 <b>self_reported</b>，不与设备测量合并计算；腘绳肌断点角与扭矩需视频标记后才可计算。", "warn", 3)
    ], { chips: [dataChip()] });

    page("lab/history", "测试历史与对比", "与上次同条件比是进步还是退步？", "LAB / 历史", [
      S_metrics([{ label: "累计测试", value: "128", unit: "次", delta: "无限历史 · 云端备份" },
        { label: "CMJ 最好", value: cm(jumpH(0.512)), unit: "cm", delta: "11/13" },
        { label: "DJ RSI 最好", value: fmt(jumpRSI(0.398, 0.184), 2), delta: "11/13" },
        { label: "同条件可比", value: "3", unit: "组", delta: "地面 / 鞋 / 时段一致" }]),
      S_table("全部测试记录", "CSV 导出供研究与复核", ["日期", "类型", "高度 cm", "RSI", "方法", "fps", "条件", "来源"], A.JUMPS.map(j => [
        esc(j.date), esc(j.type), cm(jumpH(j.tf)), j.tc === null ? "—" : fmt(jumpRSI(j.tf, j.tc), 2),
        esc(j.method), j.fps === null ? "—" : esc(j.fps), esc(j.cond), esc(j.method === "manual" ? "manual" : "import")
      ]), 3),
      S_note("对比规则", "条件不一致时对比开关置灰并说明原因；<b>不跨条件合并数据</b>。左右不对称需双侧设备数据齐备才计算。", "warn", 2, { label: "CSV 导出", sheet: "confirm", sheetId: "导出测试历史" }),
      S_cards("关联页面", "测试 ↔ 分析边界", [
        { icon: "analyze", title: "跳跃表现趋势", sub: "analyze/jump · 只读", route: "analyze/jump" },
        { icon: "analyze", title: "VBT 分析", sub: "analyze/vbt · 只读", route: "analyze/vbt" },
        { icon: "sliders", title: "标定与动作库", sub: "lab/calibration · 参数版本", route: "lab/calibration" }
      ], 1)
    ], { chips: [dataChip()] });

    page("lab/calibration", "标定与动作库", "计算参数用的是哪一套？", "LAB / 标定", [
      S_metrics([{ label: "已标定参数", value: state.calibrated ? "5 / 6" : "4 / 6", delta: "变更留版本与时间戳" },
        { label: "V1RM（后蹲）", value: state.calibrated ? "0.30" : "—", unit: state.calibrated ? "m/s" : "", delta: state.calibrated ? "演示标定值" : "未标定 → 1RM 不可计算", na: !state.calibrated },
        { label: "IMU 采样率", value: "200", unit: "Hz", delta: "imu-001 · 已登记" },
        { label: "LVP R² 门槛", value: "0.95", delta: "配置项 · 低于门槛不输出 1RM" }]),
      S_table("需真机标定的参数", "未标定一律留空，不填猜测默认值", ["参数", "当前值", "影响指标", "状态"], [
        ["IMU 低通截止频率", "—", "vbt.mcv / mpv / pv", '<span class="mini">未标定</span>'],
        ["ZUPT 阈值", "—", "积分速度漂移", '<span class="mini">未标定</span>'],
        ["V1RM 后蹲", state.calibrated ? "0.30 m/s" : "—", "vbt.lvp / 1RM", state.calibrated ? "已标定（演示）" : '<span class="mini">未标定 → 1RM「—」</span>'],
        ["LVP 最小 R²", "0.95", "1RM 是否输出", "已配置"],
        ["视频帧率 fps", "240", "jump.height（视频法）", "已配置"],
        ["PPO / FVP 系数", "—", "jump.ppo / FVP", '<span class="mini">未标定 → 不输出估算值</span>']
      ], 3),
      S_flow("标定与版本留痕", "P8 阶段逐项真机标定", [
        { t: "真机采集静止段与已知负荷", d: "建立重力向量、滤波截止与 ZUPT 阈值的实测依据" },
        { t: "写入配置并记录版本", d: "参数、时间、操作者写入 rule_definition 与审计日志" },
        { t: "回归用例复跑", d: "用例 5（ZUPT 静止段回 0）与用例 1（跳跃高度）必须复现" },
        { t: "灰度与回滚", d: "在教练工作台 · 规则与口径版本管理生效范围" }
      ], 2),
      S_note(state.calibrated ? "标定已写入（演示）" : "演示：写入 V1RM 标定值", state.calibrated
        ? "V1RM = 0.30 m/s 已生效，<b>analyze/vbt</b> 的 1RM 估计现在可计算。真实产品中该值必须来自真机标定，不得猜测。"
        : "点按按钮写入演示标定值 <b>V1RM = 0.30 m/s</b>，然后到 <b>analyze/vbt</b> 观察 1RM 从「—」变为计算结果——这是「未标定不输出估算值」规则的可交互验证。", state.calibrated ? "info" : "warn", 1,
        { label: state.calibrated ? "查看 VBT 分析" : "写入标定值（演示）", route: state.calibrated ? "analyze/vbt" : undefined, sheet: state.calibrated ? undefined : "calibrate" })
    ], { chips: [dataChip()] });
  })();

  /* 数据 */
  (function () {
    page("data", "数据", "数据从哪来、可信吗、缺了什么？", "DATA / 概览", [
      S_metrics([
        { label: "在用设备", value: "5", unit: "台", delta: "1 台需重连 · 1 台未授权", go: "data/devices" },
        { label: "可用数据源", value: "3", unit: "类", delta: "文件 / IMU / 手填", go: "data/sources" },
        { label: "28 日缺测", value: "2", unit: "天", delta: "显示「—」· 不补 0", go: "data/quality" },
        { label: "已登记指标", value: String(Object.keys(A.METRICS).length), unit: "项", delta: "口径 Registry 唯一定义源", go: "data/metrics" }
      ]),
      S_cards("设备状态", "个人设备与授权 · 组织级设备群在教练工作台", A.DEVICES.slice(0, 5).map(d => ({
        icon: d.kind.indexOf("IMU") >= 0 ? "bolt" : "heart", title: d.name, sub: d.proto + " · " + d.rate,
        value: d.status === "online" ? "已连接" : d.status === "warn" ? "需重连" : "离线",
        badge: d.status === "online" ? "在线" : d.status === "warn" ? "需关注" : "离线",
        badgeTone: d.status === "online" ? "ok" : d.status === "warn" ? "warn" : "mute", route: "data/devices", tone: d.status === "warn" ? "warn" : ""
      })), 2),
      S_heat("28 日数据质量", "绿=有效 · 橙=suspect · 虚线=缺测", 1),
      S_note("数据治理四条硬规则", "① 每条样本带 <b>source</b> 与 <b>quality_flag</b>；② 缺测显示「—」，<b>不插值、不补零、不估算、不合并</b>；③ 同一指标多来源在筛选时互斥；④ 每个派生值可下钻到原始样本与公式版本。", "info", 3)
    ], { chips: [dataChip()], actions: [{ label: "＋ 配对设备", sheet: "device", primary: true }, { label: "导入文件", route: "data/import" }] });

    page("data/devices", "设备中心", "哪些设备在线、用什么协议？", "DATA / 设备", [
      S_metrics([{ label: "已连接", value: "4", delta: "BLE / FTMS / FIT 导入" },
        { label: "需重连", value: "1", delta: "跑步机 TM-03 · 离线队列 3 条" },
        { label: "未授权", value: "1", delta: "厂商云端 API · 需开发者授权" },
        { label: "最高采样率", value: "200", unit: "Hz", delta: "VBT IMU · imu-001" }]),
      S_cards("已登记设备", "点按查看详情；解绑需二次确认", A.DEVICES.map(d => ({
        icon: d.kind.indexOf("IMU") >= 0 ? "bolt" : d.kind.indexOf("骑行") >= 0 ? "chart" : "heart",
        title: d.name, sub: d.kind + " · " + d.proto + " · " + d.rate + " · 最后同步 " + d.last,
        value: d.status === "online" ? "已连接" : d.status === "warn" ? "需重连" : d.status === "locked" ? "未授权" : "离线",
        badge: d.status === "online" ? "在线" : d.status === "warn" ? "需关注" : d.status === "locked" ? "需授权" : "离线",
        badgeTone: d.status === "online" ? "ok" : d.status === "warn" || d.status === "locked" ? "warn" : "mute", sheet: "confirm", sheetId: d.name, tone: d.status === "warn" ? "warn" : ""
      })), 2),
      S_flow("设备配对流程", "权限在使用上下文中请求，不在启动时索要", [
        { t: "扫描 BLE 广播", d: "显示名称 / RSSI / 标准服务 UUID；未授权协议标注「需授权」而非伪造可用" },
        { t: "确认协议与 characteristic", d: "HR 0x180D/0x2A37 · CPP 0x1818/0x2A63 · FTMS 0x1826/0x2AD2/0x2ACD · RSC 0x1814" },
        { t: "标定与采样率登记", d: "IMU 需静止段重力估计与 ZUPT 阈值；留空=未标定" },
        { t: "完成与断连策略", d: "断连进离线缓存队列，恢复后按 device_id + ts_ms 去重回传" }
      ], 1),
      S_note("真机差异", "各厂商对 FTMS 的实现存在差异，<b>字节布局须以实现时的官方 GATT 规范文本与真机验证为准</b>；不一致样本标记 quality_flag=suspect 并进质量页，不静默丢弃。", "warn", 3,
        { label: "打开配对", sheet: "device" })
    ], { chips: [dataChip()], actions: [{ label: "＋ 配对设备", sheet: "device", primary: true }] });

    page("data/sources", "数据源与授权", "数据来自哪里、授权是否有效？", "DATA / 数据源", [
      S_table("数据源清单", "未取得授权前只使用用户自有文件与手动录入", ["数据源", "状态", "source", "说明"], A.SOURCES.map(s => [
        esc(s.name), esc(s.state), esc(s.src), '<span class="mini">' + esc(s.note) + '</span>'
      ]), 3),
      S_note("授权合规", "E3 / E4 涉及 SDK 许可与厂商开发者授权。<b>未取得前不假设可用</b>；连接设备与读取用户自有数据属互操作性开发，但不得据此推导厂商专有算法。", "warn", 2),
      S_kv("来源枚举", "写入时强制校验", [
        ["device", "BLE / FTMS 实时样本流"], ["api", "厂商授权 API 或 HealthKit / Health Connect"],
        ["import", "FIT / TCX / CSV / JSON 文件导入"], ["manual", "手动录入表单"],
        ["quality_flag", "valid / suspect / missing（缺测不写 0）"]
      ], 1)
    ], { chips: [dataChip()] });

    page("data/import", "导入与手动录入", "怎么把外部数据放进来？", "DATA / 导入", [
      S_flow("导入链路", "预签名直传 · 幂等任务 · 失败进死信", [
        { t: "选择文件", d: "FIT / TCX / CSV / JSON；大文件走预签名 URL 直传，不穿 API 服务" },
        { t: "字段映射预览", d: "ts_ms / ax / ay / az / gx / gy / gz / load_kg / exercise；校验采样率与单位" },
        { t: "写入 source 与 quality_flag", d: "import 或 manual；缺测写 NULL，不写 0" },
        { t: "后台处理与回传进度", d: "独立 worker；幂等键 = import_id + calc_version；SSE 反馈进度" }
      ], 2),
      S_kv("IMU 统一导入 schema", "CSV 列名或 JSON 字段", [
        ["device_id", "imu-001"], ["sample_rate_hz", "200"], ["unit", '{ acc: "m/s^2", gyr: "rad/s" }'],
        ["source", "import"], ["session_id", "s-2026-11-13-01"], ["exercise / load_kg", "back_squat / 80"],
        ["samples[]", '{ ts_ms, ax, ay, az, gx, gy, gz }']
      ], 1),
      S_note("手动填入最小字段", "无法提供原始波形时：<b>exercise, load_kg, rep_index, mpv_or_mcv, velocity_loss_pct, method=manual</b>。两种来源都写入 source，<b>计算时互斥筛选，不合并</b>。", "info", 3, { label: "打开手动录入", sheet: "manual" }),
      S_cards("快捷入口", "所有录入都带口径与来源", [
        { icon: "database", title: "从 IMU 拉取采样数据", sub: "CSV / JSON 预览与字段映射", sheet: "imu", value: "打开" },
        { icon: "plus", title: "手动填入 VBT / 跳跃 / 睡眠", sub: "按公式实时预览派生值", sheet: "manual", value: "打开" },
        { icon: "chart", title: "查看缺测日历", sub: "点按日期可就地补录", route: "data/quality", value: "进入" }
      ], 3)
    ], { chips: [dataChip()], actions: [{ label: "从 IMU 拉取", sheet: "imu", primary: true }] });

    page("data/quality", "数据质量与缺测", "哪几天缺测、哪些样本可疑？", "DATA / 质量", [
      S_metrics([{ label: "28 日有效天", value: L().v28 + "/28", delta: "缺测 2 天", go: "data/import" },
        { label: "suspect 样本", value: "2", unit: "天", delta: "FTMS 字节布局差异待真机核对" },
        { label: "不可计算指标", value: state.injectMissing ? "3" : "1", unit: "项", delta: "PPO/FVP 未标定 + 窗口不足" },
        { label: "离线回传队列", value: "3", unit: "条", delta: "device_id + ts_ms 去重" }]),
      S_heat("28 日质量热力日历", "点按日期补录 · 缺测为虚线空位", 2),
      S_table("不可计算清单", "返回原因，不显示 0", ["指标", "原因", "处理"], [
        ["jump.ppo / FVP", "Sayers / Samozino 系数未标定", "前往 lab/calibration"],
        ["acwr.rolling", L().rolling === null ? "7 日窗口有效天 5/7" : "28 日窗口有效天 26/28（临界）", "以 EWMA 为主口径"],
        ["tm / ts", L().tm === null ? "7 日窗口有效天不足 7" : "已计算", "不可计算时不输出 0 或 ∞"],
        ["tl.tss（跑步课）", "无功率数据", "不回退 TRIMP 冒充"],
        ["sleep 规律性", "1 夜缺测", "不插值补齐"]
      ], 1),
      S_note("治理约束", "缺测日以 <b>quality_flag</b> 标记并在 UI 显示「—」；ACWR / TM 等窗口指标在有效天数不足时<b>返回不可计算</b>，而不是 0。", "warn", 3)
    ], { chips: [dataChip()] });

    page("data/metrics", "指标口径 Registry", "每个数字是怎么算出来的？", "DATA / Registry", [
      S_note("四问准入", "每个指标必须能回答 <b>公式 / 窗口 / 输入 / 证据编号</b>，否则不允许上线。分析页只引用 Registry，不重新定义、不内置第二套公式。", "info", 3),
      S_table("已登记指标", "点按任意行可下钻到公式版本与原始样本", ["metric_id", "简称", "窗口", "版本", "证据", "有效性规则"], Object.keys(A.METRICS).map(k => [
        '<button class="chip" data-act="sheet" data-sheet="metric" data-id="' + esc(k) + '">ⓘ ' + esc(k) + '</button>',
        esc(A.METRICS[k].short), esc(A.METRICS[k].window), esc(A.METRICS[k].version), esc(A.METRICS[k].evidence),
        '<span class="mini">' + esc(A.METRICS[k].valid) + '</span>'
      ]), 3),
      S_table("模块边界表", "防止功能堆叠的结构性约定", ["边界", "A 侧", "B 侧"], A.BOUNDARIES.map(b => [esc(b[0]), '<span class="mini">' + esc(b[1]) + '</span>', '<span class="mini">' + esc(b[2]) + '</span>']), 3),
      S_note("AWCR 口径声明", "本次确认：<b>AWCR 一律按 ACWR</b>（Acute:Chronic Workload Ratio）处理，不再列为待确认项；Registry 中仅作别名登记，同时提供 rolling 与 EWMA 双口径。若后续给出不同定义，新增独立 metric_id 而不改写既有口径。", "info", 3)
    ], { chips: [dataChip()] });

    page("data/profile", "档案与设置", "个体参数与偏好是什么？", "DATA / 档案", [
      S_kv("个体参数", "变更留版本，避免历史值被追溯改写", [
        ["静息心率 HRrest", "52 bpm · device"], ["最大心率 HRmax", "192 bpm · manual"],
        ["FTP / CP", "268 W / 254 W · device"], ["体重 / 身高", "72.4 kg / 1.78 m · manual"],
        ["腿长 / 推蹬距离", "0.92 m / 0.38 m · manual"], ["时区", "Asia/Shanghai (GMT+8)"]
      ], 2),
      S_cards("偏好与无障碍", "三端一致，跟随系统", [
        { icon: "moon", title: "外观", sub: "浅色 / 深色 · 跟随系统", value: state.theme === "light" ? "浅色" : "深色", sheet: "theme" },
        { icon: "check", title: "减弱动效", sub: "prefers-reduced-motion · 位移改交叉淡化", value: "已支持" },
        { icon: "check", title: "增强对比 / 减少透明", sub: "prefers-contrast / reduced-transparency", value: "已支持" },
        { icon: "check", title: "Dynamic Type", sub: "布局重排不截断 · 最小 11px", value: "已支持" },
        { icon: "lock", title: "隐私与同意", sub: "健康数据单独同意 · 可导出 / 可删除", value: "查看", route: "admin/compliance" }
      ], 1),
      S_note("未标定参数", "采样率、滤波截止、ZUPT 阈值、V1RM、LVP R² 门槛<b>默认留空</b>，不填猜测值；相关指标在此之前返回「不可计算」。", "warn", 3, { label: "前往标定", route: "lab/calibration" })
    ], { chips: [dataChip()] });
  })();

  /* 管理后台 */
  (function () {
    // 全部由 A.ATHLETES 现算，避免「库里 2 个人、页面写 8 个人」这种不可信的数
    function teamAgg() {
      const list = A.ATHLETES || [];
      // 真实库：直接用服务端 arc_team_overview() 的结论，前端不重复算
      const T = A.TEAM && Array.isArray(A.TEAM.members_detail) ? A.TEAM : null;
      if (T) {
        const over = T.members_detail.filter(m => m.acwr !== null && m.acwr > 1.3);
        return {
          n: T.members || 0, warn: T.warn || 0, low: T.thin || 0, over,
          load7: Number(T.load7 || 0),
          quality: T.avg_readiness == null ? "—" : Math.round(T.avg_readiness),
          complete: 0, minComplete: 0,
          overName: over.length ? over[0].name + " " + Number(over[0].acwr).toFixed(2) : "—",
          ruleVer: T.rule_version || "default",
          live: true
        };
      }
      const n = list.length;
      const warn = list.filter(a => a.flag === "需关注").length;
      const low = list.filter(a => a.flag === "数据不足").length;
      const over = list.filter(a => a.acwr !== null && a.acwr > 1.3);
      const load7 = list.reduce((x, a) => x + (a.load7 || 0), 0);
      const avg = key => n ? list.reduce((x, a) => x + (a[key] || 0), 0) / n : 0;
      const complete = list.filter(a => a.complete > 0);
      const minComplete = complete.length ? Math.min.apply(null, complete.map(a => a.complete)) : 0;
      return {
        n, warn, low, over, load7,
        complete: Math.round(avg("complete") * 100),
        quality: Math.round(avg("quality") * 100),
        minComplete: Math.round(minComplete * 100),
        overName: over.length ? over[0].name + " " + over[0].acwr.toFixed(2) : "—"
      };
    }
    const AG = teamAgg();
    page("admin", "团队数据看板", "全队谁需要关注？", "ADMIN / 聚合视图", [
      S_hero({ kicker: "工作区 B · 教练工作台 · 当前角色 " + roleLabel(state.role),
        title: AG.n + " 名成员 · " + AG.warn + " 人需关注 · " + AG.low + " 人数据不足",
        lead: "此页为团队聚合视图，只读，不显示样本级数据，也不允许切换口径。明细请进入成员页；样本级下钻按角色权限决定。",
        evidence: [
          { label: "样本量 n", value: String(AG.n), detail: "按所辖成员聚合 · 28 日窗口" },
          { label: "ACWR 越界", value: String(AG.over.length), detail: "> 1.30" + (AG.over.length ? " · " + AG.overName : "") },
          { label: AG.live ? "平均就绪度" : "数据完整度", value: AG.live ? (AG.quality + " 分") : (AG.quality + "%"),
            detail: AG.live ? ("由服务端 arc_team_overview 汇总 · 规则版本 " + AG.ruleVer) : ("全队平均 · 最低 " + AG.minComplete + "%") }
        ], actions: [{ label: "查看成员", route: "admin/athletes", primary: true }] }),
      S_metrics([
        { label: "团队 7 日负荷", value: AG.load7.toLocaleString("en-US"), delta: "n=" + AG.n + " · 按所辖成员求和", go: "admin/athletes" },
        { label: "计划完成率", value: String(AG.complete), unit: "%", delta: "n=" + AG.n + " · 平均", go: "admin/athletes" },
        { label: "风险队列", value: String(AG.warn + AG.low), unit: "人", delta: AG.over.length + " 越界 + " + AG.low + " 不足", go: "admin/athletes" },
        { label: "数据完整度", value: String(AG.quality), unit: "%", delta: "n=" + AG.n + " · 28 日有效天平均", go: "admin/fleet" }
      ]),
      S_chart("成员 7 日负荷分布", "聚合口径：按所辖成员求和 · n=8", chartTeamLoad(), 2, { legend: [{ name: "7 日 TL", color: "var(--indigo)" }] }),
      S_cards("风险队列", "聚合视图 → 成员页 → 成员分析（按权限）", A.ATHLETES.filter(a => a.flag !== "正常").map(a => ({
        icon: "users", title: a.name + " · " + a.squad, sub: "ACWR " + (a.acwr === null ? "—" : a.acwr.toFixed(2)) + " · 完整度 " + (a.quality * 100).toFixed(0) + "%",
        value: a.flag, badge: a.flag, badgeTone: a.flag === "需关注" ? "warn" : "mute", route: "admin/athletes"
      })), 1),
      S_note("看板边界", "<b>admin/overview</b> 只展示聚合指标，每张卡标注样本量 n 与聚合口径；不展示原始样本、不做口径切换、不显示个人黑盒评分。与 <b>analyze/*</b> 的差别在页首常驻说明。", "info", 3)
    ], { chips: [dataChip(), '<span class="chip strong">当前角色 · ' + roleLabel(state.role) + '</span>'] });
    P["admin/overview"] = P["admin"];

    page("admin/athletes", "成员档案", "团队有哪些人、状态如何？", "ADMIN / 成员", [
      S_table("成员列表", "n=" + A.ATHLETES.length + " · 按所辖成员 · 28 日窗口", ["成员", "组别", "7 日 TL", "ACWR", "完成率", "数据完整度", "状态"], A.ATHLETES.map(a => [
        esc(a.name), esc(a.squad), esc(a.load7), a.acwr === null ? "—" : a.acwr.toFixed(2),
        (a.complete * 100).toFixed(0) + "%", (a.quality * 100).toFixed(0) + "%",
        '<span class="badge ' + (a.flag === "正常" ? "ok" : a.flag === "需关注" ? "warn" : "mute") + '">' + esc(a.flag) + '</span>'
      ]), 3),
      S_cards("成员操作", "按角色权限开放", [
        { icon: "plus", title: "邀请成员", sub: "head_coach / admin 可操作", value: "邀请", sheet: "confirm", sheetId: "邀请新成员" },
        { icon: "analyze", title: "进入成员分析（只读）", sub: "按角色权限决定是否可看明细", value: "进入", route: "analyze/load" },
        { icon: "data", title: "成员设备与授权", sub: "组织级设备群在 admin/fleet", value: "进入", route: "admin/fleet" }
      ], 2),
      S_note("权限", "<b>Observer</b> 只能看汇总看板，无成员级明细；<b>Medical</b> 只看恢复域；<b>Analyst</b> 全量只读 + 导出。切换顶栏角色可现场验证。", "", 1)
    ], { chips: [dataChip()] });

    page("admin/roles", "角色与权限", "谁能看 / 改 / 批 / 导？", "ADMIN / 权限", [
      S_matrix("RBAC 权限矩阵", "● 完全 · ◐ 受限 · — 无 · 服务端强制", 3),
      S_cards("切换角色（演示）", "切换后可见模块按矩阵重算；括号内是落到库里的 RBAC 角色", A.ROLES.map(r => ({
        icon: "shield", title: r.label, sub: r.id + " → " + (A.ROLE_MAP[r.id] || "未映射"),
        value: state.role === r.id ? "当前" : "切换", sheet: "roles", sheetId: r.id,
        badge: state.role === r.id ? "当前" : undefined, badgeTone: "info"
      })), 2),
      S_note("实现约束", "权限在<b>服务端 RBAC 中间件</b>强制，前端仅做呈现控制；无权限入口显示<b>锁定态 + 原因</b>，不静默隐藏，避免同一入口在不同端行为不一致。", "warn", 1)
    ], { chips: [dataChip()] });

    page("admin/fleet", "设备与数据管理", "组织级设备资产与数据策略如何？", "ADMIN / 设备群", [
      S_metrics([{ label: "设备资产", value: "23", unit: "台", delta: "4 个训练工位" },
        { label: "批量导入任务", value: "4", delta: "1 进行中 · 1 重试 · 2 完成" },
        { label: "凭据审计", value: "2", unit: "项", delta: "厂商 API 授权未申请" },
        { label: "保留策略", value: "730", unit: "天", delta: "原始样本只追加不覆盖" }]),
      S_table("导入任务", "幂等键 = import_id + calc_version", ["任务", "来源", "状态", "重试", "request_id"], [
        ["imu_20261113_01", "CSV · 200 Hz", "完成", "0", "rq_8f02"],
        ["fit_watch_batch_07", "FIT × 12", "完成", "0", "rq_7d9c"],
        ["imu_20261113_02", "JSON · 200 Hz", "进行中", "0", "rq_8f21"],
        ["tcx_legacy_03", "TCX × 3", "重试中", "1 / 3", "rq_8f1a"]
      ], 3),
      S_flow("设备群与批量策略", "与个人数据页的边界", [
        { t: "设备资产登记", d: "归属组织而非个人；工位、采样率、固件、标定时间" },
        { t: "批量导入与凭据审计", d: "预签名直传；授权状态、访问记录、轮换周期" },
        { t: "保留与删除策略", d: "原始样本只追加；删除请求走合规流程并留审计" },
        { t: "离线回传队列", d: "恢复连接后按 device_id + ts_ms 去重回传" }
      ], 2),
      S_note("边界", "<b>data/devices</b> 是本人设备与授权；<b>admin/fleet</b> 是组织级资产、批量任务、凭据与保留策略。个人页不显示组织级配置，管理页不直接编辑个人生理样本。", "info", 1)
    ], { chips: [dataChip()] });

    page("admin/rules", "规则与口径版本", "当前生效的是哪套算法？", "ADMIN / 版本", (function () {
      const LIVE = state.dbLive;
      const RP = A.RULE_PACK;

      if (!LIVE) {
        return [
          S_table("生效中的规则", "每条规则可解释、可灰度、可回滚", ["规则", "条件", "动作", "版本", "生效范围"], [
            ["R-01 负荷增量", "CTL 斜率 ≤1.5/日 且 ACWR∈[.8,1.3]", "维持计划", "v1.0", "全队"],
            ["R-04 恢复偏离", "lnRMSSD 在基线 ±1SD", "允许既定强度", "v1.0", "全队"],
            ["R-07 单调性风险", "TM<2.0 且 TS<10000", "不插入 deload", "v1.0", "全队"],
            ["R-12 数据充分性", "慢性窗 ≥26/28 有效天", "主口径 EWMA", "v1.0", "全队"],
            ["acwr.ewma", "λ=2/(7+1)、2/(28+1)", "ACWR 主口径", "v1.0", "全队"],
            ["vbt.lvp", "V=a·kg+b · R²≥0.95", "1RM 估计", "v0.9 灰度", "A 组"]
          ], 3),
          S_cards("版本操作", "写操作记入审计日志", [
            { icon: "sliders", title: "灰度范围调整", sub: "vbt.lvp v0.9 · 当前 A 组", value: "调整", sheet: "confirm", sheetId: "调整灰度范围" },
            { icon: "arrow", title: "回滚到上一版本", sub: "需二次确认 · 影响历史可解释性", value: "回滚", sheet: "confirm", sheetId: "回滚规则版本" },
            { icon: "list", title: "查看变更审计", sub: "admin/audit · request_id 贯穿", value: "进入", route: "admin/audit" }
          ], 2),
          S_note("口径唯一性", "所有公式来自 <b>data/metrics</b> Registry；版本变更不改写历史值，历史结果保留其计算时的 calc_version。", "", 1)
        ];
      }

      if (!RP) {
        return [
          S_note("还没有生效的规则版本", "库里的 <b>rules</b> 表是空的，计算会退回代码里的默认口径" +
            "（<b>不是</b>某个可追溯的版本号）。这说明阈值目前无法被审计——建议立即用 <b>arc_seed_default_rules()</b> 落一个 v1.0。", "warn", 3),
          S_note("为什么这条重要", "阈值不落库就无法回答「三个月前那条建议是按什么标准给的」。规则版本是历史可解释性的前提。", "", 3)
        ];
      }

      const p = RP.payload || {};
      const g = (o, k) => (o && o[k] !== undefined && o[k] !== null) ? o[k] : "—";
      const rows = [
        ["ACWR 安全区", g(p.acwr, "low") + " – " + g(p.acwr, "high"), "越界给「负荷提醒」，不直接禁止训练"],
        ["ACWR 危险值", g(p.acwr, "danger"), "超过则升级为「负荷急增」标记"],
        ["单调性上限 TM", g(p, "monotony_max"), "超过表示训练变化太少，伤病风险上升"],
        ["训练应变上限 TS", g(p, "strain_max"), "TM × 周负荷，超限提示减量"],
        ["就绪度权重", "ACWR " + g(p.readiness, "acwr_w") + " / HRV " + g(p.readiness, "hrv_w") + " / 睡眠 " + g(p.readiness, "sleep_w"), "缺分量时按剩余权重重新归一"],
        ["就绪度 SWC 系数", g(p.readiness, "swc_k"), "个体最小有意义变化"],
        ["睡眠目标", g(p.sleep, "target_min") + " min", "睡眠债以此为基准"],
        ["睡眠债告警线", g(p.sleep, "deficit_warn_min") + " min", "超过才提示"],
        ["VBT 1RM 速度阈值", g(p.vbt, "velocity_1rm") + " m/s", "未标定时不估算 1RM"],
        ["VBT 速度损失告警", g(p.vbt, "vl_warn_pct") + " %", "组内掉速超限标记"],
        ["跳跃左右不对称告警", g(p.jump, "asym_warn_pct") + " %", "单侧测试才有值"],
        ["窗口", "急性 " + g(p.windows, "acute_days") + " 日 / 慢性 " + g(p.windows, "chronic_days") + " 日 / 基线 " + g(p.windows, "baseline_days") + " 日", "EWMA 与滚动口径共用"],
        ["数据充分性", "≥ " + g(p.data, "min_valid_days") + " 有效天", "不足则不出主口径结论"]
      ];

      return [
        S_metrics([
          { label: "生效版本", value: RP.version, delta: RP.name, go: "admin/rules" },
          { label: "生效日期", value: RP.effective_from, delta: "版本总数 " + RP.versions, go: "admin/rules" },
          { label: "阈值条目", value: String(rows.length), unit: "项", delta: "全部来自 rules.payload" },
          { label: "口径来源", value: "DB", delta: "计算函数运行时读取，不硬编码" }
        ], 3),
        S_table("生效中的阈值", "rules.payload · " + RP.version + " · " + RP.effective_from,
          ["规则项", "阈值", "用途"], rows, 3,
          { note: "这些值不是写死在代码里的：换一版规则只改 rules 表一行，所有计算函数即时按新阈值走。" }),
        S_cards("版本操作", "需要组织管理员权限 · 写操作记入审计日志", [
          { icon: "list", title: "查看变更审计", sub: "admin/audit · rule.activate 会留痕", value: "进入", route: "admin/audit" },
          { icon: "chart", title: "查看这些阈值算出的结果", sub: "analyze/load · 负荷与周期", value: "进入", route: "analyze/load" }
        ], 2),
        S_note("口径唯一性", "所有公式来自 <b>data/metrics</b> Registry；版本变更不改写历史值，历史结果保留其计算时的 calc_version。", "", 1)
      ];
    })(), { chips: [dataChip()] });

    page("admin/audit", "审计日志", "谁在什么时候改了什么？", "ADMIN / 审计", [
      S_table("结构化日志", "含 request_id · 不记录密码 / 令牌 / RR 原始值", ["时间", "actor", "action", "target", "结果", "request_id"], A.AUDIT.map(a => [
        esc(a.ts), esc(a.actor), esc(a.action), esc(a.target),
        '<span class="badge ' + (a.result.indexOf("拒绝") >= 0 ? "bad" : "ok") + '">' + esc(a.result) + '</span>', esc(a.rid)
      ]), 3),
      S_note("日志约束", "结构化 JSON、贯穿 request_id、不记录隐私数据与密钥。失败重试与死信任务同样留痕；<b>Medical / Analyst 角色仅可见受限范围</b>。", "", 3)
    ], { chips: [dataChip()] });

    page("admin/compliance", "合规与备案", "上架与数据合规还差什么？", "ADMIN / 合规", [
      S_metrics([{ label: "备案路径", value: "正常", delta: "自有境内后端 → APP 备案" },
        { label: "名称预检", value: "通过", delta: "「第三世界」未命中禁词" },
        { label: "管局审核", value: "20", unit: "工作日", delta: "整体按 4–6 周排期" },
        { label: "未决项", value: "3", delta: "App 内展示 / ASC 回填 / 公安备案" }]),
      S_cards("取号后四件事", "缺一不可", [
        { icon: "check", title: "App 内展示备案号", sub: "设置页展示并链接 beian.miit.gov.cn", value: "待办", badge: "待办", badgeTone: "warn" },
        { icon: "check", title: "回填 App Store Connect", sub: "App 信息 → ICP 备案号", value: "待办", badge: "待办", badgeTone: "warn" },
        { icon: "check", title: "确认中国大陆可售", sub: "销售地区校验", value: "待办", badge: "待办", badgeTone: "warn" },
        { icon: "check", title: "30 日内公安联网备案", sub: "beian.gov.cn 并展示公安备案号", value: "待办", badge: "待办", badgeTone: "warn" }
      ], 2),
      S_kv("路径与主体判定", "已用备案助手脚本预检", [
        ["路径", "<b>正常 APP 备案</b> · 存在自有境内后端即属于互联网信息服务"],
        ["名称", "「第三世界」未命中禁词或前置审批触发词；备案名 = ASC 后台名 = 图标下名 = 简中 App 信息名，<b>四处逐字一致</b>"],
        ["主体", "个人主体仅限<b>非经营性</b>：纯免费、无内购 / 广告 / 电商 / 内容发布。一旦引入订阅或团队付费，须先注册个体工商户或公司"],
        ["名称风险", "备案后改名需变更备案，苹果侧 ICP 编号验证会失败直到信息对齐"]
      ], 1),
      S_note("健康数据合规", "睡眠 / HRV / RR 间期属敏感个人信息：<b>单独同意、最小必要、可导出、可删除</b>；BLE / HealthKit 权限在使用上下文中请求，不在启动时一次性索要。省级材料细节以属地管局公示为准，本页不构成法律结论。", "warn", 3)
    ], { chips: [dataChip()] });
  })();
  }

  function roleLabel(id) { const r = A.ROLES.find(x => x.id === id); return r ? r.label : id; }

  /* ── 权限 ────────────────────────────────────────────── */
  function accessFor(route) {
    if (state.workspace !== "admin") return { ok: true };
    const p = A.PERMISSIONS, idx = p.columns.indexOf(state.role);
    let key = "overview";
    if (route === "admin/athletes") key = "athletes";
    else if (route === "admin/roles") key = "roles";
    else if (route === "admin/fleet") key = "fleet";
    else if (route === "admin/rules") key = "rules";
    else if (route === "admin/audit") key = "audit";
    else if (route === "admin/compliance") key = "compliance";
    const r = p.rows.find(x => x.key === key);
    const v = r ? r.v[idx] : "full";
    return { ok: v !== "none", limited: v === "limited", module: r ? r.module : "团队数据看板" };
  }

  /* ── 渲染 ────────────────────────────────────────────── */
  function primaryOf(route) { return route.split("/")[0]; }
  function navGroup() { return A.NAV.find(n => n.id === primaryOf(state.route)) || A.NAV[0]; }
  function defaultRoute(id) {
    if (id === "admin") return "admin/overview";
    const n = A.NAV.find(x => x.id === id);
    return n && n.children.length ? id : (n ? id : "today");
  }

  function renderConsole() {
    const seg = document.getElementById("platformSeg");
    seg.innerHTML = ["iphone", "ipad", "mac"].map(p => '<button data-act="platform" data-p="' + p + '" class="' + (state.platform === p ? "on" : "") + '">' + ({ iphone: "iPhone", ipad: "iPad", mac: "Mac" })[p] + '</button>').join("");
    document.getElementById("themeBtn").innerHTML = icon(state.theme === "light" ? "moon" : "sun", 16);
    const rs = document.getElementById("roleSel");
    rs.value = state.role;
    // 真实模式下角色来自 memberships，前端不允许自行切换，否则「看到什么」和「服务端放行什么」会错位
    rs.disabled = !!state.dbLive;
    rs.title = state.dbLive ? "角色由组织成员关系决定，不可在此切换" : "演示用角色切换";
    const host = document.getElementById("dbHost");
    if (host && window.ARC_UI) host.innerHTML = window.ARC_UI.pillHtml();
    // 外壳上的「DEMO 演示数据」标签也要跟着连接状态变，不能一边连真库一边挂着 DEMO
    const tag = document.querySelector(".console .demo-tag");
    if (tag) {
      tag.textContent = state.dbLive ? "真实数据 · RLS 生效" : "DEMO 演示数据";
      tag.classList.toggle("live", !!state.dbLive);
    }
  }
  function renderShell() {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dataset.workspace = state.workspace;
    document.getElementById("app").className = "app platform-" + state.platform;
    document.getElementById("device").className = "device p-" + state.platform;
    const isAdmin = state.workspace === "admin";
    const group = navGroup();

    // Sidebar
    let side = '<div class="side-head"><div class="side-mark">第</div><div><div class="side-name">第三世界</div><div class="side-caption">' + (isAdmin ? "教练工作台" : "运动员工作区") + '</div></div></div><div class="side-scroll">';
    if (!isAdmin) {
      side += '<div class="side-group-label">我的</div>';
      A.NAV.forEach(n => {
        const on = primaryOf(state.route) === n.id;
        side += '<button class="side-item ' + (on ? "on" : "") + '" data-act="nav" data-route="' + n.id + '">' + icon(n.icon, 18) + '<span>' + n.label + '</span></button>';
        if (on && n.children.length) {
          side += '<div class="side-sub"><button class="side-subitem ' + (state.route === n.id ? "on" : "") + '" data-act="nav" data-route="' + n.id + '">概览</button>' +
            n.children.map(c => '<button class="side-subitem ' + (state.route === n.id + "/" + c.id ? "on" : "") + '" data-act="nav" data-route="' + n.id + "/" + c.id + '">' + c.label + '</button>').join("") + '</div>';
        }
      });
      side += '<div class="side-group-label">工作区</div><button class="side-item" data-act="nav" data-route="admin/overview">' + icon("shield", 18) + '<span>教练工作台</span></button>';
    } else {
      side += '<div class="side-group-label">工作区 B</div>';
      A.ADMIN_NAV.forEach(n => {
        const r = "admin/" + n.id;
        const ac = accessFor(r);
        side += '<button class="side-item ' + (state.route === r || (state.route === "admin" && n.id === "overview") ? "on" : "") + '" data-act="nav" data-route="' + r + '">' + icon(n.icon, 18) + '<span>' + n.label + '</span>' + (ac.ok ? "" : '<span class="lock">' + icon("lock", 12) + '</span>') + '</button>';
      });
      side += '<div class="side-group-label">返回</div><button class="side-item" data-act="nav" data-route="today">' + icon("arrow", 18) + '<span>运动员工作区</span></button>';
    }
    side += '</div><div class="side-foot">同语义导航 · 同组件 · 同数据<br>仅列数与导航控件随 size class 变化</div>';
    document.getElementById("sidebar").innerHTML = side;

    // Topbar
    const pg = P[state.route] || P.today;
    const sec = state.route.indexOf("/") >= 0;
    let top = (sec ? '<button class="icon-btn" data-act="back" title="返回上一级">' + icon("back", 15) + '</button>' : "") +
      (sec ? '<span class="crumb"><b>' + (isAdmin ? "教练工作台" : group.label) + '</b> / ' + esc(pg.title) + '</span>'
           : '<span class="topbar-title">' + esc(pg.title) + '</span>') +
      '<span class="topbar-spacer"></span>' +
      (isAdmin ? '<button class="pill accent" data-act="sheet" data-sheet="roles">' + icon("shield", 13) + ' ' + roleLabel(state.role) + '</button>' : "") +
      '<button class="pill hide-phone live-pill" data-act="live-toggle" title="暂停 / 继续实时推流"><span class="live-dot on" data-live-dot></span><span data-live-label>实时 · 1 Hz</span></button>' +
      '<button class="icon-btn hide-phone" data-act="live-refresh" title="即时刷新" aria-label="即时刷新">↻</button>' +
      '<button class="pill hide-phone" data-act="sheet" data-sheet="scores">对标评分</button>' +
      '<button class="pill hide-phone" data-act="sheet" data-sheet="window">28 日 · ' + (state.params.acwr === "ewma" ? "EWMA" : "rolling") + '</button>' +
      (state.dbLive
        ? '<button class="pill accent" data-act="arc-record">＋ 记录</button><span class="pill live" title="数据来自 Supabase 真实库，行级权限已生效">真实数据</span>'
        : '<span class="pill demo" title="演示数据，不是真实训练记录">DEMO</span>') +
      '<button class="pill accent" data-act="workspace">' + icon(isAdmin ? "arrow" : "shield", 13) + (isAdmin ? " 返回" : " 工作台") + '</button>' +
      '<button class="pill kbd-hint" data-act="palette">' + icon("search", 13) + '<span class="kbd">⌘K</span></button>';
    document.getElementById("topbar").innerHTML = top;

    // Subnav (iPhone)
    let subs = [];
    if (isAdmin) subs = A.ADMIN_NAV.map(n => ({ id: "admin/" + n.id, label: n.label }));
    else subs = [{ id: group.id, label: "概览" }].concat(group.children.map(c => ({ id: group.id + "/" + c.id, label: c.label })));
    document.getElementById("subnav").innerHTML = subs.map(s => '<button class="' + (state.route === s.id || (state.route === "admin" && s.id === "admin/overview") ? "on" : "") + '" data-act="nav" data-route="' + s.id + '">' + esc(s.label) + '</button>').join("");

    // Tabbar
    document.getElementById("tabbar").innerHTML = A.NAV.map(n => '<button class="' + (!isAdmin && primaryOf(state.route) === n.id ? "on" : "") + '" data-act="nav" data-route="' + n.id + '">' + icon(n.icon, 21) + '<span>' + n.label + '</span></button>').join("");

    renderConsole();
    fitStage();
  }

  function renderPage() {
    chartRegistry = {}; chartSeq = 0;
    const pg = P[state.route] || P.today;
    const ac = accessFor(state.route);
    const content = document.getElementById("content");
    if (!ac.ok) {
      content.innerHTML = '<div class="page"><div class="page-head"><div class="page-eyebrow">PERMISSION / 403</div><h1 class="page-title">' + esc(pg.title) + '</h1><p class="page-question">此模块对当前角色不可用</p></div>' +
        '<div class="card locked"><div class="locked-ico">' + icon("lock", 34) + '</div><div class="locked-title">已锁定 · ' + esc(ac.module) + '</div>' +
        '<div class="locked-desc">当前角色「' + esc(roleLabel(state.role)) + '」对该模块无权限。权限在服务端 RBAC 强制；前端保留入口并显示原因，不静默隐藏。</div>' +
        '<button class="btn" data-act="sheet" data-sheet="roles">切换角色（演示）</button></div></div>';
      return;
    }
    const chips = (pg.chips || []).join("");
    const actions = (pg.actions || []).map(a => '<button class="btn ' + (a.primary ? "primary" : "") + '" data-act="' + (a.sheet ? "sheet" : "nav") + '" ' +
      (a.sheet ? 'data-sheet="' + a.sheet + '"' + (a.id ? ' data-id="' + esc(a.id) + '"' : "") : 'data-route="' + a.route + '"') + '>' + esc(a.label) + '</button>').join("");
    // docs/04：按界面注入实时控制条 / 对标评分 / 数据融合（不改变既有路由与层级）
    let sections = pg.sections.slice();
    const LV = window.ARC_LIVE;
    if (LV) {
      if (sections.some(x => x.type === "chart" || x.type === "heat")) sections.unshift(S_livebar());
      const scoreMap = {
        "analyze": ["evlab.status", "te.aerobic", "bodybattery", "sleep.score"],
        "analyze/load": ["evlab.status", "evlab.recovery", "evlab.running"],
        "analyze/recovery": ["hrv.status", "coros.hrv", "sleep.score", "bodybattery"],
        "analyze/endurance": ["te.aerobic", "evlab.running", "evlab.status"],
        "analyze/vbt": ["evlab.status", "evlab.recovery"],
        "analyze/jump": ["evlab.status", "evlab.running"],
        "analyze/report": ["evlab.status", "bodybattery"],
        "train": ["evlab.status", "bodybattery"],
        "train/session": ["te.aerobic", "evlab.status"],
        "train/plan": ["evlab.status", "evlab.recovery"],
        "lab": ["evlab.status", "evlab.recovery"],
        "lab/vbt": ["evlab.status", "te.aerobic"],
        "data": ["bodybattery", "sleep.score"],
        "admin/overview": ["evlab.status", "bodybattery"],
        "admin": ["evlab.status", "bodybattery"]
      };
      if (scoreMap[state.route]) sections.push(S_scores(scoreMap[state.route]));
      if (["data/sources", "data/import", "data/devices", "lab/vbt", "lab/calibration"].indexOf(state.route) >= 0) sections.push(S_fusion());
    }
    content.innerHTML = '<div class="page"><div class="page-head">' +
      '<div class="page-eyebrow">' + esc(pg.eyebrow || "") + '</div>' +
      '<h1 class="page-title">' + esc(pg.title) + '</h1>' +
      '<p class="page-question">' + esc(pg.question || "") + '</p>' +
      '<div class="page-chips">' + chips + '</div>' +
      (actions ? '<div class="page-actions">' + actions + '</div>' : "") +
      '</div><div class="page-grid">' + sections.map(renderSection).join("") + '</div></div>';
    content.scrollTop = 0;
    requestAnimationFrame(mountCharts);
  }
  function renderAll() { buildPages(); renderShell(); renderPage(); }

  function navigate(route) {
    if (route === "admin") route = "admin/overview";
    if (!P[route]) route = "today";
    const nextAdmin = primaryOf(route) === "admin";
    if (nextAdmin !== (state.workspace === "admin")) { state.workspace = nextAdmin ? "admin" : "athlete"; }
    state.route = route; state.sheet = null; state.palette = false;
    renderAll(); renderOverlay();
  }

  /* ── 浮层 ────────────────────────────────────────────── */
  function metricValue(id) {
    const l = L();
    const map = {
      "acwr.ewma": fmt(l.ewma, 2), "acwr.rolling": l.rolling === null ? "—" : fmt(l.rolling, 2),
      "ctl": fmt(l.ctl, 1), "atl": fmt(l.atl, 1), "tsb": fmt(l.tsb, 1), "tm": l.tm === null ? "—" : fmt(l.tm, 2),
      "ts": l.ts === null ? "—" : fmt(l.ts, 0), "tl.srpe": "96", "tl.tss": "不可计算 · 无功率数据",
      "hrv.rmssd": "64 ms", "sleep.tst": "409 min", "vbt.mcv": "0.72 m/s", "vbt.vl": "23.6 %",
      "vbt.lvp": "R² " + fmt(LVP.r2, 3), "vbt.power": "518 W（近似）", "jump.height": cm(jumpH(0.512)) + " cm",
      "jump.rsi": fmt(jumpRSI(0.398, 0.184), 2), "jump.ppo": "— · 系数未标定"
    };
    return map[id] || "—";
  }
  function rawSamples(id) {
    const rows = load().slice(-6).reverse().map(r => [esc(r.date), r.tl === null ? "—" : fmt(r.tl, 0), fmt(r.ctl, 1), fmt(r.atl, 1), fmt(r.ewma, 2), r.v7 + "/7", "device"]);
    if (id.indexOf("jump") === 0) return A.JUMPS.slice(0, 5).map(j => [esc(j.date), esc(j.type), j.tf.toFixed(3), j.tc === null ? "—" : j.tc.toFixed(3), cm(jumpH(j.tf)) + " cm", esc(j.method), j.fps === null ? "—" : esc(j.fps)]);
    if (id.indexOf("vbt") === 0) return A.VBT_SETS.map(s => [esc(s.load) + " kg", s.mpv.toFixed(2), s.mcv.toFixed(2), s.pv.toFixed(2), s.vl.toFixed(1) + "%", esc(s.p) + " W", "import"]);
    return rows;
  }
  function rawColumns(id) {
    if (id.indexOf("jump") === 0) return ["日期", "类型", "t_f s", "t_c s", "高度", "方法", "fps"];
    if (id.indexOf("vbt") === 0) return ["负荷", "MPV", "MCV", "PV", "VL%", "功率", "source"];
    return ["日期", "TL", "CTL", "ATL", "ACWR EWMA", "有效天", "source"];
  }
  function sheetSpec() {
    if (!state.sheet) return null;
    const t = state.sheet.type, id = state.sheet.id;
    const foot = (buttons) => '<div class="sheet-foot">' + buttons + '</div>';
    const closeBtn = '<button class="btn" data-act="close">关闭</button>';

    if (t === "scores") {
      return { title: "对标评分与阈值分档 · 原型级还原", subtitle: "O12 · 公开可查口径 / DEMO 占位 / 不还原真实算法", small: false,
        body: window.ARC_LIVE ? window.ARC_LIVE.scoresSheetHtml(id) : "",
        footer: foot(closeBtn + '<button class="btn primary" data-act="sheet" data-sheet="fusion">数据融合与映射</button>') };
    }
    if (t === "fusion") {
      return { title: "数据融合与字段映射 · 原型级还原", subtitle: "O13 · 来源 / 映射 / 处理链 / App 内部实现要点", small: false,
        body: window.ARC_LIVE ? window.ARC_LIVE.fusionHtml(false) : "",
        footer: foot(closeBtn + '<button class="btn primary" data-act="nav" data-route="data/sources">查看数据源</button>') };
    }
    if (t === "metric") {
      const m = A.METRICS[id] || A.METRICS.ctl;
      return { title: m.name, subtitle: "O1 指标下钻 · 口径 / 窗口 / 来源 / 证据 / 原始样本", small: false,
        body: '<dl class="kv">' +
          '<dt>当前值</dt><dd><b style="font-size:16px">' + esc(metricValue(id)) + '</b> <span style="color:var(--text-3)">· DEMO</span></dd>' +
          '<dt>公式版本</dt><dd>' + esc(m.version) + '</dd><dt>窗口</dt><dd>' + esc(m.window) + '</dd>' +
          '<dt>输入</dt><dd>' + esc(m.inputs) + '</dd><dt>证据编号</dt><dd>' + esc(m.evidence) + '</dd>' +
          '<dt>有效性规则</dt><dd>' + esc(m.valid) + '</dd><dt>source</dt><dd>device / import / manual（互斥筛选）</dd>' +
          '<dt>quality_flag</dt><dd>valid · suspect · missing</dd></dl>' +
          '<div class="sheet-section-title">公式原文</div><div class="formula">' + esc(m.formula) + '</div>' +
          '<div class="sheet-section-title">口径说明</div><div class="note">' + esc(m.note) + '</div>' +
          '<div class="sheet-section-title">原始样本（前几行）</div><div class="table-wrap"><table class="tbl"><thead><tr>' + rawColumns(id).map(c => '<th>' + esc(c) + '</th>').join("") + '</tr></thead><tbody>' + rawSamples(id).map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join("") + '</tr>').join("") + '</tbody></table></div>',
        footer: foot(closeBtn + '<button class="btn primary" data-act="nav" data-route="data/metrics">查看完整 Registry</button>') };
    }
    if (t === "rule") {
      const r = A.RULES[id] || A.RULES["R-01"];
      return { title: id + " · " + r.title, subtitle: "O7 规则解释 · 可解释规则，不输出黑盒评分", small: false,
        body: '<dl class="kv"><dt>输入值</dt><dd>' + esc(r.input) + '</dd><dt>触发阈值</dt><dd>' + esc(r.threshold) + '</dd>' +
          '<dt>结论</dt><dd><b>' + esc(r.conclusion) + '</b></dd><dt>建议动作</dt><dd>' + esc(r.action) + '</dd>' +
          '<dt>版本号</dt><dd>' + esc(r.version) + '</dd></dl>' +
          '<div class="sheet-section-title">规则可调整参数</div><div class="note">阈值、窗口、有效天数下限均为配置项，变更需留版本并经审批；历史结果保留其计算时的版本号。</div>' +
          '<div class="sheet-section-title">同时生效的规则</div>' + Object.keys(A.RULES).map(k => '<div style="padding:6px 0;border-bottom:1px solid var(--separator)"><b>' + k + '</b> · ' + esc(A.RULES[k].title) + ' → ' + esc(A.RULES[k].action) + '</div>').join(""),
        footer: foot(closeBtn + '<button class="btn primary" data-act="nav" data-route="train/plan">应用为周期块</button>') };
    }
    if (t === "device") {
      return { title: "配对设备", subtitle: "O2 · BLE 扫描 → 协议确认 → 标定 → 完成", small: false,
        body: '<div class="sheet-section-title">附近设备（DEMO 广播）</div>' +
          '<div class="list">' + [
            { icon: "heart", title: "HR-Band 07", sub: "RSSI −52 dBm · BLE 0x180D / 0x2A37", value: "心率带", badge: "可配对", badgeTone: "info" },
            { icon: "chart", title: "Trainer 11", sub: "RSSI −61 dBm · FTMS 0x1826 / 0x2AD2", value: "骑行台", badge: "可配对", badgeTone: "info" },
            { icon: "bolt", title: "IMU 002", sub: "RSSI −70 dBm · CSV / JSON · 200 Hz", value: "VBT IMU", badge: "可配对", badgeTone: "info" },
            { icon: "lock", title: "ANT+ 设备", sub: "协议授权未取得", value: "—", badge: "需授权", badgeTone: "warn", tone: "warn" }
          ].map(row).join("") + '</div>' +
          '<div class="sheet-section-title">将订阅的标准服务</div><div class="formula">HR 0x180D / 0x2A37 · Cycling Power 0x1818 / 0x2A63 · FTMS 0x1826 (Indoor Bike 0x2AD2 / Treadmill 0x2ACD / Control Point 0x2AD9) · RSC 0x1814 / 0x2A53 · Device Info 0x180A · Battery 0x180F</div>' +
          '<div class="sheet-section-title">标定（留空 = 未标定）</div><div class="form-grid"><div class="form-row"><label>采样率 Hz</label><input value="200"></div><div class="form-row"><label>低通截止 Hz</label><input placeholder="未标定"></div></div>' +
          '<div class="note warn">未授权协议显示「需授权」而非伪造可用；FTMS 各厂商字节布局差异须真机验证。</div>',
        footer: foot(closeBtn + '<button class="btn primary" data-act="toast" data-msg="已连接 HR-Band 07 · 采样率 1 Hz">完成配对</button>') };
    }
    if (t === "imu") {
      return { title: "从 VBT IMU 拉取采样数据", subtitle: "O4 · CSV / JSON 预览与字段映射 · 写入 source=import", small: false,
        body: '<dl class="kv"><dt>设备</dt><dd>imu-001 · 200 Hz</dd><dt>单位</dt><dd>acc m/s² · gyr rad/s</dd><dt>session_id</dt><dd>s-2026-11-13-01</dd><dt>exercise / load</dt><dd>back_squat / 80 kg</dd></dl>' +
          '<div class="sheet-section-title">字段映射</div><div class="table-wrap"><table class="tbl"><thead><tr><th>列</th><th>映射到</th><th>单位</th><th>状态</th></tr></thead><tbody>' +
          [["ts_ms", "raw_sample.ts_ms", "ms", "✔"], ["ax / ay / az", "acc_x / acc_y / acc_z", "m/s²", "✔"], ["gx / gy / gz", "gyr_x / gyr_y / gyr_z", "rad/s", "✔"], ["load_kg", "strength_set.load_kg", "kg", "✔"], ["sample_rate_hz", "device.sample_rate_hz", "Hz", "✔"]].map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + r[3] + '</td></tr>').join("") + '</tbody></table></div>' +
          '<div class="sheet-section-title">数据预览（前 3 行 · DEMO）</div><div class="formula">{"ts_ms":1731456000000,"ax":0.12,"ay":-0.03,"az":9.79,"gx":0.01,"gy":0.00,"gz":0.02}\n{"ts_ms":1731456000005,"ax":0.14,"ay":-0.02,"az":9.81,"gx":0.01,"gy":0.00,"gz":0.02}\n{"ts_ms":1731456000010,"ax":0.11,"ay":-0.04,"az":9.78,"gx":0.02,"gy":0.00,"gz":0.01}</div>' +
          '<div class="note info" style="margin-top:12px">处理链：静止段估计重力 → 去重力 → 低通 → 积分 → ZUPT → 重复切分。每步中间结果可持久化、可下钻。未标定参数留空，不填猜测默认值。</div>',
        footer: foot(closeBtn + '<button class="btn primary" data-act="toast" data-msg="已导入 1,240 条样本 · source=import · 后台任务 rq_8f02">确认导入</button>') };
    }
    if (t === "manual") { return manualSheet(); }
    if (t === "newtest") {
      return { title: "新建测试", subtitle: "O5 · 选择协议后进入对应采集页", small: true,
        body: (id ? '<div class="note info">已选协议：<b>' + esc(id) + '</b>。点按下方按钮进入采集页。</div>' : '<div class="note">选择一个协议开始测量；所有录入都写入 source 与 quality_flag。</div>') +
          '<div class="sheet-section-title">协议</div><div class="protocol-grid">' +
          ["CMJ", "SJ", "DJ 跳深", "RSI 10-5", "VBT 杠铃速度", "5-0-5 变向", "踝背屈 ROM", "Wellness 问卷"].map(x => '<button class="protocol" data-act="sheet" data-sheet="newtest" data-id="' + esc(x) + '">' + esc(x) + '</button>').join("") + '</div>',
        footer: foot(closeBtn + '<button class="btn primary" data-act="nav" data-route="' + (id && id.indexOf("VBT") >= 0 ? "lab/vbt" : id && id.indexOf("ROM") >= 0 ? "lab/screen" : id && id.indexOf("问卷") >= 0 ? "lab/screen" : id && id.indexOf("变向") >= 0 ? "lab/sprint" : "lab/jump") + '">进入采集</button>') };
    }
    if (t === "window") {
      return { title: "窗口与口径", subtitle: "O6 · 选择后页面原地刷新并更新标签", small: true,
        body: '<div class="form-row"><label>分析窗口（与实时控制条同步）</label><select data-act="param" data-key="window">' + [7, 28, 42, 90].map(v => '<option value="' + v + '" ' + (curWindow() === v ? "selected" : "") + '>' + v + ' 日</option>').join("") + '</select></div>' +
          '<div class="form-row"><label>TL 口径（一次选定并固定）</label><select data-act="param" data-key="tl">' + [["srpe", "sRPE"], ["trimp", "TRIMP"], ["tss", "TSS"]].map(v => '<option value="' + v[0] + '" ' + (state.params.tl === v[0] ? "selected" : "") + '>' + v[1] + '</option>').join("") + '</select></div>' +
          '<div class="form-row"><label>ACWR 主口径</label><select data-act="param" data-key="acwr">' + [["ewma", "EWMA（推荐）"], ["rolling", "rolling 7/28"]].map(v => '<option value="' + v[0] + '" ' + (state.params.acwr === v[0] ? "selected" : "") + '>' + v[1] + '</option>').join("") + '</select></div>' +
          '<div class="form-row"><label>HRV 测量上下文</label><select data-act="param" data-key="context">' + [["night", "夜间"], ["morning", "晨起"]].map(v => '<option value="' + v[0] + '" ' + (state.params.context === v[0] ? "selected" : "") + '>' + v[1] + '</option>').join("") + '</select></div>' +
          '<div class="note warn">rolling 版急性窗包含在慢性窗内存在数学耦合；以 EWMA 为主口径，并同时展示两口径差异。口径变更会保留 calc_version 留痕。</div>' +
          '<div class="note" style="margin-top:8px"><b>原型限制（不补造）</b>：TL 口径与 ACWR 主口径选择目前只更新标签，<b>不重算数值</b>——原型缺少各 TL 口径所需的原始输入（HR 时序 / 功率 / RPE），凭空换算等于补造数据。生产环境由 <code>metric-registry</code> 按口径读取真实输入重算，并保留 calc_version。窗口与 HRV 上下文为真实即时生效项。</div>',
        footer: foot(closeBtn + '<button class="btn primary" data-act="close">应用</button>') };
    }
    if (t === "roles") {
      return { title: "角色与权限", subtitle: "O8 · 切换角色以验证 RBAC 呈现", small: true,
        body: '<div class="note info">当前角色：<b>' + esc(roleLabel(state.role)) + '</b>。切换后可见模块按权限矩阵重算，无权限页显示锁定态 + 原因。</div>' +
          '<div class="sheet-section-title">选择角色</div><div class="list">' + A.ROLES.map(r => row({ icon: "shield", title: r.label, sub: r.id, value: state.role === r.id ? "当前" : "切换", sheet: "roles", sheetId: r.id, badge: state.role === r.id ? "当前" : undefined, badgeTone: "info" })).join("") + '</div>',
        footer: foot(closeBtn + '<button class="btn primary" data-act="nav" data-route="admin/roles">查看权限矩阵</button>') };
    }
    if (t === "confirm") {
      return { title: "需要确认", subtitle: "O9 · 关键操作二次确认", small: true,
        body: '<div class="note warn"><div class="note-title">⚠ 此操作会影响以下对象</div>对象：<b>' + esc(id || "未指定") + '</b><br>影响：写入或删除后<b>不可自动撤销</b>；所有变更将记入审计日志并保留 request_id。<br><br>原型为演示环境，不会真正修改任何数据。</div>',
        footer: foot('<button class="btn" data-act="close">取消</button><button class="btn danger" data-act="toast" data-msg="操作已记录（演示）· request_id rq_demo">确认</button>') };
    }
    if (t === "theme") {
      return { title: "外观", subtitle: "浅色 / 深色 · 跟随系统偏好", small: true,
        body: '<div class="note">当前：<b>' + (state.theme === "light" ? "浅色" : "深色") + '</b>。原型同时响应 <span class="formula" style="display:inline;padding:2px 6px">prefers-color-scheme</span> 等系统偏好。</div>',
        footer: foot(closeBtn + '<button class="btn primary" data-act="theme">切换外观</button>') };
    }
    return null;
  }

  const MANUAL = {
    jump: { label: "跳跃测试", route: "lab/jump", fields: [
      { k: "type", label: "协议", type: "select", options: ["CMJ", "SJ", "DJ", "RSI 10-5"], v: "CMJ" },
      { k: "tf", label: "腾空时间 t_f (s)", type: "number", v: "0.500" },
      { k: "tc", label: "接触时间 t_c (s) · DJ 必填", type: "number", v: "0.180" },
      { k: "fps", label: "帧率 fps（视频法必填）", type: "number", v: "" },
      { k: "cond", label: "测试条件（地面 / 鞋 / 时段）", type: "text", v: "木地板 / 室内 / 09:10" }
    ] },
    vbt: { label: "VBT 组", route: "lab/vbt", fields: [
      { k: "exercise", label: "动作", type: "select", options: ["back_squat", "bench_press", "deadlift"], v: "back_squat" },
      { k: "load", label: "负荷 load_kg", type: "number", v: "80" },
      { k: "rep", label: "rep_index", type: "number", v: "6" },
      { k: "vb", label: "最佳重复速度 v_best (m/s)", type: "number", v: "0.72" },
      { k: "vl", label: "末次速度 v_last (m/s)", type: "number", v: "0.55" }
    ] },
    sleep: { label: "睡眠 / HRV", route: "analyze/recovery", fields: [
      { k: "date", label: "日期", type: "text", v: "2026-11-13" },
      { k: "tst", label: "TST 总睡眠 (min)", type: "number", v: "409" },
      { k: "waso", label: "WASO 觉醒 (min)", type: "number", v: "46" },
      { k: "awake", label: "觉醒次数", type: "number", v: "3" },
      { k: "rmssd", label: "RMSSD (ms) · 夜间上下文", type: "number", v: "64" }
    ] }
  };
  function manualSheet() {
    const f = MANUAL[state.manualType];
    // 质量热力日历点按某日 → 把日期带入补录表单，避免补录到错误日期
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(state.sheet && state.sheet.id) ? state.sheet.id : "";
    const fields = f.fields.map(x => {
      const v = (x.k === "date" && fromDate) ? fromDate : x.v;
      return '<div class="form-row"><label>' + esc(x.label) + '</label>' +
        (x.type === "select" ? '<select data-f="' + x.k + '">' + x.options.map(o => '<option ' + (o === v ? "selected" : "") + '>' + esc(o) + '</option>').join("") + '</select>'
          : '<input data-f="' + x.k + '" type="' + (x.type === "number" ? "number" : "text") + '" step="any" value="' + esc(v) + '" placeholder="' + (v === "" ? "留空 = 不可计算" : "") + '">') + '</div>';
    }).join("");
    const dateNote = fromDate ? '<div class="note info" style="margin-bottom:10px">来自质量热力日历的<b>指定补录日期：' + esc(fromDate) + '</b>；保存后写入 <code>source=manual</code> 并标记该日有效。</div>' : "";
    return { title: "手动填入 · " + f.label, subtitle: "O3 · 写入 source=manual · 与 import 互斥筛选", small: false,
      body: dateNote + '<div class="form-row"><label>录入类型</label><select data-act="manual-type">' + Object.keys(MANUAL).map(k => '<option value="' + k + '" ' + (state.manualType === k ? "selected" : "") + '>' + MANUAL[k].label + '</option>').join("") + '</select></div>' +
        '<div class="sheet-section-title">最小字段</div><div class="form-grid">' + fields + '</div>' +
        '<div class="sheet-section-title">按公式实时预览（真实计算）</div><div class="form-preview" id="manualPreview"></div>' +
        '<div class="note info" style="margin-top:12px">保存后停留在当前页，<b>不跳页</b>，保证连续测试不被打断。缺失字段导致的不可计算会明确显示原因，不补 0。</div>',
      footer: '<div class="sheet-foot"><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="save-manual">保存并写入 source=manual</button></div>' };
  }
  function updateManualPreview() {
    const el = document.getElementById("manualPreview"); if (!el) return;
    const get = k => { const n = document.querySelector('#overlay [data-f="' + k + '"]'); return n ? n.value : ""; };
    const num = k => { const v = parseFloat(get(k)); return Number.isFinite(v) ? v : null; };
    let rows = [];
    if (state.manualType === "jump") {
      const tf = num("tf"), tc = num("tc"), fps = num("fps");
      const h = tf !== null && tf > 0 ? jumpH(tf) : null;
      rows.push(["跳跃高度 h", h === null ? "— · 缺少 t_f" : (h * 100).toFixed(2) + " cm"]);
      rows.push(["公式", "h = g·t_f² / 8 · g = 9.81 m/s²"]);
      rows.push(["RSI", (h !== null && tc !== null && tc > 0) ? (h / tc).toFixed(2) : "— · 缺少接触时间"]);
      rows.push(["视频法校验", fps === null ? "fps 未填 → 视频法结果不可计算（不猜测帧率）" : "fps " + fps + " 已登记"]);
      rows.push(["用例 1", "t_f = 0.500 s → 30.66 cm"]);
    } else if (state.manualType === "vbt") {
      const vb = num("vb"), vl = num("vl");
      const loss = (vb !== null && vl !== null && vb > 0) ? (vb - vl) / vb * 100 : null;
      rows.push(["速度损失 VL%", loss === null ? "— · 缺少速度输入" : loss.toFixed(1) + " %"]);
      rows.push(["公式", "VL = (v_best − v_last) / v_best × 100"]);
      rows.push(["阈值", "10 / 20 / 30% 为可配置参数，不设为事实"]);
      rows.push(["source", "manual · 与 import 互斥筛选"]);
    } else {
      const tst = num("tst"), waso = num("waso");
      const eff = (tst !== null && waso !== null && tst + waso > 0) ? tst / (tst + waso) : null;
      rows.push(["睡眠效率", eff === null ? "— · 缺少 TST / WASO" : (eff * 100).toFixed(1) + " %"]);
      rows.push(["上下文", "仅在同一测量上下文（夜间/晨起）内比较"]);
      rows.push(["lnRMSSD", num("rmssd") ? Math.log(num("rmssd")).toFixed(2) : "—"]);
      rows.push(["医学边界", "不输出评分，不用于诊断"]);
    }
    el.innerHTML = rows.map(r => '<div class="fp-row"><span>' + esc(r[0]) + '</span><b>' + esc(r[1]) + '</b></div>').join("");
  }

  function renderOverlay() {
    const host = document.getElementById("overlay");
    if (!state.sheet && !state.palette) { host.innerHTML = ""; return; }
    let html = "";
    if (state.sheet) {
      const sp = sheetSpec();
      if (sp) html += '<div class="sheet-backdrop" data-act="close"></div><div class="sheet ' + (sp.small ? "small" : "") + '">' +
        '<div class="sheet-grabber"></div><div class="sheet-head"><div><h3>' + esc(sp.title) + '</h3><p>' + esc(sp.subtitle) + '</p></div>' +
        '<button class="icon-btn" data-act="close" aria-label="关闭">' + icon("close", 15) + '</button></div>' +
        '<div class="sheet-body">' + sp.body + '</div>' + (sp.footer || "") + '</div>';
    }
    if (state.palette) html += paletteHtml();
    host.innerHTML = html;
    if (state.sheet && state.sheet.type === "manual") updateManualPreview();
    if (state.palette) { const i = document.getElementById("paletteInput"); if (i) i.focus(); }
  }
  function paletteItems(q) {
    const list = [];
    A.NAV.forEach(n => { list.push({ label: n.label, path: n.id }); n.children.forEach(c => list.push({ label: n.label + " · " + c.label, path: n.id + "/" + c.id })); });
    A.ADMIN_NAV.forEach(n => list.push({ label: "工作台 · " + n.label, path: "admin/" + n.id }));
    [["指标口径下钻", "metric", "acwr.ewma"], ["设备配对", "device", ""], ["IMU 拉取", "imu", ""], ["手动录入", "manual", ""], ["新建测试", "newtest", ""], ["窗口与口径", "window", ""], ["角色与权限", "roles", ""], ["对标评分与阈值", "scores", ""], ["数据融合与映射", "fusion", ""]].forEach(x => list.push({ label: x[0], sheet: x[1], id: x[2] }));
    return list.filter(x => !q || x.label.toLowerCase().indexOf(q.toLowerCase()) >= 0 || x.path && x.path.indexOf(q.toLowerCase()) >= 0).slice(0, 12);
  }
  function paletteHtml() {
    const q = state.paletteQuery || "";
    const items = paletteItems(q);
    return '<div class="palette-backdrop" data-act="close"></div><div class="palette">' +
      '<input class="palette-input" id="paletteInput" placeholder="搜索页面、口径或操作…" value="' + esc(q) + '">' +
      '<div class="palette-list">' + items.map((x, i) => '<button class="palette-item ' + (i === state.paletteIndex ? "on" : "") + '" data-act="palette-go" data-i="' + i + '">' +
        icon(x.sheet ? "bolt" : "arrow", 15) + '<span>' + esc(x.label) + '</span><span class="path">' + esc(x.path || "弹层") + '</span></button>').join("") + '</div></div>';
  }
  function paletteGo(i) {
    const items = paletteItems(state.paletteQuery || "");
    const x = items[i] || items[0]; if (!x) return;
    state.palette = false;
    if (x.sheet) openSheet(x.sheet, x.id || ""); else navigate(x.path);
  }
  function openSheet(type, id) { state.sheet = { type, id: id || "" }; state.palette = false; renderOverlay(); }
  function toast(msg) {
    const host = document.getElementById("toasts");
    const el = document.createElement("div"); el.className = "toast";
    el.innerHTML = '<span>' + icon("check", 15) + '</span><span>' + esc(msg) + '</span>';
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(8px)"; setTimeout(() => el.remove(), 300); }, 3200);
  }

  /* ── 舞台缩放 ────────────────────────────────────────── */
  function fitStage() {
    const stage = document.getElementById("stage"), dev = document.getElementById("device");
    const [w, h] = SIZES[state.platform];
    dev.style.width = w + "px"; dev.style.height = h + "px";
    const sw = stage.clientWidth - 48, sh = stage.clientHeight - 40;
    const s = Math.min(1, sw / w, sh / h);
    dev.style.setProperty("--scale", s.toFixed(4));
  }

  /* ── 交互 ────────────────────────────────────────────── */
  /* ── 排课：课库模板 → 今天（arc_assign_session 会校验「是不是我能排的人」）── */
  function assignTemplate(tplId) {
    var DB = window.ARC_DB;
    if (!DB || !DB.isLive()) { toast("先连接真实库再排课", "warn"); return; }
    var me = (DB.state.primaryAthlete || {});
    if (!me.id) { toast("这个账号还没有运动员档案，无法排课", "warn"); return; }
    Promise.resolve()
      .then(function () {
        // 传本地日期而不是 p_date=null：库里的 current_date 走 UTC，凌晨会排到"昨天"
        var today = new Date().toLocaleDateString("sv-SE");
        return DB.rpc("arc_assign_session", { p_athlete: me.id, p_template: tplId, p_date: today, p_note: null });
      })
      .then(function () {
        toast("已排到今天 · 见「周期计划 → 本周课表」");
        return DB.reload();
      })
      .catch(function (e) {
        toast("排课失败：" + (e && e.message ? e.message : "未知错误"), "warn");
      });
  }

  /* ── 导出：真实数据按当前视图口径落成 CSV（带 BOM，Excel 直接开）────── */
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    var s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv(kind) {
    var rows = [], title = "";
    var blanks = function (v) { return v === null || v === undefined ? "" : v; };

    if (kind === "sessions") {
      title = "训练记录";
      rows.push(["日期", "项目", "时长(min)", "负荷TL", "方法", "来源"]);
      (A.SESSIONS || []).forEach(function (s) {
        rows.push([s.date, s.name, String(s.dur).replace(" min", ""), blanks(s.tl), s.method, s.src]);
      });
    } else if (kind === "metrics") {
      title = "每日指标";
      rows.push(["日期(Y-M-D)", "TL", "CTL", "ATL", "TSB", "ACWR_EWMA", "ACWR_滚动", "TM", "TS"]);
      (A.SRV || []).forEach(function (d, i) {
        rows.push([(A.DATES_FULL || [])[i] || "", blanks(d.tl), blanks(d.ctl), blanks(d.atl), blanks(d.tsb),
          blanks(d.acwr), blanks(d.rolling), blanks(d.tm), blanks(d.ts)]);
      });
    } else if (kind === "jumps") {
      title = "跳跃测试";
      rows.push(["日期", "类型", "腾空(s)", "接触(s)", "高度(cm)", "RSI", "方法", "fps"]);
      (A.JUMPS || []).forEach(function (j) {
        rows.push([j.date, j.type, blanks(j.tf), blanks(j.tc),
          blanks(j.height != null ? j.height : (j.tf === null ? null : +(jumpH(j.tf) * 100).toFixed(1))),
          blanks(j.rsi != null ? j.rsi : (j.tc === null || j.tf === null ? null : +jumpRSI(j.tf, j.tc).toFixed(3))),
          j.method, blanks(j.fps)]);
      });
    } else if (kind === "plan") {
      title = "周期计划";
      rows.push(["阶段", "区间", "目标周TL", "实际周TL", "状态", "重点"]);
      (A.PLAN_BLOCKS || []).forEach(function (b) {
        rows.push([b.phase, b.range, blanks(b.target), blanks(b.actual), b.status, b.focus || ""]);
      });
    }

    if (rows.length <= 1) { toast("当前没有可导出的数据（不导出空表冒充结果）", "warn"); return; }

    var csv = rows.map(function (r) { return r.map(csvCell).join(","); }).join("\r\n");
    var stamp = new Date().toISOString().slice(0, 10);
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "ARC-" + title + "-" + stamp + ".csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast("已导出 " + title + " · " + (rows.length - 1) + " 行");
  }

  document.addEventListener("click", function (e) {
    const el = e.target.closest("[data-act]"); if (!el) return;
    const a = el.dataset.act;
    if (a === "nav") { navigate(el.dataset.route); return; }
    if (a === "back") { navigate(state.route.indexOf("/") >= 0 ? primaryOf(state.route) : "today"); return; }
    if (a === "sheet") {
      const t = el.dataset.sheet, id = el.dataset.id || "";
      if (t === "toggle-missing") { state.injectMissing = !state.injectMissing; state.sheet = null; renderAll(); renderOverlay(); toast(state.injectMissing ? "已注入 2 天缺测 · 窗口指标返回不可计算" : "已恢复完整数据"); return; }
      if (t === "calibrate") { state.calibrated = true; state.sheet = null; renderAll(); renderOverlay(); toast("V1RM 0.30 m/s 已写入（演示）· 1RM 现在可计算"); return; }
      if (t === "theme") { state.theme = state.theme === "light" ? "dark" : "light"; state.sheet = null; renderAll(); renderOverlay(); return; }
      if (t === "roles" && id) { state.role = id; state.sheet = null; renderAll(); renderOverlay(); toast("已切换角色：" + roleLabel(id)); return; }
      openSheet(t, id || el.dataset.date || ""); return;
    }
    if (a === "close") { state.sheet = null; state.palette = false; renderOverlay(); return; }
    if (a === "arc-record") { if (window.ARC_UI) window.ARC_UI.openRecord(); return; }
    if (a === "download-csv") { downloadCsv(el.dataset.kind); return; }
    if (a === "assign") { assignTemplate(el.dataset.id); return; }
    if (a === "db-panel") { if (window.ARC_UI) window.ARC_UI.openPanel(); return; }
    if (state.dbLive && (a === "live-toggle" || a === "live-refresh")) {
      // 真实模式下没有假 SSE：这两个按钮改为「从库里同步一次」
      if (window.ARC_DB) window.ARC_DB.reload();
      return;
    }
    if (a === "live-toggle") { if (window.ARC_LIVE) window.ARC_LIVE.toggleLive(); return; }
    if (a === "live-refresh") { if (window.ARC_LIVE) { window.ARC_LIVE.refresh(); toast("已触发即时刷新 · 骨架加载中，全部卡片同步切版"); } return; }
    if (a === "live-filter") { if (window.ARC_LIVE) window.ARC_LIVE.setFilter(el.dataset.k, el.dataset.v); return; }
    if (a === "live-status") { if (window.ARC_LIVE) window.ARC_LIVE.setStatus(el.dataset.liveStatus); return; }
    if (a === "platform") { state.platform = el.dataset.p; renderAll(); renderOverlay(); return; }
    if (a === "theme") { state.theme = state.theme === "light" ? "dark" : "light"; renderAll(); renderOverlay(); return; }
    if (a === "workspace") { navigate(state.workspace === "admin" ? "today" : "admin/overview"); return; }
    if (a === "palette") { state.palette = true; state.sheet = null; state.paletteQuery = ""; state.paletteIndex = 0; renderOverlay(); return; }
    if (a === "palette-go") { paletteGo(parseInt(el.dataset.i, 10)); return; }
    if (a === "toast") { state.sheet = null; renderOverlay(); toast(el.dataset.msg || "已完成"); return; }
    if (a === "save-manual") { state.manualCount += 1; state.sheet = null; renderAll(); renderOverlay(); toast("已保存 · source=manual · 结果卡就地更新"); return; }
    if (a === "param") { return; }
    if (a === "none") { return; }
  });
  document.addEventListener("change", function (e) {
    const el = e.target;
    if (el.dataset && el.dataset.act === "param") {
      const k = el.dataset.key, raw = el.dataset.val || el.value;
      state.params[k] = isNaN(Number(raw)) ? raw : Number(raw);
      // 窗口为单一数据源：O6 与实时控制条双向同步，避免标签与图表使用不同窗口
      if (k === "window" && window.ARC_LIVE) window.ARC_LIVE.state.window = Number(raw);
      renderAll();
    }
    if (el.dataset && el.dataset.act === "manual-type") { state.manualType = el.value; renderOverlay(); }
    if (el.id === "roleSel") { state.role = el.value; renderAll(); renderOverlay(); toast("已切换角色：" + roleLabel(state.role)); }
  });
  document.addEventListener("input", function (e) {
    if (e.target.matches("[data-f]")) updateManualPreview();
    if (e.target.id === "paletteInput") { state.paletteQuery = e.target.value; state.paletteIndex = 0; renderOverlay(); const i = document.getElementById("paletteInput"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  });
  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); state.palette = !state.palette; state.sheet = null; state.paletteQuery = ""; state.paletteIndex = 0; renderOverlay(); return; }
    if (e.key === "Escape") { state.sheet = null; state.palette = false; renderOverlay(); return; }
    if (state.palette) {
      if (e.key === "ArrowDown") { e.preventDefault(); state.paletteIndex = Math.min(state.paletteIndex + 1, paletteItems(state.paletteQuery || "").length - 1); renderOverlay(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); state.paletteIndex = Math.max(0, state.paletteIndex - 1); renderOverlay(); return; }
      if (e.key === "Enter") { e.preventDefault(); paletteGo(state.paletteIndex); return; }
    }
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches('[role="button"][data-act]')) { e.preventDefault(); e.target.click(); }
  });
  document.getElementById("themeBtn").addEventListener("click", function () { state.theme = state.theme === "light" ? "dark" : "light"; renderAll(); renderOverlay(); });
  window.addEventListener("resize", function () { fitStage(); requestAnimationFrame(mountCharts); });

  /* ── 启动（支持 ?platform=&theme=&role=&route= 深链，便于评审与截图） ── */
  (function initFromURL() {
    try {
      const q = new URLSearchParams(location.search);
      const p = q.get("platform"); if (p && SIZES[p]) state.platform = p;
      const t = q.get("theme"); if (t === "dark" || t === "light") state.theme = t;
      const r = q.get("role"); if (A.ROLES.some(x => x.id === r)) state.role = r;
      const route = q.get("route");
      if (route) { buildPages(); if (P[route]) { state.route = route; state.workspace = primaryOf(route) === "admin" ? "admin" : "athlete"; } }
      const LV = window.ARC_LIVE;
      if (LV) {
        const w = Number(q.get("window")); if ([7, 28, 42, 90].indexOf(w) >= 0) { LV.state.window = w; state.params.window = w; }
        const src = q.get("source"); if (["all", "device", "import", "manual"].indexOf(src) >= 0) LV.state.source = src;
        const st = q.get("status"); if (["ok", "loading", "empty", "error", "offline"].indexOf(st) >= 0) LV.state.status = st;
        if (q.get("live") === "0") LV.state.live = false;
      }
    } catch (err) { /* 忽略非法查询参数 */ }
  })();
  if (window.ARC_LIVE) {
    window.ARC_LIVE.setRenderer(renderChart);   // 实时引擎复用同一套 SVG 渲染器，保证状态一致
    window.ARC_LIVE.subscribe(s => { state.params.window = s.window; }); // 窗口双向同步
    window.ARC_LIVE.start();                    // SSE 仿真：1 Hz 增量推送
  }
  renderAll(); renderOverlay();

  /* ── 接入层需要的几个口子（supabase-client.js / ui-flows.js 调用） ── */
  window.ARC_RELOAD = function () { renderAll(); renderOverlay(); };
  window.ARC_SET_ROLE = function (id) {
    if (!A.ROLES.some(function (r) { return r.id === id; })) return false;
    state.role = id; return true;
  };
  window.ARC_DB_MODE = function (v) { state.dbLive = !!v; };
  window.ARC_GOTO = navigate;
  window.ARC_DEBUG = { state, P, load, computeLoad, LVP, oneRM, jumpH, navigate, openSheet, LIVE: window.ARC_LIVE };
})();
