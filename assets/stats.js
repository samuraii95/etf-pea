// Calculs de performance / risque sur une série de cours quotidiens.
// Une série = { dates: ["2024-01-02", ...], t: [timestamps UTC], c: [cours] }

export const DAY = 86400000;

export const PERIODS = {
  "1J": { label: "1 jour" },
  "1S": { label: "1 semaine", d: 7 },
  "1M": { label: "1 mois", m: 1 },
  "3M": { label: "3 mois", m: 3 },
  "6M": { label: "6 mois", m: 6 },
  "YTD": { label: "depuis le 1er janvier" },
  "1A": { label: "1 an", y: 1 },
  "3A": { label: "3 ans", y: 3 },
  "5A": { label: "5 ans", y: 5 },
  "10A": { label: "10 ans", y: 10 },
  "MAX": { label: "depuis la création" },
};

export function makeSeries(hist) {
  return { dates: hist.dates, t: hist.dates.map(d => Date.parse(d + "T00:00:00Z")), c: hist.close };
}

// Dernier indice dont la date est <= ts (-1 si aucun)
export function idxAtOrBefore(s, ts) {
  let lo = 0, hi = s.t.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.t[mid] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// Premier indice dont la date est >= ts
export function idxAtOrAfter(s, ts) {
  const i = idxAtOrBefore(s, ts);
  return i >= 0 && s.t[i] === ts ? i : i + 1;
}

function minusMonths(ts, months) {
  const d = new Date(ts);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() - months, day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, lastDay));
}

// Date de départ (timestamp) d'une période qui se termine au dernier cours
export function periodStartTs(lastTs, key) {
  const p = PERIODS[key];
  if (key === "YTD") return Date.UTC(new Date(lastTs).getUTCFullYear(), 0, 1) - DAY;
  if (p.d) return lastTs - p.d * DAY;
  if (p.m) return minusMonths(lastTs, p.m);
  if (p.y) return minusMonths(lastTs, 12 * p.y);
  return -Infinity;
}

// Indice de départ d'une période, ou null si l'historique est trop court
export function periodStartIdx(s, key) {
  const n = s.c.length;
  if (n < 2) return null;
  if (key === "MAX") return 0;
  if (key === "1J") return n - 2;
  const start = periodStartTs(s.t[n - 1], key);
  if (s.t[0] > start + 4 * DAY) return null; // le fonds n'existait pas encore
  return Math.max(0, idxAtOrBefore(s, start));
}

export function perf(s, key) {
  const i = periodStartIdx(s, key);
  if (i === null) return null;
  return s.c[s.c.length - 1] / s.c[i] - 1;
}

export function years(s, a = 0, b = s.c.length - 1) {
  return (s.t[b] - s.t[a]) / (365.25 * DAY);
}

// Performance annualisée entre deux indices (null si moins d'un an)
export function cagr(s, a = 0, b = s.c.length - 1) {
  const y = years(s, a, b);
  if (y < 0.98) return null;
  return Math.pow(s.c[b] / s.c[a], 1 / y) - 1;
}

export function annualizedFor(s, key) {
  const i = periodStartIdx(s, key);
  return i === null ? null : cagr(s, i);
}

// Volatilité annualisée (écart-type des rendements quotidiens x racine(252))
export function volatility(s, a, b = s.c.length - 1) {
  if (a === null || b - a < 5) return null;
  let sum = 0, sum2 = 0, n = 0;
  for (let i = a + 1; i <= b; i++) {
    const r = Math.log(s.c[i] / s.c[i - 1]);
    sum += r; sum2 += r * r; n++;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, (sum2 - n * mean * mean) / (n - 1))) * Math.sqrt(252);
}

// Plus forte baisse depuis un sommet, avec dates et date de retour au sommet
export function maxDrawdown(s, a = 0, b = s.c.length - 1) {
  let peak = a, best = { dd: 0, peak: a, trough: a, recovery: null };
  for (let i = a; i <= b; i++) {
    if (s.c[i] > s.c[peak]) peak = i;
    const dd = s.c[i] / s.c[peak] - 1;
    if (dd < best.dd) best = { dd, peak, trough: i, recovery: null };
  }
  if (best.dd < 0) {
    for (let i = best.trough; i <= b; i++) {
      if (s.c[i] >= s.c[best.peak]) { best.recovery = i; break; }
    }
  }
  return best;
}

// Statistiques d'une fenêtre [a, b]
export function windowStats(s, a, b) {
  let hi = a, lo = a;
  for (let i = a; i <= b; i++) {
    if (s.c[i] > s.c[hi]) hi = i;
    if (s.c[i] < s.c[lo]) lo = i;
  }
  return {
    perf: s.c[b] / s.c[a] - 1,
    cagr: cagr(s, a, b),
    high: hi, low: lo,
    vol: volatility(s, a, b),
    dd: maxDrawdown(s, a, b),
  };
}

export function sma(s, n) {
  const len = s.c.length;
  if (len < n) return null;
  let sum = 0;
  for (let i = len - n; i < len; i++) sum += s.c[i];
  return sum / n;
}

export function range52w(s) {
  const last = s.c.length - 1;
  const a = Math.max(0, idxAtOrAfter(s, s.t[last] - 365 * DAY));
  let hi = a, lo = a;
  for (let i = a; i <= last; i++) {
    if (s.c[i] > s.c[hi]) hi = i;
    if (s.c[i] < s.c[lo]) lo = i;
  }
  return { hi, lo, partial: s.t[0] > s.t[last] - 360 * DAY };
}

export function bestWorstDay(s) {
  let best = 1, worst = 1;
  for (let i = 1; i < s.c.length; i++) {
    const r = s.c[i] / s.c[i - 1] - 1;
    if (r > s.c[best] / s.c[best - 1] - 1) best = i;
    if (r < s.c[worst] / s.c[worst - 1] - 1) worst = i;
  }
  return {
    best, bestR: s.c[best] / s.c[best - 1] - 1,
    worst, worstR: s.c[worst] / s.c[worst - 1] - 1,
  };
}

// Performances par année civile (la première année peut être partielle)
export function calendarYears(s) {
  const out = [];
  const firstYear = +s.dates[0].slice(0, 4);
  let prevClose = null, startClose = s.c[0], year = firstYear;
  for (let i = 0; i < s.c.length; i++) {
    const y = +s.dates[i].slice(0, 4);
    const isLastOfYear = i === s.c.length - 1 || +s.dates[i + 1].slice(0, 4) !== y;
    if (y !== year) { year = y; startClose = prevClose; }
    if (isLastOfYear) {
      out.push({
        year: y,
        r: s.c[i] / startClose - 1,
        partial: y === firstYear && s.dates[0] > `${firstYear}-01-07`,
        ytd: i === s.c.length - 1,
      });
      prevClose = s.c[i];
    }
  }
  return out;
}

// Part des mois en hausse
export function positiveMonths(s) {
  const ends = [];
  for (let i = 0; i < s.c.length; i++) {
    if (i === s.c.length - 1 || s.dates[i + 1].slice(0, 7) !== s.dates[i].slice(0, 7)) ends.push(s.c[i]);
  }
  let up = 0, n = 0;
  for (let i = 1; i < ends.length; i++) { n++; if (ends[i] > ends[i - 1]) up++; }
  return n ? { share: up / n, up, n } : null;
}

// Investissement programmé : `amount` euros investis au premier cours de chaque mois, à partir de l'indice a.
// Renvoie la courbe [date, total versé, valeur], les totaux et le rendement annualisé des versements (TRI).
export function dca(s, amount, a = 0) {
  const points = [], flows = [];
  let units = 0, invested = 0, month = "";
  for (let i = a; i < s.c.length; i++) {
    const m = s.dates[i].slice(0, 7);
    if (m !== month) {
      month = m;
      units += amount / s.c[i];
      invested += amount;
      flows.push({ t: s.t[i], amount });
    }
    points.push([s.t[i], invested, Math.round(units * s.c[i] * 100) / 100]);
  }
  const tEnd = s.t[s.t.length - 1];
  const value = units * s.c[s.c.length - 1];
  return { points, invested, value, gain: value - invested, n: flows.length, irr: irr(flows, value, tEnd) };
}

// Taux annuel qui, appliqué à chaque versement depuis sa date, donne la valeur finale (recherche par dichotomie)
function irr(flows, finalValue, tEnd) {
  if (flows.length < 2 || tEnd - flows[0].t < 330 * DAY) return null; // moins d'un an : pas d'annualisation
  const futureValue = r => flows.reduce((sum, f) => sum + f.amount * Math.pow(1 + r, (tEnd - f.t) / (365.25 * DAY)), 0);
  let lo = -0.99, hi = 10;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (futureValue(mid) > finalValue) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
