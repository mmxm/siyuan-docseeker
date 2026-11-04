# Avancement — Plugin SiYuan « DocSeeker »

> Journal d'état, à relire en début de session. Complète `CAHIER_DES_CHARGES.md` (le quoi) et `PLAN_IMPLEMENTATION.md` (le comment). Règles de travail : `CLAUDE.md`.
> Dernière mise à jour : 2026-11-04.

## En une minute

- **Fait** : toute la logique sans interface (normalisation, BM25, codec `.dsx`, extraction, indexeur, client noyau, découverte, ouverture + calque de surlignage) et un plugin minimal chargé dans un vrai SiYuan (onglet avec « Diagnostic M0 » et « Réindexer »).
- **Validé dans SiYuan 3.8.9** : diagnostic M0 6/6, indexation réelle de 4 PDF (dont 165 Mo).
- **Problème bloquant pour la recherche** : mémoire de l'index décodé ≈ 60 Ko/page, soit 1,5 à 2,5 Go pour les 47 PDF. À traiter **avant** l'onglet de recherche.
- **Pas encore fait** : onglet de recherche, vignettes, clic → PDF à la bonne page surlignée (jamais essayé en vrai), réglages, `icon.png`.
- **GitHub** : dépôt `git@github.com:mmxm/siyuan-docseeker.git`, branche `main`. **Des commits locaux ne sont pas poussés** (GitHub était en panne le 2026-11-04) : faire `git push origin main` dès que possible (voir `git log origin/main..HEAD`).

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

1. **Mémoire de l'index de recherche** (confirmé, bloquant). Pistes, par ordre : (a) ne pas décoder `wordOrdinals` pour la recherche (inutiles au classement) ; (b) postings en tableaux typés (`Uint32Array`) au lieu d'objets ; (c) chargement des index à la demande / par document ; (d) interner/éliminer les termes rares. Mesurer avec `decodeIndexForSearch` sur les `.dsx` réels (outil : un test Vitest temporaire qui lit `~/SiYuan/data/storage/petal/siyuan-docseeker/idx/*.dsx`, forcer le GC pour une mesure fiable) avant et après.
2. **Surlignage et ouverture à la bonne page** non éprouvés (voir « Non testé »). C'est le cœur du critère d'acceptation ; à valider dès qu'une première recherche existe.
3. Écritures concurrentes sérialisées dans un seul onglet : deux onglets ou deux appareils restent exposés (le repli sur `.bak` atténue).
4. La pause de l'indexeur n'interrompt pas les jobs déjà en cours (elle empêche d'en démarrer de nouveaux).
5. `getViewport({scale:1})` du PDF.js de SiYuan doit fournir `transform`, `width`, `height` (a fonctionné pour les 4 PDF indexés).

## Prochaines étapes

1. **Réduire la mémoire de l'index** (risque 1), en TDD, mesures avant/après sur les `.dsx` réels. Objectif indicatif : < 300 Mo pour 40 000 pages.
2. **Onglet de recherche** : saisie, BM25 + regroupement par document, vignettes paresseuses (rendu + cache IndexedDB), clic → `openPdfAtPage` (+ calque). Charger les index en filtrant sur `.dsx`.
3. **Valider à la main dans SiYuan** : ouverture à la bonne page, surlignage, zoom, PDF déjà ouvert, plusieurs onglets PDF.
4. Réglages, thème clair/sombre, `icon.png`, mesures sur les 47 PDF du corpus réel (`/Users/francois/Documents/DocFastExplorer/data/documents`, hors fichiers de test OffNote/RaceNote/RT_/ZipExport…). Voir `CAHIER_DES_CHARGES.md` §8.
5. Pousser sur GitHub.

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
