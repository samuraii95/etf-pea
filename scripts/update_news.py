"""
Market News : actualités susceptibles d'influencer le Nasdaq 100 et le S&P 500.
Résultat écrit dans data/news.json.

1. Lecture de flux RSS publics (Fed, BEA, CNBC, MarketWatch, Investing.com)
2. Filtre de pertinence par mots-clés, suppression des doublons, articles récents uniquement
3. Si la variable d'environnement ANTHROPIC_API_KEY existe (secret GitHub, jamais dans la page) :
   Claude rédige un résumé en français, choisit la catégorie et estime l'impact potentiel,
   uniquement à partir du titre et de l'extrait fournis par la source.
   Sans clé : extrait original (anglais), catégorie par mots-clés, impact « non évalué ».
Les articles déjà traités sont gardés en cache dans news.json pour ne pas repayer l'analyse.
"""

import datetime as dt
import email.utils
import hashlib
import html
import json
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "news.json"
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
NOW = dt.datetime.now(dt.timezone.utc)

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
MAX_ITEMS = 40           # taille maximale du flux affiché
MAX_AGE_H = 72           # actualités de marché : 3 jours
MAX_AGE_OFFICIAL_H = 24 * 10  # communiqués officiels (Fed, BEA) : 10 jours

FEEDS = [
    {"source": "Federal Reserve", "url": "https://www.federalreserve.gov/feeds/press_monetary.xml", "official": True, "category": "fed_macro"},
    {"source": "BEA (U.S. Bureau of Economic Analysis)", "url": "https://apps.bea.gov/rss/rss.xml", "official": True, "category": "fed_macro",
     "title_must": ["gdp", "personal income and outlays", "pce"]},
    {"source": "CNBC", "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html"},   # Top news
    {"source": "CNBC", "url": "https://www.cnbc.com/id/20910258/device/rss/rss.html"},    # Economy
    {"source": "CNBC", "url": "https://www.cnbc.com/id/19854910/device/rss/rss.html"},    # Technology
    {"source": "CNBC", "url": "https://www.cnbc.com/id/15839135/device/rss/rss.html"},    # Earnings
    {"source": "CNBC", "url": "https://www.cnbc.com/id/100727362/device/rss/rss.html"},   # World
    {"source": "MarketWatch", "url": "https://feeds.content.dowjones.io/public/rss/mw_topstories"},
    {"source": "Investing.com", "url": "https://www.investing.com/rss/news_25.rss", "naive_tz": "UTC"},
]

# Mots-clés (anglais, minuscules). Servent au filtre de pertinence et à la catégorie sans IA.
KEYWORDS = {
    "earnings": ["earnings", "quarterly results", "revenue", "profit", "guidance", "eps", "beats estimates",
                 "misses estimates", "quarter", "q1 ", "q2 ", "q3 ", "q4 ", "outlook"],
    "tech": ["nvidia", "apple", "microsoft", "alphabet", "google", "amazon", "meta ", "tesla", "broadcom", "amd",
             "intel", "qualcomm", "tsmc", "semiconductor", "chip", "micron", "ai ", "artificial intelligence",
             "data center", "openai", "software", "big tech", "magnificent seven", "sk hynix", "asml"],
    "fed_macro": ["federal reserve", "the fed", "fed ", "fomc", "powell", "rate cut", "rate hike", "interest rate",
                  "treasury", "yield", "bond", "inflation", "cpi", "pce", "ppi", "jobs report", "payroll",
                  "unemployment", "jobless", "gdp", "recession", "consumer spending", "retail sales", "ism",
                  "economy", "economic", "labor market", "wages", "consumer confidence"],
    "geopolitics": ["war", "china", "russia", "ukraine", "iran", "israel", "taiwan", "sanction", "tariff",
                    "trade war", "opec", "geopolitic", "conflict", "missile", "election", "midterm", "congress",
                    "white house", "trump", "middle east", "strait"],
    "markets": ["stocks", "stock market", "s&p 500", "nasdaq", "dow jones", "wall street", "sell-off", "selloff",
                "vix", "fear gauge", "oil prices", "brent", "crude", "treasuries"],
}
CATEGORY_ORDER = ["earnings", "fed_macro", "tech", "geopolitics", "markets"]
KEYWORD_RE = {c: re.compile(r"\b(" + "|".join(re.escape(k.strip()) for k in ks) + r")\b", re.I) for c, ks in KEYWORDS.items()}
# Titres écartés d'office : bruit fréquent sans lien avec les indices américains
EXCLUDE_RE = re.compile(r"stocks (higher|lower|flat) at close of trade|oversold|overbought|good bets|mortgage|credit card|"
                        r"retire|social security|savings account|how to |best .* to buy|horoscope|recipe", re.I)


# ================================================================ lecture des flux

def clean(text):
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    return re.sub(r"\s+", " ", text).strip()


def parse_date(raw, naive_tz=None):
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        d = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc) if naive_tz == "UTC" else None
    return d.astimezone(dt.timezone.utc) if d else None


def normalize_url(url):
    p = urlsplit(url.strip())
    return urlunsplit((p.scheme, p.netloc.lower(), p.path.rstrip("/"), "", ""))


def item_id(url):
    return hashlib.sha1(normalize_url(url).encode()).hexdigest()[:12]


def read_feed(feed):
    r = requests.get(feed["url"], headers=HEADERS, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    out = []
    for it in root.iter("item"):
        title, link = clean(it.findtext("title")), (it.findtext("link") or "").strip()
        published = parse_date(it.findtext("pubDate"), feed.get("naive_tz"))
        if not title or not link or not published or EXCLUDE_RE.search(title):
            continue
        if feed.get("title_must") and not any(k in title.lower() for k in feed["title_must"]):
            continue
        out.append({
            "id": item_id(link), "url": link, "title": title, "excerpt": clean(it.findtext("description"))[:400],
            "source": feed["source"], "official": feed.get("official", False),
            "published": published.isoformat(timespec="minutes"), "feed_category": feed.get("category"),
        })
    return out


def official_text(url):
    """Premiers paragraphes d'un communiqué officiel (Fed, BEA), pour que le résumé repose sur le texte réel."""
    page = requests.get(url, headers=HEADERS, timeout=30).content.decode("utf-8", "replace")
    page = re.sub(r"<!--.*?-->|<script.*?</script>|<style.*?</style>", " ", page, flags=re.S | re.I)
    paras = [clean(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", page, re.S | re.I)]
    boiler = re.compile(r"\.gov|padlock|official website|sensitive information|javascript|cookies", re.I)
    paras = [p for p in paras if len(p) > 60 and not boiler.search(p)]
    return " ".join(paras)[:1500]


def keyword_categories(text):
    return [c for c in CATEGORY_ORDER if KEYWORD_RE[c].search(text)]


def words(title):
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if len(w) >= 4}


def is_duplicate(item, kept):
    w = words(item["title"])
    for k in kept:
        if k["id"] == item["id"]:
            return True
        w2 = words(k["title"])
        if w and w2 and len(w & w2) / len(w | w2) >= 0.5:
            return True
    return False


# ================================================================ analyse par Claude

SYSTEM = """Tu es un analyste de marché qui prépare une revue de presse en français pour un investisseur particulier
qui suit le Nasdaq 100 et le S&P 500.

Pour chaque article, tu reçois uniquement son titre, l'extrait publié par la source et le nom de la source.
Règles :
- Résume en français en 1 ou 2 phrases courtes, uniquement avec les informations du titre et de l'extrait.
  N'ajoute aucun chiffre, nom ou fait absent du texte fourni. Si l'extrait est vide, reformule seulement le titre.
- Traduis le titre en français, fidèlement et sans sensationnalisme.
- relevant = false si l'article n'a pas de lien plausible avec les marchés actions américains
  (faits divers, conseils de finances personnelles, lifestyle, marchés étrangers sans effet sur les États-Unis).
- category : fed_macro (Fed, taux, inflation CPI/PCE, emploi, croissance, données économiques), tech (entreprises
  technologiques, IA, semi-conducteurs), earnings (résultats et prévisions d'entreprises), geopolitics (conflits,
  sanctions, droits de douane, élections, politique), markets (mouvements de marché généraux).
- impact : effet potentiel à court terme sur le Nasdaq 100 / S&P 500 tel qu'on peut le déduire du texte :
  positif, negatif ou neutre. Choisis neutre si l'effet est ambigu, mitigé ou impossible à déduire.
  Ne présente jamais l'impact comme une certitude.
- impact_reason : une phrase courte en français qui justifie l'impact."""

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "relevant": {"type": "boolean"},
                    "title_fr": {"type": "string"},
                    "summary_fr": {"type": "string"},
                    "category": {"type": "string", "enum": CATEGORY_ORDER},
                    "impact": {"type": "string", "enum": ["positif", "negatif", "neutre"]},
                    "impact_reason": {"type": "string"},
                },
                "required": ["id", "relevant", "title_fr", "summary_fr", "category", "impact", "impact_reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def analyze_with_claude(items):
    """Renvoie {id: analyse}. Lève une exception si l'API est injoignable (le script continue sans IA)."""
    import anthropic

    client = anthropic.Anthropic()  # lit ANTHROPIC_API_KEY
    results = {}
    for start in range(0, len(items), 20):
        batch = items[start:start + 20]
        payload = [{"id": it["id"], "source": it["source"], "title": it["title"], "excerpt": it["excerpt"]} for it in batch]
        params = dict(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": "Articles à analyser (JSON) :\n" + json.dumps(payload, ensure_ascii=False)}],
        )
        if not MODEL.startswith("claude-haiku"):
            # si le modèle refuse une requête, l'API la relance sur le modèle de secours recommandé
            params.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
        response = client.beta.messages.create(**params)
        if response.stop_reason == "refusal":
            print("Analyse refusée par le modèle pour ce lot, articles gardés sans résumé IA")
            continue
        text = next((b.text for b in response.content if b.type == "text"), "")
        for row in json.loads(text)["items"]:
            results[row["id"]] = row
        print(f"Claude ({response.model}) : {len(batch)} articles analysés, "
              f"{response.usage.input_tokens} jetons en entrée, {response.usage.output_tokens} en sortie")
    return results


# ================================================================ programme principal

def main():
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        old = {"items": []}
    cache = {it["id"]: it for it in old.get("items", [])}
    rejected_before = set(old.get("rejected", []))  # jugés hors sujet par l'IA lors d'un passage précédent

    errors, fresh = {}, []
    for feed in FEEDS:
        try:
            fresh += read_feed(feed)
        except Exception as e:
            errors[feed["url"]] = str(e)[:200]
            print(f"Flux indisponible : {feed['url']} ({e})")

    # récence + pertinence par mots-clés
    candidates = []
    for it in sorted(fresh, key=lambda x: (not x["official"], x["published"])):
        age_h = (NOW - dt.datetime.fromisoformat(it["published"])).total_seconds() / 3600
        if age_h > (MAX_AGE_OFFICIAL_H if it["official"] else MAX_AGE_H) or age_h < -1:
            continue
        cats = [it["feed_category"]] if it["feed_category"] else keyword_categories(it["title"] + " " + it["excerpt"])
        if not cats:
            continue
        it["keyword_category"] = cats[0]
        candidates.append(it)

    # doublons (même URL ou titres très proches) : on garde l'officiel ou le plus ancien
    kept = []
    for it in candidates:
        if not is_duplicate(it, kept):
            kept.append(it)

    # texte complet des communiqués officiels nouveaux (quelques-uns par semaine)
    for it in kept:
        if it["official"] and it["id"] not in cache:
            try:
                it["excerpt"] = official_text(it["url"]) or it["excerpt"]
            except Exception as e:
                print("Communiqué illisible :", it["url"], e)
        elif it["official"]:
            it["excerpt"] = cache[it["id"]].get("excerpt", it["excerpt"])

    # analyse IA des nouveaux articles seulement
    ai_enabled = bool(os.environ.get("ANTHROPIC_API_KEY"))
    ai_error = None
    todo = [it for it in kept if it["id"] not in rejected_before and not cache.get(it["id"], {}).get("ai")]
    analyses = {}
    if ai_enabled and todo:
        try:
            analyses = analyze_with_claude(todo)
        except Exception as e:
            ai_error = f"{type(e).__name__}: {str(e)[:150]}"
            print("Analyse IA indisponible :", ai_error)

    items, rejected = [], []
    for it in kept:
        prev, a = cache.get(it["id"], {}), analyses.get(it["id"])
        if it["id"] in rejected_before:
            rejected.append(it["id"]); continue
        if a:
            if not a["relevant"]:
                rejected.append(it["id"]); continue
            it.update(ai=True, title_fr=a["title_fr"], summary_fr=a["summary_fr"], category=a["category"],
                      impact=a["impact"], impact_reason=a["impact_reason"], relevant=True)
        elif prev.get("ai"):
            it.update({k: prev[k] for k in ("ai", "title_fr", "summary_fr", "category", "impact", "impact_reason", "relevant")})
        else:
            it.update(ai=False, category=it["keyword_category"], impact=None, relevant=True)
        for k in ("feed_category", "keyword_category"):
            it.pop(k, None)
        items.append(it)

    # les communiqués officiels (Fed, BEA) sont toujours gardés, le reste par ordre de récence
    items.sort(key=lambda x: x["published"], reverse=True)
    official = [i for i in items if i["official"]]
    others = [i for i in items if not i["official"]][: max(0, MAX_ITEMS - len(official))]
    items = sorted(official + others, key=lambda x: x["published"], reverse=True)
    OUT.write_text(json.dumps({
        "updated": NOW.isoformat(timespec="seconds"),
        "ai": {"enabled": ai_enabled, "model": MODEL if ai_enabled else None, "error": ai_error},
        "sources": sorted({f["source"] for f in FEEDS}),
        "errors": errors,
        "items": items,
        "rejected": rejected[-300:],
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(items)} actualités retenues ({sum(1 for i in items if i.get('ai'))} analysées par l'IA), {len(errors)} flux en erreur")


if __name__ == "__main__":
    main()
