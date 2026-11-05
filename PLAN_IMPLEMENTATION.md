# Plan d'implémentation — Plugin SiYuan « DocSeeker »

> Statut au 2026-11-05 : **v0.2.0 publiée** (tag `v0.2.0`, release GitHub du 2026-11-05).
> Ce document dit ce qui est fait, ce qui ne l'est pas, et pourquoi le réel diffère du plan initial du 2026-11-03.
> Chaque statut a été vérifié dans le code, les tests, `git log` ou `gh`. Ce qui n'a pas pu l'être est marqué **non vérifié**.
> Documents liés : `AVANCEMENT.md` (état détaillé, architecture, dette, commandes), `CAHIER_DES_CHARGES.md` (le quoi), `CLAUDE.md` (règles de travail), `CHANGELOG.md`.

**Légende** : *Fait* = implémenté et testé (et validé dans SiYuan quand c'est indiqué). *Partiel* = une partie seulement. *À faire* = absent du code.

---

## 1. Guide d'entrée pour le nouveau développeur

### Par où commencer (environ une heure)

1. `README.md` : ce que fait le plugin pour l'utilisateur, et ses limites connues.
2. `AVANCEMENT.md`, sections 1 (état), 3 (architecture), 5 (dette et risques) et 6 (prochaines étapes).
3. `CAHIER_DES_CHARGES.md` : exigences F1 à F6 et critères d'acceptation (§8).
4. `CLAUDE.md` : règles de travail (délégation aux agents, TDD, commit seulement si typecheck et tests sont verts, pas de modification des données SiYuan sans demande).
5. Ce document, sections 2 à 4.
6. Code, dans cet ordre :
   - `src/index.ts` : le plugin et le câblage réel (seul fichier qui importe `siyuan`) ;
   - `src/searchTab.ts` : assemblage de l'onglet de recherche ;
   - `src/core/codec/format.ts` : contrat du format `.dsx` (en-tête et bornes) ;
   - `src/core/bm25.ts` et `src/search/searchController.ts` : recherche et vue-modèle ;
   - `src/indexer/indexer.ts` : indexation et reprise.

### Lancer le projet (depuis la racine du dépôt)

```bash
npm install            # non vérifié depuis zéro ; node_modules est présent sur la machine de référence
npm test               # 1 337 tests attendus, tous verts (vérifié le 2026-11-05)
npm run typecheck      # sans erreur (vérifié)
npm run package        # dist/index.js et package.zip (vérifié)
```

Pour voir le plugin dans SiYuan : copier les fichiers listés dans `AVANCEMENT.md` section 7, désactiver puis réactiver le plugin, ouvrir l'icône de recherche de la barre supérieure, puis lancer « Réindexer » dans la section « Avancé ». Ne pas modifier les données de SiYuan sans l'accord de l'utilisateur.

### Trois premières tâches suggérées

1. **Câbler `removeStaleTmp()` au démarrage** (`src/siyuan/petalStore.ts`, aucun appelant aujourd'hui). Petite tâche, à faire en TDD (`ecc:tdd-guide`). Fin : un `<nom>.bak` orphelin est restauré ou supprimé au démarrage, couvert par un test, et `npm test` reste vert.
2. **Trancher la pause et la reprise.** `pause()` et `resume()` existent dans `src/indexer/indexer.ts` et `src/core/queue.ts`, mais aucun bouton ne les appelle, et le CHANGELOG 0.2.0 les annonce. Fin : soit les deux boutons existent dans la section « Avancé » et sont testés, soit le code et le CHANGELOG sont corrigés. Il n'y a pas d'écart entre les deux.
3. **Revalider le cadrage multi-termes des vignettes dans SiYuan** (commit `13b3c55`, jamais validé à la main). Fin : constat daté dans `AVANCEMENT.md` section 2. Cette étape demande l'accord et la présence de l'utilisateur.

---

## 2. Jalons réalisés

Numérotation : M0 à M5 comme dans le plan initial. Le « jalon 6 » (re-classement par proximité) est ainsi nommé dans le commit `dcdb962`. La publication est notée M7 : le cahier des charges (§7) l'appelle « M6 ».

Dates : les 34 commits sont du 2026-11-04 (22) ou du 2026-11-05 (12). Premier commit `cfa0773`.

| Jalon | Contenu réalisé | Commits clés (date) | Validation | Statut |
|---|---|---|---|---|
| **M0** Spike et squelette | Diagnostic M0 (7 contrôles), plugin chargeable, icône, onglet, i18n fr | `c3bf48e` (04/11), `5daa0c3` (repli HEAD→GET Range), `23341f7` (mesures) | SiYuan 3.8.9 : 6 OK, 1 ignoré (authentification) | Fait |
| **M1** Indexation | Normalisation, codec `.dsx`, file, manifeste, découverte, extraction, orchestrateur, écriture dans `petal` | `cfa0773`, `e6020ee`, `d5dfeed`, `7934a18`, `690e463` (04/11) | SiYuan : 4 PDF indexés (dont 165 Mo). Node : 44 PDF (mesure du 05/11) | Partiel : pas de Worker, pas de points de reprise (§3) |
| **M2** Recherche | Index BM25 par segments en tableaux typés, onglet, multi-mots, préfixe sur le dernier mot | `276e2d4`, `d8aacc3`, `a6bd83c`, `9aa03ca`, `52d347b`, `fb53c5c` (04/11) | SiYuan : recherche « BPCO » (`7e725d2`) ; multi-mots essayés à la main | Fait |
| **M3** Vignettes | Cadrage (`crop.ts`), plan de vignette, rendu PDF.js, chargement paresseux, cache IndexedDB, cadrage multi-termes | `9aa03ca`, `13b3c55` (04/11) | SiYuan : rendu et surlignage (`7e725d2`). Cadrage multi-termes **non revalidé** | Fait, à revalider |
| **M4** Navigation | `openTab` à la page, calque de surlignage, PDF déjà ouvert, zoom, bouton de la barre ouvre un nouvel onglet | `51db7a7`, `e9bfa7c`, `aee4605` (05/11) | SiYuan : bonne page, calque, PDF déjà ouvert, zoom, thème sombre (`7e725d2`). Centrage sur la zone : non documenté comme validé | Fait |
| **M5** Finitions | Index partagé au démarrage, pages dépliables, libération PDF.js, onglets multiples, mesures sur 47 PDF | `5119cf5`, `e2b78b0`, `aee4605`, `35f3255`, `81fcd90`, `d5946bf` (04–05/11) | SiYuan : onglets multiples et Plus/Replier validés (`35f3255`). Mesures faites sous Node | Partiel : réglages, pause dans l'interface, indexation au démarrage absents (§3) |
| **M6** Re-classement par proximité, phase 1 | Occurrences géométriques, bonus multi-mots, tri des 5 premières pages, fenêtres de 15 documents (jusqu'à 60), grâce de 300 ms, parité avec le moteur Rust | `959c71c`, `80a39d7`, `218becd` (05/11), validation `dcdb962` | SiYuan validé le 05/11 ; fixture de 17 scénarios générée par le vrai moteur Rust | Fait (phase 1) |
| **M7** Publication 0.2.0 | README FR et EN, icône, CHANGELOG, `scripts/release.mjs` (`release:check`), tag et release GitHub | `4a83cb0` (05/11), tag `v0.2.0` sur ce commit | `gh release view v0.2.0` : release publiée, `package.zip` de 79 719 octets | Fait ; Marché à faire |

---

## 3. Écarts par rapport au plan initial

| Sujet | Plan initial | Réalisé (vérifié) | Raison |
|---|---|---|---|
| Extraction PDF | Pool de 2 à 3 Workers (`index.worker`) | Thread principal (`src/indexer/indexer.ts`, `src/indexer/loadPdf.ts`). Le seul `new Worker` sert au diagnostic M0 (`src/index.ts`). | Non documentée. À mesurer dans SiYuan (interface bloquée ?). |
| Recherche et vignettes | `search.worker` et `thumb.worker` séparés | Thread principal (`searchStore`, `pdfRenderer`) | Non documentée. |
| Reprise | Points de reprise en IndexedDB ou OPFS tous les 50 à 100 pages | Reprise par document : `manifest.json`. Le `.dsx` n'est écrit qu'à la fin d'un PDF. | Non documentée. Simplification : un PDF interrompu est refait en entier. |
| Dossier de stockage | `petal/docseeker/idx/` | `petal/siyuan-docseeker/idx/` (nom du plugin, `plugin.json`) | Nom réel du plugin. |
| Format `.dsx` | En-tête, longueurs, dictionnaire, postings, boîtes (5 blocs). Empreinte = chemin + taille + `/ID` | 4 sections deflate-raw, en-tête versionné (version du format, du normaliseur, de l'extracteur `docseeker-extract-1`, chemin source). Empreinte = hash du chemin + taille (`src/core/manifest.ts`) | Chemin source dans l'en-tête pour détecter les collisions de nom. Pas d'`/ID` : le chemin suffit. |
| Version de PDF.js | Lue au démarrage, avertissement hors de la plage testée | Non contrôlée à l'exécution. M0 la rapporte seulement. | Non réalisé. |
| Chargement de PDF.js | Import du module, repli dans un Worker | `window.pdfjsLib` seulement (`src/indexer/loadPdf.ts`). Pas de repli. | Non réalisé. Le spike depuis un Worker n'a pas été fait. |
| `pdfjs-dist` (tests) | Dépendance de développement pour les tests d'intégration | Absente de `package.json`. Tests avec doubles. `measure:corpus` lit le PDF.js de `/Applications/SiYuan.app`. | Non documentée. |
| Tests IndexedDB | `fake-indexeddb` | Absent de `package.json` (non vérifié : tests du cache par doubles) | Non documentée. |
| Vignettes : file et cache | File LIFO, cache LRU | Pas de LIFO. Cache IndexedDB (`src/search/thumbnailCache.ts`). LRU sur les correspondances (`src/search/pageMatches.ts`). | Non documentée. |
| Liste de résultats | Grille virtualisée | Non virtualisée. Pages dépliables par lots de 10, plafond de 200 par document. | Non documentée. |
| Réglages (F6) | Dossiers, taille des vignettes, indexation au démarrage, vider l'index | Absents (aucun réglage dans `src/`) | Non réalisés. |
| Pause et reprise (F2) | Boutons pause, reprise, annulation | API `pause()` et `resume()` présente, **aucun bouton**. Annulation : `indexer.cancel()` appelé au déchargement. | Non documentée. Incohérent avec le CHANGELOG (§4 R2). |
| Indexation au démarrage (F1, M5) | Configurable | Jamais automatique : seul « Réindexer » lance l'indexation. Au démarrage, seuls les `.dsx` sont chargés. | Choix documenté dans le README. |
| Ouverture et surlignage | Calque ou visionneuse propre (décision D1) | Calque dans le visualiseur natif, validé dans SiYuan. La visionneuse propre n'a pas été nécessaire. | — |
| Mobile | Hors v1 | Hors v1. `plugin.json` déclare `desktop` et `browser-desktop`. | Décision. |
| Classement | Temps 1 : bonus multi-mots et tri par mots distincts. Temps 2 : taille de police | Phase 1 faite (proximité géométrique, page A4 supposée de 595 pt). Phase 2 à faire. | Découpage en deux temps. |
| Couverture | 80 % sur `src/core` | Seuil de 80 % sur `src/**` (`vitest.config.ts`). Mesure : 97,99 % des lignes. | Élargi. |
| Lint | `npm run lint` | Absent : aucun script `lint`, aucun ESLint dans `package.json` | Non réalisé. |
| Marché et `preview.png` | M6 optionnel | Non fait | À faire (§4 R8). |

---

## 4. Jalons restants, ordonnés, avec critères d'acceptation

L'ordre et le contenu sont ceux de `AVANCEMENT.md` section 6. Un jalon est fermé quand son critère est rempli et constaté (test ou constat daté dans SiYuan).

| Réf. | Jalon | Critère d'acceptation |
|---|---|---|
| **R1** | Revalider dans SiYuan le cadrage multi-termes des vignettes (`13b3c55`), la réindexation à chaud, le centrage sur la zone, et plusieurs onglets après rebuild | Constat daté pour chaque point, dans `AVANCEMENT.md` §2. Une requête à deux mots montre des vignettes cadrées sur la zone qui contient les deux mots. |
| **R2** | Pause et reprise dans l'interface, ou suppression du code mort. Mise en cohérence du CHANGELOG | Soit deux boutons « Pause » et « Reprendre » dans la section « Avancé », testés (`tests/unit/indexer/indexer.test.ts`) et validés dans SiYuan ; soit `pause()` et `resume()` retirés. Dans les deux cas, le CHANGELOG décrit le comportement réel. |
| **R3** | Robustesse des écritures et documents périmés : `removeStaleTmp()` câblé au démarrage ; en-tête de `src/siyuan/openPdf.ts` à jour | Un `.bak` orphelin est restauré ou supprimé au démarrage, couvert par un test. Aucun commentaire ne dit « non vérifié » pour une fonction validée. |
| **R4** | Phase 2 du classement : taille de police dans le `.dsx`, bonus de taille (plafond 400, seuil 10 pt), tri des occurrences par police. Nouvelle version de format (`DSX_FORMAT_VERSION = 2`) et réindexation | Fixture `tests/fixtures/docseeker-ranking.json` régénérée avec les cas de police ; parité verte ; réindexation de la bibliothèque réelle sans erreur. |
| **R5** | Lacunes d'appariement : sous-chaîne (≥ 4 caractères), mot d'un caractère, expressions entre guillemets | Un test de parité par cas. Chaque cas est traité ou documenté dans le README comme hors périmètre. |
| **R6** | Navigation clavier dans SiYuan (flèches entre vignettes) | Les flèches déplacent le focus entre cartes dans SiYuan 3.8.9, ou le comportement de repli est documenté. |
| **R7** | Mesure de latence sur serveur Docker (lecture des `.dsx`, re-classement) | Médiane et p95 pour une requête à deux mots sur le corpus de 47 PDF, publiées dans `AVANCEMENT.md`. |
| **R8** | `preview.png` et soumission au Marché (`siyuan-note/bazaar`) | `preview.png` dans le dépôt, PR ouverte sur le dépôt Bazaar, lien noté dans `AVANCEMENT.md`. |
| **R9** | Réglages : dossiers, taille des vignettes, indexation au démarrage, vider l'index | Chaque réglage est persisté, testé et visible dans la section « Avancé ». |
| **R10** | Intégration continue (GitHub Actions) : `npm test`, `npm run typecheck`, `npm run package` | Workflow vert sur `main` (aucun `.github/` aujourd'hui). |
| **R11** | Améliorations : grille virtualisée, réduction de la duplication de termes entre segments, validation des données IndexedDB, clé de vignette avec cadrage | Chaque point fermé par un test ou une mesure. |

---

## 5. Critères d'acceptation du cahier des charges (§8) : état

| Critère | Statut | Détail |
|---|---|---|
| Corpus de 47 PDF : indexation sans gel ni plantage | Partiel | Sous Node : 44 PDF indexés en ~191 s, 1 échec légitime (0 octet). Les 2 PDF restants du corpus ne sont pas expliqués dans les notes (non vérifié). Dans SiYuan : non mesuré (gel non mesuré). |
| Recherche multi-mots identique en logique à DocSeeker | Partiel | BM25 et multi-mots conformes aux tests de parité. Le classement est proche, pas identique (taille de police, lacunes d'appariement, voir R4 et R5). |
| Clic sur une vignette : bon PDF, bonne page, résultat surligné | Partiel | Validé dans SiYuan pour le cas testé (bonne page, calque). Centrage sur la zone : non documenté comme validé. |
| Après rechargement, l'index n'est pas reconstruit | Partiel | Conception : le chargement lit les `.dsx` et ne réindexe pas. Non vérifié dans SiYuan après rechargement. |
| Aucun appel réseau hors du noyau SiYuan | Partiel | Vérifié dans le code : aucune URL externe ni CDN dans `src/`. Les `fetch` ciblent le noyau et les assets (`src/siyuan/kernelApi.ts`, `src/diagnostic/m0.ts`). Non vérifié par l'onglet réseau de SiYuan. |

---

## 6. Annexe : plan initial (2026-11-03), avec statut

Contenu historique conservé pour comprendre les décisions. Le plan initial était en attente de validation ; le spike M0 a été fait avant le reste, comme demandé (D2).

### 6.1 Points qui changent le cahier des charges

| Point | Statut |
|---|---|
| BM25 et tokenisation réécrits en TypeScript, avec parité FTS5 | Fait. `src/core/bm25.ts`, `src/core/normalize.ts`. Parité sur `tests/fixtures/fts5-parity.json` et `fts5-tokens.json`. |
| Unité d'indexation = la page | Fait (`PageInput`, postings par page). |
| PDF.js de SiYuan, non embarqué (`window.pdfjsLib`) | Fait. Version rapportée par M0 : 6.4.299. |
| Ouverture par `openTab({ pdf: { path, page } })`, page à partir de 1 | Fait et validé dans SiYuan (`src/siyuan/openPdf.ts`). |
| Calque de surlignage dessiné par le plugin (pas la barre de recherche de PDF.js) | Fait et validé dans SiYuan (`src/ui/highlightOverlay.ts`). |
| Boîtes enregistrées en fractions de page, origine en haut à gauche | Fait (`src/core/codec/format.ts`, `src/core/crop.ts`). |
| Mobile hors v1 | Décision retenue. |

### 6.2 Architecture initiale

Le diagramme initial prévoyait `core/`, `workers/`, `storage/`, `siyuan/` et `ui/`. Réalisé : `core/`, `search/`, `indexer/`, `siyuan/`, `ui/`, `diagnostic/`. `workers/` n'existe pas (§3). `storage/` est remplacé par `src/siyuan/petalStore.ts`. L'architecture actuelle est décrite dans `AVANCEMENT.md` §3.

### 6.3 Phases initiales

| Phase | Contenu prévu | Statut |
|---|---|---|
| M0 – Spike et squelette | Diagnostic, squelette, icône, onglet, i18n | Fait |
| M1 – Indexation | Normalisation, codec, file, découverte, `index.worker`, progression | Partiel (pas de Worker, pas de points de reprise) |
| M2 – Recherche | BM25, index inversé en tableaux typés, `search.worker`, onglet | Fait (sans `search.worker`) |
| M3 – Vignettes | Cadrage, `thumb.worker`, file LIFO, cache LRU, cache IndexedDB, repli texte | Partiel (sans Worker, sans LIFO ; repli texte non vérifié) |
| M4 – Navigation | `openPdf.ts` : page et surlignage, sinon visionneuse propre | Fait (calque validé) |
| M5 – Finitions | Réglages, indexation incrémentale au démarrage, plafonds mémoire, thème, mesures | Partiel (réglages et démarrage automatique absents ; thème sombre validé dans SiYuan, thème clair non documenté ; mesures faites ; plafonds en place : 200 pages par document, LRU) |
| M6 – Publication (cahier) | `package.zip`, README, Marché | Partiel (zip et README faits ; Marché à faire) |

### 6.4 Format `.dsx` initial

Le format réalisé suit les grandes lignes du plan (en-tête versionné, longueurs, dictionnaire trié, postings en varint, boîtes quantifiées sur 8 octets, deflate par section, écriture par `.tmp`). Écarts : voir §3. Les bornes anti-DoS (`MAX_PAGES`, `MAX_TERMS`, budgets d'inflation) ne figuraient pas dans le plan initial : elles ont été ajoutées après revue (`e6020ee`).

### 6.5 Indexation initiale

| Élément prévu | Statut |
|---|---|
| `getDocument` sans chargement complet (`disableAutoFetch`, `disableStream`, `rangeChunkSize` de 256 Ko) | **Non réalisé** : `src/indexer/loadPdf.ts` appelle `getDocument({ url })` seulement. Les requêtes Range sont validées (M0 : 206), mais la consommation réseau et mémoire avec les options par défaut de PDF.js n'est pas mesurée (AVANCEMENT §5). |
| Pool de workers, `destroy()` en fin de document | Partiel : pas de pool. `destroy()` par `loadingTask` (`aee4605`). |
| Pause coopérative entre deux pages | Partiel : la pause (API) ne démarre plus de travail, mais ne coupe pas le travail en cours (AVANCEMENT §5). Pas d'interface. |
| Points de reprise en local | À faire (remplacé par la reprise par document). |
| `.dsx` publié seulement quand le PDF est terminé | Fait. |
| PDF en échec ou sans texte isolé, le lot continue | Fait. |

### 6.6 Spike M0 initial

| Question | Réponse et statut |
|---|---|
| 1. Range (206) et `Content-Length` | Fait. Range → 206. `HEAD` peut répondre 404 pour les noms NFD : repli `GET Range` (`src/siyuan/kernelApi.ts`). |
| 2. Débit et mémoire sur le PDF de 165 Mo | Fait (SiYuan : 1,5 Mo de `.dsx`). Mémoire : 60 Ko par page avant compaction, 2,9 Ko après (`276e2d4`, mesure du 04/11, non revérifiée ici). |
| 3a. `openTab` à la bonne page | Fait et validé dans SiYuan. |
| 3b. Calque aligné au zoom, réinjecté sur `pagerendered` | Fait et validé dans SiYuan (zoom, PDF déjà ouvert). |
| 3c. Visionneuse propre en repli | Non nécessaire. |
| 4. Aller-retour `putFile` et `getFile` de 50 Mo | Fait : identique, 18 à 41 Mo/s (M0). |
| 5. Taille réelle d'un `.dsx` | Fait : environ 3 Ko par page. |
| 6. Chargement des workers depuis `/plugins/<nom>/` | Partiel : le Worker de PDF.js est testé depuis `/stage/protyle/js/pdf/` (M0 « worker »). Le chemin `/plugins/<nom>/` n'a pas été testé (non vérifié). |

### 6.7 Stratégie de tests initiale

| Élément prévu | Statut |
|---|---|
| Codec : aller-retour, vides, Unicode, signature, version, troncature, migration, taille maximale | Fait (`tests/unit/codec*.test.ts`). Migration entre versions : non vérifiée (une seule version existe). |
| Normalisation : accents, `œ`/`æ`, ligatures, apostrophes, NFC/NFD, chaîne vide | Fait (`tests/unit/normalize*.test.ts`). |
| BM25 : valeurs calculées à la main, ET, préfixe, parité | Fait (`tests/unit/bm25*.test.ts`, `queryConsistency.test.ts`). |
| Cadrage : centre, bords, page plus petite que 300×120, boîte dégénérée | Fait (`tests/unit/crop.test.ts`). |
| File : ordre, pause, reprise, annulation, échec isolé, diff | Fait (`tests/unit/queue.test.ts`, `manifest.test.ts`). |
| Intégration : Vitest jsdom, `fake-indexeddb`, un PDF réel sous Node | Partiel : jsdom et doubles. Pas de `fake-indexeddb`. Le PDF réel sous Node est dans `tests/perf/`, hors `npm test`. |
| `npm run lint`, `npx tsc --noEmit`, `npm test -- --coverage`, `npm run build`, `npm run pack` | Partiel : `typecheck` (`tsc`), `test:coverage`, `package` (le plan disait `pack`). **Pas de lint.** |
| Test manuel en webapp, onglet réseau : aucune requête hors SiYuan | À faire (§5, dernier critère). |

### 6.8 Risques initiaux

| Risque | Niveau initial | Statut actuel |
|---|---|---|
| Calque dans le DOM du visualiseur natif | Moyen | Validé dans SiYuan. Dépend de la structure interne de PDF.js (non publique). |
| Interface mobile sans `openTab` | Faible | Hors v1. |
| Dépendance à la version de PDF.js de SiYuan | Moyen | Mitigation partielle : version rapportée par M0, pas de contrôle à l'exécution (§3). |
| PDF de plus de 100 Mo | Élevé | Partiel : un PDF à la fois, `destroy()`. Un PDF de 225 Mo est indexé sous Node et un de 165 Mo dans SiYuan. Les options de chargement progressif (Range, `disableAutoFetch`) ne sont pas passées à PDF.js (§6.5). |
| Parité BM25 avec FTS5 | Moyen | Fait (tests de référence). |
| Taille de l'index | Moyen | Fait : environ 3 Ko par page, compaction mémoire. |
| Conflits de synchronisation des `.dsx` | Moyen | Un fichier par PDF. Écriture `.tmp`/`.bak`. Écritures concurrentes sur deux appareils : exposées (AVANCEMENT §5). |
| Évolution de l'API de SiYuan | Faible | `minAppVersion` 3.8.0 (`plugin.json`). Couche `siyuan/` isolée. |

### 6.9 Décisions initiales

| Décision | Statut |
|---|---|
| D1 : calque de surlignage dans le visualiseur natif, visionneuse propre en repli | Validée et réalisée (calque). Repli non nécessaire. |
| D2 : spike M0 avant le reste | Fait. |
