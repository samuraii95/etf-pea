"""
Met à jour les cours des ETF listés dans data/etfs.json.

- data/history/<ID>.json : cours de clôture quotidiens depuis la création
- data/intraday.json     : points 5 min (vue 1J) et 30 min (vue 1S)
- data/meta.json         : heure de mise à jour et état de chaque source

Sources : Boursorama (historique long des ETF cotés à Paris) et Yahoo Finance
(ETF cotés sur Xetra, et secours si Boursorama ne répond pas).
La première exécution télécharge tout l'historique, les suivantes
ne récupèrent que les dernières semaines et les fusionnent avec l'existant.
"""

import datetime as dt
import json
import sys
import time
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HIST = DATA / "history"
PARIS = ZoneInfo("Europe/Paris")
EPOCH = dt.date(1970, 1, 1)

BOURSO_URL = "https://www.boursorama.com/bourse/action/graph/ws/GetTicksEOD"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
}
BOURSO_MAX_DAYS = 7300  # Boursorama ne renvoie pas plus de 20 ans en une fois


# ---------------------------------------------------------------- Boursorama

def bourso_ticks(symbol, length, period):
    r = requests.get(BOURSO_URL, params={"symbol": symbol, "length": length, "period": period, "guid": ""},
                     headers=HEADERS, timeout=30)
    r.raise_for_status()
    js = r.json()
    if not isinstance(js, dict) or not js.get("d") or not js["d"].get("QuoteTab"):
        raise ValueError("réponse vide")
    time.sleep(0.4)  # on reste poli avec le serveur
    return js["d"]["QuoteTab"]


def bourso_daily(symbol, full):
    ticks = bourso_ticks(symbol, BOURSO_MAX_DAYS if full else 45, 0)
    # "d" = nombre de jours depuis le 01/01/1970
    return {(EPOCH + dt.timedelta(days=t["d"])).isoformat(): t["c"] for t in ticks if t["c"] and t["c"] > 0}


def bourso_intraday(symbol, days, minutes):
    points = []
    for t in bourso_ticks(symbol, days, minutes):
        # "d" = AAMMJJ * 10000 + minutes écoulées depuis minuit (heure de Paris)
        day, mins = divmod(t["d"], 10000)
        yy, rest = divmod(day, 10000)
        mm, dd = divmod(rest, 100)
        when = dt.datetime(2000 + yy, mm, dd, mins // 60, mins % 60, tzinfo=PARIS)
        if t["c"] and t["c"] > 0:
            points.append([int(when.timestamp() * 1000), t["c"]])
    return points


# ---------------------------------------------------------------- Yahoo

def yahoo_daily(ticker, full):
    import yfinance as yf
    h = yf.Ticker(ticker).history(period="max" if full else "3mo", auto_adjust=False)
    if h.empty:
        raise ValueError("aucune donnée")
    return {d.date().isoformat(): round(float(c), 4) for d, c in h["Close"].items() if c == c and c > 0}


def yahoo_intraday(ticker, period, interval):
    import yfinance as yf
    h = yf.Ticker(ticker).history(period=period, interval=interval)
    if h.empty:
        raise ValueError("aucune donnée")
    return [[int(d.timestamp() * 1000), round(float(c), 4)] for d, c in h["Close"].items() if c == c and c > 0]


# ---------------------------------------------------------------- utilitaires

def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def source_order(etf):
    """Source principale d'abord, puis l'autre en secours."""
    others = [s for s in etf["sources"] if s != etf["primary"]]
    return [etf["primary"]] + others


def remove_spikes(series):
    """Supprime les points aberrants isolés (aller-retour de plus de 20 % en 1 jour)."""
    dates = sorted(series)
    bad = set()
    for a, b, c in zip(dates, dates[1:], dates[2:]):
        pa, pb, pc = series[a], series[b], series[c]
        up, down = pb / pa - 1, pc / pb - 1
        if abs(up) > 0.2 and abs(down) > 0.15 and up * down < 0 and abs(pc / pa - 1) < 0.08:
            bad.add(b)
    return {d: v for d, v in series.items() if d not in bad}, sorted(bad)


# ---------------------------------------------------------------- mise à jour

def update_history(etf, status):
    path = HIST / f"{etf['id']}.json"
    old = read_json(path, None)
    series = dict(zip(old["dates"], old["close"])) if old else {}
    full = not series

    new, errors = None, []
    for src in source_order(etf):
        try:
            symbol = etf["sources"][src]
            new = bourso_daily(symbol, full) if src == "boursorama" else yahoo_daily(symbol, full)
            status["source"] = src
            break
        except Exception as e:  # on essaie la source suivante
            errors.append(f"{src}: {e}")
    if new is None:
        status["error"] = " | ".join(errors)
        return False

    series.update(new)
    series = {d: v for d, v in series.items() if d >= etf["inception"]}
    series, spikes = remove_spikes(series)
    if spikes:
        status["spikes_removed"] = spikes

    dates = sorted(series)
    write_json(path, {"id": etf["id"], "dates": dates, "close": [series[d] for d in dates]})
    status["first"], status["last"], status["points"] = dates[0], dates[-1], len(dates)
    return True


def update_intraday(etf):
    for src in source_order(etf):
        try:
            symbol = etf["sources"][src]
            if src == "boursorama":
                return {"day": bourso_intraday(symbol, 1, 5), "week": bourso_intraday(symbol, 5, 30), "source": src}
            return {"day": yahoo_intraday(symbol, "1d", "5m"), "week": yahoo_intraday(symbol, "5d", "30m"), "source": src}
        except Exception:
            continue
    return None


def main():
    etfs = read_json(DATA / "etfs.json", [])
    old_intraday = read_json(DATA / "intraday.json", {})
    meta = {"updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "etfs": {}}
    intraday = {}
    ok_count = 0

    for etf in etfs:
        status = {}
        if update_history(etf, status):
            ok_count += 1
        intra = update_intraday(etf)
        intraday[etf["id"]] = intra or old_intraday.get(etf["id"])
        status["intraday"] = intra["source"] if intra else "échec"
        meta["etfs"][etf["id"]] = status
        print(f"{etf['id']:6s} {status}")

    write_json(DATA / "intraday.json", intraday)
    write_json(DATA / "meta.json", meta)
    print(f"{ok_count}/{len(etfs)} ETF mis à jour")
    if ok_count == 0:
        sys.exit(1)  # tout a échoué : le workflow GitHub passe en rouge et envoie un mail


if __name__ == "__main__":
    main()
