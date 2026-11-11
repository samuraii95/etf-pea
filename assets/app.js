import * as S from "./stats.js";
import { $, nf, NBSP, euro, pct, cls, arrow, esc, dfDay, dfDayShort, dfMonth, dfYear, dfTime, dfDayTime, dfFull,
  dfWeekday, fmtDay, parisDay, css, alpha, getJSON, resetDataSource, ago, tooltipBase } from "./ui.js";
import { renderThermo, refreshThermo } from "./thermo.js";

// ------------------------------------------------------------------ réglages
const RANGES = ["1J", "1S", "1M", "3M", "6M", "1A", "3A", "5A", "MAX"];
const CMP_RANGES = ["1S", "1M", "3M", "6M", "YTD", "1A", "3A", "5A", "MAX"];
const LABEL = { "1J": "1J", "1S": "1S", "1M": "1M", "3M": "3M", "6M": "6M", YTD: "YTD", "1A": "1A", "3A": "3A", "5A": "5A", MAX: "Max" };
const TOP_PERIODS = [["1M", "1 mois"], ["1A", "1 an"], ["3A", "3 ans"], ["MAX", "Max"]];
const DEFAULT_CMP = ["WPEA", "ESE", "PUST", "PAASI", "PTPXE", "ESIT", "BNK", "HLT"];
const MAX_COLORED = 8;
const REFRESH_MS = 5 * 60 * 1000;
const DCA_RANGES = ["1A", "3A", "5A", "10A", "MAX"];
const TOUCH = matchMedia("(pointer: coarse)").matches;

const state = {
  etfs: [], byId: {}, series: {}, intraday: {}, meta: {}, union: null,
  tab: "suivi",
  selected: localStorage.getItem("etf") || "WPEA",
  range: localStorage.getItem("range") || "1A",
  log: false,
  peaOnly: localStorage.getItem("peaOnly") === "1",
  sort: localStorage.getItem("sort") || "day",
  dca: { amount: +localStorage.getItem("dcaAmount") || 100, range: localStorage.getItem("dcaRange") || "5A" },
  cmp: {
    range: localStorage.getItem("cmpRange") || "1A",
    selected: JSON.parse(localStorage.getItem("cmpSelected") || "null") || DEFAULT_CMP,
    peaOnly: false,
    showOthers: true,
    maxMode: "cagr",
    sortCol: "1A",
    sortDir: -1,
  },
};

let mainChart = null, yearChart = null, cmpChart = null, dcaChart = null;
let view = null;        // ce qui est affiché dans le graphique principal
let cmpView = null;     // idem pour la comparaison
let cmpRaf = 0;

// ------------------------------------------------------------------ formatage
function durationText(ms) {
  const months = Math.round(ms / (30.44 * S.DAY));
  if (months < 1) return `${Math.max(1, Math.round(ms / S.DAY))} j`;
  if (months < 24) return `${months} mois`;
  return `${nf(1).format(months / 12)} ans`;
}

// ------------------------------------------------------------------ données
async function loadData() {
  const [etfs, meta, intraday] = await Promise.all([
    getJSON("data/etfs.json"),
    getJSON("data/meta.json").catch(() => ({})),
    getJSON("data/intraday.json").catch(() => ({})),
  ]);
  const hists = await Promise.all(etfs.map(e => getJSON(`data/history/${e.id}.json`).catch(() => null)));
  state.etfs = etfs.filter((e, i) => hists[i] && hists[i].dates.length > 1);
  state.byId = Object.fromEntries(state.etfs.map(e => [e.id, e]));
  state.series = {};
  etfs.forEach((e, i) => { if (hists[i]) state.series[e.id] = S.makeSeries(hists[i]); });
  state.meta = meta;
  state.intraday = intraday || {};
  if (!state.byId[state.selected]) state.selected = state.etfs[0].id;
  state.cmp.selected = state.cmp.selected.map(id => (state.byId[id] ? id : null)).slice(0, MAX_COLORED);
  buildUnion();
}

// Calendrier commun à tous les ETF (pour la comparaison)
function buildUnion() {
  const set = new Set();
  for (const e of state.etfs) for (const d of state.series[e.id].dates) set.add(d);
  const dates = [...set].sort();
  const aligned = {};
  for (const e of state.etfs) {
    const s = state.series[e.id];
    const arr = new Array(dates.length);
    let j = 0, last = null;
    for (let i = 0; i < dates.length; i++) {
      while (j < s.dates.length && s.dates[j] <= dates[i]) last = s.c[j++];
      arr[i] = last; // null avant la création, puis dernier cours connu
    }
    aligned[e.id] = arr;
  }
  state.union = { dates, t: dates.map(d => Date.parse(d + "T00:00:00Z")), aligned };
}

const visibleEtfs = peaOnly => state.etfs.filter(e => !peaOnly || e.pea);
const peaBadge = e => (e.pea ? `<span class="badge pea" title="Éligible au PEA">PEA</span>` : `<span class="badge off" title="Non éligible au PEA">Hors PEA</span>`);

// ------------------------------------------------------------------ onglets & thème
function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
  $("#tab-suivi").hidden = tab !== "suivi";
  $("#tab-comparer").hidden = tab !== "comparer";
  $("#tab-thermo").hidden = tab !== "thermo";
  syncHash();
  if (tab === "suivi") renderSuivi();
  else if (tab === "comparer") renderComparer();
  else renderThermo();
  window.scrollTo({ top: 0 });
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  localStorage.setItem("theme", document.documentElement.dataset.theme);
  rerenderCharts();
}

function rerenderCharts() {
  if (state.tab === "suivi") { renderMainChart(true); renderYears(); renderDca(); }
  else if (state.tab === "comparer") { renderCmpChart(true); renderTop(); }
  else renderThermo();
}

// Adresse de la page : #suivi/WPEA, #comparer ou #thermo (un lien ouvre directement le bon ETF)
function readHash() {
  const [tab, id] = location.hash.slice(1).split("/");
  return { tab: ["comparer", "thermo"].includes(tab) ? tab : "suivi", id };
}

function syncHash() {
  const hash = state.tab === "suivi" ? `#suivi/${state.selected}` : "#" + state.tab;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function tabFromHash() {
  const { tab, id } = readHash();
  if (tab === "suivi" && state.byId[id]) state.selected = id;
  return tab;
}

// ------------------------------------------------------------------ onglet Suivi
function renderSuivi() {
  renderList();
  renderHead();
  renderRangeButtons();
  renderMainChart(false);
  renderStats();
  renderDca();
  renderYears();
  renderFund();
}

function renderList() {
  const items = visibleEtfs(state.peaOnly).map(e => ({ e, s: state.series[e.id] }));
  const by = {
    day: (a, b) => (S.perf(b.s, "1J") ?? -9) - (S.perf(a.s, "1J") ?? -9),
    "1A": (a, b) => (S.perf(b.s, "1A") ?? -9) - (S.perf(a.s, "1A") ?? -9),
    name: (a, b) => a.e.name.localeCompare(b.e.name, "fr"),
    config: () => 0,
  };
  items.sort(by[state.sort] || by.day);
  const ul = $("#etf-list");
  ul.innerHTML = items.map(({ e, s }) => {
    const d = S.perf(s, "1J");
    return `<li class="etf-item" data-id="${e.id}" aria-current="${e.id === state.selected}" tabindex="0">
      <div class="nm">${esc(e.name)}</div><div class="px">${euro(s.c.at(-1))}</div>
      <div class="sub"><b>${esc(e.id)}</b>${peaBadge(e)}<span>${esc(e.issuer)}</span></div>
      <div class="ch ${cls(d)}">${arrow(d)}${pct(d)}</div></li>`;
  }).join("");
  if (!items.some(x => x.e.id === state.selected) && items.length) selectEtf(items[0].e.id);
  const cur = ul.querySelector('[aria-current="true"]');
  if (cur && TOUCH) cur.scrollIntoView({ block: "nearest", inline: "center" });
}

function selectEtf(id) {
  state.selected = id;
  localStorage.setItem("etf", id);
  if (state.tab !== "suivi") return showTab("suivi");
  syncHash();
  renderSuivi();
}

function renderHead() {
  const e = state.byId[state.selected], s = state.series[e.id];
  $("#d-ticker").textContent = e.id;
  $("#d-isin").textContent = e.isin;
  $("#d-pea").outerHTML = `<span id="d-pea" class="badge ${e.pea ? "pea" : "off"}">${e.pea ? "Éligible PEA" : "Non éligible PEA"}</span>`;
  $("#d-name").textContent = e.name;
  $("#d-fullname").textContent = `${e.fullName} · ${e.index}`;
  const last = s.c.at(-1), prev = s.c.at(-2), d = last / prev - 1;
  $("#d-price").textContent = euro(last);
  $("#d-change").className = "change " + cls(d);
  $("#d-change").textContent = `${arrow(d)}${last - prev >= 0 ? "+" : "−"}${nf(2).format(Math.abs(last - prev))} € (${pct(d)}) sur la dernière séance`;
  const intra = state.intraday[e.id];
  const lastPt = intra?.day?.at(-1);
  $("#d-quote-time").textContent = lastPt && parisDay(lastPt[0]) === s.dates.at(-1)
    ? `Dernier cours : ${dfFull.format(lastPt[0])} · ${e.exchange}`
    : `Clôture du ${fmtDay(s.t.at(-1))} · ${e.exchange}`;
  document.title = `${e.id} ${euro(last)} · Mes ETF PEA`;
}

function rangeAvailable(key) {
  const s = state.series[state.selected], intra = state.intraday[state.selected];
  if (key === "1J") return !!(intra?.day?.length > 1);
  if (key === "1S") return true;
  return key === "MAX" || S.periodStartIdx(s, key) !== null;
}

function renderRangeButtons() {
  if (!rangeAvailable(state.range)) state.range = "MAX";
  $("#range-buttons").innerHTML = RANGES.map(k => {
    const ok = rangeAvailable(k);
    return `<button data-range="${k}" aria-pressed="${k === state.range}" ${ok ? "" : `disabled title="Historique trop court"`}>${LABEL[k]}</button>`;
  }).join("");
  $("#log-scale").disabled = state.range === "1J" || state.range === "1S";
}

// Prépare les données du graphique principal selon la période choisie
function buildView() {
  const id = state.selected, s = state.series[id], intra = state.intraday[id];
  if (state.range === "1J" || state.range === "1S") {
    const pts = state.range === "1J" ? intra?.day : intra?.week;
    if (pts?.length > 1) {
      const firstDay = Date.parse(parisDay(pts[0][0]) + "T00:00:00Z");
      const i = S.idxAtOrBefore(s, firstDay - 1);
      return {
        id, kind: "intra", labels: pts.map(p => p[0]), values: pts.map(p => p[1]),
        base: i >= 0 ? s.c[i] : pts[0][1], start: 0, end: pts.length - 1,
      };
    }
  }
  const key = state.range === "1J" ? "1S" : state.range;
  return { id, kind: "daily", labels: s.t, values: s.c, base: null, start: S.periodStartIdx(s, key) ?? 0, end: s.c.length - 1 };
}

function axisDateLabel(ts) {
  if (!view) return "";
  if (view.kind === "intra") return state.range === "1J" ? dfTime.format(ts) : dfWeekday.format(ts);
  const span = view.spanDays ?? 365;
  if (span <= 120) return dfDayShort.format(ts);
  if (span <= 1100) return dfMonth.format(ts);
  return dfYear.format(ts);
}

function sliderStyle(color) {
  return {
    type: "slider", height: 34, bottom: 8, left: 14, right: 64,
    borderColor: css("--border"), backgroundColor: "transparent",
    fillerColor: alpha(color, 0.10),
    dataBackground: { lineStyle: { color: css("--muted"), opacity: 0.5 }, areaStyle: { color: css("--muted"), opacity: 0.08 } },
    selectedDataBackground: { lineStyle: { color, opacity: 0.9 }, areaStyle: { color, opacity: 0.18 } },
    handleStyle: { color: css("--surface"), borderColor: css("--muted") },
    moveHandleStyle: { color: css("--muted"), opacity: 0.4 },
    emphasis: { handleStyle: { borderColor: color }, moveHandleStyle: { color, opacity: 0.7 } },
    textStyle: { color: css("--muted"), fontSize: 11 },
    labelFormatter: (v, str) => (view?.kind === "intra" ? (state.range === "1J" ? dfTime : dfDayTime).format(+str) : fmtDay(+str)),
    brushSelect: false, filterMode: "filter",
  };
}

// Zoom dans le graphique : Ctrl + molette (la molette seule fait défiler la page), glisser pour se déplacer.
// Sur écran tactile on garde seulement le curseur du bas pour ne pas bloquer le défilement.
function insideZoom() {
  return { type: "inside", filterMode: "filter", disabled: TOUCH, zoomOnMouseWheel: "ctrl", moveOnMouseWheel: false, moveOnMouseMove: true };
}

function renderMainChart(keepWindow) {
  if (!window.echarts) return;
  const old = view;
  view = buildView();
  if (keepWindow && old && old.id === view.id && old.kind === view.kind && mainChart) {
    const dz = mainChart.getOption().dataZoom?.[0];
    if (dz) {
      const oldLast = old.values.length - 1;
      view.start = Math.min(dz.startValue, view.values.length - 2);
      view.end = dz.endValue >= oldLast ? view.values.length - 1 : dz.endValue;
    }
  }
  mainChart ||= echarts.init($("#main-chart"));
  const ref = view.kind === "intra" ? view.base : view.values[view.start];
  const color = view.values[view.end] >= ref ? css("--up-line") : css("--down");
  const logAxis = state.log && view.kind === "daily";
  const base = view.base;

  mainChart.setOption({
    animation: false,
    grid: { left: 14, right: 64, top: 12, bottom: 70 },
    xAxis: {
      type: "category", data: view.labels, boundaryGap: false,
      axisLine: { lineStyle: { color: css("--axis") } }, axisTick: { show: false },
      axisLabel: { color: css("--muted"), hideOverlap: true, formatter: v => axisDateLabel(+v) },
    },
    yAxis: {
      type: logAxis ? "log" : "value", scale: !logAxis, position: "right",
      min: base ? v => Math.min(v.min, base) : logAxis ? v => v.min * 0.9 : undefined,
      max: base ? v => Math.max(v.max, base) : logAxis ? v => v.max * 1.1 : undefined,
      splitLine: { lineStyle: { color: css("--grid") } }, axisLine: { show: false },
      axisLabel: { color: css("--muted"), formatter: v => nf(v < 20 ? 2 : v < 1000 ? 1 : 0).format(v) },
    },
    tooltip: { ...tooltipBase(), formatter: mainTooltip },
    dataZoom: [
      { ...insideZoom(), startValue: view.start, endValue: view.end, minValueSpan: view.kind === "daily" ? 4 : 6 },
      { ...sliderStyle(color), startValue: view.start, endValue: view.end, minValueSpan: view.kind === "daily" ? 4 : 6 },
    ],
    series: [{
      type: "line", data: view.values, showSymbol: false, symbolSize: 8, sampling: "lttb",
      lineStyle: { width: 2, color }, itemStyle: { color },
      areaStyle: logAxis ? undefined : {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: alpha(color, 0.25) }, { offset: 1, color: alpha(color, 0.01) }]),
      },
      markLine: base ? {
        symbol: "none", silent: true, data: [{ yAxis: base }],
        lineStyle: { type: "dashed", color: css("--muted"), width: 1 },
        label: { formatter: "Clôture précédente", position: "insideStartTop", color: css("--muted"), fontSize: 11 },
      } : undefined,
    }],
  }, true);
  view.color = color;
  mainChart.off("datazoom");
  mainChart.on("datazoom", () => {
    const dz = mainChart.getOption().dataZoom[0];
    updateWindow(dz.startValue, dz.endValue);
  });
  updateWindow(view.start, view.end);
}

function mainTooltip(params) {
  const p = params[0];
  if (!p || p.value == null) return "";
  const ts = +p.axisValue, v = +p.value;
  const ref = view.kind === "intra" ? view.base : view.values[view.winStart ?? view.start];
  const r = v / ref - 1;
  const when = view.kind === "intra" ? dfDayTime.format(ts) : fmtDay(ts);
  const vs = view.kind === "intra" ? "vs clôture précédente" : "vs début de la fenêtre";
  return `<div class="tt"><div class="tt-date">${when}</div><div class="tt-big">${euro(v)}</div>
    <div class="${cls(r)}">${arrow(r)}${pct(r)} <span class="muted">${vs}</span></div></div>`;
}

// Statistiques de la fenêtre visible (mises à jour quand on zoome)
function updateWindow(a, b) {
  if (!view) return;
  a = Math.max(0, Math.round(a)); b = Math.min(view.values.length - 1, Math.round(b));
  view.winStart = a; view.winEnd = b;
  view.spanDays = (view.labels[b] - view.labels[a]) / S.DAY;
  const box = $("#window-stats");
  const ws = (label, value, klass = "", big = false) => `<div class="ws ${big ? "big" : ""}"><b class="${klass}">${value}</b><span>${label}</span></div>`;
  let html;
  if (view.kind === "intra") {
    const ref = a === 0 ? view.base : view.values[a];
    const r = view.values[b] / ref - 1;
    const slice = view.values.slice(a, b + 1);
    html = ws(`${a === 0 ? "depuis la clôture précédente" : "sur la fenêtre"} · ${dfDayTime.format(view.labels[a])} → ${dfTime.format(view.labels[b])}`, arrow(r) + pct(r), cls(r), true)
      + ws("plus haut", euro(Math.max(...slice))) + ws("plus bas", euro(Math.min(...slice)));
  } else {
    const s = state.series[view.id];
    const st = S.windowStats(s, a, b);
    html = ws(`performance · ${fmtDay(s.t[a])} → ${fmtDay(s.t[b])}`, arrow(st.perf) + pct(st.perf), cls(st.perf), true)
      + (st.cagr != null ? ws("par an (annualisée)", pct(st.cagr), cls(st.cagr)) : "")
      + ws("volatilité annualisée", pct(st.vol, 1).replace("+", ""))
      + ws("baisse max. dans la fenêtre", pct(st.dd.dd, 1), st.dd.dd < 0 ? "down" : "")
      + ws(`plus haut · ${fmtDay(s.t[st.high])}`, euro(s.c[st.high]))
      + ws(`plus bas · ${fmtDay(s.t[st.low])}`, euro(s.c[st.low]));
  }
  box.innerHTML = html;
  // la couleur de la courbe suit le signe de la performance de la fenêtre
  const ref = view.kind === "intra" && a === 0 ? view.base : view.values[a];
  const color = view.values[b] >= ref ? css("--up-line") : css("--down");
  if (color !== view.color) {
    view.color = color;
    const area = state.log && view.kind === "daily" ? undefined : {
      color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: alpha(color, 0.25) }, { offset: 1, color: alpha(color, 0.01) }]),
    };
    mainChart.setOption({
      series: [{ lineStyle: { color }, itemStyle: { color }, areaStyle: area }],
      dataZoom: [{}, { fillerColor: alpha(color, 0.10), selectedDataBackground: { lineStyle: { color }, areaStyle: { color, opacity: 0.18 } } }],
    });
  }
}

function tile(label, value, detail = "", klass = "") {
  return `<div class="tile"><div class="lbl">${label}</div><div class="val ${klass}">${value}</div>${detail ? `<div class="det">${detail}</div>` : ""}</div>`;
}

function renderStats() {
  const e = state.byId[state.selected], s = state.series[e.id];
  const n = s.c.length, last = s.c[n - 1];
  const p = k => S.perf(s, k);
  const perfTile = (k, label, extra = "") => tile(label, p(k) == null ? "—" : arrow(p(k)) + pct(p(k)), p(k) == null ? "historique trop court" : extra, cls(p(k)));

  // ---- court terme
  const r52 = S.range52w(s);
  const i1m = S.periodStartIdx(s, "1M");
  const ma50 = S.sma(s, 50), ma200 = S.sma(s, 200);
  const vsMA = ma => (ma ? `cours ${last >= ma ? "au-dessus" : "en dessous"} (${pct(last / ma - 1, 1)})` : "historique trop court");
  let trend = "—";
  if (ma50 && ma200) trend = last > ma50 && ma50 > ma200 ? "Haussière" : last < ma50 && ma50 < ma200 ? "Baissière" : "Neutre";
  $("#short-stats").innerHTML = [
    perfTile("1J", "1 jour", `${last - s.c[n - 2] >= 0 ? "+" : "−"}${nf(2).format(Math.abs(last - s.c[n - 2]))} €`),
    perfTile("1S", "1 semaine"),
    perfTile("1M", "1 mois"),
    perfTile("3M", "3 mois"),
    perfTile("6M", "6 mois"),
    perfTile("YTD", `Depuis le 1er janv.`),
    tile("Volatilité 1 mois", i1m == null ? "—" : nf(1).format(S.volatility(s, i1m) * 100) + NBSP + "%", "annualisée"),
    tile(`Plus haut 52 sem.${r52.partial ? "*" : ""}`, euro(s.c[r52.hi]), `${fmtDay(s.t[r52.hi])} · ${pct(last / s.c[r52.hi] - 1, 1)} du sommet`),
    tile(`Plus bas 52 sem.${r52.partial ? "*" : ""}`, euro(s.c[r52.lo]), `${fmtDay(s.t[r52.lo])} · ${pct(last / s.c[r52.lo] - 1, 1)} depuis`),
    tile("Moyenne mobile 50 j", ma50 ? euro(ma50) : "—", vsMA(ma50)),
    tile("Moyenne mobile 200 j", ma200 ? euro(ma200) : "—", vsMA(ma200)),
    tile("Tendance (MM50 / MM200)", trend, "cours vs moyennes mobiles", trend === "Haussière" ? "up" : trend === "Baissière" ? "down" : ""),
  ].join("");

  // ---- long terme
  const ann = k => { const a = S.annualizedFor(s, k); return a == null ? "" : `soit ${pct(a)} par an`; };
  const cagrMax = S.cagr(s);
  const i1a = S.periodStartIdx(s, "1A"), i3a = S.periodStartIdx(s, "3A"), i5a = S.periodStartIdx(s, "5A");
  const dd = S.maxDrawdown(s);
  const ddDet = dd.dd < 0
    ? `${fmtDay(s.t[dd.peak])} → ${fmtDay(s.t[dd.trough])} · ${dd.recovery != null ? `remonté en ${durationText(s.t[dd.recovery] - s.t[dd.trough])}` : "sommet pas encore retrouvé"}`
    : "";
  const riskIdx = i5a ?? 0;
  const riskRet = S.cagr(s, riskIdx), riskVol = S.volatility(s, riskIdx);
  const pm = S.positiveMonths(s);
  const yrs = S.calendarYears(s).filter(y => !y.partial && !y.ytd);
  const bestY = yrs.length >= 2 ? yrs.reduce((a, b) => (b.r > a.r ? b : a)) : null;
  const worstY = yrs.length >= 2 ? yrs.reduce((a, b) => (b.r < a.r ? b : a)) : null;
  const bw = S.bestWorstDay(s);
  $("#long-stats").innerHTML = [
    perfTile("1A", "1 an"),
    perfTile("3A", "3 ans", ann("3A")),
    perfTile("5A", "5 ans", ann("5A")),
    tile("Depuis la création", arrow(p("MAX")) + pct(p("MAX"), 1), `depuis le ${fmtDay(s.t[0])}`, cls(p("MAX"))),
    tile("Perf. annualisée (max)", cagrMax == null ? "—" : pct(cagrMax), cagrMax == null ? "moins d'un an d'historique" : `sur ${nf(1).format(S.years(s))} ans`, cls(cagrMax)),
    tile("Volatilité 1 an", i1a == null ? "—" : nf(1).format(S.volatility(s, i1a) * 100) + NBSP + "%", "annualisée"),
    tile("Volatilité 3 ans", i3a == null ? "—" : nf(1).format(S.volatility(s, i3a) * 100) + NBSP + "%", "annualisée"),
    tile("Baisse max. historique", pct(dd.dd, 1), ddDet, dd.dd < 0 ? "down" : ""),
    tile(`Rendement / risque ${i5a != null ? "5 ans" : "(max)"}`, riskRet != null && riskVol ? nf(2).format(riskRet / riskVol) : "—", "perf. annualisée ÷ volatilité"),
    tile("Mois en hausse", pm ? nf(0).format(pm.share * 100) + NBSP + "%" : "—", pm ? `${pm.up} sur ${pm.n} mois` : ""),
    tile("Meilleure année", bestY ? pct(bestY.r, 1) : "—", bestY ? String(bestY.year) : "moins de 2 années complètes", cls(bestY?.r)),
    tile("Pire année", worstY ? pct(worstY.r, 1) : "—", worstY ? String(worstY.year) : "", cls(worstY?.r)),
    tile("Meilleure séance", pct(bw.bestR), fmtDay(s.t[bw.best]), "up"),
    tile("Pire séance", pct(bw.worstR), fmtDay(s.t[bw.worst]), "down"),
  ].join("");
}

// Simulateur : et si j'avais investi X euros chaque mois dans cet ETF ?
function renderDca() {
  const s = state.series[state.selected];
  if (!window.echarts || !s) return;
  const eur0 = x => nf(0).format(x) + NBSP + "€";
  const available = k => k === "MAX" || S.periodStartIdx(s, k) !== null;
  if (!available(state.dca.range)) state.dca.range = "MAX";
  $("#dca-range").innerHTML = DCA_RANGES.map(k =>
    `<button data-range="${k}" aria-pressed="${k === state.dca.range}" ${available(k) ? "" : `disabled title="Historique trop court"`}>${k === "MAX" ? "Max" : k}</button>`).join("");
  if (document.activeElement !== $("#dca-amount")) $("#dca-amount").value = state.dca.amount;

  const a = S.periodStartIdx(s, state.dca.range) ?? 0;
  const r = S.dca(s, state.dca.amount, a);
  const ratio = r.gain / r.invested;
  const ws = (label, value, klass = "", big = false) => `<div class="ws ${big ? "big" : ""}"><b class="${klass}">${value}</b><span>${label}</span></div>`;
  $("#dca-stats").innerHTML =
    ws("valeur aujourd'hui", eur0(r.value), "", true)
    + ws(`versé en ${r.n} mensualités`, eur0(r.invested))
    + ws("plus ou moins-value", `${r.gain >= 0 ? "+" : "−"}${eur0(Math.abs(r.gain))} (${pct(ratio, 1)})`, cls(r.gain))
    + (r.irr != null ? ws("rendement annualisé des versements", pct(r.irr, 1), cls(r.irr)) : "");
  $("#dca-note").textContent = `Simulation sur les cours passés : ${nf(0).format(state.dca.amount)} € investis au premier cours de chaque mois depuis le ${fmtDay(s.t[a])}, sans frais de courtage ni fiscalité. Les performances passées ne préjugent pas des performances futures.`;

  dcaChart ||= echarts.init($("#dca-chart"));
  const value = css("--s1"), paid = css("--ink-2");
  dcaChart.setOption({
    animation: false,
    grid: { left: 8, right: 8, top: 30, bottom: 4, containLabel: true },
    legend: { top: 0, left: 0, itemWidth: 14, itemHeight: 3, icon: "rect", textStyle: { color: css("--ink-2"), fontSize: 12 } },
    xAxis: {
      type: "time", axisLine: { lineStyle: { color: css("--axis") } }, axisTick: { show: false },
      axisLabel: { color: css("--muted"), hideOverlap: true, formatter: v => (s.t.at(-1) - s.t[a] > 800 * S.DAY ? dfYear.format(v) : dfMonth.format(v)) },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value", position: "right", splitLine: { lineStyle: { color: css("--grid") } },
      axisLabel: { color: css("--muted"), formatter: v => nf(0).format(v) + " €" },
    },
    tooltip: {
      ...tooltipBase(),
      formatter: ps => {
        const [t, inv, val] = r.points[ps[0].dataIndex];
        const g = val - inv;
        return `<div class="tt"><div class="tt-date">${fmtDay(t)}</div>
          <div class="tt-row"><i style="background:${value}"></i><b>${eur0(val)}</b><span>Valeur</span></div>
          <div class="tt-row"><i style="background:${paid}"></i><b>${eur0(inv)}</b><span>Versé</span></div>
          <div class="${cls(g)}">${g >= 0 ? "+" : "−"}${eur0(Math.abs(g))} (${pct(g / inv, 1)})</div></div>`;
      },
    },
    series: [
      { name: "Valeur du portefeuille", type: "line", data: r.points.map(p => [p[0], p[2]]), showSymbol: false, symbolSize: 7,
        lineStyle: { width: 2, color: value }, itemStyle: { color: value },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: alpha(value, 0.2) }, { offset: 1, color: alpha(value, 0.01) }]) } },
      { name: "Total versé", type: "line", step: "end", data: r.points.map(p => [p[0], p[1]]), showSymbol: false, symbolSize: 7,
        lineStyle: { width: 1.5, color: paid, type: "dashed" }, itemStyle: { color: paid } },
    ],
  }, true);
}

function renderYears() {
  const s = state.series[state.selected];
  if (!window.echarts || !s) return;
  yearChart ||= echarts.init($("#year-chart"));
  const ys = S.calendarYears(s);
  const up = css("--up-line"), down = css("--down");
  const showLabels = ys.length <= 12;
  yearChart.setOption({
    animation: false,
    grid: { left: 8, right: 8, top: showLabels ? 22 : 10, bottom: 4, containLabel: true },
    xAxis: {
      type: "category", data: ys.map(y => y.year + (y.partial ? "*" : "")),
      axisLine: { lineStyle: { color: css("--axis") } }, axisTick: { show: false },
      axisLabel: { color: css("--muted"), hideOverlap: true },
    },
    yAxis: {
      type: "value", splitLine: { lineStyle: { color: css("--grid") } },
      axisLabel: { color: css("--muted"), formatter: v => nf(0).format(v) + " %" },
    },
    tooltip: {
      ...tooltipBase(), axisPointer: { type: "shadow", shadowStyle: { color: alpha(css("--muted"), 0.12) } },
      formatter: ps => {
        const y = ys[ps[0].dataIndex];
        return `<div class="tt"><div class="tt-date">${y.year}${y.partial ? " (année incomplète, depuis la création)" : y.ytd ? " (depuis le 1er janvier)" : ""}</div><div class="tt-big ${cls(y.r)}">${pct(y.r)}</div></div>`;
      },
    },
    series: [{
      type: "bar", barMaxWidth: 28,
      data: ys.map(y => ({
        value: +(y.r * 100).toFixed(2),
        itemStyle: { color: y.r >= 0 ? up : down, opacity: y.partial || y.ytd ? 0.55 : 1, borderRadius: y.r >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] },
      })),
      label: { show: showLabels, position: "top", color: css("--ink-2"), fontSize: 11, formatter: o => pct(o.value / 100, 1) },
    }],
  }, true);
  $("#year-note").textContent = ys.some(y => y.partial) ? "* première année incomplète (le fonds a démarré en cours d'année). Barres atténuées : années incomplètes." : "Barre atténuée : année en cours.";
}

function renderFund() {
  const e = state.byId[state.selected], s = state.series[e.id], m = state.meta?.etfs?.[e.id] || {};
  const created = Date.parse(e.inception + "T00:00:00Z");
  const gap = s.t[0] - created > 20 * S.DAY;
  const rows = [
    ["Nom complet", esc(e.fullName)],
    ["ISIN", esc(e.isin)],
    ["Émetteur", esc(e.issuer)],
    ["Indice suivi", esc(e.index)],
    ["Exposition", esc(e.zone)],
    ["Éligible PEA", e.pea ? `<span class="up">Oui</span>` : `<span class="down">Non</span>`],
    ["Réplication", esc(e.replication)],
    ["Frais courants (TER)", nf(2).format(e.ter) + NBSP + "% / an"],
    ["Création du fonds", fmtDay(created)],
    ["Historique affiché depuis", fmtDay(s.t[0]) + (gap ? ` <span class="muted">(premiers cours disponibles)</span>` : "")],
    ["Place de cotation", esc(e.exchange)],
    ["Source des cours", m.source === "yahoo" ? "Yahoo Finance" : "Boursorama"],
  ];
  $("#fund-sheet").innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");
}

// ------------------------------------------------------------------ onglet Comparer
function renderComparer() {
  $("#cmp-range-buttons").innerHTML = CMP_RANGES.map(k => `<button data-range="${k}" aria-pressed="${k === state.cmp.range}">${LABEL[k]}</button>`).join("");
  renderChips();
  renderCmpChart(false);
  renderTop();
  renderTable();
}

function slotColor(id) {
  const i = state.cmp.selected.indexOf(id);
  return i >= 0 ? css(`--s${i + 1}`) : null;
}

function renderChips() {
  $("#cmp-chips").innerHTML = visibleEtfs(state.cmp.peaOnly).map(e => {
    const on = state.cmp.selected.includes(e.id);
    const color = on ? slotColor(e.id) : "";
    return `<button class="chip" data-id="${e.id}" aria-pressed="${on}" title="${esc(e.fullName)}">
      <span class="key" style="${color ? `background:${color}` : ""}"></span><b>${esc(e.id)}</b><span class="cn">${esc(e.name)}</span></button>`;
  }).join("");
}

// Courbes en % depuis le début de la fenêtre [a, ...]
function rebased(id, a) {
  const arr = state.union.aligned[id];
  let b = a;
  while (b < arr.length && arr[b] == null) b++;
  if (b >= arr.length) return arr.map(() => null);
  const ref = arr[b];
  return arr.map((v, i) => (v == null || i < b ? null : Math.round((v / ref - 1) * 10000) / 100));
}

function cmpWindowStart(key) {
  const u = state.union, last = u.t.length - 1;
  if (key === "MAX") {
    // début = premier cours du plus ancien ETF affiché
    const ids = visibleEtfs(state.cmp.peaOnly).map(e => e.id);
    return Math.min(...ids.map(id => u.aligned[id].findIndex(v => v != null)));
  }
  return Math.max(0, S.idxAtOrBefore(u, S.periodStartTs(u.t[last], key)));
}

function cmpSeries(a) {
  const ids = visibleEtfs(state.cmp.peaOnly).map(e => e.id);
  const colored = ids.filter(id => state.cmp.selected.includes(id));
  const others = state.cmp.showOthers ? ids.filter(id => !colored.includes(id)) : [];
  const muted = css("--muted");
  return [...others, ...colored].map(id => {
    const c = slotColor(id);
    return {
      id, name: id, type: "line", data: rebased(id, a), showSymbol: false, symbolSize: 7, sampling: "lttb",
      lineStyle: { width: c ? 2 : 1, color: c || muted, opacity: c ? 1 : 0.45 },
      itemStyle: { color: c || muted }, z: c ? 3 : 1,
      emphasis: { focus: "series", lineStyle: { width: c ? 3 : 2 } },
      blur: { lineStyle: { opacity: 0.15 } },
    };
  });
}

function renderCmpChart(keepWindow) {
  if (!window.echarts) return;
  cmpChart ||= echarts.init($("#cmp-chart"));
  const u = state.union, last = u.t.length - 1;
  let a = cmpWindowStart(state.cmp.range), b = last;
  if (keepWindow && cmpView) { a = cmpView.a; b = cmpView.b; }
  cmpView = { a, b };
  const accent = css("--accent");
  cmpChart.setOption({
    animation: false,
    grid: { left: 14, right: 64, top: 12, bottom: 70 },
    xAxis: {
      type: "category", data: u.t, boundaryGap: false,
      axisLine: { lineStyle: { color: css("--axis") } }, axisTick: { show: false },
      axisLabel: {
        color: css("--muted"), hideOverlap: true,
        formatter: v => { const span = (u.t[cmpView.b] - u.t[cmpView.a]) / S.DAY; return span <= 120 ? dfDayShort.format(+v) : span <= 1100 ? dfMonth.format(+v) : dfYear.format(+v); },
      },
    },
    yAxis: {
      type: "value", scale: true, position: "right",
      splitLine: { lineStyle: { color: css("--grid") } },
      axisLabel: { color: css("--muted"), formatter: v => (v > 0 ? "+" : v < 0 ? "−" : "") + nf(Math.abs(v) < 10 ? 1 : 0).format(Math.abs(v)) + " %" },
    },
    tooltip: { ...tooltipBase(), formatter: cmpTooltip },
    dataZoom: [
      { ...insideZoom(), startValue: a, endValue: b, minValueSpan: 4 },
      { ...sliderStyle(accent), showDataShadow: false, startValue: a, endValue: b, minValueSpan: 4, labelFormatter: (v, str) => fmtDay(+str) },
    ],
    series: cmpSeries(a),
  }, true);
  cmpChart.off("datazoom");
  cmpChart.on("datazoom", () => {
    const dz = cmpChart.getOption().dataZoom[0];
    const na = Math.round(dz.startValue), nb = Math.round(dz.endValue);
    const rebase = na !== cmpView.a;
    cmpView = { a: na, b: nb };
    if (rebase) {
      cancelAnimationFrame(cmpRaf);
      cmpRaf = requestAnimationFrame(() => cmpChart.setOption({ series: cmpSeries(na).map(s => ({ id: s.id, data: s.data })) }));
    }
  });
}

function cmpTooltip(params) {
  const rows = params.filter(p => p.value != null).sort((x, y) => y.value - x.value);
  if (!rows.length) return "";
  const head = `<div class="tt-date">${fmtDay(+params[0].axisValue)} · depuis le ${fmtDay(state.union.t[cmpView.a])}</div>`;
  return `<div class="tt">${head}${rows.map(p => {
    const c = slotColor(p.seriesName);
    const v = p.value / 100;
    return `<div class="tt-row ${c ? "" : "ctx"}"><i style="background:${c || css("--muted")}"></i><b class="${c ? cls(v) : ""}">${pct(v, 1)}</b><span>${esc(p.seriesName)} · ${esc(state.byId[p.seriesName].name)}</span></div>`;
  }).join("")}</div>`;
}

function topValue(s, key) {
  if (key !== "MAX") return { v: S.perf(s, key), sub: key === "3A" ? S.annualizedFor(s, "3A") : null };
  const total = S.perf(s, "MAX"), ann = S.cagr(s);
  return state.cmp.maxMode === "cagr" ? { v: ann, sub: total } : { v: total, sub: ann };
}

function renderTop() {
  const etfs = visibleEtfs(state.cmp.peaOnly);
  $("#top-grid").innerHTML = TOP_PERIODS.map(([key, label]) => {
    const rows = etfs.map(e => ({ e, s: state.series[e.id], ...topValue(state.series[e.id], key) }));
    const ok = rows.filter(r => r.v != null).sort((x, y) => y.v - x.v).slice(0, 10);
    const missing = rows.filter(r => r.v == null).map(r => r.e.id);
    const maxAbs = Math.max(...ok.map(r => Math.abs(r.v)), 1e-9);
    const toggle = key === "MAX"
      ? `<div class="seg" role="group" aria-label="Mode de classement Max">
          <button data-maxmode="cagr" aria-pressed="${state.cmp.maxMode === "cagr"}">par an</button>
          <button data-maxmode="total" aria-pressed="${state.cmp.maxMode === "total"}">total</button></div>`
      : "";
    const subText = r => {
      if (key === "3A" && r.sub != null) return `<small>${pct(r.sub, 1)}/an</small>`;
      if (key === "MAX") {
        const since = `depuis ${r.s.dates[0].slice(0, 4)}`;
        return state.cmp.maxMode === "cagr" ? `<small>${pct(r.sub, 0)} · ${since}</small>` : `<small>${r.sub != null ? pct(r.sub, 1) + "/an · " : ""}${since}</small>`;
      }
      return "";
    };
    const title = key === "MAX" ? (state.cmp.maxMode === "cagr" ? "Max · perf. annualisée" : "Max · perf. totale") : label;
    return `<div class="card top-card">
      <div class="top-head"><h3>Top 10 · ${title}</h3>${toggle}</div>
      <ol class="rank">${ok.map((r, i) => `
        <li data-id="${r.e.id}" title="${esc(r.e.fullName)}">
          <span class="pos">${i + 1}</span>
          <div style="min-width:0"><div class="rn">${esc(r.e.name)}</div><div class="rs">${esc(r.e.id)} · ${r.e.pea ? "PEA" : "hors PEA"}</div></div>
          <div class="rv ${cls(r.v)}">${pct(r.v, 1)}${subText(r)}</div>
          <div class="bar"><i style="width:${(Math.abs(r.v) / maxAbs) * 100}%;background:${r.v >= 0 ? css("--up-line") : css("--down")}"></i></div>
        </li>`).join("")}</ol>
      ${missing.length ? `<p class="top-foot">Historique trop court : ${missing.map(esc).join(", ")}</p>` : ""}
      ${key === "MAX" && state.cmp.maxMode === "cagr" ? `<p class="top-foot">Classé par performance annualisée pour comparer des fonds d'âges différents.</p>` : ""}
    </div>`;
  }).join("");
}

const TABLE_COLS = [
  { key: "name", label: "ETF" },
  { key: "price", label: "Cours" },
  { key: "1J", label: "1J" }, { key: "1S", label: "1S" }, { key: "1M", label: "1M" }, { key: "3M", label: "3M" },
  { key: "6M", label: "6M" }, { key: "YTD", label: "YTD" }, { key: "1A", label: "1A" }, { key: "3A", label: "3A" },
  { key: "5A", label: "5A" }, { key: "MAX", label: "Max" },
  { key: "cagr", label: "Par an (max)" }, { key: "vol", label: "Vol. 1A" }, { key: "dd", label: "Baisse max." },
  { key: "since", label: "Depuis" },
];

function tableRow(e) {
  const s = state.series[e.id];
  const i1a = S.periodStartIdx(s, "1A");
  const r = { e, name: e.name, price: s.c.at(-1), cagr: S.cagr(s), vol: i1a == null ? null : S.volatility(s, i1a), dd: S.maxDrawdown(s).dd, since: s.t[0] };
  for (const k of ["1J", "1S", "1M", "3M", "6M", "YTD", "1A", "3A", "5A", "MAX"]) r[k] = S.perf(s, k);
  return r;
}

function renderTable() {
  const { sortCol, sortDir } = state.cmp;
  const rows = visibleEtfs(state.cmp.peaOnly).map(tableRow);
  rows.sort((x, y) => {
    const a = x[sortCol], b = y[sortCol];
    if (typeof a === "string") return sortDir * a.localeCompare(b, "fr");
    if (a == null) return 1;
    if (b == null) return -1;
    return sortDir * (a - b);
  });
  const head = `<thead><tr>${TABLE_COLS.map(c => `<th data-col="${c.key}" ${c.key === sortCol ? `aria-sort="${sortDir > 0 ? "ascending" : "descending"}"` : ""}>${c.label}${c.key === sortCol ? (sortDir > 0 ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead>`;
  const body = rows.map(r => `<tr>${TABLE_COLS.map(c => {
    const v = r[c.key];
    if (c.key === "name") return `<td data-id="${r.e.id}"><b>${esc(r.e.id)}</b> ${esc(r.e.name)} ${peaBadge(r.e)}</td>`;
    if (c.key === "price") return `<td>${euro(v)}</td>`;
    if (c.key === "vol") return `<td>${v == null ? "—" : nf(1).format(v * 100) + NBSP + "%"}</td>`;
    if (c.key === "dd") return `<td class="down">${pct(v, 1)}</td>`;
    if (c.key === "since") return `<td class="muted">${dfYear.format(v)}</td>`;
    return `<td class="${cls(v)}">${pct(v, 1)}</td>`;
  }).join("")}</tr>`).join("");
  $("#perf-table").innerHTML = head + `<tbody>${body}</tbody>`;
}

// ------------------------------------------------------------------ évènements
function bindEvents() {
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#theme-btn").addEventListener("click", toggleTheme);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderCharts);

  $("#etf-list").addEventListener("click", ev => { const li = ev.target.closest(".etf-item"); if (li) selectEtf(li.dataset.id); });
  $("#etf-list").addEventListener("keydown", ev => { if (ev.key === "Enter") { const li = ev.target.closest(".etf-item"); if (li) selectEtf(li.dataset.id); } });
  $("#pea-only").checked = state.peaOnly;
  $("#pea-only").addEventListener("change", ev => { state.peaOnly = ev.target.checked; localStorage.setItem("peaOnly", state.peaOnly ? "1" : "0"); renderList(); });
  $("#sort-select").value = state.sort;
  $("#sort-select").addEventListener("change", ev => { state.sort = ev.target.value; localStorage.setItem("sort", state.sort); renderList(); });

  $("#range-buttons").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-range]");
    if (!b || b.disabled) return;
    state.range = b.dataset.range;
    localStorage.setItem("range", state.range);
    renderRangeButtons();
    renderMainChart(false);
  });
  $("#log-scale").addEventListener("change", ev => { state.log = ev.target.checked; renderMainChart(true); });
  $("#reset-zoom").addEventListener("click", () => renderMainChart(false));

  $("#dca-range").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-range]");
    if (!b || b.disabled) return;
    state.dca.range = b.dataset.range;
    localStorage.setItem("dcaRange", state.dca.range);
    renderDca();
  });
  $("#dca-amount").addEventListener("input", ev => {
    const v = Math.round(+ev.target.value);
    if (!(v >= 1 && v <= 1e6)) return; // saisie en cours ou valeur absurde : on garde le montant précédent
    state.dca.amount = v;
    localStorage.setItem("dcaAmount", v);
    renderDca();
  });

  $("#cmp-range-buttons").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-range]");
    if (!b) return;
    state.cmp.range = b.dataset.range;
    localStorage.setItem("cmpRange", state.cmp.range);
    document.querySelectorAll("#cmp-range-buttons button").forEach(x => x.setAttribute("aria-pressed", x === b));
    renderCmpChart(false);
  });
  $("#cmp-chips").addEventListener("click", ev => {
    const chip = ev.target.closest(".chip");
    if (!chip) return;
    const id = chip.dataset.id, sel = state.cmp.selected;
    const i = sel.indexOf(id);
    if (i >= 0) sel.splice(i, 1, null); // on libère la couleur sans repeindre les autres
    else {
      const free = sel.indexOf(null);
      if (free >= 0) sel[free] = id;
      else if (sel.length < MAX_COLORED) sel.push(id);
      else { chip.animate([{ transform: "translateX(-3px)" }, { transform: "translateX(3px)" }, { transform: "none" }], 200); return; }
    }
    while (sel.length && sel.at(-1) === null) sel.pop();
    localStorage.setItem("cmpSelected", JSON.stringify(sel));
    renderChips();
    renderCmpChart(true);
  });
  $("#cmp-pea-only").addEventListener("change", ev => { state.cmp.peaOnly = ev.target.checked; renderChips(); renderCmpChart(false); renderTop(); renderTable(); });
  $("#cmp-show-others").addEventListener("change", ev => { state.cmp.showOthers = ev.target.checked; renderCmpChart(true); });
  $("#top-grid").addEventListener("click", ev => {
    const mm = ev.target.closest("button[data-maxmode]");
    if (mm) { state.cmp.maxMode = mm.dataset.maxmode; renderTop(); return; }
    const li = ev.target.closest("li[data-id]");
    if (li) selectEtf(li.dataset.id);
  });
  $("#perf-table").addEventListener("click", ev => {
    const th = ev.target.closest("th[data-col]");
    if (th) {
      const col = th.dataset.col;
      state.cmp.sortDir = state.cmp.sortCol === col ? -state.cmp.sortDir : (col === "name" ? 1 : -1);
      state.cmp.sortCol = col;
      renderTable();
      return;
    }
    const td = ev.target.closest("td[data-id]");
    if (td) selectEtf(td.dataset.id);
  });

  // les graphiques se redimensionnent dès que leur conteneur change de taille (onglet affiché, rotation du téléphone...)
  const ro = new ResizeObserver(entries => {
    for (const en of entries) if (en.contentRect.width > 0) echarts.getInstanceByDom(en.target)?.resize();
  });
  ["#main-chart", "#year-chart", "#cmp-chart", "#dca-chart"].forEach(sel => ro.observe($(sel)));
  window.addEventListener("hashchange", () => showTab(tabFromHash()));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}

// ------------------------------------------------------------------ rafraîchissement
let lastRefresh = 0;
async function refresh() {
  if (Date.now() - lastRefresh < 60_000) return;
  lastRefresh = Date.now();
  resetDataSource();
  if (state.tab === "thermo") refreshThermo();
  const before = state.meta?.updated;
  try {
    const meta = await getJSON("data/meta.json");
    if (meta.updated === before) return;
    await loadData();
    renderStatus();
    if (state.tab === "suivi") {
      renderList(); renderHead(); renderRangeButtons(); renderMainChart(true); renderStats(); renderDca(); renderYears(); renderFund();
    } else if (state.tab === "comparer") {
      renderChips(); renderCmpChart(true); renderTop(); renderTable();
    }
  } catch (err) {
    console.warn("Rafraîchissement impossible", err);
  }
}

function renderStatus() {
  const m = state.meta;
  if (m?.updated) {
    // le robot passe toutes les 15 min en séance et toutes les heures sinon : au-delà, quelque chose coince
    const late = Date.now() - Date.parse(m.updated) > 100 * 60000;
    const el = $("#updated");
    el.className = `fresh small ${late ? "late" : "ok"}`;
    el.innerHTML = `<i aria-hidden="true"></i><span class="lbl">${late ? "Données en retard · " : "Données à jour · "}</span>${ago(m.updated)}`;
    el.title = `Dernière mise à jour : ${dfFull.format(new Date(m.updated))} (heure de Paris)`;
  }
  const errors = Object.entries(m?.etfs || {}).filter(([, v]) => v.error).map(([k]) => k);
  $("#data-status").textContent = errors.length
    ? `Dernière mise à jour incomplète pour : ${errors.join(", ")} (les cours précédents sont conservés).`
    : m?.updated ? `Dernière mise à jour des données : ${dfFull.format(new Date(m.updated))}.` : "";
}

// ------------------------------------------------------------------ démarrage
async function start() {
  const saved = localStorage.getItem("theme");
  if (saved) document.documentElement.dataset.theme = saved;
  if (!window.echarts) await new Promise(r => window.addEventListener("load", r, { once: true }));
  try {
    await loadData();
  } catch (err) {
    document.querySelector("main").innerHTML = `<div class="card"><h2>Impossible de charger les données</h2><p class="muted">${esc(err.message)}</p>
      <p class="muted small">Si tu ouvres le fichier index.html directement depuis ton disque, le navigateur bloque la lecture des fichiers de données : il faut passer par un petit serveur web (voir le README).</p></div>`;
    return;
  }
  lastRefresh = Date.now();
  bindEvents();
  renderStatus();
  showTab(tabFromHash());
  setInterval(refresh, REFRESH_MS);
  setInterval(renderStatus, 60_000); // "il y a 12 min" reste exact sans recharger
}

start();
