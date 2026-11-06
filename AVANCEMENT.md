# Avancement — Plugin SiYuan « DocSeeker »

> Document de passation. Il dit où en est le projet, comment il est construit, ce qui reste ouvert et comment reprendre.
> Complète `CAHIER_DES_CHARGES.md` (le quoi), `PLAN_IMPLEMENTATION.md` (le plan et le guide d'entrée) et `CLAUDE.md` (règles de travail).
> Dernière mise à jour : 2026-11-05 (état vérifié par `npm test`, `npm run typecheck`, `npm run package`, `npm run test:coverage`, `npm run release:check` et `gh release view v0.2.0`).

Légende utilisée ci-dessous :
- **[SiYuan]** : validé à la main dans SiYuan 3.8.9 (webapp, ordinateur). Source : commits `docs:` et sections précédentes de ce fichier ; non rejouable depuis le dépôt.
- **[tests]** : couvert par les tests automatiques seulement.
- **[mesure]** : chiffre issu d'une mesure (Node ou SiYuan), non revérifié ici sauf mention.

---

## 1. En une minute

- **Version publiée : 0.2.0.** `package.json` et `plugin.json` indiquent `0.2.0`. Tag git `v0.2.0` sur le commit `4a83cb0`.
- **Release GitHub `DocSeeker 0.2.0` publiée** le 2026-11-05 (non brouillon, non préversion) avec `package.zip` (79 719 octets, sha256 `99f4e35c…`). Vérifié avec `gh release view v0.2.0`.
- **Branche `main`** : identique à `origin/main` (`4a83cb0`), arbre de travail propre. `dist/` et `package.zip` sont ignorés par git.
- **Tests : 1 337 tests verts** (`npm test`, 46 fichiers dans `tests/unit`). Les mesures de `tests/perf` ne sont pas dans `npm test`.
- **Typage : propre** (`npm run typecheck` : `tsc --noEmit`, puis `tsconfig.test.json`).
- **Couverture** (`npm run test:coverage`, seuil 80 % sur `src/**`) : lignes 97,99 %, instructions 96,83 %, branches 90,55 %, fonctions 95,91 %.
- **Bundle** : `dist/index.js` = 227 085 octets (227 Ko ; 68,47 Ko gzip). `package.zip` = 79 719 octets.
- **Ce qui marche dans SiYuan 3.8.9** : diagnostic M0, indexation de PDF réels, recherche, vignettes surlignées, clic → PDF à la bonne page avec calque, plusieurs onglets de recherche, pages dépliables, re-classement par proximité (phase 1). Détail en section 2.
- **Ce qui manque** : pause/reprise de l'indexation (le code existe, l'interface non), réglages, `preview.png`, soumission au Marché, CI. Voir section 5.
- **Attention** : `npm run release:check` échoue actuellement sur « le tag v0.2.0 existe déjà ». C'est attendu après publication. Pour une nouvelle version, il faut d'abord incrémenter la version (voir section 7).

---

## 1 bis. Feuille de route en cours (décidée le 2026-11-06)

Ordre : **J7** (résultats compacts, recherche sur Entrée) → **J8** (paramètres du plugin : Réindexer, diagnostic, vider l'index, interrupteur d'indexation automatique) → **J9** (indexation automatique : démarrage, nouveaux PDF, suppressions, `removeStaleTmp`) → **J11** (classement phase 2, format `.dsx` v2, migration automatique grâce à J9) → **J10** (parité avec la recherche SiYuan : chemin, filtres, tris, onglet ou fenêtre flottante, raccourcis).

- **J9 : fait et commité, non validé dans SiYuan.** Vérifié : typecheck propre, 1 621 tests verts (52 fichiers), cinq relectures indépendantes (TypeScript, échecs silencieux, performance, UX/accessibilité, revue finale des corrections). Nouveaux modules purs : `src/indexer/autoSync.ts` (planificateur : 3 s après `onLayoutReady`, retour de focus avec 30 s minimum, périodique 5/15/60 min depuis la fin de la passe précédente, jamais deux passes, `triggerNow` booléen), `src/indexer/indexActivity.ts` (états running/done/partial/failed pour l'indicateur), `src/settings.ts` (`settings.json` via `loadData`/`saveData`, sérialisé, réécrit si corrompu ; défaut : automatique activée, 5 min). `removeStaleTmp()` est appelé au démarrage (dette R3 fermée). Panneau : interrupteur (`role="switch"`) et fréquence (désactivée si coupé). Onglet : indicateur sous le champ, suffixe « des résultats peuvent manquer » pendant l'indexation. `IndexSummary` gagne `incomplete`/`failures` ; la garde « aucune suppression sur parcours incomplet » est intacte. Retrait progressif des PDF en échec (5 min, 30 min, 2 h ; mémoire seulement ; `resetFailures()` après vidage). `shouldYield` : les passes automatiques attendent pendant `keydown`/`pointerdown`/`wheel` (3 s). Les clés `pause`/`resume`/`indexingPaused` sont supprimées (R2 : pas de boutons pause/reprise).
  - **À valider à la main dans SiYuan** : focus/`visibilitychange` ; ajout et suppression réels d'un PDF dans `assets` ; `settings.json` conservé après rechargement ; rendu de l'interrupteur et de la liste ; vidage puis reconstruction automatique ; dossier illisible (état « partiel ») ; PDF de 0 octet (pas de clignotement, pas de rechargement toutes les 5 min) ; **latence de l'interface pendant une première indexation** (extraction dans le thread principal, non mesurée).
  - **Dette connue** : cache `(chemin, date)` dans la découverte (une passe vide fait ~1 requête HEAD par PDF) ; débounce du rafraîchissement de l'index partagé pendant un run ; une demande manuelle qui rejoint une passe automatique la laisse « automatique » ; le panneau peut afficher « 1 échec » à chaque passe automatique tant qu'un PDF échoue ; `describeEvent` en dur en français.
- **J8 : fait et commité, non validé dans SiYuan.** Vérifié : typecheck propre, 1 441 tests verts (49 fichiers), trois relectures indépendantes (TypeScript, échecs silencieux, UX/accessibilité) dont les défauts ont été corrigés. Panneau `Setting` (`src/ui/settingsPanel.ts`) : Réindexer, Vider l'index (confirmation ; `petalStore.clear()` supprime le manifeste d'abord, puis `.bak`/`.tmp` avant chaque `.dsx` ; `SharedIndex.refreshNow()` invalide les caches), Diagnostic technique, journal. Section « Avancé » retirée de l'onglet ; bouton « Ouvrir les paramètres » à la place de Réindexer. Garde commune vidage/indexation portée par le plugin.
  - **Retour de test manuel (2026-11-06)** : le panneau était quasi vide avec `direction: "column"` (SiYuan range titre et action côte à côte, action forcée à 200 px). Corrigé en `direction: "row"` (lu dans le code de SiYuan 3.8.9 : `createActionElement` est appelé à chaque ouverture, `destroyCallback` à la destruction du dialogue). Pas de croix native dans le champ de recherche de SiYuan : Échap vide le champ. Réindexation : « 1 échec » sur le corpus (PDF de 0 octet connu, non revérifié dans le journal).
  - **Pas d'interrupteur d'indexation automatique ici** : il arrive avec son implémentation en J9 (pas de réglage mort).
  - **À valider à la main dans SiYuan** : `createActionElement` appelé à chaque ouverture et `destroyCallback` à chaque fermeture (supposé d'après les types `siyuan.d.ts`, non prouvé) ; `confirm()` annulable (ses boutons Confirmer/Annuler ne sont pas personnalisables) ; vidage réel et recherche qui se vide dans les onglets ouverts ; fermer/rouvrir le panneau pendant un vidage ou une indexation ; rendu des boutons `aria-disabled` et du journal défilable ; annonces du lecteur d'écran.
  - **Reste** : `describeEvent` et quelques libellés d'état sont en dur en français ; clés mortes `pause`/`resume`/`indexingPaused` toujours présentes (R2).
- **J7 : fait et commité, non validé dans SiYuan.** Vérifié : `npm run typecheck` propre, `npm test` 1 362 tests verts (47 fichiers), deux relectures indépendantes (TypeScript, accessibilité). Changements : `submit(query)` remplace `setQuery` et le débounce ; Entrée lance la recherche, la croix native et Échap vident ; dossier contenant seul affiché (`src/ui/pathLabel.ts`, ellipse par le début en CSS rtl, chemin complet en infobulle) ; « N pages » ; placeholder « (Entrée pour lancer) ».
  - **À valider à la main dans SiYuan** : rendu de l'ellipse rtl, Entrée dans le champ Electron (IME compris), croix native (émet-elle `search` ou `input` ?), annonces du lecteur d'écran.
  - **Écarts connus, non traités** : pas de bouton « Rechercher » (pointeur/commande vocale) ; pas d'`aria-busy` pendant le calcul ; chemin complet seulement en infobulle ; Échap efface les résultats.

---

## 2. Ce qui est fait, par jalon et capacité

Les jalons du plan initial sont décrits dans `PLAN_IMPLEMENTATION.md`. Dates : tous les commits sont du 2026-11-04 ou du 2026-11-05 (22 et 12 commits ; 34 au total, premier commit `cfa0773`).

### M0 — Diagnostic technique
- **Fichiers** : `src/diagnostic/m0.ts` (7 contrôles : `discovery`, `head`, `range`, `roundtrip`, `pdfjs`, `worker`, `auth`), `src/siyuan/kernelApi.ts`, bouton « Diagnostic M0 » dans `src/index.ts`.
- **Commits** : `c3bf48e` (point d'entrée, diagnostic, paquet), `5daa0c3` (repli `GET Range` quand `HEAD` répond 404), `fd2417a` et `46ae34a` (corrections du diagnostic), `23341f7` (mesures des premiers index).
- **[SiYuan]** : 6 OK, 0 échec, 1 ignoré (authentification). Constats : `HEAD` répond 404 pour les noms NFD/accentués (`GET Range` répond 206) ; un PDF de 0 octet est servi en 200 sans `Content-Range`.

### Extraction du texte
- **Fichiers** : `src/core/extract.ts` (texte PDF.js → `DocumentIndex`, une boîte par jeton, détection des PDF sans texte via `isLikelyScanned`), `src/indexer/loadPdf.ts` (charge un PDF via `window.pdfjsLib`, chemin encodé par segment, annulation).
- **Commits** : `d5dfeed`, `aee4605` (libération PDF.js, voir plus bas).
- **[SiYuan]** : 4 PDF indexés dont un de 165 Mo (378 pages). **[tests]** : `tests/unit/extract.test.ts`, `tests/unit/indexer/loadPdf.test.ts`.
- **Limite** : `getDocument` ne reçoit que l'URL, sans options de chargement progressif (§5, point 12).

### Format `.dsx`
- **Fichiers** : `src/core/codec/format.ts` (constantes et contrat), `encode.ts`, `decode.ts`. Version de format 1, magic `DSX1`.
- **Contenu** : 4 sections compressées en deflate-raw (longueurs par page, dictionnaire de termes, postings, boîtes de mots en fractions de 65 535). Bornes anti-bombe (`MAX_INFLATED_BYTES`, `MAX_TOTAL_INFLATED_BYTES`, `MAX_INFLATION_RATIO`, etc.) dans `format.ts`.
- **Commits** : `cfa0773`, `e6020ee` (durcissement après revues).
- **[tests]** : `tests/unit/codec*.test.ts` (aller-retour, fichiers tronqués, budgets, propriétés avec fast-check). Taille mesurée : environ 3 Ko par page sur les vrais index (2026-11-04).

### Index BM25 compact
- **Fichiers** : `src/core/bm25.ts` (un segment par document ; postings en `Uint32Array`), `src/core/indexMerge.ts` (fusion et mises à jour incrémentales), `src/core/normalize.ts` (équivalent FTS5 `unicode61 remove_diacritics 2`).
- **Parité** : avec SQLite FTS5 sur `tests/fixtures/fts5-parity.json` et `fts5-tokens.json` (`tests/unit/bm25.parity.test.ts`, `normalize.fts5.test.ts`).
- **Commit** : `276e2d4` (index compact).
- **[tests]**. Mémoire : 2,89 Ko par page après compaction (mesure `COPIES=20 npm run measure:memory` du 2026-11-04, non revérifiée ici).

### Indexeur reprenable
- **Fichiers** : `src/indexer/indexer.ts` (orchestrateur injectable), `src/core/queue.ts` (file : concurrence 2, pause, annulation, journal borné de 1 000 entrées), `src/core/manifest.ts` (diff, empreinte), `src/siyuan/discovery.ts` (lecture de `data/assets`, `complete` et `planIndexUpdate`), `src/siyuan/petalStore.ts` (écriture `.tmp` puis `.bak`).
- **Reprise** : un PDF n'entre dans `manifest.json` qu'après écriture réussie de son `.dsx`. Les PDF inchangés ne sont pas relus. Aucune suppression sur un parcours incomplet.
- **Commits** : `7934a18` (orchestrateur), `690e463` (branchement dans l'onglet).
- **[SiYuan]** : indexation réelle de 4 PDF. **[mesure]** : 44 PDF indexés en Node en ~191 s, un PDF de 0 octet échoue (corpus de 47 fichiers, voir plus bas).
- **Non vérifié** : la reprise après coupure brutale dans SiYuan.

### Index partagé au démarrage
- **Fichiers** : `src/search/sharedIndex.ts` (un seul `SearchStore` pour tous les onglets, chargé à `onLayoutReady`, rafraîchissement débouncé de 1 s), `src/search/searchStore.ts` (lecture des `.dsx` seulement, décodage concurrence 2, résultats partiels).
- **Commits** : `5119cf5`.
- **[SiYuan]** : plusieurs onglets validés (`35f3255`). **Non vérifié** : réindexation à chaud (un PDF réindexé pendant qu'un onglet est ouvert).

### Onglet de recherche
- **Fichiers** : `src/searchTab.ts` (assemblage, injection de toutes les dépendances), `src/search/searchController.ts` (`submit`, requête, vue-modèle ; plus de débounce depuis J7), `src/search/pageMatches.ts` (correspondances par page, LRU), `src/search/queryMatch.ts` (mot entier, préfixe sur le dernier mot seulement), `src/ui/searchView.ts` (DOM sans `innerHTML`, clavier, ARIA), `src/ui/searchStyles.ts` (CSS avec variables `--b3-*`).
- **Commits** : `d8aacc3`, `a6bd83c`, `9aa03ca`, `52d347b` (assemblage), `fb53c5c` (validation multi-mots sur les vrais index).
- **[SiYuan]** : recherche « BPCO » (3 documents, 30 pages) (`7e725d2`). Multi-mots et préfixes essayés à la main : OK.

### Vignettes cadrées et cache IndexedDB
- **Fichiers** : `src/core/crop.ts` (portage de `calculateCropBounds` de DocSeeker, 300 × 120 pt, rendu à l'échelle 1,5), `src/search/thumbnailPlan.ts` (cadrage sur la zone qui couvre le plus de mots distincts), `src/siyuan/pdfRenderer.ts` (rendu PDF.js, cache de documents, `destroy`), `src/ui/thumbnailLoader.ts` (chargement paresseux, observateur injecté ; le `IntersectionObserver` réel est créé dans `src/searchTab.ts`), `src/search/thumbnailCache.ts` (IndexedDB, base version 2 ; repli en mémoire).
- **Commits** : `13b3c55` (cadrage multi-termes ; `THUMBNAIL_DOC_VERSION = 2` dans `searchTab.ts`).
- **[SiYuan]** : vignettes rendues avec mots surlignés (`7e725d2`). **Non revalidé** après `13b3c55` : le cadrage multi-termes n'a été vérifié que sur le vrai `.dsx` (ITEM_209 p. 6, paragraphe I.2), pas dans SiYuan.

### Ouverture du PDF et calque de surlignage
- **Fichiers** : `src/siyuan/openPdf.ts` (`openTab({ app, pdf: { path, page } })`, puis calque), `src/ui/highlightOverlay.ts` (calque en pourcentages, dans `.page[data-page-number=N]`, réinjection, orphelin libéré après 30 s).
- **Commits** : `51db7a7` (ouverture centrée sur la zone), `e9bfa7c` (bouton de la barre ouvre un nouvel onglet).
- **[SiYuan]** : clic → bonne page avec calque, PDF déjà ouvert, zoom, thème sombre (`7e725d2`). **Non documenté comme validé** : le centrage sur la zone de la vignette.

### Pages dépliables
- **Fichiers** : `src/ui/searchView.ts` (`EXPAND_BATCH = 10`), `src/core/bm25.ts` (`MAX_EXPANDED_PAGES = 200`).
- **Commit** : `e2b78b0`.
- **[SiYuan]** : boutons « Plus » et « Replier » OK, plusieurs onglets OK (`35f3255`).

### Re-classement par proximité, phase 1 (jalon 6)
- **Fichiers** : `src/search/proximity.ts` (occurrences géométriques : même ligne, écart < 25 pt, page supposée de 595 pt de large ; bonus +5 000 / partiel +2 000), `src/search/proximityRanker.ts` (fenêtres de 15 documents, jusqu'à 60, concurrence 2), `src/search/searchController.ts` (grâce de 300 ms puis réordonnancement unique, statut « Classement affiné »), `src/core/constants.ts`.
- **Parité** : `tests/fixtures/docseeker-ranking.json` (17 scénarios générés par le vrai moteur Rust, `npm run gen:ranking-fixture`) ; `tests/unit/search/proximity.parity.test.ts`.
- **Commits** : `959c71c`, `80a39d7`, `218becd`, validation `dcdb962`.
- **[SiYuan]** : validé le 2026-11-05 (`dcdb962`). **Non mesuré** : latence réelle du re-classement sur un serveur Docker.

### Libération de la mémoire PDF.js
- **Fichiers** : `src/indexer/loadPdf.ts` (`destroy()` idempotent sur le document, qui appelle `loadingTask.destroy()` : le `PDFDocumentProxy` de PDF.js 6.4.299 n'a pas de `destroy()`), `src/siyuan/pdfRenderer.ts`.
- **Commit** : `aee4605`. **Effet réel sur la mémoire dans SiYuan : non mesuré.**

### Onglets multiples
- **Fichier** : `src/index.ts`, `openSearchTab` avec `openNewTab: true`. Sans cela SiYuan refocalise l'onglet existant (identifiant fixe).
- **Commit** : `e9bfa7c`. **[SiYuan]** : validé (`35f3255`).

### Mesures sur 47 PDF réels (2026-11-05)
- **Fichiers** : `tests/perf/corpus.measure.test.ts`, `tests/perf/corpusTools.ts`, `tests/perf/memory.measure.test.ts`, `tests/perf/multiword.measure.test.ts`. Commits `81fcd90`, `d5946bf`.
- **Résultats rapportés [mesure]** : 44 PDF indexés en ~191 s (plus long : 225 Mo, 17 s) ; 46 index rechargés en 1,13 s (18 323 pages, 56,8 Mo de `.dsx`) ; requêtes : médiane de quelques ms, pire cas isolé 535 ms ; plafond de 200 pages par document : négligeable.
- **Non rejouable** sans le corpus local (`/Users/francois/Documents/DocFastExplorer/data/documents`, hors dépôt).

### Interface et install
- **Fichiers** : `src/index.ts` (icône de barre supérieure, onglet « docseeker », section « Avancé » avec « Réindexer » et « Diagnostic M0 », journal des avertissements), `i18n/fr_FR.json` (40 clés), `icon.png` et `icon.svg` (`scripts/gen-icon.mjs`).
- **[SiYuan]** : la section « Avancé » affichait la clé brute quand `fr_FR.json` installé était ancien (corrigé en recopiant le fichier).

### Release 0.2.0
- **Fichiers** : `CHANGELOG.md`, `README.md` (français), `README_en_US.md`, `plugin.json`, `scripts/release.mjs`, `scripts/package.mjs`.
- **Commits** : `4a83cb0` (préparation), tag `v0.2.0` sur ce commit, release GitHub publiée le 2026-11-05.
- **Non fait** : `preview.png`, soumission au Marché (`siyuan-note/bazaar`) : aucune trace dans le dépôt.

---

## 3. Architecture en une page

### Flux de données

```
data/assets/**/*.pdf
   │  siyuan/discovery.ts      readDir (récursif, liens bornés) + HEAD pour la taille
   ▼
manifest diff                  core/manifest.ts  (added / modified / removed / unchanged)
   │  indexer/indexer.ts       orchestrateur, file core/queue.ts (concurrence 2)
   │    ├─ indexer/loadPdf.ts     window.pdfjsLib de SiYuan, getDocument(url), destroy()
   │    ├─ core/extract.ts        texte + boîtes, une boîte par jeton, PDF sans texte détectés
   │    ├─ core/codec/encode.ts   .dsx (deflate-raw par section)
   │    └─ siyuan/petalStore.ts   écriture .tmp → .bak → nom final (renameFile ne remplace pas)
   ▼
data/storage/petal/siyuan-docseeker/idx/
   ├─ <empreinte>.dsx            un fichier par PDF
   └─ manifest.json              état connu : PDF publiés, plus les PDF sans texte (notés pour ne pas être relus)
   │
   │  search/sharedIndex.ts + search/searchStore.ts   (un seul index pour tous les onglets)
   │    lecture des .dsx, decodeIndexForSearch (sans boîtes), core/indexMerge.ts → Bm25Index
   ▼
core/bm25.ts  searchPages + groupByDocument       BM25 par page, score de document
   │  search/pageMatches.ts                        correspondances par page (LRU)
   │  search/proximityRanker.ts                   re-classement par proximité (async, fenêtres)
   ▼
ui/searchView.ts  (via search/searchController.ts)  liste par document, pages dépliables
   │
   ├─ vignettes : search/thumbnailPlan.ts → siyuan/pdfRenderer.ts (PDF.js) → core/crop.ts
   │              → ui/thumbnailLoader.ts (IntersectionObserver), cache search/thumbnailCache.ts (IndexedDB)
   └─ clic : siyuan/openPdf.ts → openTab({ pdf: { path, page } }) → ui/highlightOverlay.ts (calque %)
```

### Rôle des dossiers

| Dossier | Rôle |
|---|---|
| `src/index.ts` | Plugin : barre supérieure, onglet, panneau de paramètres (`Setting`, depuis J8), câblage réel. Seul fichier qui importe `siyuan` (API plugin). |
| `src/searchTab.ts` | Assemblage de l'onglet de recherche. Tout est injecté, aucun accès direct au noyau ou à `window`. |
| `src/core/` | Cœur pur : normalisation, codec `.dsx`, BM25, fusion d'index, extraction, manifeste, file, cadrage. Pas de DOM. |
| `src/search/` | Logique de recherche sans DOM : index partagé, magasin, contrôleur, correspondances, proximité, vignettes (plan et cache). |
| `src/siyuan/` | Adaptateur noyau : client HTTP (`kernelApi`), stockage des `.dsx` (`petalStore`), découverte, ouverture PDF, rendu PDF.js. |
| `src/indexer/` | Orchestrateur d'indexation injectable et chargeur PDF.js. |
| `src/ui/` | DOM : vue de recherche, chargeur de vignettes, calque de surlignage, CSS. |
| `src/diagnostic/` | Diagnostic M0 (spike technique), exécuté depuis l'interface. |
| `tests/unit/` | 46 fichiers Vitest (`npm test`). Alias `siyuan` vers `tests/stubs/siyuan.ts`. |
| `tests/perf/` | Mesures hors `npm test` (`measure:*`). Lisent des données locales. |
| `tests/fixtures/` | Jeux de référence : parité FTS5 (BM25, tokenisation) et classement DocSeeker (17 scénarios). |
| `tools/docseeker-ref/` | Harnais Rust qui appelle `search-core` de DocSeeker, utilisé par `gen:ranking-fixture`. |
| `scripts/` | Paquet (`package.mjs`), release (`release.mjs`), générateurs de fixtures et d'icône. |
| `i18n/` | `fr_FR.json` (40 clés). Seule langue. |

### Frontière : adaptateur SiYuan / cœur pur

- **Adaptateur SiYuan** : `src/index.ts`, `src/searchTab.ts` (câblage), `src/siyuan/*`, `src/indexer/loadPdf.ts` (`window.pdfjsLib`), `src/ui/*` (DOM).
- **Cœur pur** : `src/core/*` et `src/search/*`. Pas de DOM (vérifié par recherche). Une exception : `src/search/thumbnailCache.ts` utilise `globalThis.indexedDB` par défaut, injectable.
- **Règle** : toute dépendance à SiYuan, au noyau, à PDF.js ou au DOM passe par une fonction injectée (`deps`). Les tests remplacent ces dépendances.

---

## 4. Décisions d'architecture et pièges rencontrés

### Décisions
- **Cible v1** : SiYuan webapp sur ordinateur (testée en 3.8.9), y compris Docker. Le mobile n'a pas `openTab` pour les plugins (`openTab` y est un « TODO: Mobile » dans l'API de plugin, lu dans le dépôt SiYuan lors du plan : non revérifié ici) : hors v1. L'application de bureau est déclarée (`plugin.json`) mais non testée.
- **PDF.js** : celui de SiYuan (`window.pdfjsLib`, 6.4.299), non embarqué. Le plugin ne vérifie pas la version à l'exécution (le plan le prévoyait) ; M0 la rapporte seulement.
- **Surlignage** : calque dessiné par le plugin dans le visualiseur natif, pas la barre de recherche de PDF.js (qui ne gère ni préfixes ni termes non adjacents). Les boîtes sont enregistrées en fractions de page pour être utilisées en pourcentages CSS.
- **Un `.dsx` par PDF**, nommé `<empreinte>.dsx` (empreinte = chemin et taille, `manifest.ts`). Dans `data/storage/petal/siyuan-docseeker/idx/`, synchronisé par SiYuan.
- **Pas de Worker d'indexation** : l'extraction tourne dans le thread principal (le seul `new Worker` sert au diagnostic M0). Écart avec le cahier des charges, non mesuré dans SiYuan.
- **Préfixe sur le dernier mot seulement**, comme DocSeeker. Écarts Unicode documentés dans les tests.
- **PDF sans texte** : ignorés, signalés, et notés au manifeste pour ne pas être relus à chaque passe.
- **Classement** : BM25 par page + score de document (titre, meilleur BM25, nombre de pages) comme DocSeeker ; re-classement par proximité en phase 1 (pas de taille de police, voir section 5).
- **Index en segments** : un segment par document, postings en `Uint32Array`, parce que la version à objets était trop lourde (60 Ko par page mesurés avant compaction, 2,9 Ko après).
- **Écriture de `.dsx`** : `renameFile` du noyau répond 409 si la cible existe, donc `.tmp` → `.bak` → nom final, avec restauration en cas d'échec. Pas atomique au sens POSIX. `read()` et `list()` se rabattent sur `.bak`, mais `removeStaleTmp()` (`petalStore.ts`) n'est appelé nulle part (voir section 5, point 17).
- **Découverte** : aucune suppression d'index sur un parcours incomplet (`complete: false`).
- **Sécurité des `.dsx`** (fichiers synchronisés, donc non fiables) : bornes de taille, de pages, de termes, de boîtes et d'inflation dans `format.ts`, `BudgetExceededError` si dépassé.

### Pièges (vérifiés dans le code ou rapportés)
- **Rechargement du plugin** : ⌘R ne suffit pas. Désactiver puis réactiver le plugin dans Marché > Téléchargés > Plugins (vérifié dans le README, validé [SiYuan]).
- **Plusieurs onglets** : `openNewTab: true` dans `src/index.ts` (sinon SiYuan refocalise l'onglet à identifiant fixe).
- **PDF.js 6.4.299** : pas de `destroy()` sur le `PDFDocumentProxy`, seulement sur `loadingTask` (`src/indexer/loadPdf.ts`, commentaire et test).
- **Noms NFD (macOS)** : `HEAD /assets/…` répond 404 pour ces noms alors que `GET Range` répond 206. D'où le repli dans `kernelApi.headAsset`.
- **Navigation aux flèches entre vignettes** : le code existe (`src/ui/searchView.ts`, gestionnaires `keydown`), fonctionne en jsdom, mais ne fonctionne pas dans SiYuan (constat rapporté par l'utilisateur ; cause non identifiée). Non revérifié ici.
- **Ancien `i18n/fr_FR.json`** : la section « Avancé » affichait la clé brute. Recopier le fichier à chaque build (`npm run package` puis copie).
- **Test de durée** : `tests/unit/extract.test.ts` (ligne ~269) impose une durée inférieure à 20 s. Le rapport « intermittent sous charge » n'a pas été vérifié ici.
- **Commandes enchaînées** : `npm test | grep … && git commit` ne s'arrête pas sur un test rouge. Lire le résultat avant de committer.
- **Node** : les `.ts` du projet ne s'exécutent pas directement avec Node 26 (strip-types). Passer par Vitest.
- **Hook GateGuard** (environnement de l'agent, non lié au code) : exige d'énoncer les faits avant la première édition d'un fichier. Constat de session, non vérifié dans le dépôt.

---

## 5. Dette technique et risques ouverts (classés)

### Fonctionnalité (écarts utilisateur)
1. **Lacunes d'appariement** (`src/search/queryMatch.ts`, `src/core/normalize.ts`) :
   - pas de recherche par sous-chaîne (« pco » ne trouve pas « BPCO ») : documenté dans le README ;
   - mot d'un caractère compté différemment ;
   - expressions entre guillemets non gérées : la tokenisation ignore les guillemets (`TOKEN_RUN = /[\p{L}\p{N}]+/`).
2. **Pas de taille de police dans `.dsx`** (`format.ts`, boîtes = x, y, largeur, hauteur) : ni bonus de taille, ni tri des occurrences par police. Phase 2 du classement.
3. **Largeur de page supposée 595 pt** (`src/core/constants.ts`, `ASSUMED_PAGE_WIDTH_PT`) : la proximité suppose un A4. Pour un Letter ou un format plus large, l'écart de 25 pt est faussé.
4. **Pause et reprise absentes de l'interface.** `src/indexer/indexer.ts` expose `pause()` et `resume()`, `src/core/queue.ts` aussi, mais aucun bouton ne les appelle. Les clés `pause`, `resume`, `indexingPaused` de `fr_FR.json` ne sont utilisées nulle part. **Le CHANGELOG 0.2.0 annonce « pause/reprise dans la section Avancé » : c'est inexact.** Corriger le CHANGELOG ou ajouter les boutons.
5. **Réglages absents** : aucun `addSetting` ni de réglage dans `src/` (cahier des charges F6).
6. **Indexation dans le thread principal** : pas de Worker d'indexation. Le cahier demande que l'interface ne soit jamais bloquée. Non mesuré dans SiYuan.
7. **Pas de grille virtualisée** : toutes les cartes du document sont dans le DOM (au plus 200 pages par document). Pas de file LIFO pour les vignettes (le plan la prévoyait).
8. **Latence réelle du re-classement** (lecture HTTP des `.dsx`) : non mesurée. Ressenti positif en webapp de bureau, pas de chiffre.

### Qualité et mémoire
9. **Double émission d'invalidation** dans `sharedIndex` : `onInvalidate` est émis à l'événement puis à nouveau à la fin du rafraîchissement (`src/search/sharedIndex.ts`, en-tête). Coût faible, mais à simplifier.
10. **Effet réel de `destroy()` PDF.js sur la mémoire** : non mesuré dans SiYuan.
11. **Mémoire de l'index** : 2,9 Ko par page après compaction. Restes : termes dupliqués entre segments ; recherche en O(D log T) ; `decodePageMatches` relit le dictionnaire à chaque page (à grouper).
12. **Options de chargement PDF.js non passées** : `src/indexer/loadPdf.ts` appelle `getDocument({ url })`, sans `disableAutoFetch`, `disableStream` ni `rangeChunkSize` (prévus par le plan). Les Range sont validés (M0), mais la consommation réseau et mémoire sur les gros PDF avec les options par défaut n'est pas mesurée.
13. **Mesures non rejouables** : `measure:corpus` et `measure:multiword` lisent des données locales. `CORPUS_DIR` et `DSX_OUT` (`tests/perf/corpus.measure.test.ts`) ont des valeurs par défaut propres à cette machine et à une session. À rendre configurables avant de partager le dépôt.

### Sécurité (différés, rapportés par les revues)
14. `makeSegment` (`src/core/bm25.ts`) partage `pageLengths` quand les termes sont réordonnés. Non revérifié ligne par ligne.
15. Données IndexedDB non validées (`size` NaN, `blob` non `Blob`) dans `src/search/thumbnailCache.ts`.
16. Clé de vignette sans le recadrage : la clé dépend de la requête (`thumbnailLoader.ts`), mais pas du cadrage lui-même.
17. **`removeStaleTmp()` n'est jamais appelé** (aucun appelant dans `src/`). Après une coupure entre les deux renames de `petalStore`, un `<nom>.bak` sans `<nom>` reste tel quel : `read()` s'en sert, mais rien ne le restaure ni ne le nettoie au démarrage. À câbler au démarrage et à tester.
18. Un blob de boîtes corrompu n'est détecté qu'à la lecture de la page : des vignettes peuvent manquer, sans erreur globale.

### Documentation et process
19. **`src/siyuan/openPdf.ts`** : l'en-tête dit « none of this is verified yet » et liste six points à valider. La fonctionnalité a été validée dans SiYuan ([SiYuan] section 2). **Mettre à jour cet en-tête.**
20. **`CHANGELOG.md` 0.2.0** : annonce « pause/reprise dans la section Avancé », ce qui est inexact (point 4). Corriger avant la prochaine release.
21. **`release:check`** : échoue sur le tag existant. Normal après publication ; il faut incrémenter la version avant la release suivante.
22. **`preview.png`** absent (requis pour le Marché).
23. **Pas de CI** : aucun `.github/`. Les vérifications ne tournent que sur la machine du développeur.
24. **Pas de lint** : aucun script `lint` ni ESLint, alors que le plan initial le prévoyait.
25. **Couverture** : 97,99 % des lignes (mesure du 2026-11-05 ; le chiffre « ~99 % » était ancien).

---

## 6. Prochaines étapes priorisées

Chaque étape a un critère de fin. L'ordre est une proposition.

1. **Revalider dans SiYuan le cadrage multi-termes des vignettes** (`13b3c55`, non revalidé).
   - Fin : une requête à deux mots montre des vignettes cadrées sur la zone qui contient les deux mots, dans SiYuan 3.8.9, après un rebuild et une désactivation/réactivation du plugin.
2. **Décider de la pause/reprise** : ajouter les deux boutons (les clés i18n existent déjà) ou retirer le code mort.
   - Fin : un bouton « Pause » qui arrête la file, un bouton « Reprendre » qui la relance, testés (`tests/unit/indexer/indexer.test.ts`) et vérifiés dans SiYuan. Le CHANGELOG reflète le comportement réel.
3. **Robustesse des écritures et documents périmés** : câbler `removeStaleTmp()` au démarrage du plugin (`src/siyuan/petalStore.ts`, test d'un `.bak` orphelin) ; mettre à jour l'en-tête de `src/siyuan/openPdf.ts` et le CHANGELOG (pause).
   - Fin : un `.bak` orphelin est restauré ou supprimé au démarrage, couvert par un test ; aucun commentaire ne dit « non vérifié » pour une fonction validée ; le CHANGELOG ne mentionne que des fonctions présentes.
4. **Phase 2 du classement** : taille de police dans le `.dsx`, bonus de taille de police (plafond 400, seuil 10 pt), tri des occurrences par police. Nouvelle version de format (`DSX_FORMAT_VERSION = 2`) et réindexation complète.
   - Fin : le jeu de référence `tests/fixtures/docseeker-ranking.json` est régénéré avec les cas de police, la parité est verte, et une réindexation de la bibliothèque réelle passe.
5. **Lacunes d'appariement** : sous-chaîne (≥ 4 caractères), mot d'un caractère, expressions entre guillemets.
   - Fin : tests de parité ajoutés pour chaque cas, avec décision documentée dans le README (ce qui reste hors périmètre).
6. **Navigation clavier dans SiYuan** : diagnostiquer pourquoi les flèches ne fonctionnent pas dans SiYuan (hypothèse non vérifiée : SiYuan capture les touches avant le plugin).
   - Fin : les flèches changent le focus entre cartes dans SiYuan 3.8.9, ou le comportement de repli (Tab) est documenté.
7. **Mesure de latence sur serveur Docker** : temps de chargement des `.dsx` et du re-classement.
   - Fin : un chiffre (médiane, p95) pour une requête à deux mots sur le corpus de 47 PDF, publié dans ce fichier.
8. **`preview.png` et soumission au Marché** (`siyuan-note/bazaar`).
   - Fin : `preview.png` dans le dépôt, PR ouverte sur le dépôt Bazaar, lien noté ici.
9. **Réglages** (dossiers, taille des vignettes, indexation au démarrage, vider l'index).
   - Fin : chaque réglage est persisté, testé et visible dans la section « Avancé ».
10. **CI GitHub Actions** : `npm test`, `npm run typecheck`, `npm run package` sur chaque push.
    - Fin : workflow vert sur `main`, badge dans le README.
11. **Améliorations** : grille virtualisée si le document a beaucoup de pages, réduction de la duplication de termes entre segments, validation des données IndexedDB, clé de vignette avec recadrage.
    - Fin : chaque point fermé par un test ou une mesure.

---

## 7. Commandes utiles

```bash
# Installation et vérifications (à lancer avant chaque commit)
npm install
npm test                       # 1 337 tests (Vitest, tests/unit)
npm run typecheck              # tsc --noEmit (src), puis tsconfig.test.json
npm run test:coverage          # couverture, seuil 80 % (src/**)
npm run package                # vite build -> dist/index.js, puis package.zip
npm run release:check          # vérifie une release SANS rien publier (tag, version, CHANGELOG, tests, zip)

# Mesures (hors npm test, lisent des données locales en lecture seule)
npm run measure:memory         # mémoire de l'index décodé ; DSX_DIR, COPIES=20 pour extrapoler
npm run measure:multiword      # requêtes multi-mots sur les vrais .dsx ; DSX_DIR
npm run measure:corpus         # indexation + requêtes sur un corpus de PDF ; CORPUS_DIR, PDFJS_DIR, CORPUS_LIMIT, QUERY_RUNS

# Fixtures (écrivent dans tests/fixtures)
DOCSEEKER_RUST_DIR=/chemin/vers/DocFastExplorer/backend-rust npm run gen:ranking-fixture
node scripts/gen-fts5-fixture.mjs          # jeu BM25 de référence (nécessite sqlite3)
node scripts/gen-fts5-tokens-fixture.mjs   # tokenisation de référence
```

### Déploiement sur SiYuan
- **SiYuan local (macOS, dossier par défaut)** : copier `dist/index.js`, `plugin.json`, `i18n/`, `README.md`, `README_en_US.md` et `icon.png` dans `~/SiYuan/data/plugins/siyuan-docseeker/`. Le `i18n/fr_FR.json` doit être à jour (sinon clés brutes).
- **SiYuan dans Docker** : le même dossier, dans `<dossier monté>/data/plugins/siyuan-docseeker/`. Pas de reconstruction ni de redémarrage du conteneur (README).
- **Rechargement** : Marché > Téléchargés > Plugins, désactiver puis réactiver DocSeeker. Ni ⌘R ni relancer SiYuan ne suffisent (validé [SiYuan]).
- **Ne jamais modifier les données SiYuan (`~/SiYuan`) sans demander**. Les mesures lisent `~/SiYuan/data/storage/petal/siyuan-docseeker/idx` en lecture seule.

### Procédure de publication
1. Incrémenter la version à l'identique dans `package.json` et `plugin.json` (format `x.y.z`, `release.mjs` le vérifie), et ajouter une section `## x.y.z` dans `CHANGELOG.md`.
2. `npm run release:check` : doit afficher `Release X.Y.Z prête. Rien n'a été publié.`
3. Commit (voir section 8), puis `git push origin main`.
4. `git tag vX.Y.Z` puis `git push origin vX.Y.Z`.
5. `gh release create vX.Y.Z package.zip --title "DocSeeker X.Y.Z" --notes-file CHANGELOG.md`.

`release:check` ne publie rien. Il affiche les commandes à lancer à la main.

---

## 8. Conventions de travail (CLAUDE.md)

- **Délégation** : l'agent principal coordonne. Le code et les corrections de bug passent par `ecc:tdd-guide` (tests d'abord). Relecture : `ecc:typescript-reviewer`, `ecc:code-reviewer`, et selon le sujet `ecc:silent-failure-hunter`, `ecc:security-reviewer`, `ecc:performance-optimizer`, `ecc:pr-test-analyzer`.
- **Skills** : `ecc:coding-standards`, `ecc:tdd-workflow`, `ecc:verification-loop` à chaque tâche de code.
- **Commit seulement si** `npm run typecheck` et `npm test` sont verts.
- **Push** : `git push origin main`. Si GitHub refuse la clé, ne pas contourner : signaler et pousser plus tard. Vérifier `git log origin/main..HEAD`.
- **Identité git** : passée à la volée à la commande `git commit`, sans modifier la configuration globale. Les 34 commits existants portent la ligne `Co-Authored-By: Claude Sonnet 5.5`.
- **Données SiYuan** : ne jamais modifier sans demander.
- **Documentation** : pas de fichiers de rapport créés à la volée. Ce fichier et `PLAN_IMPLEMENTATION.md` sont mis à jour à chaque jalon.

---

## 9. Glossaire

- **`.dsx`** : fichier d'index binaire d'un PDF (magic `DSX1`, version de format 1), stocké dans `data/storage/petal/siyuan-docseeker/idx/`.
- **Empreinte** : nom du `.dsx`, dérivé du chemin et de la taille du PDF (`fingerprint` dans `src/core/manifest.ts`).
- **Ordinal** : indice d'un mot ou d'un jeton dans sa page (`pageBoxes[page]`). Un jeton = une boîte.
- **WordBox** : boîte d'un mot en fractions de page (x, y, largeur, hauteur, origine en haut à gauche).
- **Occurrence** : groupe de mots de la requête qui se suivent dans la même ligne (`src/search/proximity.ts`).
- **`focusOrdinals`** : ordinaux des mots à mettre en évidence dans une vignette (`src/search/thumbnailPlan.ts`).
- **Fenêtre de re-classement** : lot de 15 documents re-triés ensemble (`RERANK_WINDOW`), jusqu'à 60 documents (`RERANK_MAX_DOCS`).
- **Grâce** : délai de 300 ms (`RERANK_GRACE_MS`) avant d'appliquer le re-classement, pour éviter un saut visuel.
- **Petal store** : stockage de fichiers par plugin de SiYuan (`/data/storage/petal/<plugin>/`), via l'API du noyau (`src/siyuan/petalStore.ts`).
- **Calque (overlay)** : rectangles jaunes positionnés en pourcentages dans `.page[data-page-number=N]` du visualiseur (`src/ui/highlightOverlay.ts`).
- **Segment** : index BM25 d'un document (`DocumentSegment`) ; l'index global est une liste de segments (`src/core/bm25.ts`).
- **MAX_EXPANDED_PAGES** : plafond de 200 pages par document (`src/core/bm25.ts`).
- **DocSeeker (application d'origine)** : `~/Documents/DocFastExplorer`, backend Rust `search-core`, dont le classement est répliqué.
- **M0** : diagnostic technique (spike) exécuté dans SiYuan.
