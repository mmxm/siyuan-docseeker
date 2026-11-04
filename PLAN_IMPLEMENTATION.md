# Plan d'implémentation — Plugin SiYuan « DocSeeker »

> Statut : **en attente de validation**. Aucun code n'est écrit.
> Sources : cahier des charges (`CAHIER_DES_CHARGES.md`), agents ECC `planner` (phases, tests) et `architect` (faisabilité, formats, API).
> Les estimations chiffrées ci-dessous sont des ordres de grandeur d'agents, **non mesurés** : le spike M0 sert à les confirmer.

## 1. Points qui changent le cahier des charges

1. **BM25 et tokenisation à réécrire.** Dans DocSeeker, le classement passe par du SQL FTS5 construit en Rust et par un module Wasm, pas par du JavaScript. Il faut réécrire en TypeScript la tokenisation (minuscules, suppression des accents) et le BM25 (k1 = 1,2 ; b = 0,75), puis tester la parité avec des résultats de référence pris dans DocSeeker. Il faudra lire le code Rust `search-core`, ce qui n'a pas encore été fait. Objectif : un classement identique, pas des scores absolus identiques.
2. **Unité d'indexation = la page**, comme `page_bm25` dans DocSeeker.
3. **Le plugin utilise le PDF.js de SiYuan, pas le sien** (décision de l'utilisateur). Il n'est donc pas embarqué dans le paquet. Constaté dans le dépôt (`app/src/asset/pdfViewer.ts`, `app/src/constants.ts`) et dans l'app installée :
   - SiYuan sert son PDF.js à `/stage/protyle/js/pdf/` : `pdf.min.mjs` (bibliothèque), `pdf.worker.min.mjs` et `pdf.worker.compat.mjs` (workers), avec les dossiers `cmaps`, `standard_fonts`, `iccs` et `wasm`.
   - Il le charge comme un script module puis lit `window.pdfjsLib`. C'est l'accès à réutiliser côté page : utiliser `window.pdfjsLib` s'il est présent, sinon charger le même module.
   - Version actuelle : 6.4.299 (variante « siyuan »). Le plugin lit `pdfjsLib.version` au démarrage. Si elle sort de la plage testée, il le signale dans le journal au lieu de planter.
   - Les chemins `cMapUrl`, `standardFontDataUrl`, `iccUrl` et `wasmUrl` pointent vers ce même dossier.
   - **À valider au spike** : charger le module `pdf.min.mjs` depuis un Worker (le plan prévoit l'import dynamique de ses exports, et le montage du worker comme le fait `crop-worker.js:5-7` avec `globalThis.pdfjsWorker`) ; sinon, extraire le texte dans la page principale par lots.
   - Conséquences : l'index enregistre la version de PDF.js qui a extrait le texte (en plus de celle du normaliseur), car l'extraction peut varier d'une version à l'autre ; une mise à jour de SiYuan peut donc déclencher une réindexation douce.
4. **Visualiseur natif** (vérifié dans le dépôt `siyuan-note/siyuan`, `app/src/asset/` et `app/src/plugin/API.ts`) :
   - `openTab({ app, pdf: { path, page } })` existe dans l'API de plugin. `page` est un numéro de page (à partir de 1) ; `id` désigne une annotation du `.sya`, dont l'index de page est à partir de 0.
   - Le visualiseur est un PDF.js intégré **dans le DOM de la page** (pas dans une iframe). Il a sa propre barre de recherche (`#findInput`, `#findHighlightAll`, `#findMatchDiacritics`…) et un `PDFFindController`.
   - Pas de surlignage par paramètre d'URL : le `#search=` de PDF.js n'est pas branché dans la classe `Asset`.
   - **Mobile** : l'interface mobile de SiYuan a son propre visualiseur (`app/src/mobile/pdf.ts`, fonction `openMobilePDF`). C'est le même PDF.js, affiché dans une fenêtre modale et non dans un onglet, avec la même barre de recherche. Il s'ouvre à partir d'un lien `assets/x.pdf?page=N` cliqué dans un document. En revanche, `openTab` est un « TODO: Mobile » dans l'API de plugin : un plugin ne peut pas ouvrir un onglet ni un PDF sur mobile par cette voie. Cette limite est hors de la cible v1 (webapp sur ordinateur).
   - **Piste écartée : piloter la barre de recherche du visualiseur.** Elle fait une recherche de texte exact, sans préfixe ni tolérance aux fautes, et elle ne correspond pas à notre recherche (plusieurs mots non adjacents, classement par page). Elle surlignerait autre chose que ce que la vignette a montré.
   - **Piste retenue pour le surlignage, sans toucher aux données : un calque de surlignage dessiné par le plugin.** L'index contient déjà les boîtes des mots trouvés sur chaque page. Après l'ouverture à la bonne page, le plugin ajoute dans le DOM de la page du visualiseur (`.page[data-page-number=N]`) un calque positionné en pourcentages de la page, donc indépendant du zoom, avec un rectangle jaune par mot trouvé, pour tous les termes de la requête, adjacents ou non. Le surlignage est ainsi identique à celui des vignettes et à la logique de recherche du plugin. Points fragiles : PDF.js vide les enfants de la page à chaque nouveau rendu (`PDFPageView.reset`), donc le calque doit être réinjecté sur l'événement `pagerendered` ; et la structure du DOM du visualiseur n'est pas une API publique. À tester au spike. Repli : visionneuse PDF.js propre au plugin, qui utilise la même technique de calque.
   - **Référence DocSeeker (lue dans `frontend/`)** :
     - *Vignettes* (`crop-worker.js:547-556`) : un `fillRect` jaune `rgba(255,226,0,0.45)` par rectangle de l'occurrence (`highlight_rects`, en points PDF, origine en haut à gauche), dessiné sur le canevas rogné.
     - *Occurrence active dans la visionneuse* (`app.js:7448-7580`, `goToPageAndScrollToOccurrence`) : même technique de calque que celle retenue ici. Un `div.active-occ-overlay` est ajouté dans `.page[data-page-number=N]`, positionné en pixels avec `viewport.convertToViewportRectangle`, puis la fonction est rappelée après 150 ms pour absorber un nouveau rendu de la page. Le défilement centre ensuite l'occurrence.
     - *Surlignage de toutes les occurrences* (`app.js:3382-3405`) : événement `find` de PDF.js avec **la requête entière comme une phrase** (`phraseSearch: true`). DocSeeker a donc lui-même la limite signalée pour les termes non adjacents ; notre calque la dépasse.
     - *Différence à gérer* : la visionneuse de DocSeeker est une iframe qui expose `PDFViewerApplication`, d'où l'accès au `viewport`. Dans SiYuan elle est dans le DOM de la page et je n'ai pas trouvé d'instance globale équivalente. D'où les pourcentages de la page plutôt que le `viewport`, et la réinjection sur `pagerendered` plutôt qu'un délai fixe.
   - Conséquence sur le format `.dsx` : les boîtes de mots sont enregistrées en fractions de la page, origine en haut à gauche (conversion faite à l'indexation, rotation intrinsèque de la page comprise), pour servir telles quelles en pourcentages CSS.

## 2. Architecture

```
core/        TS pur, testable sous Node : normalisation, tokenisation, codec .dsx, BM25, cadrage de vignette
workers/     index.worker (PDF.js -> texte + boîtes -> .dsx) · thumb.worker (rendu + crop) · search.worker (index en mémoire)
storage/     PetalStore (putFile/getFile) · CheckpointStore (IndexedDB/OPFS) · ThumbCache (IndexedDB)
siyuan/      seule couche qui touche l'API plugin : openTab, .sya, i18n, thème, API noyau
ui/          onglet central, grille de vignettes virtualisée, progression, réglages
```

### Format `.dsx` (un fichier par PDF)
Chemin : `/data/storage/petal/docseeker/idx/<empreinte>.dsx` (empreinte = chemin de l'asset + taille + `/ID` du PDF).
1. En-tête : magic `DSX1`, version du format, version du normaliseur, taille et date du PDF, nombre de pages, table des offsets.
2. Longueur en termes par page (pour BM25).
3. Dictionnaire de termes triés (front-coding, df, offset) : recherche par préfixe par dichotomie.
4. Postings en delta + varint : page, tf, ordinaux de mots.
5. Boîtes de mots quantifiées (8 octets par mot) pour vignettes et surlignage, décodées page par page.

Compression `CompressionStream('deflate-raw')` **par section**, pour décoder paresseusement. Écriture atomique : `.tmp` puis `renameFile`.

### Indexation
- `getDocument({ disableAutoFetch: true, disableStream: true, rangeChunkSize: 256K })`, sinon PDF.js téléchargerait les 8,7 Go.
- Pool de 2 workers (3 si `hardwareConcurrency` ≥ 8), un PDF à la fois par worker, `doc.destroy()` en fin de document.
- Pause coopérative entre deux pages ; points de reprise tous les 50 à 100 pages en local (IndexedDB/OPFS, non synchronisés) ; le `.dsx` n'est publié qu'une fois le PDF terminé.
- Un PDF en échec ou sans texte est isolé et signalé, le lot continue.

## 3. Phases

| Phase | Contenu | Dépend de |
|---|---|---|
| **M0 – Spike + squelette** | Voir §4. Build Vite/TypeScript strict, `plugin.json`, icône, commande, onglet vide, i18n fr | — |
| **M1 – Indexation** | Tests puis code : normalisation, codec `.dsx`, file d'indexation, découverte (diff manifeste), `index.worker`, progression | M0 |
| **M2 – Recherche** | Tests puis code : BM25, index inversé en tableaux typés, `search.worker`, onglet de recherche (liste nom/page/extrait) | M1 |
| **M3 – Vignettes** | Tests puis code : `calculateCropBounds` (repris de `crop-worker.js`), `thumb.worker` (file LIFO, cache LRU), chargement paresseux, cache IndexedDB, repli texte | M2 |
| **M4 – Navigation** | `openPdf.ts` : page + surlignage selon le résultat du spike ; sinon visionneuse PDF.js du plugin | M3, spike |
| **M5 – Finitions** | Réglages, indexation incrémentale au démarrage, plafonds mémoire, thème, mesures sur le corpus de 47 PDF | M4 |

## 4. Spike M0 (à faire avant le reste)

1. `/assets/*.pdf` accepte-t-il les requêtes Range (206) en webapp, et `HEAD` donne-t-il `Content-Length` ? (`readDir` ne renvoie pas la taille.)
2. Débit (pages/s) et pic mémoire sur le PDF de 165 Mo, puis sur 5 PDF.
3. Ouverture et surlignage, dans cet ordre, en s'arrêtant au premier qui fonctionne :
   a. `openTab({ pdf: { path, page } })` ouvre-t-il la bonne page (numérotation à partir de 1) ?
   b. Calque de surlignage : après l'ouverture, injecter dans `.page[data-page-number=N]` un calque en pourcentages avec quelques rectangles de test. Reste-t-il aligné au zoom et au défilement ? Est-il réinjecté correctement sur `pagerendered` (changement de zoom, retour sur la page) ? Fonctionne-t-il sur un PDF déjà ouvert dans un onglet ?
   c. Seulement si b échoue : visionneuse PDF.js du plugin (même technique de calque). L'annotation temporaire dans le `.sya` n'est plus retenue : elle ne sait surligner qu'un extrait de texte exact et modifie des données synchronisées.
4. Aller-retour `putFile`/`getFile` de 50 Mo binaire, et sa limite de taille.
5. Taille réelle d'un `.dsx`, pour extrapoler au corpus.
6. Chargement des workers depuis `/plugins/<nom>/` en webapp.

## 5. Stratégie de tests (TDD, couverture ≥ 80 % sur `src/core`)

- **Codec** : aller-retour, document et page vides, Unicode, rejet d'une signature ou d'une version invalide, fichier tronqué, migration entre versions, taille maximale sur une fixture.
- **Normalisation** : accents, `œ`/`æ`, ligatures, apostrophes, traits d'union, chiffres, NFC/NFD, chaîne vide.
- **BM25** : valeurs calculées à la main sur 3 documents, ET, préfixe sur le dernier mot seulement, parité de classement avec DocSeeker.
- **Cadrage** : centre, quatre bords, page plus petite que 300×120, boîte dégénérée.
- **File d'indexation** : ordre, pause/reprise, annulation, échec isolé, reprise après coupure, diff ajout/modification/suppression.
- **Intégration** : Vitest avec jsdom et fake-indexeddb, plus un PDF réel traité sous Node. Les tests s'appuient sur une copie de développement de PDF.js à la version de SiYuan (`pdfjs-dist`, dépendance de développement uniquement, jamais livrée dans le paquet).

Validation : `npm run lint` · `npx tsc --noEmit` · `npm test -- --coverage` · `npm run build` · `npm run pack`, puis test manuel en webapp en vérifiant dans l'onglet réseau qu'aucune requête ne sort de SiYuan.

## 6. Risques

| Risque | Niveau | Mitigation |
|---|---|---|
| Calque de surlignage injecté dans le DOM du visualiseur natif : structure interne de PDF.js non publique, calque effacé à chaque rendu de page | Moyen | Spike (pistes a, b, c) ; réinjection sur `pagerendered` ; couche `siyuan/openPdf.ts` isolée ; repli : visionneuse du plugin |
| Sur l'interface mobile, `openTab` n'est pas disponible pour les plugins (onglet central et ouverture de PDF) | Faible (cible = webapp bureau) | Hors v1 ; à étudier plus tard (fenêtre de dialogue pour l'interface, ouverture via un lien `assets/…pdf?page=N`) |
| Dépendance au PDF.js de SiYuan : version qui change, accès depuis un Worker non confirmé | Moyen | Contrôle de `pdfjsLib.version`, version de l'extracteur dans l'en-tête `.dsx`, tests sur la version de développement alignée, spike du chargement en Worker |
| PDF de plus de 100 Mo (tampon PDF.js de la taille du fichier) | Élevé | Range, un PDF à la fois par worker, `destroy()`, mesure au spike |
| Parité BM25 avec FTS5 | Moyen | Tests de référence, lecture de `search-core` |
| Taille de l'index et limites d'écriture du noyau | Moyen | Quantification, deflate par section, mesure au spike ; SQLite-Wasm en dernier repli |
| Conflits de synchronisation des `.dsx` | Moyen | Un fichier par PDF, nom dérivé de l'empreinte |
| Changement d'API ou de format `.sya` selon la version de SiYuan | Faible | `minAppVersion`, couche `siyuan/` isolée |

**Complexité** : M0 faible, M1 élevée, M2 moyenne, M3 élevée, M4 moyenne à élevée, M5 moyenne.

## 7. Décisions à valider

- **D1** : valider l'approche du surlignage : calque dessiné par le plugin dans le visualiseur natif (a, b), avec la visionneuse PDF.js du plugin en repli (c). Aucune donnée utilisateur n'est modifiée.
- **D2** : lancer le spike M0 en premier, avant tout développement des autres phases ?
