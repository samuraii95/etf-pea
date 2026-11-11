#!/usr/bin/env bash
# Boucle du robot GitHub (voir .github/workflows/update.yml).
# À chaque tour : récupère le code à jour, télécharge les données, les publie sur la branche « data ».
# S'arrête au bout de DUREE_MAX secondes (le workflow se relance alors) ou dès qu'une exécution
# plus récente a pris le relais.

set -u

DUREE_MAX=${DUREE_MAX:-19800}          # 5 h 30 : on passe le relais avant la limite de 6 h d'une tâche GitHub
PAUSE_SEANCE=${PAUSE_SEANCE:-900}      # 15 min de 8 h 55 à 22 h 20 (heure de Paris), du lundi au vendredi
PAUSE_HORS_SEANCE=${PAUSE_HORS_SEANCE:-3600}
PUB="${RUNNER_TEMP:-/tmp}/publication"
DEPOT=${DEPOT:-"https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"}
debut=$(date +%s)
dernier_jour=""

en_seance() {
  local jour heure
  jour=$(TZ=Europe/Paris date +%u)
  heure=$((10#$(TZ=Europe/Paris date +%H%M)))
  [ "$jour" -le 5 ] && [ "$heure" -ge 855 ] && [ "$heure" -lt 2220 ]
}

# Une exécution plus récente (lancée à la main, par un envoi de code ou par relais) prend la main.
# Les exécutions du cron ne comptent pas : elles s'arrêtent d'elles-mêmes si une boucle tourne.
releve_arrivee() {
  local n
  n=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow "$WORKFLOW" --limit 20 \
        --json number,status,event \
        --jq "[.[] | select(.number > $GITHUB_RUN_NUMBER and .event != \"schedule\" and (.status == \"in_progress\" or .status == \"queued\"))] | length" 2>/dev/null)
  [ "${n:-0}" -gt 0 ]
}

charger_donnees() {   # reprend les dernières données publiées (historiques, score, actualités déjà analysées)
  if git fetch -q --depth=1 origin data 2>/dev/null; then
    mkdir -p data
    git archive FETCH_HEAD | tar -x -C data
    git checkout -q -- data/etfs.json data/fomc.json   # la configuration vient toujours de main
    echo "Données précédentes reprises depuis la branche data"
  else
    echo "Pas encore de branche data : téléchargement complet"
  fi
}

mettre_a_jour_le_code() {   # scripts et liste des ETF à jour sans attendre le prochain relais
  if git fetch -q --depth=1 origin main; then
    # (pas ce script lui-même : on ne remplace pas un script en cours d'exécution)
    git checkout -q -f FETCH_HEAD -- 'scripts/*.py' data/etfs.json data/fomc.json || true
  fi
}

publier() {
  rm -rf "$PUB" && mkdir -p "$PUB" && cp -r data/. "$PUB"/
  git -C "$PUB" init -q -b data
  git -C "$PUB" add -A
  git -C "$PUB" -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
      commit -q -m "Données du $(date -u +'%Y-%m-%d %H:%M') UTC"
  git -C "$PUB" push -q -f "$DEPOT" data && echo "Données publiées"
}

entretien() {   # au démarrage puis à chaque changement de jour : copie de secours du site à jour, cron de secours gardé actif
  local jour
  jour=$(TZ=Europe/Paris date +%F)
  [ "$jour" = "$dernier_jour" ] && return
  if [ -n "$dernier_jour" ] || [ "${GITHUB_EVENT_NAME:-}" != "push" ]; then
    gh workflow run deploy.yml --repo "$GITHUB_REPOSITORY" --ref main || true
  fi
  gh workflow enable "$WORKFLOW" --repo "$GITHUB_REPOSITORY" || true
  dernier_jour=$jour
}

attendre() {   # $1 = secondes ; hors séance, on se réveille dès l'ouverture
  local fin=$(( $(date +%s) + $1 ))
  while [ "$(date +%s)" -lt "$fin" ]; do
    sleep 60
    if [ "$2" = "hors" ] && en_seance; then break; fi
  done
}

charger_donnees
while true; do
  if releve_arrivee; then
    echo "Une exécution plus récente prend le relais : arrêt."
    echo "relais=non" >> "$GITHUB_OUTPUT"
    exit 0
  fi

  mettre_a_jour_le_code
  python scripts/update_data.py   || echo "::warning::Cours des ETF : échec de ce passage"
  python scripts/update_market.py || echo "::warning::Market Thermometer : échec de ce passage"
  python scripts/update_news.py   || echo "::warning::Actualités : échec de ce passage"
  publier || echo "::warning::Publication impossible à ce passage"
  entretien

  if en_seance; then pause=$PAUSE_SEANCE; mode=seance; else pause=$PAUSE_HORS_SEANCE; mode=hors; fi
  # pas le temps de faire une pause et un tour de plus : on passe le relais maintenant
  if [ $(( $(date +%s) - debut + pause + 300 )) -ge "$DUREE_MAX" ]; then
    echo "relais=oui" >> "$GITHUB_OUTPUT"
    exit 0
  fi
  attendre "$pause" "$mode"
done
