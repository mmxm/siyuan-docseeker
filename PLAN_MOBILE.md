# Plan B : DocSeeker sur SiYuan mobile (PWA iOS et application native)

> Statut : **plan validé par l'utilisateur (2026-11-08), version complète. Rien n'est implémenté.** Étape en cours : E0 (spike).
> Source : diagnostic du 2026-11-07/08, noyau jetable SiYuan 3.8.9 (`npm run sandbox`), lecture du dépôt `siyuan-note/siyuan` au tag v3.8.9 (commit `d3af9d5`). Rien n'a été mesuré sur un vrai iPhone.

## 1. Cause de l'incompatibilité

- `plugin.json` déclare `"frontends": ["desktop", "browser-desktop"]`.
- SiYuan ouvert en PWA sur iOS charge le bundle mobile ; `getFrontend()` y renvoie `browser-mobile` (`app/src/util/functions.ts:22-29`). L'application native iOS renvoie `mobile` (agent utilisateur commençant par `SiYuan/`).
- Le noyau filtre les plugins selon ce frontend (`kernel/bazaar/plugin.go:54-107`, `loadPetals` dans `kernel/model/plugin.go`) : un plugin incompatible n'est jamais envoyé au client. Dans le bac à sable, `loadPetals` renvoie `[]` pour `browser-mobile` et `["siyuan-docseeker"]` pour `browser-desktop`.
- Un champ `frontends` absent ou vide vaut « compatible partout » pour un plugin (`IsTargetSupported`, `plugin.go:97-99`).
- Le bundle mobile est servi si le cookie `siyuan-desktop-mode=false` ou si l'agent utilisateur est mobile (`kernel/server/serve.go:755-795`). Un iPad en agent utilisateur « Mac » ou contenant `Pad` reçoit le bundle bureau (`browser-desktop`).

## 2. Constats vérifiés (SiYuan v3.8.9)

| Sujet | Constat | Source |
|---|---|---|
| `openTab` | stub vide sur mobile (`// TODO: Mobile`) | `app/src/plugin/API.ts:46-53` |
| `addTab` | renvoie `undefined` sur mobile, rien n'est enregistré | `app/src/plugin/index.ts:609-648` |
| `addTopBar` | entrée dans le menu principal mobile, seulement la forme `icon`+`title`+`callback` ; l'option `element` est ignorée | `index.ts:262`, `:327-346` |
| `addDock` | fonctionne sur mobile (panneau latéral) | `index.ts:706-770`, `app/src/mobile/dock/` |
| `Dialog`, `Menu`, `showMessage`, `confirm` | disponibles | `API.ts:412-428` |
| `addCommand` | enregistrées, mais accès mobile non trouvé | `commandAdapter.ts` |
| `window.pdfjsLib` | absent au démarrage sur mobile (les gabarits `desktop` et `app` chargent `pdf.min.mjs`, pas le gabarit mobile) ; injecter `/stage/protyle/js/pdf/pdf.min.mjs?v=6.4.299-siyuan.1` en `<script type=module>` le définit (testé, v6.4.299) | `app/src/assets/template/*/index.tpl` ; `app/src/asset/pdfViewer.ts:14-27` |
| Visionneur PDF mobile de SiYuan | `openMobilePDF(path, page)` (page 1-based), panneau plein écran `#model`, **non exporté dans l'API plugin** (seuls `openMobileFileById` et `openAssetPicker` le sont) | `app/src/mobile/pdf.ts:41` ; `API.ts:20,427,453` |
| Lien `assets/x.pdf?page=N` | sur mobile, `openLink` l'envoie à `openMobilePDF` (`action = "current"`), mais `openLink` n'est pas exporté : un clic simulé hors protyle n'est pas garanti (**à tester en E0**) | `app/src/editor/openLink.ts:120-124` ; `pdfAssetLink.ts:36-68` |
| Plugins sur noyau distant | bloqués seulement si l'URL contient `?remote=1` ; rien à activer pour une PWA servie par le noyau | `app/src/util/hostCapabilities.ts:63` |
| Synchro | `storage/petal` n'est **pas** exclu : l'index (`.dsx`, `manifest.json`) et `settings.json` du plugin sont synchronisés ou partagés | `kernel/model/sync.go` (pas d'exclusion de `storage/petal`) |
| Recherche native | le noyau indexe le texte des PDF (`PdfAssetParser`), `/api/search/fullTextSearchAssetContent`, panneau mobile `searchAssetsPanel` ; mais `AssetContent` n'a ni page ni vignette : ne remplace pas DocSeeker | `kernel/model/asset_content.go:42-51,584` |
| Même bundle pour PWA et application | seul `getFrontend()` diffère ; aucun lecteur PDF distinct trouvé pour l'application iOS (fluidité réelle non mesurée) | `functions.ts:22-29` |

### Résultats dans le bac à sable (émulation Android Chrome 375 px, pas Safari iOS)
- Avec `browser-mobile` ajouté à la copie du manifeste (hors dépôt) : le plugin se charge et son entrée « Ouvrir la recherche dans les PDF » apparaît dans le menu principal.
- L'indexation échoue pour les 20 PDF : `PDF.js de SiYuan indisponible (window.pdfjsLib absent)`.
- Cliquer sur l'entrée ne fait rien et n'écrit aucune erreur (`openTab` est un stub). Déclarer `browser-mobile` seul donne donc un plugin qui échoue en silence.
- `CompressionStream` et IndexedDB sont présents dans cet environnement.

## 3. Inventaire de DocSeeker (src/)

- API de plugin : `openTab` (`src/index.ts:435`, `:528` ; `src/siyuan/openPdf.ts:157`), `addTab` (`index.ts:86`), `addTopBar` (`:106`), `addCommand` ×4 (`:115-133`), `Setting`/`openSetting` (`:95-104`, `:602`), `Dialog`/`Menu` via `src/siyuan/nativeUi.ts`, `showMessage`, `confirm`, `loadData`/`saveData`. Routes `/api/...` par `fetch`.
- Trois points d'appel à `window.pdfjsLib` : `src/index.ts:594`, `:690`, `:704` (diagnostic).
- API navigateur : un `Worker` (diagnostic, `index.ts:705`), canvas DOM, IndexedDB (`src/search/thumbnailCache.ts`), `CompressionStream` / `DecompressionStream` sans repli (`src/core/codec/encode.ts:101`, `decode.ts:211`), IntersectionObserver, MutationObserver (`highlightOverlay.ts`).
- Mémoire : rendu 2 en parallèle, 3 documents ouverts (`src/siyuan/pdfRenderer.ts:3-4`) ; échelle 1,5 (`src/core/constants.ts:2`) ; cache de vignettes 64 Mo / 2000 entrées (`searchTab.ts:31-32`) ; 64 Mo de `pageMatches` ; index chargé en entier à `onLayoutReady` (`index.ts:145`).
- Tactile : 13 occurrences de `32px` dans `src/ui/searchStyles.ts` ; dialogues `520px` (`nativeUi.ts:308`) et `420px` (`searchToolbar.ts:112`) ; fenêtre flottante `80vw`/`90vh` + `positionId` (`nativeUi.ts:468-489`) ; aucun `dvh`, `visualViewport`, `safe-area` ; chemin complet seulement en `title` (`searchView.ts:502`) ; `:hover` sans équivalent tactile (`searchStyles.ts:14,95`). `enterkeyhint="search"` existe déjà (`searchView.ts:267`).
- `onPdfOpened` ferme la fenêtre de recherche à chaque ouverture de PDF (`index.ts:630-633`).

## 4. Décision structurante : MVP mobile en lecture seule

Sur mobile, le plugin cherche et affiche, il n'indexe pas. L'index est construit sur ordinateur.
- Risque d'aller-retour : un PDF est jugé modifié si `size` ou `modifiedAt` change (`src/core/manifest.ts:116`) ; `modifiedAt` vient de l'heure **locale** du fichier (`src/siyuan/discovery.ts:117`), qui diffère d'un appareil à l'autre après synchronisation. Deux appareils qui indexent se renverraient la bibliothèque en boucle et écriraient `manifest.json` en concurrence.
- Le mobile surcharge `autoIndex` et `openMode` **à la lecture**, sans jamais écrire `settings.json` (qui est synchronisé).
- À masquer sur mobile : « Vider l'index » (`petalStore.clear()` effacerait l'index de tous les appareils) et « Réindexer ».
- Hors MVP : indexation mobile (demande d'abord de remplacer `modifiedAt` par une empreinte taille + hash partiel, ce qui touche aussi le bureau) ; zoom et +/- du visionneur.

## 5. Étapes (tests d'abord pour chaque étape ; `npm run typecheck` et `npm test` verts avant de passer à la suivante)

| # | Étape | Contenu | Effort |
|---|---|---|---|
| E0 | Spike | `plugin.json` de **développement** avec `mobile` et `browser-mobile` (bac à sable seulement, jamais publié). Vérifier : plugin chargé et entrée `addTopBar` ; dialogue plein écran et deux dialogues empilés ; ouverture des réglages ; injection de `pdf.min.mjs`, URL du worker (`...pdf.worker.compat.mjs?v=6.4.299-siyuan.2`, workers module dans WKWebView) ; rendu d'une page ; temps et mémoire de `sharedIndex.load()` sur un index réel ; clavier et focus ; repli `window.open(...#page=N)` ; lien `assets/x.pdf?page=N` ; comparaison du visionneur de SiYuan en PWA et en application. Consigner dans `AVANCEMENT.md`. À faire aussi sur l'iPhone de l'utilisateur. | 0,5 j |
| E1 | Profil de plateforme | `src/platform/frontend.ts` (`getFrontend()` de siyuan injecté, jamais `navigator`) et `profile.ts` (`PlatformProfile`). Mobile : lecture seule, concurrence de rendu 1, 1 document ouvert, échelle 1,0, cache 16 Mo / 500 entrées, chargement de l'index à la première ouverture, surcharge à la lecture sans écriture. Profil bureau = constantes actuelles. | 0,5 j |
| E2 | Chargeur PDF.js | `src/siyuan/pdfjsLoader.ts` : `createLazyPdfjs`, singleton, injection du `<script type=module>` **seulement si `pdfjsLib` est absent** (sinon un second exemplaire casserait le visionneur de SiYuan), délai, échec non mis en cache, balise retirée. `createLoadPdf` accepte un getter asynchrone ; adapter les trois points d'appel et le diagnostic. | 0,5 j |
| E3 | Plafonds injectés de bout en bout | `createPdfRenderer({concurrency, maxOpenDocuments})` existe mais n'est pas transmis (`searchTab.ts:363-367`) ; option d'échelle dans `thumbnailLoader` (`:201-206`) et clé de cache avec l'échelle ; `cacheLimits` via `SearchTabDeps` ; plafond de `pageMatches` ; concurrence de décodage (`searchStore.ts:69`) ; `disableAutoFetch` dans `createLoadPdf`. | 0,5-1 j |
| E4 | Entrée mobile | `openFloatingDialog` reçoit `layout: "window" \| "fullscreen"` (sans `positionId`, `dvh`) ; `openInTab` optionnel (le bouton « Ouvrir dans un onglet » disparaît) ; aucune commande ni réglage `openMode` qui passe par `openTab` (`index.ts:131`, `:386-391`, `:456`, `:528`, Alt+clic `searchView.ts:1032`) ; `addTab` non enregistré sur mobile ; `onPdfOpened` ne ferme pas la recherche sur mobile (empiler sans fermer) ; entrée `addTopBar` ; réglages en repli par `openCustomDialog` si `openSetting` est inopérant. | 1 j |
| E4b | Ergonomie tactile | Variable `--docseeker-hit` : 32 px par défaut, 44 px sous `pointer: coarse` ; champs à 16 px (zoom iOS) ; `dvh` + `visualViewport` (`--docseeker-vvh`) pour le clavier ; `env(safe-area-inset-*)` ; `:hover` sous `@media (hover: hover)` + `:active` ; `touch-action: manipulation` ; `min-height: 0`, `overscroll-behavior: contain` sur la liste ; barre basse « Fermer » à 48 px ; chemin complet lisible sans survol ; dialogues `min(520px, 94vw)` (élargir les regex de largeur `nativeUi.ts:177,247,330`) ; second dialogue empilé avec le premier `inert`, focus rendu à la carte à la fermeture ; pas de `focus()` automatique dans le visionneur. | 1 j |
| E5 | Visionneur de page | `src/ui/mobilePdfViewer.ts` : second dialogue, **page entière** rendue par `renderCrop` avec les `div` de surlignage du chemin des vignettes (pas `highlightOverlay`, surdimensionné), « Page N / M » visible, boutons précédent/suivant de 48 px, canvas libéré à la fermeture, `devicePixelRatio` plafonné à 2. Même signature que `openPdfAtPage`, renvoie un `Disposer<OpenPdfReport>` (statut connu, sinon « état inconnu » `searchTab.ts:152-166`). Repli `window.open(/assets/x.pdf#page=N)` sans promesse de page ni surlignage. | 1 j |
| E6 | Documentation et publication | `plugin.json` : `frontends` + `mobile` et `browser-mobile`, version 0.5.0 ; CHANGELOG ; README (retirer « ne fonctionne pas sur mobile », `README.md:19,162`) ; `AVANCEMENT.md`. **Dernière étape**, après validation sur l'iPhone. | 0,5 j |

Total estimé : 5,5 à 6 jours. E1 à E3 ne changent rien au bureau et peuvent être livrées seules. Version réduite possible (E0, E2, E4, E5 + CSS bloquant, environ 3 jours), non retenue.

## 6. États à afficher à l'écran (jamais en infobulle seule)

- **Recherche** : repos (invite + nombre de PDF indexés), chargement (texte + « Annuler » 44 px), vide (« Aucun résultat pour « … » » + « Réinitialiser les filtres »), erreur (`.docseeker-alert` + « Réessayer »), vignette en erreur lisible, indexation signalée mais non lancée par le téléphone, résultats tronqués (« Voir plus » 44 px).
- **Dialogue de chemin** : chargement, vide, erreur avec « Réessayer ».
- **Filtres** : valeur invalide avec message sous le champ, bouton d'application désactivé avec la raison affichée.
- **Visionneur** : squelette 3/4 + « Chargement de la page N… », « Page N / M », bouton désactivé en première/dernière page, « Aucun surlignage sur cette page », erreur de rendu ou PDF introuvable avec « Réessayer » et « Fermer ».

## 7. Risques

1. Module PDF.js et worker sur iOS (cache hors ligne de la PWA, politique de sécurité du contenu).
2. Mémoire iOS : index décodé en entier (`sharedIndex`, ≈ 2,89 Ko par page décodé, 64 Mo de `pageMatches`), PDF.js dans le thread principal, onglet tué par Safari. En PWA le noyau est distant : chaque lancement transfère tout l'index.
3. Comportement du `Dialog` mobile (largeur, hauteur, `positionId`, `zIndex` empilé, clavier iOS).
4. Visionneur maison à maintenir, sans zoom ni sélection ; repli `#page=N` sans surlignage (le lecteur PDF d'iOS ignore souvent `#page`, et en PWA il ouvre Safari).
5. URL `?v=...` de PDF.js liées à SiYuan 3.8.9 (`minAppVersion` vaut 3.8.0).
6. `Setting`/`openSetting` peut être inopérant sur mobile.
7. Le faux `Dialog` des tests est calqué sur le bundle bureau ; la validation sur iPhone (PWA et application) est manuelle.
8. `frontends` modifié trop tôt exposerait un plugin non validé : dernier pas seulement.
9. Contrastes à vérifier en thèmes clair et sombre (texte secondaire 12 px, `opacity: .8`, focus 2 px).
10. `sharedIndex` n'est pas rafraîchi après une synchronisation (seul l'indexeur local émet un événement, `sharedIndex.ts:145-159`).

## 8. Non vérifié

- Tout test sur un vrai iPhone (mémoire, `CompressionStream('deflate-raw')` dans Safari iOS, workers module, clavier, safe-area). L'émulation est Android Chrome.
- L'application native iOS (`mobile`) : non testée, son code n'est pas dans le dépôt consulté.
- Fluidité du lecteur PDF de SiYuan en PWA et en application.
- Comment déclencher les commandes en mobile.
- Plugins communautaires équivalents : la recherche a été interrompue sans résultat ; on ne peut pas affirmer qu'il n'en existe pas.
- Rendu d'un `Dialog` avec résultats et vignettes sur mobile.
- Ouverture d'un PDF par lien `assets/x.pdf?page=N` depuis un plugin.

## 9. Règles du projet à respecter pendant l'implémentation

Libellés de menu et de dialogue via `src/siyuan/nativeUi.ts` ; pas d'`innerHTML` avec des données ; aucune erreur avalée sans trace ; clavier, focus et contrastes (pas de lecteur d'écran) ; pas de commit de `siyuan.csv` ni du fichier `Collé ... .textClipping` ; pas de tag, release ni PR vers `siyuan-note/bazaar` sans demande ; ne jamais contourner un échec de `git push`.

## 10. Agents et skills ECC

- Par étape : `ecc:tdd-guide` (tests d'abord), puis `ecc:typescript-reviewer` et `ecc:code-reviewer`.
- E2, E5 : `ecc:security-reviewer`, `ecc:silent-failure-hunter`. E3, E5 : `ecc:performance-optimizer`. E4b : `ecc:a11y-architect`, `design-skills:interaction-design`. Fin : `ecc:verification-loop`, `ecc:doc-updater`, `ecc:pr-test-analyzer`.
- Déjà utilisés pour ce plan : `ecc:code-explorer`, `general-purpose` ×3 (code de SiYuan, ouverture PDF/stockage, plugins communautaires interrompu), `ecc:code-architect`, `ecc:architect` et `ecc:a11y-architect` (relectures), `design-skills:interaction-design`. Écartés : `ecc:planner` (blueprint et relectures déjà faits), `ecc:docs-lookup` (pas de documentation du code interne de SiYuan).
- Correction d'un relecteur écartée après vérification : `enterkeyhint` existe déjà.
