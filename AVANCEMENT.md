# Avancement — Plugin SiYuan « DocSeeker »

> Journal d'état, à relire en début de session. Complète `CAHIER_DES_CHARGES.md` (le quoi) et `PLAN_IMPLEMENTATION.md` (le comment). Règles de travail : `CLAUDE.md`.
> Dernière mise à jour : 2026-11-04.

## En une minute

- **Fait** : toute la logique sans interface (normalisation, BM25, codec `.dsx`, extraction, indexeur, client noyau, découverte, ouverture + calque de surlignage) et un plugin minimal chargé dans un vrai SiYuan (onglet avec « Diagnostic M0 » et « Réindexer »).
- **Validé dans SiYuan 3.8.9** : diagnostic M0 6/6, indexation réelle de 4 PDF (dont 165 Mo).
- **Mémoire de l'index traitée (2026-11-04)** : `Bm25Index` en segments par document, postings en `Uint32Array` (CSR), `wordOrdinals` non décodés pour la recherche. Mesure : ≈ 55 Ko/page → **2,89 Ko/page** (≈ 113 Mo pour 40 000 pages) via `COPIES=20 npm run measure:memory` (4 index réels recopiés ; à refaire sur les 47 PDF). 707 tests. Restes : termes dupliqués entre segments, coût de recherche O(D·log T).
- **Onglet de recherche écrit (2026-11-04, commit 52d347b)** : saisie avec délai, BM25 groupé par document, vignettes paresseuses surlignées (PDF.js de SiYuan, cache IndexedDB), clic → `openPdfAtPage` + calque, états d'erreur visibles, accessibilité clavier/ARIA. 966 tests, `dist/index.js` 191 Ko. Relu par 5 agents (TS, erreurs avalées, a11y, perf, sécurité), corrections faites. **Jamais essayé dans un vrai SiYuan.**
- **Validé à la main dans SiYuan 3.8.9 (2026-11-04, captures de l'utilisateur)** : recherche d'un mot (« BPCO », 3 documents, 30 pages), vignettes rendues avec mots surlignés, clic → PDF ouvert à la bonne page avec calque de surlignage, **PDF déjà ouvert**, **zoom**, **thème sombre**. Constaté : la section « Avancé » affichait la clé brute (`advanced`) car `i18n/fr_FR.json` installé était ancien ; corrigé en copiant le fichier.
- **Requêtes multi-mots et préfixes** : validées hors interface sur les 4 vrais `.dsx` (`npm run measure:multiword`, 1 570 pages ; AND, préfixe sur le dernier mot seulement, accents/casse/ponctuation, requête vide, < 3 ms ; pages résultat = intersection des postings, boîtes cohérentes) + `tests/unit/search/queryConsistency.test.ts`. Aucun bug trouvé. Reste à les essayer à la main dans l'onglet.
- **Cadrage des vignettes multi-termes** : la vignette se centre sur la zone de 300x120 pt qui couvre le plus de mots distincts de la requête (index de terme par ordinal, `makeTermIndexer`, `termIndexes`), repli sur l'ancien comportement sans info de terme ; version du cache de vignettes passée à 2. Vérifié sur le vrai .dsx (« classification bpco », ITEM_209 p. 6 → paragraphe I.2), relu (typescript-reviewer), findings corrigés. À revalider à la main après rebuild.
- **Pas encore validé / fait** : plusieurs onglets PDF, réindexation à chaud, réglages, `icon.png`, mesures sur les 47 PDF (temps de chargement à froid, mémoire réelle).
- **GitHub** : dépôt `git@github.com:mmxm/siyuan-docseeker.git`, branche `main`, à jour (le push avait échoué en début de session puis a fonctionné).

## Où on en est

**Tests : 679, typage strict propre, couverture ~99 % des lignes de `src`.**

| Module | Rôle |
|---|---|
| `src/core/normalize.ts` | Normalisation et tokenisation (équivalent FTS5 `unicode61 remove_diacritics 2`) |
| `src/core/bm25.ts` | BM25 au niveau de la page ; parité avec SQLite FTS5 **prouvée** sur un jeu de référence généré (`tests/fixtures/fts5-parity.json`) |
| `src/core/crop.ts`, `constants.ts` | Cadrage des vignettes, conversion des boîtes en pourcentages (portage de `crop-worker.js` de DocSeeker) |
| `src/core/manifest.ts` | Diff incrémental des PDF, empreinte 53 bits, erreurs typées |
| `src/core/queue.ts` | File d'indexation (pause, reprise, annulation, échec isolé, journal borné) |
| `src/core/codec/*` | Format binaire `.dsx` versionné, compressé par section, budgets anti-bombe, `decodeIndexForSearch` sans boîtes |
| `src/core/extract.ts` | Texte PDF.js → `DocumentIndex` (une boîte par jeton), détection des PDF scannés |
| `src/core/indexMerge.ts` | Fusion des index décodés en un index de recherche, mises à jour incrémentales |
| `src/siyuan/kernelApi.ts` | Client de l'API HTTP du noyau. `headAsset` : `HEAD`, avec repli `GET Range: bytes=0-0` (+ `Content-Length` si 200) quand `HEAD` répond 404 |
| `src/siyuan/petalStore.ts` | Stockage des `.dsx` (écriture par `.tmp` + `.bak`, car `renameFile` n'écrase pas) |
| `src/siyuan/discovery.ts` | Liste des PDF de `data/assets`, `complete` + `planIndexUpdate` (jamais de suppression sur un parcours incomplet) |
| `src/siyuan/openPdf.ts`, `src/ui/highlightOverlay.ts` | Ouverture à la bonne page et calque de surlignage en % dans le visualiseur natif — **jamais essayés dans un vrai SiYuan** |
| `src/indexer/indexer.ts` | Orchestrateur injectable : découverte, `manifest.json`, extraction, `.dsx`, annulation sans publication tardive, PDF scannés notés au manifeste |
| `src/indexer/loadPdf.ts` | Charge un PDF via `window.pdfjsLib` de SiYuan (URL encodée par segment, annulation) |
| `src/diagnostic/m0.ts` | 7 contrôles techniques (discovery, head, range, roundtrip, pdfjs, worker, auth), le plus petit PDF **non vide** sert au test PDF.js |
| `src/index.ts` | Plugin : icône de barre supérieure, commande, onglet (Réindexer + état, Diagnostic M0) |

Build : `npm run package` → `dist/index.js` + `package.zip` (index.js, plugin.json, i18n, README). Installation de test : copie manuelle dans `~/SiYuan/data/plugins/siyuan-docseeker/` puis rechargement de SiYuan (⌘R). Pas encore d'`icon.png`.

## Décisions prises

- Cible v1 : SiYuan **webapp sur ordinateur** (3.8.9). Le mobile n'a pas `openTab` pour les plugins : hors v1.
- PDF.js : celui **de SiYuan** (`/stage/protyle/js/pdf/`, `window.pdfjsLib`), non embarqué.
- Index : un fichier `.dsx` par PDF sous `data/storage/petal/<plugin>/idx/`, synchronisé par SiYuan. `manifest.json` est dans le même dossier : le chargement des index doit filtrer sur `.dsx`.
- Clic sur une vignette : visualiseur natif, **surlignage par calque dessiné par le plugin** (pas la barre de recherche de PDF.js, qui ne gère ni préfixes ni termes non adjacents).
- PDF scannés : ignorés et signalés (notés au manifeste pour ne pas être réextraits à chaque passe ; à rediscuter si on préfère les retenter). Documents SiYuan : hors périmètre. Interface en français.
- Préfixe sur le **dernier mot seulement** (DocSeeker l'applique à tous) ; écarts Unicode volontaires documentés dans les tests.

## Résultats réels dans SiYuan 3.8.9 (webapp desktop, 2026-11-04)

**Diagnostic M0 — 6 OK, 0 échec, 1 ignoré (auth)** :
- `Content-Length` lu ; `Range` → 206 ; `putFile`/`getFile` de 50 Mio identiques (18 à 41 Mo/s) ; `window.pdfjsLib` 6.4.299 : `getDocument` + texte OK (23 pages, 123 items) ; Worker module same-origin sur `/stage/protyle/js/pdf/pdf.worker.min.mjs` OK.
- Écarts trouvés et corrigés : `HEAD` renvoie **404** pour les noms accentués (NFD, double espace) alors que `GET` + `Range` répond 206 ; un PDF de 0 octet est servi en 200 sans `Content-Range` ; le PDF vide ne doit pas être choisi pour tester PDF.js.

**Indexation réelle** (corpus de test dans `~/SiYuan/data/assets` : 5 PDF dont Hématologie à 0 octet) :
- `.dsx` : 62 Ko pour 23 pages ; 1,2 à 1,5 Mo pour 380 à 480 pages (≈ 3 Ko/page). Le PDF de 165 Mo (378 pages, 181 508 mots) donne 1,5 Mo. Extrapolé : 100 à 150 Mo pour les 47 PDF, acceptable.
- **Mémoire de l'index décodé** (`decodeIndexForSearch`, mesure sans ramasse-miettes forcé, indicative) : ≈ 27 à 28 Mo pour ~460 pages, soit ≈ 60 Ko/page → **1,5 à 2,5 Go** pour 25 000-40 000 pages. Trop.

**Non testé** : expiration de session ; `openTab` à la page N (numérotation) ; `openTab` sur un PDF déjà ouvert ; calque de surlignage au zoom / re-rendu ; détection de l'onglet visible ; durée de l'indexation complète des 47 PDF.

## Risques ouverts

1. **Mémoire de l'index** : traitée (≈ 2,9 Ko/page). Restes : termes dupliqués entre segments. Perf reportées jusqu'aux mesures réelles : `decodePageMatches` relit dictionnaire + postings à chaque page (grouper par document/requête), `searchPages` en mode préfixe court (accumulateurs typés, plafond de préfixe), tri partiel du top 5. Sécurité (revue) : un blob de boîtes corrompu n'est détecté qu'à la lecture de la page (pages sans vignette possibles) ; mineurs : `makeSegment` partage `pageLengths` quand les termes sont réordonnés (bm25.ts ~232), données IndexedDB non validées (`size` NaN, `blob` non Blob), clé de vignette sans le recadrage.
2. **Surlignage et ouverture à la bonne page** non éprouvés (voir « Non testé »). C'est le cœur du critère d'acceptation ; à valider dès qu'une première recherche existe.
3. Écritures concurrentes sérialisées dans un seul onglet : deux onglets ou deux appareils restent exposés (le repli sur `.bak` atténue).
4. La pause de l'indexeur n'interrompt pas les jobs déjà en cours (elle empêche d'en démarrer de nouveaux).
5. `getViewport({scale:1})` du PDF.js de SiYuan doit fournir `transform`, `width`, `height` (a fonctionné pour les 4 PDF indexés).

## Prochaines étapes

1. **Valider à la main dans SiYuan** (avec l'accord de l'utilisateur pour copier `dist/index.js`) : chargement des index, première recherche, vignettes (rendu et surlignage), clic → bonne page surlignée, zoom, PDF déjà ouvert, plusieurs onglets PDF, thème clair/sombre.
2. Corriger ce que la validation révèle ; puis les perf reportées (risque 1) selon les mesures réelles.
3. Réglages, `icon.png`, mesures sur les 47 PDF du corpus réel (`/Users/francois/Documents/DocFastExplorer/data/documents`, hors fichiers de test OffNote/RaceNote/RT_/ZipExport…). Voir `CAHIER_DES_CHARGES.md` §8.
4. Charger les index au démarrage du plugin (aujourd'hui à l'ouverture de l'onglet, résultats partiels pendant le chargement) ; chaque onglet recrée son `searchStore`.

## Commandes utiles

```bash
npm test                  # tous les tests
npm run test:coverage     # couverture (seuil 80 % sur src)
npm run typecheck         # src (sans types Node) puis tests (avec types Node)
npm run package           # build Vite puis package.zip
cp dist/index.js ~/SiYuan/data/plugins/siyuan-docseeker/index.js   # puis ⌘R dans SiYuan
git push origin main      # dépôt git@github.com:mmxm/siyuan-docseeker.git (clé SSH présente)
node scripts/gen-fts5-fixture.mjs         # régénère le jeu de référence BM25 (nécessite sqlite3)
node scripts/gen-fts5-tokens-fixture.mjs  # idem pour la tokenisation
```

Commits : identité passée à la volée (`git -c user.name="francois" -c user.email="lesecq.f@gmail.com" commit`), rien dans la config git globale ; ajouter la ligne `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Pièges rencontrés (pour la prochaine session)

- Le hook GateGuard exige, avant la première écriture/édition d'un fichier, d'énoncer les faits demandés (appelants, absence de doublon, schémas, citation verbatim de la dernière instruction de l'utilisateur) puis de relancer.
- Une commande enchaînée (`npm test | grep … && git commit`) **ne s'arrête pas** sur un test rouge : vérifier les résultats avant de commiter.
- Node 26 ne peut pas exécuter directement les `.ts` du projet (syntaxe non supportée par le strip-types) : passer par Vitest.
- Les noms de fichiers macOS sont en NFD ; le noyau SiYuan répond 404 à `HEAD` sur ces noms.
