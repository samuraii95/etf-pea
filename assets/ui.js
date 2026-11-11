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

// ------------------------------------------------------------------ données
// Le robot publie les données sur la branche « data » du dépôt (adresse dans la balise <meta name="data-remote">).
// En ligne, on lit cette branche (toujours la plus fraîche) et on garde la copie livrée avec le site en secours.
// En local (localhost), c'est l'inverse : d'abord les fichiers du dossier data/.
const REMOTE = document.querySelector('meta[name="data-remote"]')?.content || "";
const LOCAL_FIRST = ["localhost", "127.0.0.1", ""].includes(location.hostname);
const bust = () => `?v=${Math.floor(Date.now() / 60000)}`;
let basePromise = null;

async function pickBase() {
  const order = !REMOTE ? ["data/"] : LOCAL_FIRST ? ["data/", REMOTE] : [REMOTE, "data/"];
  for (const base of order) {
    try {
      const r = await fetch(base + "meta.json" + bust(), { cache: "no-cache" });
      if (r.ok) return base;
    } catch { /* source injoignable : on essaie la suivante */ }
  }
  return "data/";
}

// url = "data/xxx.json" ; la source est choisie une fois par chargement (resetDataSource pour la rechoisir)
export async function getJSON(url) {
  const base = await (basePromise ||= pickBase());
  const r = await fetch(base + url.replace(/^data\//, "") + bust(), { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} : ${r.status}`);
  return r.json();
}

export function resetDataSource() { basePromise = null; }

// "il y a 12 min", "il y a 3 h", "il y a 2 j"
export function ago(date) {
  const min = Math.max(0, Math.round((Date.now() - new Date(date).getTime()) / 60000));
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min}${NBSP}min`;
  if (min < 48 * 60) return `il y a ${Math.round(min / 60)}${NBSP}h`;
  return `il y a ${Math.round(min / 1440)}${NBSP}j`;
}

export function tooltipBase() {
  return {
    trigger: "axis", confine: true, borderWidth: 1, padding: [8, 10],
    backgroundColor: css("--surface"), borderColor: css("--border"),
    textStyle: { color: css("--ink") }, extraCssText: "box-shadow: 0 6px 24px rgba(0,0,0,.12); border-radius: 10px;",
    axisPointer: { type: "line", lineStyle: { color: css("--muted"), width: 1 } },
  };
}
