// Petites fonctions d'affichage partagées par les onglets (formatage FR, couleurs du thème, données).

export const $ = sel => document.querySelector(sel);
const NF = {};
export const nf = d => (NF[d] ||= new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }));
export const NBSP = " ";
export const euro = x => (x == null ? "—" : nf(2).format(x) + NBSP + "€");
export const pct = (x, d = 2) => (x == null || !isFinite(x) ? "—" : (x > 0 ? "+" : x < 0 ? "−" : "") + nf(d).format(Math.abs(x * 100)) + NBSP + "%");
export const cls = x => (x == null ? "" : x > 0 ? "up" : x < 0 ? "down" : "");
export const arrow = x => (x > 0 ? "▲ " : x < 0 ? "▼ " : "");
export const esc = str => String(str ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

export const dfDay = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const dfDayShort = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
export const dfMonth = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit", timeZone: "UTC" });
export const dfYear = new Intl.DateTimeFormat("fr-FR", { year: "numeric", timeZone: "UTC" });
export const dfTime = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
export const dfDayTime = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
export const dfFull = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
export const dfWeekday = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", timeZone: "Europe/Paris" });
const dfParisISO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" });
export const fmtDay = ts => dfDay.format(ts);
export const parisDay = ts => dfParisISO.format(ts); // "AAAA-MM-JJ"

export function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
export function alpha(hex, a) {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

export async function getJSON(url) {
  const r = await fetch(`${url}?v=${Math.floor(Date.now() / 60000)}`, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} : ${r.status}`);
  return r.json();
}

export function tooltipBase() {
  return {
    trigger: "axis", confine: true, borderWidth: 1, padding: [8, 10],
    backgroundColor: css("--surface"), borderColor: css("--border"),
    textStyle: { color: css("--ink") }, extraCssText: "box-shadow: 0 6px 24px rgba(0,0,0,.12); border-radius: 10px;",
    axisPointer: { type: "line", lineStyle: { color: css("--muted"), width: 1 } },
  };
}
