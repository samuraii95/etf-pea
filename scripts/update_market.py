"""
Market Thermometer : indicateurs des marchés américains et score 0-100
pour le Nasdaq 100 et le S&P 500. Résultat écrit dans data/market.json.

Sources (gratuites, sans clé) :
- Fed : taux effectif et fourchette cible -> Federal Reserve Bank of New York (API Markets Data)
- Probabilités de la prochaine réunion -> calculées à partir des contrats à terme Fed Funds
  (CBOT, cours Yahoo Finance) avec la méthode publiée par CME FedWatch
- Taux à 10 ans -> U.S. Department of the Treasury (taux officiels quotidiens)
- VIX -> CBOE (cours différé + historique officiel)
- Brent, Nasdaq 100, S&P 500 -> Yahoo Finance (cours différés)

Méthode du score : voir la fonction score_* de chaque pilier et le README.
Une donnée absente n'est jamais remplacée par une valeur inventée.
"""

import calendar
import csv
import datetime as dt
import io
import json
import math
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
TODAY = dt.datetime.now(dt.timezone.utc).date()

# Pondérations des 4 piliers (somme = 1). Justification dans le README et sur la page.
WEIGHTS = {
    "NDX": {"trend": 0.35, "fed": 0.30, "vix": 0.20, "oil": 0.15},
    "SPX": {"trend": 0.35, "fed": 0.25, "vix": 0.20, "oil": 0.20},
}
STALE_DAYS = 4      # au-delà : donnée signalée comme retardée
UNUSABLE_DAYS = 10  # au-delà : donnée considérée comme indisponible


# ================================================================ outils

def get(url, **kw):
    r = requests.get(url, headers=HEADERS, timeout=30, **kw)
    r.raise_for_status()
    return r


def iso(d):
    return d.isoformat() if d else None


def value_on_or_before(series, day):
    """series = liste triée de (date, valeur). Dernière valeur dont la date <= day."""
    best = None
    for d, v in series:
        if d <= day:
            best = (d, v)
        else:
            break
    return best


def change(series, days, pct=True):
    """Variation entre le dernier point et le point situé `days` jours calendaires plus tôt."""
    if len(series) < 2:
        return None
    last_d, last_v = series[-1]
    old = value_on_or_before(series, last_d - dt.timedelta(days=days))
    if not old or old[0] < series[0][0]:
        return None
    return last_v / old[1] - 1 if pct else last_v - old[1]


def interp(x, points):
    """Interpolation linéaire sur une liste de points (x, y) triés."""
    if x <= points[0][0]:
        return points[0][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return points[-1][1]


def fr(x, d=2):
    """Nombre au format français (virgule décimale)."""
    return f"{x:.{d}f}".replace(".", ",")


def vix_label(lvl):
    return ("très basse (attention à la complaisance)" if lvl < 12 else "basse" if lvl < 16 else "normale" if lvl < 20
            else "à surveiller" if lvl < 25 else "élevée" if lvl < 30 else "très élevée (stress)" if lvl < 40 else "extrême (panique)")


def clamp(x, lo=0, hi=100):
    return max(lo, min(hi, x))


def freshness(day):
    if day is None:
        return "indisponible"
    age = (TODAY - day).days
    if age > UNUSABLE_DAYS:
        return "indisponible"
    return "retardée" if age > STALE_DAYS else "ok"


def yahoo_daily(ticker, period="2y"):
    import yfinance as yf
    h = yf.Ticker(ticker).history(period=period, auto_adjust=False)
    out = [(d.date(), float(c)) for d, c in h["Close"].items() if c == c]
    if not out:
        raise ValueError(f"{ticker} : aucune donnée")
    return out


def sma(values, n):
    return sum(values[-n:]) / n if len(values) >= n else None


# ================================================================ collecte

def fetch_fed():
    base = "https://markets.newyorkfed.org/api/rates/unsecured/effr"
    start = TODAY - dt.timedelta(days=380)
    rows = get(f"{base}/search.json", params={"startDate": start.isoformat(), "endDate": TODAY.isoformat()}).json()["refRates"]
    rows = sorted(rows, key=lambda r: r["effectiveDate"])
    last = rows[-1]
    return {
        "asof": last["effectiveDate"],
        "effr": last["percentRate"],
        "target": [last["targetRateFrom"], last["targetRateTo"]],
        "history": [[r["effectiveDate"], r["percentRate"]] for r in rows],
    }


def fetch_treasury_10y():
    series = []
    for year in (TODAY.year - 1, TODAY.year):
        url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
               f"daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
        for row in csv.DictReader(io.StringIO(get(url).text)):
            if row.get("10 Yr"):
                series.append((dt.datetime.strptime(row["Date"], "%m/%d/%Y").date(), float(row["10 Yr"])))
    series.sort()
    if not series:
        raise ValueError("aucune donnée")
    return series


MONTH_CODES = "FGHJKMNQUVXZ"


def zq_symbol(year, month):
    return f"ZQ{MONTH_CODES[month - 1]}{year % 100:02d}.CBT"


def add_months(year, month, n):
    k = year * 12 + month - 1 + n
    return k // 12, k % 12 + 1


def fetch_fed_futures(symbols):
    import yfinance as yf
    prices = {}
    for s in symbols:
        h = yf.Ticker(s).history(period="10d", auto_adjust=False)
        if not h.empty:
            prices[s] = (h.index[-1].date(), float(h["Close"].iloc[-1]))
    return prices


def brent_front_contracts(n=2):
    """Échéances Brent en cours. Le contrat de livraison M expire le dernier jour ouvré
    du 2e mois qui précède M (ex. contrat de janvier -> fin novembre)."""
    out, k = [], 0
    while len(out) < n:
        y, m = add_months(TODAY.year, TODAY.month, k)        # mois d'expiration candidat
        last = dt.date(y, m, calendar.monthrange(y, m)[1])
        while last.weekday() >= 5:
            last -= dt.timedelta(days=1)
        if last >= TODAY:
            dy, dm = add_months(y, m, 2)                         # mois de livraison
            out.append(f"BZ{MONTH_CODES[dm - 1]}{dy % 100:02d}.NYM")
        k += 1
    return out


def fetch_brent():
    """Historique d'un seul contrat (l'échéance en cours) pour que les variations ne soient
    pas faussées par les changements d'échéance du contrat « continu » BZ=F."""
    for sym in brent_front_contracts():
        try:
            return yahoo_daily(sym, "1y"), sym
        except Exception:
            continue
    return yahoo_daily("BZ=F", "1y"), "BZ=F"


def fetch_vix():
    hist = []
    text = get("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv").text
    for row in csv.DictReader(io.StringIO(text)):
        hist.append((dt.datetime.strptime(row["DATE"], "%m/%d/%Y").date(), float(row["CLOSE"])))
    hist.sort()
    hist = [p for p in hist if p[0] >= TODAY - dt.timedelta(days=400)]
    quote = get("https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json").json()["data"]
    qday = dt.date.fromisoformat(quote["last_trade_time"][:10])
    if quote.get("current_price") and (not hist or qday > hist[-1][0]):
        hist.append((qday, float(quote["current_price"])))
    return hist, quote["last_trade_time"]


# ================================================================ calculs

def fed_expectations(effr, decisions, prices):
    """Probabilités de la prochaine décision, méthode CME FedWatch simplifiée.

    Le contrat Fed Funds d'un mois vaut 100 - taux moyen du mois. Pour le mois de la
    réunion : taux moyen = (jours avant * taux actuel + jours après * nouveau taux) / jours du mois.
    On en déduit le nouveau taux attendu, donc la variation attendue, puis la répartition
    entre les deux scénarios de 25 pb qui l'encadrent.
    """
    upcoming = [d for d in decisions if d >= TODAY]
    if not upcoming:
        raise ValueError("calendrier FOMC à mettre à jour (data/fomc.json)")
    meeting = upcoming[0]
    y, m = meeting.year, meeting.month
    n = calendar.monthrange(y, m)[1]
    days_pre, days_post = meeting.day, n - meeting.day  # nouveau taux effectif le lendemain de la décision
    sym = zq_symbol(y, m)
    if days_post >= 8 and sym in prices:
        avg = 100 - prices[sym][1]
        r_post = (avg * n - effr * days_pre) / days_post
        used = [sym]
    else:  # réunion en toute fin de mois : le contrat du mois suivant reflète le nouveau taux
        ny, nm = add_months(y, m, 1)
        sym2 = zq_symbol(ny, nm)
        if sym2 not in prices:
            raise ValueError("contrat à terme indisponible")
        r_post = 100 - prices[sym2][1]
        used = [sym2]
    delta_bp = (r_post - effr) * 100

    k = math.floor(delta_bp / 25)
    frac = delta_bp / 25 - k
    probs = [{"move_bp": k * 25, "p": round(1 - frac, 3)}, {"move_bp": (k + 1) * 25, "p": round(frac, 3)}]
    probs = [p for p in probs if p["p"] >= 0.005]

    # taux moyen implicite dans environ 6 mois
    y6, m6 = add_months(TODAY.year, TODAY.month, 6)
    sym6 = zq_symbol(y6, m6)
    implied_6m = None
    if sym6 in prices:
        rate6 = 100 - prices[sym6][1]
        implied_6m = {"month": f"{y6}-{m6:02d}", "rate": round(rate6, 3), "change_bp": round((rate6 - effr) * 100, 1), "contract": sym6}

    return {
        "meeting": meeting.isoformat(),
        "expected_change_bp": round(delta_bp, 1),
        "probs": probs,
        "implied_6m": implied_6m,
        "contracts": {s: {"date": iso(prices[s][0]), "price": prices[s][1]} for s in used + ([sym6] if implied_6m else [])},
    }


def index_stats(series):
    closes = [v for _, v in series]
    last_d, last = series[-1]
    year = [v for d, v in series if d >= last_d - dt.timedelta(days=365)]
    high52 = max(year)
    ma50, ma200 = sma(closes, 50), sma(closes, 200)
    hist = []
    for i in range(len(series)):
        if series[i][0] < last_d - dt.timedelta(days=365):
            continue
        c = closes[: i + 1]
        hist.append([series[i][0].isoformat(), round(closes[i], 2),
                     round(sma(c, 50), 2) if len(c) >= 50 else None,
                     round(sma(c, 200), 2) if len(c) >= 200 else None])
    return {
        "asof": last_d.isoformat(), "last": round(last, 2),
        "chg_1d": change(series, 1) if (last_d - series[-2][0]).days <= 4 else None,
        "chg_7d": change(series, 7), "chg_30d": change(series, 30),
        "ma50": round(ma50, 2) if ma50 else None, "ma200": round(ma200, 2) if ma200 else None,
        "high52": round(high52, 2), "drawdown": last / high52 - 1,
        "history": hist,
    }


def simple_stats(series, keep_days=190, decimals=2):
    last_d, last = series[-1]
    prev = series[-2]
    return {
        "asof": last_d.isoformat(), "last": round(last, decimals),
        "chg_1d": last / prev[1] - 1, "chg_7d": change(series, 7), "chg_30d": change(series, 30),
        "history": [[d.isoformat(), round(v, decimals)] for d, v in series if d >= last_d - dt.timedelta(days=keep_days)],
    }


# ================================================================ scores par pilier
# Chaque fonction renvoie (score 0-100, liste de facteurs). Un facteur = effet en points + explication.

def factor(effect, text):
    return {"effect": round(effect, 1), "text": text}


def is_stress(vix, spx):
    """Contexte de stress : VIX >= 30, ou S&P 500 sous sa MM200 avec une baisse de plus de 8 % sur 30 jours."""
    if vix and vix["last"] >= 30:
        return True
    if spx and spx["ma200"] and spx["chg_30d"] is not None:
        return spx["last"] < spx["ma200"] and spx["chg_30d"] <= -0.08
    return False


def score_fed(fed, exp, t10, stress):
    s, f = 50, []
    # 1) trajectoire attendue des taux, lue dans son contexte
    if exp and exp["implied_6m"]:
        d6 = exp["implied_6m"]["change_bp"]
        if d6 <= -25:
            if stress:
                s -= 5; f.append(factor(-5, f"Baisses de taux anticipées ({d6:+.0f} pb sur 6 mois) dans un contexte de stress : signal de ralentissement plutôt qu'un soutien"))
            else:
                s += 15; f.append(factor(15, f"Baisses de taux anticipées ({d6:+.0f} pb sur 6 mois) dans un marché stable : soutien aux valorisations"))
        elif d6 >= 25:
            s -= 20; f.append(factor(-20, f"Hausses de taux anticipées ({d6:+.0f} pb sur 6 mois) : pression sur les valorisations"))
        else:
            f.append(factor(0, f"Taux directeur attendu globalement stable sur 6 mois ({d6:+.0f} pb)"))
        nxt = exp["expected_change_bp"]
        if nxt >= 10:
            s -= 5; f.append(factor(-5, f"Hausse possible dès la prochaine réunion (variation attendue {nxt:+.0f} pb)"))
    # 2) niveau du taux à 10 ans
    if t10:
        lvl = t10["last"]
        pts = 10 if lvl < 3.75 else 5 if lvl < 4.25 else 0 if lvl < 4.75 else -10 if lvl < 5.25 else -20
        txt = {10: "bas, favorable aux actions", 5: "modéré", 0: "neutre", -10: "élevé : concurrence pour les actions", -20: "très élevé : forte pression sur les valorisations"}[pts]
        s += pts; f.append(factor(pts, f"Taux à 10 ans à {fr(lvl)} % ({txt})"))
        # 3) vitesse de variation sur un mois, lue dans son contexte
        c = t10["chg_30d_bp"]
        if c is not None:
            if c >= 40:
                s -= 15; f.append(factor(-15, f"Taux à 10 ans en forte hausse sur 1 mois ({c:+.0f} pb)"))
            elif c >= 20:
                s -= 7; f.append(factor(-7, f"Taux à 10 ans en hausse sur 1 mois ({c:+.0f} pb)"))
            elif c <= -20:
                if stress:
                    f.append(factor(0, f"Taux à 10 ans en baisse ({c:+.0f} pb) mais par recherche de sécurité : pas un signal positif"))
                else:
                    s += 7; f.append(factor(7, f"Détente des taux à 10 ans sur 1 mois ({c:+.0f} pb)"))
    return clamp(s), f


VIX_CURVE = [(10, 80), (12, 88), (15, 90), (20, 72), (25, 52), (30, 33), (40, 15), (50, 8)]


def score_vix(vix):
    lvl = vix["last"]
    s = interp(lvl, VIX_CURVE)
    f = [factor(s - 50, f"VIX à {fr(lvl, 1)} : volatilité {vix_label(lvl)}")]
    c7 = vix["chg_7d"]
    if c7 is not None:
        old = lvl / (1 + c7)
        if c7 >= 0.30:
            s -= 10; f.append(factor(-10, f"Nervosité en forte hausse sur 7 jours ({c7 * 100:+.0f} %)"))
        elif c7 <= -0.20 and old >= 20:
            s += 10; f.append(factor(10, f"La tension retombe : VIX {c7 * 100:+.0f} % sur 7 jours"))
    return clamp(s), f


def score_oil(oil, spx):
    s, f = 65, []
    lvl = oil["last"]
    if lvl < 55:
        s -= 10; f.append(factor(-10, f"Brent très bas ({lvl:.0f} $) : peut refléter une demande mondiale faible"))
    elif lvl < 85:
        s += 10; f.append(factor(10, f"Brent à {lvl:.0f} $ : zone sans pression inflationniste marquée"))
    elif lvl < 100:
        s -= 5; f.append(factor(-5, f"Brent élevé ({lvl:.0f} $) : légère pression sur l'inflation"))
    elif lvl < 120:
        s -= 15; f.append(factor(-15, f"Brent au-dessus de 100 $ ({lvl:.0f} $) : pression inflationniste"))
    else:
        s -= 30; f.append(factor(-30, f"Brent au-dessus de 120 $ ({lvl:.0f} $) : choc énergétique"))
    c30, eq30 = oil["chg_30d"], (spx or {}).get("chg_30d")
    if c30 is not None:
        if c30 >= 0.10:
            if eq30 is not None and eq30 >= 0:
                s -= 5; f.append(factor(-5, f"Pétrole {c30 * 100:+.0f} % sur 30 jours avec des actions en hausse : plutôt porté par la demande, à surveiller"))
            else:
                s -= 15; f.append(factor(-15, f"Pétrole {c30 * 100:+.0f} % sur 30 jours avec des actions en baisse : choc d'offre possible, risque inflationniste"))
            if c30 >= 0.20:
                s -= 10; f.append(factor(-10, "Flambée de plus de 20 % en un mois"))
        elif c30 <= -0.10:
            if eq30 is not None and eq30 >= 0:
                s += 5; f.append(factor(5, f"Pétrole {c30 * 100:+.0f} % sur 30 jours : détente favorable à la désinflation"))
            else:
                s -= 8; f.append(factor(-8, f"Pétrole {c30 * 100:+.0f} % sur 30 jours avec des actions en baisse : craintes sur la croissance"))
    c7 = oil["chg_7d"]
    if c7 is not None and c7 >= 0.08:
        s -= 5; f.append(factor(-5, f"Mouvement brutal sur 7 jours ({c7 * 100:+.0f} %)"))
    return clamp(s), f


def score_trend(ix, name):
    s, f = 0, []
    last, ma50, ma200 = ix["last"], ix["ma50"], ix["ma200"]
    if ma200:
        if last > ma200:
            s += 30; f.append(factor(30, f"{name} au-dessus de sa moyenne mobile 200 jours (tendance de fond haussière)"))
        else:
            f.append(factor(-30, f"{name} sous sa moyenne mobile 200 jours (tendance de fond dégradée)"))
    if ma50 and ma200:
        if ma50 > ma200:
            s += 20; f.append(factor(20, "Moyenne 50 jours au-dessus de la 200 jours"))
        else:
            f.append(factor(-20, "Moyenne 50 jours sous la 200 jours"))
    if ma50:
        if last > ma50:
            s += 15; f.append(factor(15, f"{name} au-dessus de sa moyenne 50 jours"))
        else:
            f.append(factor(-15, f"{name} sous sa moyenne 50 jours (faiblesse à court terme)"))
    c30 = ix["chg_30d"]
    if c30 is not None:
        pts = interp(c30, [(-0.10, 0), (0.05, 20)])
        s += pts; f.append(factor(pts - 10, f"Performance sur 30 jours : {fr(c30 * 100, 1) if c30 < 0 else '+' + fr(c30 * 100, 1)} %"))
    dd = ix["drawdown"]
    pts = 15 if dd > -0.05 else 8 if dd > -0.10 else 3 if dd > -0.20 else 0
    txt = "proche de son plus haut" if pts == 15 else "en repli modéré" if pts == 8 else "en correction" if pts == 3 else "en marché baissier"
    s += pts; f.append(factor(pts - 8, f"{fr(abs(dd) * 100, 1)} % sous son plus haut sur 1 an ({txt})"))
    c7 = ix["chg_7d"]
    if c7 is not None and c7 <= -0.05:
        s -= 5; f.append(factor(-5, f"Chute marquée sur 7 jours ({fr(c7 * 100, 1)} %)"))
    return clamp(s), f


BANDS = [(25, "Très défavorable"), (45, "Défavorable"), (60, "Neutre / incertain"), (80, "Favorable"), (100, "Très favorable")]


def band(score):
    for hi, label in BANDS:
        if score <= hi:
            return label
    return BANDS[-1][1]


def global_score(key, pillars):
    """Moyenne pondérée des piliers disponibles. Si un pilier manque, score arrondi à 5 et signalé ;
    si la tendance manque ou si deux piliers manquent, pas de score."""
    w = WEIGHTS[key]
    ok = {p: v for p, v in pillars.items() if v.get("score") is not None}
    missing = [p for p in w if p not in ok]
    if "trend" in missing or len(missing) >= 2:
        return {"score": None, "status": "insuffisant", "missing": missing, "label": "Données insuffisantes"}
    total_w = sum(w[p] for p in ok)
    raw = sum(ok[p]["score"] * w[p] for p in ok) / total_w
    if missing:
        val = int(5 * round(raw / 5))
        return {"score": val, "status": "partiel", "missing": missing, "label": band(val)}
    val = int(round(raw))
    return {"score": val, "status": "complet", "missing": [], "label": band(val)}


# ================================================================ programme principal

def main():
    out = {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "weights": WEIGHTS, "errors": {}}
    fomc = [dt.date.fromisoformat(d) for d in json.loads((DATA / "fomc.json").read_text(encoding="utf-8"))["decisions"]]

    def attempt(name, fn):
        try:
            return fn()
        except Exception as e:
            out["errors"][name] = str(e)[:200]
            print(f"[{name}] erreur : {e}")
            return None

    # ---- Fed + futures
    fed = attempt("fed", fetch_fed)
    exp = None
    if fed:
        upcoming = [d for d in fomc if d >= TODAY][:2]
        months = {(d.year, d.month) for d in upcoming}
        months |= {add_months(d.year, d.month, 1) for d in upcoming}
        months.add(add_months(TODAY.year, TODAY.month, 6))
        prices = attempt("futures", lambda: fetch_fed_futures([zq_symbol(y, m) for y, m in sorted(months)])) or {}
        exp = attempt("fedwatch", lambda: fed_expectations(fed["effr"], fomc, prices)) if prices else None
    t10 = None
    s10 = attempt("us10y", fetch_treasury_10y)
    if s10:
        t10 = {"asof": s10[-1][0].isoformat(), "last": s10[-1][1], "source": "U.S. Treasury",
               "chg_30d_bp": round(change(s10, 30, pct=False) * 100, 1) if change(s10, 30, pct=False) is not None else None,
               "history": [[d.isoformat(), v] for d, v in s10 if d >= s10[-1][0] - dt.timedelta(days=365)]}
    else:  # secours : indice CBOE du 10 ans (^TNX) via Yahoo
        s10 = attempt("us10y_yahoo", lambda: yahoo_daily("^TNX", "1y"))
        if s10:
            c = change(s10, 30, pct=False)
            t10 = {"asof": s10[-1][0].isoformat(), "last": round(s10[-1][1], 3), "source": "CBOE ^TNX (Yahoo)",
                   "chg_30d_bp": round(c * 100, 1) if c is not None else None,
                   "history": [[d.isoformat(), round(v, 3)] for d, v in s10]}

    # ---- VIX
    vix = None
    r = attempt("vix", fetch_vix)
    if r:
        hist, quote_time = r
        vix = simple_stats(hist)
        vix["quote_time"] = quote_time
        vix["source"] = "CBOE"
    else:
        hist = attempt("vix_yahoo", lambda: yahoo_daily("^VIX", "1y"))
        if hist:
            vix = simple_stats(hist); vix["source"] = "Yahoo Finance (^VIX)"

    # ---- Brent et indices
    oil = None
    r = attempt("brent", fetch_brent)
    if r:
        bz, sym = r
        oil = simple_stats(bz)
        oil["contract"] = sym
        oil["source"] = f"ICE Brent, échéance {sym.split('.')[0]} (Yahoo Finance)" if sym != "BZ=F" else "ICE Brent continu (Yahoo Finance)"
    indices = {}
    for key, ticker, name in (("NDX", "^NDX", "Nasdaq 100"), ("SPX", "^GSPC", "S&P 500")):
        s = attempt(key, lambda t=ticker: yahoo_daily(t, "2y"))
        if s and len(s) > 200:
            indices[key] = index_stats(s)
            indices[key].update({"name": name, "source": "Yahoo Finance"})

    # ---- fraîcheur des données
    def usable(block):
        if not block:
            return False
        block["freshness"] = freshness(dt.date.fromisoformat(block["asof"]))
        return block["freshness"] != "indisponible"

    for b in (fed, t10, vix, oil, *indices.values()):
        usable(b)

    out.update({"fed": fed and {k: v for k, v in fed.items()}, "fedwatch": exp, "us10y": t10, "vix": vix, "brent": oil, "indices": indices})

    # ---- scores
    spx = indices.get("SPX") if indices.get("SPX", {}).get("freshness") != "indisponible" else None
    vix_ok = vix if vix and vix["freshness"] != "indisponible" else None
    stress = is_stress(vix_ok, spx)
    fed_ok = fed and fed["freshness"] != "indisponible" and (exp or (t10 and t10["freshness"] != "indisponible"))
    common = {
        "fed": dict(zip(("score", "factors"), score_fed(fed, exp, t10 if t10 and t10["freshness"] != "indisponible" else None, stress))) if fed_ok else {"score": None},
        "vix": dict(zip(("score", "factors"), score_vix(vix_ok))) if vix_ok else {"score": None},
        "oil": dict(zip(("score", "factors"), score_oil(oil, spx))) if oil and oil["freshness"] != "indisponible" else {"score": None},
    }
    out["context"] = {"stress": stress}
    out["scores"] = {}
    for key in ("NDX", "SPX"):
        ix = indices.get(key)
        pillars = dict(common)
        pillars["trend"] = dict(zip(("score", "factors"), score_trend(ix, ix["name"]))) if ix and ix["freshness"] != "indisponible" else {"score": None}
        for p in pillars.values():
            if p.get("score") is not None:
                p["score"] = round(p["score"], 1)
        out["scores"][key] = {"pillars": pillars, **global_score(key, pillars)}
        print(key, out["scores"][key]["score"], out["scores"][key]["label"], {p: v.get("score") for p, v in pillars.items()})

    (DATA / "market.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if out["errors"]:
        print("Erreurs :", out["errors"])


if __name__ == "__main__":
    main()
