# Avancement — Plugin SiYuan « DocSeeker »

> Journal d'état, à relire en début de session. Complète `CAHIER_DES_CHARGES.md` (le quoi) et `PLAN_IMPLEMENTATION.md` (le comment).
> Dernière mise à jour : 2026-11-04.

## Où on en est

**Fait, testé en local (601 tests, typage strict propre, couverture ~99 % des lignes de `src`) :**

| Module | Rôle |
|---|---|
| `src/core/normalize.ts` | Normalisation et tokenisation (équivalent FTS5 `unicode61 remove_diacritics 2`) |
| `src/core/bm25.ts` | BM25 au niveau de la page ; parité avec SQLite FTS5 **prouvée** sur un jeu de référence généré (`tests/fixtures/fts5-parity.json`) |
| `src/core/crop.ts`, `constants.ts` | Cadrage des vignettes, conversion des boîtes en pourcentages (portage de `crop-worker.js`) |
| `src/core/manifest.ts` | Diff incrémental des PDF, empreinte 53 bits, erreurs typées |
| `src/core/queue.ts` | File d'indexation (pause, reprise, annulation, échec isolé, journal borné) |
| `src/core/codec/*` | Format binaire `.dsx` versionné, compressé par section, budgets anti-bombe, `decodeIndexForSearch` sans boîtes |
| `src/core/extract.ts` | Texte PDF.js → `DocumentIndex` (une boîte par jeton), détection des PDF scannés |
| `src/core/indexMerge.ts` | Fusion des index décodés en un index de recherche, mises à jour incrémentales |
| `src/siyuan/kernelApi.ts` | Client de l'API HTTP du noyau (formats vérifiés dans le code Go) |
| `src/siyuan/petalStore.ts` | Stockage des `.dsx` (écriture par `.tmp` + `.bak`, car `renameFile` n'écrase pas) |
| `src/siyuan/discovery.ts` | Liste des PDF de `data/assets`, `complete` + `planIndexUpdate` (jamais de suppression sur un parcours incomplet) |
| `src/siyuan/openPdf.ts`, `src/ui/highlightOverlay.ts` | Ouverture à la bonne page et calque de surlignage en % dans le visualiseur natif |

Chaque module a été écrit en TDD (agents ECC `tdd-guide`), puis relu par trois agents de revue (TypeScript, échecs silencieux, sécurité) dont les constats ont été corrigés.

**Plugin :** `src/index.ts` (icône, commande, onglet avec bouton « Diagnostic M0 »), `src/diagnostic/m0.ts` (7 contrôles : discovery, head, range, roundtrip, pdfjs, worker, auth), `npm run package` produit `package.zip` (build vérifié, jamais chargé dans un vrai SiYuan). Pas encore d'`icon.png`.

**Dépôt :** `git@github.com:mmxm/siyuan-docseeker.git`, branche `main`. Identité de commit passée à la volée (`-c user.name=francois -c user.email=…`), rien dans la config git globale.

## Décisions prises

- Cible v1 : SiYuan **webapp sur ordinateur** (3.8.9 installé en local). Le mobile n'a pas `openTab` pour les plugins : hors v1.
- PDF.js : celui **de SiYuan** (`/stage/protyle/js/pdf/`, `window.pdfjsLib`), non embarqué.
- Index : un fichier `.dsx` par PDF sous `data/storage/petal/<plugin>/idx/`, synchronisé par SiYuan.
- Clic sur une vignette : visualiseur natif, **surlignage par calque dessiné par le plugin** (pas la barre de recherche de PDF.js, qui ne gère ni préfixes ni termes non adjacents).
- PDF scannés : ignorés et signalés. Documents SiYuan : hors périmètre. Interface en français.
- Préfixe sur le **dernier mot seulement** (DocSeeker l'applique à tous) ; écarts Unicode volontaires documentés dans les tests.

## Risques ouverts (à ne pas oublier)

1. **Mémoire de l'index de recherche** (nouveau, important). Un index synthétique de 3 000 pages décodé pour la recherche pèse 60 à 100 Mo, mesure bruitée. Le corpus réel (47 PDF, ~25 000 à 40 000 pages) pourrait atteindre le Go en objets JS. Pistes : ne pas décoder `wordOrdinals` pour la recherche (inutiles au classement), stocker les postings en tableaux typés, charger les index à la demande. **À mesurer sur le vrai corpus avant de continuer.**
2. **Hypothèses jamais testées dans un vrai SiYuan** (spike M0) : chargement du PDF.js de SiYuan depuis un Worker ; numérotation des pages de `openTab` ; `openTab` sur un PDF déjà ouvert ; détection de l'onglet visible ; PDF.js remplace-t-il l'élément `.page` ; `HEAD` + `Content-Length` sur `/assets/*.pdf` ; limite de taille de `putFile` ; réponse d'auth quand la session expire.
3. Les écritures concurrentes ne sont sérialisées que dans un onglet : deux onglets ou deux appareils restent exposés (le repli sur `.bak` atténue).
4. Un traitement abandonné après annulation peut continuer à écrire dans l'index : l'indexeur réel devra vérifier avant de publier.

## Prochaines étapes

1. **Exécuter le diagnostic M0** : installer `package.zip` dans un SiYuan en marche (le noyau ne tourne pas actuellement), avec des PDF importés, et lire le rapport. Restent à vérifier à la main : `openTab` à la page N, re-création du calque au zoom, expiration de session.
2. Ajouter `icon.png`.
3. Indexeur réel : worker + PDF.js de SiYuan + `buildDocumentIndex` + `encodeIndex` + `petalStore`, piloté par `queue`.
4. Onglet de recherche : saisie, BM25, regroupement, vignettes paresseuses (rendu + cache IndexedDB), clic → `openPdfAtPage`.
5. Réglages, thème, mesures sur le corpus de 47 PDF (voir `CAHIER_DES_CHARGES.md` §8).

## Commandes utiles

```bash
npm test                  # tous les tests
npm run test:coverage     # couverture (seuil 80 % sur src)
npm run typecheck         # src (sans types Node) puis tests (avec types Node)
node scripts/gen-fts5-fixture.mjs         # régénère le jeu de référence BM25 (nécessite sqlite3)
node scripts/gen-fts5-tokens-fixture.mjs  # idem pour la tokenisation
```
