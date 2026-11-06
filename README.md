# Mes ETF PEA

Site perso qui trace les cours de mes ETF depuis leur création, avec :

- **Suivi** : courbe par ETF (1J, 1S, 1M, 3M, 6M, 1A, 3A, 5A, Max), curseur de fenêtre pour zoomer, échelle log, stats court terme et long terme (perfs, volatilité, baisse max., moyennes mobiles, meilleures/pires années…), performances annuelles et fiche du fonds.
- **Comparer & Top 10** : toutes les courbes sur le même graphique (base 0 % au début de la fenêtre), Top 10 sur 1 mois, 1 an, 3 ans et Max, tableau complet triable.
- **Market Thermometer** : score de 0 à 100 sur le contexte des marchés américains (un pour le Nasdaq 100, un pour le S&P 500), calculé à partir de 4 indicateurs (Fed et taux, VIX, Brent, tendance), avec la méthode affichée sur la page, et un flux d'actualités filtrable.

Les données sont mises à jour automatiquement par GitHub (toutes les 30 min de l'ouverture de Paris à la clôture de Wall Street). Rien ne tourne sur ton PC.

## Les ETF suivis

| Ticker | ETF | ISIN | PEA |
|---|---|---|---|
| PAASI | Amundi PEA Asie Émergente (MSCI Emerging Asia) | FR0013412012 | oui |
| BNK | Amundi STOXX Europe 600 Banks | LU1834983477 | oui |
| ESIT | iShares MSCI Europe Information Technology | IE00BMW42413 | oui |
| AEEM | Amundi MSCI Emerging Markets Swap | LU1681045370 | **non** |
| ESE | BNP Paribas Easy S&P 500 | FR0011550185 | oui |
| HLT | Amundi STOXX Europe 600 Healthcare | LU1834986900 | oui |
| IUSQ | iShares MSCI ACWI | IE00B6R52259 | **non** |
| GPEA | Amundi PEA Global (MSCI ACWI) | FR0014017NX3 | oui |
| WPEA | iShares MSCI World Swap PEA | IE0002XZSHO1 | oui |
| MEUD | Amundi Core Stoxx Europe 600 | LU0908500753 | **non** |
| UST | Amundi Core Nasdaq-100 Swap | LU1829221024 | **non** |
| PUST | Amundi PEA Nasdaq-100 | FR0011871110 | oui |
| PTPXE | Amundi PEA Japon (TOPIX) | FR0013411980 | oui |

Éligibilité vérifiée en novembre 2026 (justETF, Boursorama). Elle peut changer : vérifie auprès de ton courtier.

## Mettre le site en ligne (gratuit, avec GitHub Pages)

1. Crée un compte sur <https://github.com> si tu n'en as pas.
2. Crée un **nouveau dépôt public** (par exemple `etf-pea`), sans README.
3. Envoie ce dossier dans le dépôt :
   ```bash
   git init -b main
   git add .
   git commit -m "Premier envoi"
   git remote add origin https://github.com/TON-PSEUDO/etf-pea.git
   git push -u origin main
   ```
4. Dans le dépôt : **Settings → Pages → Build and deployment → Source : GitHub Actions**.
5. Onglet **Actions → Mise à jour des cours → Run workflow** pour la première mise en ligne.
6. Le site est alors sur `https://TON-PSEUDO.github.io/etf-pea/`. Ajoute-le à l'écran d'accueil de ton téléphone.

Si un jour GitHub met en pause la tâche planifiée (après 60 jours sans activité sur le dépôt), il suffit de la réactiver dans l'onglet Actions.

## Market Thermometer

Sources, toutes gratuites et sans clé :

| Indicateur | Source |
|---|---|
| Taux directeur, taux effectif | Federal Reserve Bank of New York (API Markets Data) |
| Probabilités de la prochaine réunion | Calculées à partir des contrats à terme Fed Funds du CBOT (cours Yahoo Finance) avec la méthode publiée par CME FedWatch. L'API officielle FedWatch est payante, donc ce ne sont pas les chiffres officiels du CME, mais le même calcul. |
| Taux à 10 ans | U.S. Department of the Treasury (taux officiels quotidiens) |
| VIX | CBOE (cours différé et historique officiel) |
| Brent | Contrat ICE de l'échéance en cours (Yahoo Finance) |
| Nasdaq 100, S&P 500 | Yahoo Finance (cours différés) |

FRED n'est pas utilisé : son API demande une clé, et il ne fait que republier ces mêmes sources officielles.

La méthode du score (pondérations et règles) est détaillée sur la page, dans « Méthode de calcul du score », et dans `scripts/update_market.py`. Une donnée manquante n'est jamais remplacée : le score devient « partiel » ou n'est pas affiché.

Le calendrier des réunions de la Fed est dans `data/fomc.json` : à compléter chaque année avec les dates publiées sur <https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm>.

### Actualités (Market News)

Flux RSS publics : Federal Reserve, BEA (PIB, inflation PCE), CNBC, MarketWatch et Investing.com. Les articles sont filtrés par mots-clés, dédoublonnés et limités aux 3 derniers jours (10 jours pour les communiqués officiels).

Pour avoir le titre traduit, un résumé en français, la catégorie et l'impact estimé, il faut une clé API Claude :

1. Crée une clé sur <https://platform.claude.com> (compte payant à l'usage).
2. Dans le dépôt GitHub : **Settings → Secrets and variables → Actions → New repository secret**, nom `ANTHROPIC_API_KEY`.

La clé reste côté serveur (dans GitHub Actions) : elle n'apparaît jamais dans la page ni dans le dépôt. Sans clé, les articles s'affichent en anglais avec l'extrait d'origine et l'impact « non évalué ».

Modèle utilisé par défaut : `claude-opus-5-5`, avec un effort de réflexion réduit (`low`) et une relance automatique sur un autre modèle si une requête est refusée. Seuls les nouveaux articles sont envoyés (environ 100 par jour), soit à peu près 0,40 $ par jour (≈ 12 $ par mois). Pour réduire fortement le coût, crée une variable de dépôt `CLAUDE_MODEL` = `claude-haiku-5-5` (**Settings → Secrets and variables → Actions → Variables**) : on passe à moins de 0,50 $ par mois, avec des résumés un peu moins fins.

## Ajouter ou retirer un ETF

Modifie `data/etfs.json` (copie un bloc existant et change les champs), puis envoie la modif sur GitHub. Le robot télécharge tout l'historique du nouvel ETF au passage suivant.

- `sources.boursorama` : `1rT` + ticker pour Euronext Paris (ex. `1rTWPEA`)
- `sources.yahoo` : ticker Yahoo Finance (ex. `WPEA.PA` pour Paris, `IUSQ.DE` pour Xetra)
- `primary` : la source utilisée en premier, l'autre sert de secours
- `inception` : date de création du fonds (les cours plus anciens sont ignorés)

## Tester sur ton PC

```bash
py -m pip install -r requirements.txt
py scripts/update_data.py
py scripts/update_market.py
py scripts/update_news.py
py scripts/serve.py
```

Puis ouvre <http://localhost:8765>.

## Sources des données

- **Boursorama** : historique de cotation des ETF cotés à Paris (jusqu'à 20 ans) et intraday
- **Yahoo Finance** : ETF cotés sur Xetra (ESIT, IUSQ) et secours si Boursorama ne répond pas

Tous ces ETF sont capitalisants, donc le cours suffit pour calculer les performances : il n'y a pas de dividendes à réintégrer.
