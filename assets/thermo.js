// Onglet Market Thermometer : score 0-100 (Nasdaq 100 / S&P 500), 4 indicateurs, méthode et actualités.
// Les données viennent de data/market.json et data/news.json (scripts/update_market.py et update_news.py).
import { $, nf, NBSP, pct, cls, esc, dfDay, dfMonth, dfFull, dfDayTime, css, alpha, getJSON, tooltipBase } from "./ui.js";

const PILLARS = { trend: "Tendance", fed: "Politique monétaire", vix: "Volatilité (VIX)", oil: "Pétrole (Brent)" };
const INDEX_NAMES = { NDX: "Nasdaq 100", SPX: "S&P 500" };
const BANDS = [
  { max: 25, label: "Très défavorable", st: "critical", icon: "▼▼" },
  { max: 45, label: "Défavorable", st: "serious", icon: "▼" },
  { max: 60, label: "Neutre / incertain", st: "warning", icon: "●" },
  { max: 80, label: "Favorable", st: "good", icon: "▲" },
  { max: 100, label: "Très favorable", st: "good", icon: "▲▲" },
];
const NEWS_FILTERS = { all: "Toutes", fed_macro: "FED / Macro", tech: "Technologie", earnings: "Résultats", geopolitics: "Géopolitique" };
const CAT_LABEL = { fed_macro: "FED / Macro", tech: "Technologie", earnings: "Résultats", geopolitics: "Géopolitique", markets: "Marchés" };
const IMPACT = {
  positif: { label: "Impact positif", icon: "▲", st: "good" },
  negatif: { label: "Impact négatif", icon: "▼", st: "critical" },
  neutre: { label: "Impact neutre", icon: "●", st: "neutral" },
};

let market = null, news = null, loadedAt = 0;
let newsFilter = "all", trendIdx = "NDX";
const charts = {};
let ro = null;

// ------------------------------------------------------------------ outils
const band = s => BANDS.find(b => s <= b.max) || BANDS.at(-1);
const st = key => css(`--st-${key}`);
const num = (x, d = 2) => (x == null ? "—" : nf(d).format(x));
const bp = x => (x == null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${nf(0).format(Math.abs(x))}${NBSP}pb`);
const dateOf = iso => dfDay.format(Date.parse(iso.slice(0, 10) + "T00:00:00Z"));

function bandChip(score) {
  if (score == null) return `<span class="band-chip st-neutral">Indisponible</span>`;
  const b = band(score);
  return `<span class="band-chip st-${b.st}"><i aria-hidden="true">${b.icon}</i>${b.label}</span>`;
}

function freshnessNote(block) {
  if (!block) return `<span class="fresh-badge">Donnée indisponible</span>`;
  if (block.freshness === "retardée") return `<span class="fresh-badge">Donnée retardée (au ${dateOf(block.asof)})</span>`;
  if (block.freshness === "indisponible") return `<span class="fresh-badge">Donnée trop ancienne, non utilisée (au ${dateOf(block.asof)})</span>`;
  return "";
}

function factorList(factors = [], { hideNeutral = false } = {}) {
  const rows = factors.filter(f => !(hideNeutral && f.effect === 0));
  if (!rows.length) return "";
  return `<ul class="factor-list">${rows.map(f => {
    const k = f.effect > 0 ? "good" : f.effect < 0 ? "critical" : "neutral";
    const icon = f.effect > 0 ? "+" : f.effect < 0 ? "−" : "•";
    return `<li><span class="fx st-${k}" aria-label="${f.effect > 0 ? "favorable" : f.effect < 0 ? "défavorable" : "neutre"}">${icon}</span>${esc(f.text)}</li>`;
  }).join("")}</ul>`;
}

function chartIn(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  let c = echarts.getInstanceByDom(el);
  if (!c) {
    c = echarts.init(el);
    ro ||= new ResizeObserver(entries => {
      for (const en of entries) if (en.contentRect.width > 0) echarts.getInstanceByDom(en.target)?.resize();
    });
    ro.observe(el);
  }
  charts[id] = c;
  return c;
}

function axisCommon() {
  return {
    axisLine: { lineStyle: { color: css("--axis") } }, axisTick: { show: false },
    axisLabel: { color: css("--muted"), fontSize: 10, hideOverlap: true },
    splitLine: { show: false },
  };
}

function lineChart(id, seriesList, { unit = "", decimals = 2, marks = [] } = {}) {
  const c = chartIn(id);
  if (!c) return;
  const multi = seriesList.length > 1;
  c.setOption({
    animation: false,
    grid: { left: 6, right: 44, top: multi ? 28 : 10, bottom: 22 },
    legend: multi ? { top: 0, left: 0, itemWidth: 14, itemHeight: 3, icon: "rect", textStyle: { color: css("--ink-2"), fontSize: 11 } } : undefined,
    xAxis: { type: "time", ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, formatter: v => dfMonth.format(v) } },
    yAxis: {
      type: "value", scale: true, position: "right", ...axisCommon(), axisLine: { show: false },
      splitLine: { lineStyle: { color: css("--grid") } },
      axisLabel: { color: css("--muted"), fontSize: 10, formatter: v => nf(decimals > 1 && Math.abs(v) < 20 ? 1 : 0).format(v) },
    },
    tooltip: {
      ...tooltipBase(),
      formatter: ps => `<div class="tt"><div class="tt-date">${dfDay.format(ps[0].value[0])}</div>${ps.map(p =>
        `<div class="tt-row"><i style="background:${p.color}"></i><b>${p.value[1] == null ? "—" : nf(decimals).format(p.value[1]) + unit}</b><span>${esc(p.seriesName)}</span></div>`).join("")}</div>`,
    },
    series: seriesList.map((s, i) => ({
      type: "line", name: s.name, data: s.data.map(([d, v]) => [Date.parse(d + "T00:00:00Z"), v]),
      showSymbol: false, symbolSize: 7, connectNulls: false,
      lineStyle: { width: s.width ?? 2, color: s.color, type: s.dashed ? "dashed" : "solid" }, itemStyle: { color: s.color },
      areaStyle: s.area ? { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: alpha(s.color, 0.18) }, { offset: 1, color: alpha(s.color, 0.01) }]) } : undefined,
      markLine: i === 0 && marks.length ? {
        symbol: "none", silent: true, lineStyle: { type: "dashed", color: css("--muted"), width: 1 },
        label: { color: css("--muted"), fontSize: 10, position: "insideStartTop", formatter: p => p.name },
        data: marks.map(m => ({ yAxis: m.value, name: m.label })),
      } : undefined,
    })),
  }, true);
}

// ------------------------------------------------------------------ chargement
async function load() {
  const [m, n] = await Promise.allSettled([getJSON("data/market.json"), getJSON("data/news.json")]);
  market = m.status === "fulfilled" ? m.value : null;
  news = n.status === "fulfilled" ? n.value : null;
  loadedAt = Date.now();
}

export async function renderThermo() {
  if (!market || Date.now() - loadedAt > 5 * 60e3) await load();
  render();
}

export async function refreshThermo() {
  await load();
  render();
}

function render() {
  renderHeader();
  if (!market) {
    $("#th-gauges").innerHTML = `<div class="card"><h3>Indicateurs indisponibles</h3><p class="muted">Le fichier data/market.json n'a pas pu être chargé. Aucun score n'est affiché plutôt qu'un score inventé.</p></div>`;
    $("#th-indicators").innerHTML = "";
  } else {
    renderGauges();
    renderIndicators();
    renderMethod();
  }
  renderNews();
}

function renderHeader() {
  const parts = [];
  if (market?.updated) parts.push(`Indicateurs : ${dfFull.format(new Date(market.updated))}`);
  if (news?.updated) parts.push(`Actualités : ${dfFull.format(new Date(news.updated))}`);
  $("#th-updated").textContent = parts.length ? `Dernière actualisation (heure de Paris) · ${parts.join(" · ")}` : "";
  const errs = Object.keys(market?.errors || {});
  const labels = { fed: "taux de la Fed (NY Fed)", futures: "contrats Fed Funds", fedwatch: "probabilités de la Fed", us10y: "taux à 10 ans (Trésor)",
    us10y_yahoo: "taux à 10 ans (secours)", vix: "VIX (CBOE)", vix_yahoo: "VIX (secours)", brent: "Brent", NDX: "Nasdaq 100", SPX: "S&P 500" };
  const ageH = market?.updated ? (Date.now() - Date.parse(market.updated)) / 3600e3 : 0;
  const msgs = [];
  if (errs.length) msgs.push(`Source momentanément indisponible : ${errs.map(e => labels[e] || e).join(", ")}. Les autres données restent à jour, celles qui manquent ne sont pas remplacées par des valeurs estimées.`);
  if (ageH > 30) msgs.push(`Les indicateurs n'ont pas été actualisés depuis ${Math.round(ageH)} h.`);
  $("#th-alert").innerHTML = msgs.map(m => `<p class="th-alert">${esc(m)}</p>`).join("");
}

// ------------------------------------------------------------------ jauges
function renderGauges() {
  $("#th-gauges").innerHTML = ["NDX", "SPX"].map(key => {
    const sc = market.scores?.[key];
    if (!sc) return "";
    const weights = market.weights[key];
    const all = Object.entries(sc.pillars).flatMap(([p, v]) => (v.factors || []).map(f => ({ ...f, w: f.effect * (weights[p] || 0), pillar: p })));
    const pos = all.filter(f => f.effect > 0).sort((a, b) => b.w - a.w).slice(0, 3);
    const neg = all.filter(f => f.effect < 0).sort((a, b) => a.w - b.w).slice(0, 3);
    const note = sc.status === "partiel"
      ? `<p class="gauge-note">Score partiel, arrondi à 5 points : ${sc.missing.map(p => PILLARS[p]).join(", ")} indisponible.</p>`
      : sc.status === "insuffisant" ? `<p class="gauge-note">Données insuffisantes : pas de score affiché.</p>` : "";
    const bars = Object.keys(PILLARS).map(p => {
      const v = sc.pillars[p]?.score;
      const color = v == null ? "" : `background:${st(band(v).st)}`;
      return `<div class="pbar"><span class="pl">${PILLARS[p]} <small>${Math.round(weights[p] * 100)} %</small></span>
        <span class="pt"><i style="width:${v ?? 0}%;${color}"></i></span><b>${v == null ? "n.d." : Math.round(v)}</b></div>`;
    }).join("");
    const li = list => list.length ? `<ul>${list.map(f => `<li>${esc(f.text)}</li>`).join("")}</ul>` : `<p class="muted small">Aucun facteur marquant</p>`;
    return `<div class="card gauge-card">
      <div class="gauge-top"><h3>Market Thermometer · ${INDEX_NAMES[key]}</h3>${bandChip(sc.score)}</div>
      <div class="gauge-body">
        <div class="gauge" id="gauge-${key}" role="img" aria-label="Score ${INDEX_NAMES[key]} : ${sc.score ?? "indisponible"} sur 100"></div>
        <div class="pbars"><div class="pbars-title">Score par pilier (pondération)</div>${bars}</div>
      </div>
      ${note}
      <div class="pros-cons">
        <div><h4><span class="fx st-good">+</span>Ce qui soutient</h4>${li(pos)}</div>
        <div><h4><span class="fx st-critical">−</span>Ce qui pèse</h4>${li(neg)}</div>
      </div>
    </div>`;
  }).join("");

  for (const key of ["NDX", "SPX"]) {
    const score = market.scores?.[key]?.score;
    const c = chartIn(`gauge-${key}`);
    if (!c) continue;
    c.setOption({
      animation: false,
      series: [{
        type: "gauge", startAngle: 200, endAngle: -20, min: 0, max: 100, splitNumber: 20,
        radius: "96%", center: ["50%", "60%"],
        axisLine: { lineStyle: { width: 14, color: [[0.25, st("critical")], [0.45, st("serious")], [0.6, st("warning")], [1, st("good")]] } },
        pointer: { show: score != null, length: "56%", width: 5, itemStyle: { color: css("--ink") } },
        anchor: { show: score != null, size: 12, itemStyle: { color: css("--ink"), borderColor: css("--surface"), borderWidth: 2 } },
        axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { distance: 18, color: css("--muted"), fontSize: 10, formatter: v => (v === 0 || v === 100 ? v : "") },
        title: { show: true, offsetCenter: [0, "62%"], color: css("--muted"), fontSize: 11 },
        detail: { offsetCenter: [0, "30%"], fontSize: 34, fontWeight: 700, color: css("--ink"), formatter: () => (score == null ? "—" : String(score)) },
        data: [{ value: score ?? 0, name: "sur 100" }],
      }],
    }, true);
  }
}

// ------------------------------------------------------------------ cartes indicateurs
function pillarScore(p) {
  const v = market.scores?.NDX?.pillars?.[p]?.score;
  return v == null ? `<span class="score-chip">n.d.</span>` : `<span class="score-chip" style="--c:${st(band(v).st)}">${Math.round(v)}/100</span>`;
}

function kpi(label, value, detail = "", klass = "") {
  return `<div class="kpi"><span class="lbl">${label}</span><b class="${klass}">${value}</b>${detail ? `<span class="det">${detail}</span>` : ""}</div>`;
}

function moveLabel(m) {
  if (m === 0) return "Maintien";
  return `${m > 0 ? "Hausse" : "Baisse"} de ${nf(2).format(Math.abs(m) / 100)}${NBSP}pt`;
}

function renderIndicators() {
  const m = market, fed = m.fed, fw = m.fedwatch, t10 = m.us10y, vix = m.vix, oil = m.brent;
  const pf = p => m.scores?.NDX?.pillars?.[p]?.factors;

  // --- Fed
  const fedCard = `<div class="card ind-card">
    <div class="ind-head"><h3>Politique monétaire · Fed</h3>${pillarScore("fed")}</div>
    ${freshnessNote(fed)}
    <div class="kpis">
      ${fed ? kpi("Taux directeur (fourchette cible)", `${num(fed.target[0])} – ${num(fed.target[1])}${NBSP}%`, `taux effectif ${num(fed.effr)}${NBSP}% au ${dateOf(fed.asof)}`) : kpi("Taux directeur", "—", "indisponible")}
      ${t10 ? kpi("Taux à 10 ans", `${num(t10.last)}${NBSP}%`, `${bp(t10.chg_30d_bp)} sur 1 mois · ${dateOf(t10.asof)}`) : kpi("Taux à 10 ans", "—", "indisponible")}
    </div>
    ${fw ? `<div class="probs">
      <div class="lbl">Prochaine réunion : ${dateOf(fw.meeting)} · probabilités implicites</div>
      ${fw.probs.map(p => `<div class="prob"><span>${moveLabel(p.move_bp)}</span><span class="pt"><i style="width:${p.p * 100}%;background:${p.move_bp > 0 ? st("serious") : p.move_bp < 0 ? st("good") : css("--muted")}"></i></span><b>${nf(0).format(p.p * 100)}${NBSP}%</b></div>`).join("")}
      ${fw.implied_6m ? `<p class="det">Taux moyen anticipé pour ${dfMonth.format(Date.parse(fw.implied_6m.month + "-15T00:00:00Z"))} : ${num(fw.implied_6m.rate)}${NBSP}% (${bp(fw.implied_6m.change_bp)} par rapport à aujourd'hui)</p>` : ""}
    </div>` : `<p class="muted small">Probabilités de la prochaine réunion indisponibles.</p>`}
    <div class="mini-chart" id="ch-fed"></div>
    ${factorList(pf("fed"))}
    <p class="src">Sources : NY Fed (taux effectif), U.S. Treasury (10 ans), contrats à terme Fed Funds du CBOT (Yahoo Finance). Probabilités calculées avec la méthode publiée par CME FedWatch, ce ne sont pas les chiffres officiels du CME.</p>
  </div>`;

  // --- VIX
  const vixCard = `<div class="card ind-card">
    <div class="ind-head"><h3>Volatilité · VIX</h3>${pillarScore("vix")}</div>
    ${freshnessNote(vix)}
    ${vix ? `<div class="kpis">
      ${kpi("VIX", num(vix.last), vixLevel(vix.last))}
      ${kpi("Sur 24 h", pct(vix.chg_1d, 1), "", cls(-vix.chg_1d))}
      ${kpi("Sur 7 jours", pct(vix.chg_7d, 1), "", cls(-vix.chg_7d))}
    </div>` : ""}
    <div class="mini-chart" id="ch-vix"></div>
    ${factorList(pf("vix"))}
    <p class="note">Une volatilité élevée signale des mouvements plus amples et un risque accru, pas une baisse certaine : les pics du VIX coïncident souvent avec des points bas de marché.</p>
    <p class="src">Source : CBOE (cours différé${vix?.quote_time ? `, dernière cotation ${esc(vix.quote_time.replace("T", " "))} heure de New York` : ""}).</p>
  </div>`;

  // --- Brent
  const oilCard = `<div class="card ind-card">
    <div class="ind-head"><h3>Pétrole · Brent</h3>${pillarScore("oil")}</div>
    ${freshnessNote(oil)}
    ${oil ? `<div class="kpis">
      ${kpi("Baril de Brent", `${num(oil.last)}${NBSP}$`, `au ${dateOf(oil.asof)}`)}
      ${kpi("Sur 24 h", pct(oil.chg_1d, 1), "", "")}
      ${kpi("Sur 7 jours", pct(oil.chg_7d, 1), "", "")}
      ${kpi("Sur 30 jours", pct(oil.chg_30d, 1), "", "")}
    </div>` : ""}
    <div class="mini-chart" id="ch-oil"></div>
    ${factorList(pf("oil"))}
    <p class="note">Une hausse du pétrole n'est pas négative en soi : portée par la demande, elle accompagne une économie solide. Elle pèse surtout quand elle est brutale ou qu'elle relance l'inflation.</p>
    <p class="src">Source : ${esc(oil?.source || "Yahoo Finance")}. Variations calculées sur une seule échéance pour éviter les sauts dus aux changements de contrat.</p>
  </div>`;

  // --- Tendance
  const ix = m.indices || {};
  const row = (label, f) => `<tr><th>${label}</th>${["NDX", "SPX"].map(k => `<td>${ix[k] ? f(ix[k]) : "—"}</td>`).join("")}</tr>`;
  const rel = (a, b) => (a && b ? a / b - 1 : null);
  const cell = x => `<span class="${cls(x)}">${pct(x, 1)}</span>`;
  const trendScores = ["NDX", "SPX"].map(k => {
    const v = m.scores?.[k]?.pillars?.trend?.score;
    return `${INDEX_NAMES[k]} ${v == null ? "n.d." : Math.round(v) + "/100"}`;
  }).join(" · ");
  const trendCard = `<div class="card ind-card">
    <div class="ind-head"><h3>Tendance des marchés</h3><span class="score-chip small">${trendScores}</span></div>
    ${freshnessNote(ix.NDX)}
    <table class="trend-table">
      <thead><tr><th></th><th>Nasdaq 100</th><th>S&amp;P 500</th></tr></thead>
      <tbody>
        ${row("Dernier cours", i => nf(0).format(i.last))}
        ${row("Sur 7 jours", i => cell(i.chg_7d))}
        ${row("Sur 30 jours", i => cell(i.chg_30d))}
        ${row("Écart à la MM 50 j", i => cell(rel(i.last, i.ma50)))}
        ${row("Écart à la MM 200 j", i => cell(rel(i.last, i.ma200)))}
        ${row("Écart au plus haut 1 an", i => cell(i.drawdown))}
      </tbody>
    </table>
    <div class="seg small-seg" id="trend-switch" role="group" aria-label="Indice affiché">
      ${["NDX", "SPX"].map(k => `<button data-idx="${k}" aria-pressed="${k === trendIdx}">${INDEX_NAMES[k]}</button>`).join("")}
    </div>
    <div class="mini-chart tall" id="ch-trend"></div>
    ${factorList(m.scores?.[trendIdx]?.pillars?.trend?.factors)}
    <p class="src">Source : Yahoo Finance (cours de clôture différés). MM = moyenne mobile des cours de clôture.</p>
  </div>`;

  $("#th-indicators").innerHTML = trendCard + fedCard + vixCard + oilCard;

  // graphiques
  const ink2 = css("--ink-2");
  if (t10 || fed) lineChart("ch-fed", [
    ...(t10 ? [{ name: "Taux à 10 ans", data: t10.history, color: css("--s1") }] : []),
    ...(fed ? [{ name: "Taux effectif Fed", data: fed.history, color: css("--s2") }] : []),
  ], { unit: NBSP + "%" });
  if (vix) lineChart("ch-vix", [{ name: "VIX", data: vix.history, color: css("--s7"), area: true }], { decimals: 1, marks: [{ value: 20, label: "20" }, { value: 30, label: "30 : stress" }] });
  if (oil) lineChart("ch-oil", [{ name: "Brent ($)", data: oil.history, color: css("--s4"), area: true }], { unit: NBSP + "$" });
  const tix = ix[trendIdx];
  if (tix) lineChart("ch-trend", [
    { name: INDEX_NAMES[trendIdx], data: tix.history.map(r => [r[0], r[1]]), color: css("--s1") },
    { name: "MM 50 j", data: tix.history.map(r => [r[0], r[2]]), color: css("--s2"), width: 1.5 },
    { name: "MM 200 j", data: tix.history.map(r => [r[0], r[3]]), color: ink2, width: 1.5, dashed: true },
  ], { decimals: 0 });

  $("#trend-switch").onclick = ev => {
    const b = ev.target.closest("button[data-idx]");
    if (!b) return;
    trendIdx = b.dataset.idx;
    renderIndicators();
  };
}

function vixLevel(v) {
  return v < 12 ? "très basse (complaisance possible)" : v < 16 ? "basse" : v < 20 ? "normale" : v < 25 ? "à surveiller" : v < 30 ? "élevée" : v < 40 ? "très élevée (stress)" : "extrême (panique)";
}

// ------------------------------------------------------------------ méthode
function renderMethod() {
  const w = market.weights;
  const pctw = x => `${Math.round(x * 100)}${NBSP}%`;
  $("#th-method").innerHTML = `
    <p>Chaque pilier reçoit une note de 0 à 100, puis le score global est la moyenne pondérée des 4 piliers. Les règles sont volontairement simples et lisibles. Elles décrivent le contexte, elles ne prédisent pas la suite.</p>
    <table class="kv method-table">
      <thead><tr><th>Pilier</th><th>Nasdaq 100</th><th>S&amp;P 500</th></tr></thead>
      <tbody>${Object.keys(PILLARS).map(p => `<tr><th>${PILLARS[p]}</th><td>${pctw(w.NDX[p])}</td><td>${pctw(w.SPX[p])}</td></tr>`).join("")}</tbody>
    </table>
    <p class="muted small">Pourquoi des poids différents : les valeurs technologiques du Nasdaq 100 sont valorisées sur des bénéfices lointains, donc plus sensibles aux taux. Le S&amp;P 500, plus diversifié (énergie, industrie, consommation), est plus exposé au pétrole et à l'inflation.</p>
    <h3>Les règles par pilier</h3>
    <ul class="method-list">
      <li><b>Tendance</b> (par indice) : au-dessus de la moyenne mobile 200 jours (+30), MM 50 au-dessus de la MM 200 (+20), au-dessus de la MM 50 (+15), performance sur 30 jours (0 à 20 points entre −10 % et +5 %), écart au plus haut sur 1 an (15 points si moins de 5 %, 8 si moins de 10 %, 3 si moins de 20 %), −5 si la baisse sur 7 jours dépasse 5 %.</li>
      <li><b>Politique monétaire</b> (base 50) : hausses de taux anticipées à 6 mois −20, et −5 de plus si une hausse est probable dès la prochaine réunion. Des baisses anticipées valent +15 dans un marché calme, mais −5 en contexte de stress, car des baisses en urgence signalent un ralentissement. Le taux à 10 ans compte selon son niveau (de +10 sous 3,75 % à −20 au-dessus de 5,25 %) et sa vitesse : −15 si +40 pb en un mois. Une détente des taux longs ne compte que hors stress, sinon c'est une fuite vers la sécurité.</li>
      <li><b>Volatilité</b> : note selon le niveau du VIX (environ 90 entre 12 et 16, 72 à 20, 52 à 25, 33 à 30, 15 à 40), légèrement réduite sous 12 (complaisance). −10 si le VIX bondit de plus de 30 % en 7 jours, +10 si la tension retombe nettement depuis un niveau élevé.</li>
      <li><b>Pétrole</b> (base 65) : niveau du Brent (+10 entre 55 et 85 $, −5 jusqu'à 100 $, −15 jusqu'à 120 $, −30 au-delà, −10 sous 55 $ car signe de demande faible). Variation sur 30 jours lue avec le marché : une hausse de plus de 10 % pèse peu si les actions montent (demande), davantage si elles baissent (choc d'offre). Une baisse de plus de 10 % est favorable si les actions tiennent (désinflation), défavorable sinon (craintes de récession).</li>
      <li><b>Contexte de stress</b> : VIX à 30 ou plus, ou S&amp;P 500 sous sa MM 200 avec une baisse de plus de 8 % sur 30 jours.</li>
    </ul>
    <h3>Fiabilité des données</h3>
    <ul class="method-list">
      <li>Une donnée de plus de ${4} jours est signalée comme retardée. Au-delà de 10 jours, elle n'est plus utilisée.</li>
      <li>Si un pilier manque, le score est calculé sur les autres, arrondi à 5 points et marqué « partiel ». Sans la tendance, ou s'il manque deux piliers, aucun score n'est affiché.</li>
      <li>Aucune valeur n'est inventée : une source en panne apparaît comme indisponible.</li>
    </ul>
    <p class="muted small">Échelle : 0-25 très défavorable · 26-45 défavorable · 46-60 neutre / incertain · 61-80 favorable · 81-100 très favorable.</p>`;
}

// ------------------------------------------------------------------ actualités
function renderNews() {
  $("#news-filters").innerHTML = Object.entries(NEWS_FILTERS)
    .map(([k, v]) => `<button data-cat="${k}" aria-pressed="${k === newsFilter}">${v}</button>`).join("");
  $("#news-filters").onclick = ev => {
    const b = ev.target.closest("button[data-cat]");
    if (!b) return;
    newsFilter = b.dataset.cat;
    renderNews();
  };
  if (!news) {
    $("#news-status").textContent = "Actualités indisponibles pour le moment.";
    $("#news-list").innerHTML = "";
    return;
  }
  const ai = news.ai || {};
  $("#news-status").textContent = ai.enabled && !ai.error
    ? "Titres traduits, résumés et impacts estimés automatiquement par Claude à partir du titre et de l'extrait publiés par chaque source. Ouvre l'article pour vérifier."
    : ai.enabled
      ? "Analyse automatique momentanément indisponible : les articles récents sont affichés avec l'extrait original."
      : "Analyse automatique non activée (clé API absente) : titres et extraits originaux en anglais, catégorie déduite de mots-clés, impact non évalué.";
  const items = (news.items || []).filter(i => newsFilter === "all" || i.category === newsFilter);
  $("#news-list").innerHTML = items.length ? items.map(newsItem).join("") : `<li class="muted">Aucune actualité récente dans cette catégorie.</li>`;
}

function newsItem(i) {
  const imp = i.ai && IMPACT[i.impact];
  const impChip = imp
    ? `<span class="impact st-${imp.st}"><i aria-hidden="true">${imp.icon}</i>${imp.label}</span>`
    : `<span class="impact st-neutral">Impact non évalué</span>`;
  const when = dfDayTime.format(new Date(i.published));
  const title = i.ai ? i.title_fr : i.title;
  const body = i.ai
    ? `<p class="news-sum">${esc(i.summary_fr)}</p>${i.impact_reason ? `<p class="news-why">${esc(i.impact_reason)}</p>` : ""}`
    : i.excerpt ? `<p class="news-sum"><span class="muted">Extrait original : </span>${esc(i.excerpt.length > 260 ? i.excerpt.slice(0, 257) + "…" : i.excerpt)}</p>` : "";
  return `<li class="news-item">
    <div class="news-meta"><span class="cat">${CAT_LABEL[i.category] || "Marchés"}</span>${impChip}<span class="muted">${esc(i.source)} · ${when}</span></div>
    <a class="news-title" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>
    ${body}
  </li>`;
}
