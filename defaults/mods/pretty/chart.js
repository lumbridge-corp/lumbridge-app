// ```chart blocks as SVG: {"type":"bar"|"line"|"pie","title"?,"labels":[...],"series":[{"name","values":[...]}]}.
// Pure: returns the SVG text, or throws with a message for the person.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Round tick steps (1, 2, 5 × 10^n) covering [lo, hi] in about `count` steps. */
export function ticks(lo, hi, count = 5) {
  if (lo === hi) { hi = lo + 1; lo = Math.min(0, lo); }
  const raw = (hi - lo) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  if (out[out.length - 1] < hi) out.push(Number((out[out.length - 1] + step).toPrecision(12)));
  return out;
}

const fmt = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  return String(+v.toFixed(2));
};

/** Checks a chart spec and fills defaults. Throws on what can't be drawn. */
export function normalize(spec) {
  if (!spec || typeof spec !== "object") throw new Error("a chart is a JSON object");
  const type = String(spec.type ?? "bar").toLowerCase();
  if (!["bar", "line", "pie"].includes(type)) throw new Error(`unknown chart type "${spec.type}" (bar, line or pie)`);
  const series = (Array.isArray(spec.series) ? spec.series : []).map((s, i) => ({
    name: String(s?.name ?? `Series ${i + 1}`),
    values: (Array.isArray(s?.values) ? s.values : []).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0)),
  })).filter((s) => s.values.length);
  if (!series.length) throw new Error("a chart needs series with values");
  const n = Math.max(...series.map((s) => s.values.length));
  const labels = Array.from({ length: n }, (_, i) => String(spec.labels?.[i] ?? i + 1));
  return { type, title: spec.title ? String(spec.title) : null, labels, series };
}

/**
 * The chart as SVG. `colors`: { text, muted, grid, palette: [..] } (#rrggbb).
 */
export function chartSvg(input, colors, width = 640) {
  const spec = normalize(typeof input === "string" ? JSON.parse(input) : input);
  const pal = colors.palette;
  const font = 'font-family="Geist, Inter, Helvetica, Arial, sans-serif"';
  const parts = [];
  let top = 14;
  if (spec.title) {
    parts.push(`<text x="0" y="${top + 13}" ${font} font-size="15" font-weight="600" fill="${colors.text}">${esc(spec.title)}</text>`);
    top += 28;
  }
  const names = spec.type === "pie" ? spec.labels : spec.series.map((s) => s.name);
  if (names.length > 1 || spec.type === "pie") {
    let x = 0;
    names.forEach((name, i) => {
      const label = name.length > 24 ? `${name.slice(0, 23)}…` : name;
      const w = 22 + label.length * 7;
      if (x + w > width && x > 0) { x = 0; top += 20; }
      parts.push(`<rect x="${x}" y="${top + 2}" width="10" height="10" rx="2" fill="${pal[i % pal.length]}"/>`);
      parts.push(`<text x="${x + 15}" y="${top + 11}" ${font} font-size="12" fill="${colors.muted}">${esc(label)}</text>`);
      x += w + 10;
    });
    top += 26;
  }
  let height;
  if (spec.type === "pie") {
    const values = spec.series[0].values.map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    const r = 110, cx = width / 2, cy = top + r + 6, inner = r * 0.58;
    let a0 = -Math.PI / 2;
    values.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (a, rad) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
      if (v / total >= 0.9999) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${(r + inner) / 2}" fill="none" stroke="${pal[i % pal.length]}" stroke-width="${r - inner}"/>`);
      } else if (v > 0) {
        parts.push(`<path d="M ${p(a0, r)} A ${r} ${r} 0 ${large} 1 ${p(a1, r)} L ${p(a1, inner)} A ${inner} ${inner} 0 ${large} 0 ${p(a0, inner)} Z" fill="${pal[i % pal.length]}" stroke="${colors.bg}" stroke-width="2"/>`);
        const mid = (a0 + a1) / 2;
        if (v / total > 0.06) {
          parts.push(`<text x="${(cx + ((r + inner) / 2) * Math.cos(mid)).toFixed(1)}" y="${(cy + ((r + inner) / 2) * Math.sin(mid) + 4).toFixed(1)}" text-anchor="middle" ${font} font-size="11" font-weight="600" fill="${colors.bg}">${Math.round((v / total) * 100)}%</text>`);
        }
      }
      a0 = a1;
    });
    parts.push(`<text x="${cx}" y="${cy + 6}" text-anchor="middle" ${font} font-size="16" font-weight="600" fill="${colors.text}">${esc(fmt(total))}</text>`);
    height = cy + r + 10;
  } else {
    const all = spec.series.flatMap((s) => s.values);
    const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
    const ys = ticks(lo, hi, 5);
    const y0 = ys[0], y1 = ys[ys.length - 1];
    const left = 8 + Math.max(...ys.map((v) => fmt(v).length)) * 7.2;
    const plotH = 200, plotTop = top + 4, plotW = width - left - 8;
    const Y = (v) => plotTop + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;
    for (const v of ys) {
      const y = Y(v).toFixed(1);
      parts.push(`<line x1="${left}" x2="${left + plotW}" y1="${y}" y2="${y}" stroke="${colors.grid}" stroke-width="1"${v === 0 ? "" : ' stroke-dasharray="3 4"'}/>`);
      parts.push(`<text x="${left - 8}" y="${(+y + 4).toFixed(1)}" text-anchor="end" ${font} font-size="11" fill="${colors.muted}">${esc(fmt(v))}</text>`);
    }
    const n = spec.labels.length;
    const band = plotW / n;
    const every = Math.max(1, Math.ceil((n * 7 * Math.min(12, Math.max(...spec.labels.map((l) => l.length)))) / plotW));
    spec.labels.forEach((l, i) => {
      if (i % every) return;
      const label = l.length > 14 ? `${l.slice(0, 13)}…` : l;
      parts.push(`<text x="${(left + band * (i + 0.5)).toFixed(1)}" y="${plotTop + plotH + 18}" text-anchor="middle" ${font} font-size="11" fill="${colors.muted}">${esc(label)}</text>`);
    });
    if (spec.type === "bar") {
      const k = spec.series.length;
      const gap = Math.min(10, band * 0.2);
      const bw = Math.max(2, (band - gap * 2) / k - (k > 1 ? 2 : 0));
      spec.series.forEach((s, si) => {
        s.values.forEach((v, i) => {
          const x = left + band * i + gap + si * (bw + (k > 1 ? 2 : 0));
          const ya = Y(Math.max(0, v)), yb = Y(Math.min(0, v));
          parts.push(`<rect x="${x.toFixed(1)}" y="${ya.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, yb - ya).toFixed(1)}" rx="${Math.min(3, bw / 3).toFixed(1)}" fill="${pal[si % pal.length]}"/>`);
        });
      });
    } else {
      spec.series.forEach((s, si) => {
        const pts = s.values.map((v, i) => `${(left + band * (i + 0.5)).toFixed(1)},${Y(v).toFixed(1)}`);
        parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${pal[si % pal.length]}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`);
        if (s.values.length <= 40) for (const p of pts) {
          const [x, y] = p.split(",");
          parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="${colors.bg}" stroke="${pal[si % pal.length]}" stroke-width="2"/>`);
        }
      });
    }
    height = plotTop + plotH + 28;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.ceil(height)}" viewBox="0 0 ${width} ${Math.ceil(height)}">${parts.join("")}</svg>`;
}
