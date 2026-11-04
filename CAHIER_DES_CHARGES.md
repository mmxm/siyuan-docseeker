# Cahier des charges — Plugin SiYuan « DocSeeker »

> Statut : **brouillon v0.1** — à valider avec les réponses aux questions ouvertes (§10).
> Date : 2026-11-03

## 1. Contexte et objectif

DocSeeker (`~/Documents/DocFastExplorer`) est une application de recherche plein texte dans des PDF, avec résultats sous forme de **vignettes** : extraits graphiques de la page, découpés autour du mot trouvé et surlignés en jaune. Son architecture actuelle repose sur un backend Rust (Axum, SQLite FTS5, Pdfium) et un frontend Vanilla JS (PDF.js, mode hors-ligne SQLite-Wasm).

**Objectif** : porter cette expérience dans SiYuan sous forme de **plugin 100 % frontend**, qui cherche des mots-clés dans les PDF stockés dans SiYuan et affiche les résultats en vignettes cliquables, **sans microservice adjacent**.

**Cible d'exécution prioritaire** : SiYuan **webapp** (navigateur, accès au noyau SiYuan via son API HTTP). Le desktop (Electron) et le mobile sont des bonus, non prioritaires.

## 2. Périmètre

### Inclus (v1)
- Indexation des PDF présents dans SiYuan (dossier `data/assets/`, sous-dossiers compris).
- Recherche par mots-clés multi-mots, avec classement par pertinence.
- Affichage des résultats en vignettes (extrait de page + surlignage) regroupées par document.
- Clic sur une vignette → ouverture du PDF à la bonne page dans SiYuan.
- Indexation incrémentale, avec progression visible et possibilité de pause.

### Exclu (v1)
- Notes Markdown de DocSeeker (SiYuan a déjà ses propres notes et sa recherche).
- Synchronisation multi-appareils / mode PWA hors-ligne de DocSeeker.
- Authentification (déjà gérée par SiYuan).
- Tout processus externe : serveur, binaire, conteneur Docker, service Rust.
- OCR des PDF scannés (à confirmer, voir Q3).

## 3. Contraintes techniques structurantes

| Contrainte | Conséquence |
|---|---|
| Pas de microservice | Tout le code tourne dans le navigateur (plugin SiYuan en JS/TS) ; Pdfium/Rust remplacés par le **PDF.js de SiYuan** (non embarqué dans le plugin) |
| Webapp = navigateur | Pas d'API Node/Electron ; accès fichiers uniquement via l'API HTTP du noyau SiYuan (`/api/file/*`, `/assets/...`) |
| Persistance | Index stocké dans l'espace de stockage du plugin (`data/storage/petal/<plugin>/`) via l'API plugin, et/ou IndexedDB / OPFS du navigateur |
| Gros PDF | Ex. un PDF de 165 Mo dans l'instance actuelle : traitement page par page dans un **Web Worker**, jamais le fichier entier en mémoire d'interface |
| Compatibilité | Plugin SiYuan standard : `plugin.json`, `index.js`, `index.css`, i18n, `package.zip` ; version minimale du noyau à fixer |

## 4. Exigences fonctionnelles

### F1 — Découverte des PDF
- Lister récursivement les `.pdf` de `data/assets/` (API `readDir`).
- Détecter ajouts, modifications (taille + date de modification) et suppressions ; mettre à jour l'index en conséquence.
- Lancement : au démarrage du plugin (configurable) et à la demande (bouton « Réindexer »).

### F2 — Extraction et indexation
- Extraction du texte **page par page** avec PDF.js (`getTextContent`), dans un Web Worker.
- Conservation, pour chaque occurrence, des **coordonnées** du texte (nécessaires au surlignage et au découpage de la vignette).
- Normalisation : insensible à la casse et aux diacritiques (équivalent `remove_diacritics 2` / `unicode61` de DocSeeker), recherche par préfixe.
- Index inversé persistant ; reprise après interruption sans repartir de zéro.
- Progression affichée (document en cours, pages traitées, durée estimée), pause/reprise/annulation.

### F3 — Recherche
- Champ de recherche avec lancement à la frappe (debounce) ou à la touche Entrée.
- Multi-mots (ET par défaut), préfixe sur le dernier mot, tolérance aux accents.
- Classement **BM25** comme dans DocSeeker ; tri par pertinence, regroupement par document.
- Filtres : par document, par dossier d'assets (v1 minimal : par document).

### F4 — Affichage des résultats
- Grille de vignettes : une vignette = un extrait de page autour d'une occurrence, **300 × 120 pt** rendu à l'échelle 1,5 (valeurs de DocSeeker), mots trouvés surlignés en jaune.
- Chaque groupe affiche : nom du PDF, numéro de page, nombre d'occurrences.
- Rendu **paresseux** (uniquement les vignettes visibles) et annulable, avec placeholder pendant le calcul.
- Cache des vignettes (IndexedDB / Cache API) pour réafficher instantanément.
- Repli texte (snippet surligné) si le rendu d'une vignette échoue.

### F5 — Navigation
- Clic sur une vignette → ouvre le PDF dans SiYuan sur la page concernée, avec le terme recherché mis en évidence si le visualiseur le permet.
- Retour aux résultats sans perdre la requête ni la position de défilement.

### F6 — Intégration SiYuan
- Point d'entrée : icône dans la barre supérieure + commande/raccourci clavier ; panneau en **dock** ou en **onglet** (voir Q4).
- Respect du thème clair/sombre SiYuan (variables CSS `--b3-*`).
- Interface en **français** (via le système i18n des plugins, pour permettre d'autres langues plus tard).
- Page de réglages : dossiers à indexer, taille des vignettes, indexation auto au démarrage, vider l'index/le cache.

## 5. Exigences non fonctionnelles

- **Performance** : recherche < 200 ms sur l'index chargé ; première vignette < 1 s ; interface jamais bloquée pendant l'indexation (Worker + découpage en lots).
- **Mémoire** : plafonner la mémoire utilisée par l'index et le cache de vignettes ; libération lors de la fermeture du panneau.
- **Robustesse** : PDF protégés, corrompus ou sans couche texte → ignorés avec message dans un journal visible, sans bloquer le lot.
- **Confidentialité** : aucune donnée envoyée hors de l'instance SiYuan ; aucune dépendance chargée depuis un CDN. Le plugin utilise le **PDF.js déjà fourni par SiYuan** (`/stage/protyle/js/pdf/`) et n'embarque pas le sien.
- **Taille du paquet** : réduite, puisque PDF.js n'est pas embarqué. En contrepartie, le plugin dépend de la version de PDF.js fournie par SiYuan (voir risques).
- **Maintenabilité** : TypeScript, logique de cadrage/recherche isolée et testable hors navigateur ; reprise de la logique de `crop-worker.js` / `offline-search-worker.js` de DocSeeker plutôt que réécriture.

## 6. Architecture envisagée

```
┌────────────────────── Navigateur (SiYuan webapp) ──────────────────────┐
│  Plugin (UI : dock/onglet, recherche, grille de vignettes, réglages)   │
│        │ messages                                                      │
│  ┌─────▼───────────┐   ┌──────────────────┐   ┌────────────────────┐   │
│  │ Worker indexation│   │ Worker vignettes │   │ Stockage           │   │
│  │ PDF.js → texte + │   │ PDF.js → crop +  │   │ index : storage    │   │
│  │ coordonnées      │   │ surlignage       │   │ plugin / OPFS      │   │
│  └─────▲───────────┘   └────────▲─────────┘   │ vignettes : IDB    │   │
│        │ fetch /assets/*.pdf (Range)           └────────────────────┘   │
└────────┼───────────────────────────────────────────────────────────────┘
         │
   Noyau SiYuan (API HTTP existante — aucun ajout)
```

Réutilisation de DocSeeker : calcul de cadrage (`calculateCropBounds`), constantes (1,5 / 300 × 120 / jaune `rgba(255,226,0,.45)`), tokenisation et BM25 du worker hors-ligne, styles des vignettes.

## 7. Découpage en jalons proposé

1. **M0 – Squelette** : plugin chargeable en webapp, icône, panneau vide, i18n, build.
2. **M1 – Indexation** : découverte des PDF, extraction PDF.js en Worker, index persistant, progression.
3. **M2 – Recherche texte** : requête, BM25, résultats en liste simple (nom, page, snippet).
4. **M3 – Vignettes** : rendu/crop/surlignage, rendu paresseux, cache.
5. **M4 – Navigation** : clic → PDF à la bonne page.
6. **M5 – Finitions** : réglages, indexation incrémentale, gestion d'erreurs, thème, perfs sur gros PDF.
7. **M6 – Publication** (optionnel) : `package.zip`, README, dépôt Bazaar.

## 8. Critères d'acceptation (v1)

- Sur le corpus de référence (47 PDF, environ 8,7 Go, dont plusieurs PDF de plus de 100 Mo), l'indexation se termine sans gel de l'interface ni plantage d'onglet.
- Une recherche multi-mots renvoie des vignettes avec les termes surlignés, identiques en logique à DocSeeker.
- Un clic sur une vignette ouvre le bon PDF **à la bonne page**, avec **le résultat recherché surligné** dans le visualiseur.
- Après rechargement de la page, l'index n'est pas reconstruit.
- Aucun appel réseau hors du noyau SiYuan.

## 9. Risques

| Risque | Mitigation |
|---|---|
| Indexation lente de gros PDF dans le navigateur | Worker, lots, reprise, pause ; mesurer tôt sur le corpus de 8,7 Go (durée totale d'indexation, taille de l'index, quota de stockage) |
| Taille de l'index dans le stockage plugin | Format compact, compression ; option SQLite-Wasm si insuffisant |
| Ouverture à une page précise non supportée par le visualiseur SiYuan | Vérifier l'API d'ouverture d'asset PDF (paramètre page) dès M0 ; sinon visionneuse PDF.js propre au plugin |
| PDF scannés sans texte | Détection + signalement ; OCR hors périmètre v1 |
| Évolution de l'API de plugins SiYuan | Fixer `minAppVersion`, limiter l'usage d'API internes |

## 10. Décisions prises

- **Q3 — PDF scannés** : ignorés et signalés dans le journal (pas d'OCR en v1).
- **Q4 — Panneau** : onglet central.
- **Q5 — Clic sur vignette** : visualiseur PDF natif de SiYuan (faisabilité de l'ouverture à une page donnée à vérifier dès M0 ; repli : visionneuse PDF.js du plugin).
- **Q1 — Stockage de l'index** : **un fichier binaire compressé par PDF** dans `data/storage/petal/<plugin>/`, synchronisé par SiYuan (seuls les PDF modifiés sont retransmis). Au chargement, il est converti en index inversé en mémoire dans un Worker (tableaux typés). Le format porte un numéro de version et est isolé derrière une interface d'encodage/décodage, avec tests unitaires dédiés.

- **Q2 — Périmètre** : tous les PDF importés par l'utilisateur dans SiYuan (`data/assets/`, sous-dossiers compris).
- **Q6 — Documents SiYuan** : hors périmètre pour l'instant (PDF uniquement).
- **Q7 — Langue et jeu de test** : interface en français. Corpus de référence : les référentiels de médecine de `~/Documents/DocFastExplorer/data/documents`, soit 47 PDF pour environ 8,7 Go. Sont exclus les fichiers générés pour les tests (`OffNote*`, `RaceNote*`, `RT_*`, `ZipExport*`, notes Markdown, dossiers de notes).
- **Q8 — Dépôt** : le code vit dans `siyuhan-docseeker`, et DocSeeker est bien `~/Documents/DocFastExplorer`.

## 11. Questions ouvertes

Aucune question bloquante restante pour la v1.

