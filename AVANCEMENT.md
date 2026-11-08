# Avancement — Plugin SiYuan « DocSeeker »

> Document de passation. Il dit où en est le projet, comment il est construit, ce qui reste ouvert et comment reprendre.
> Complète `CAHIER_DES_CHARGES.md` (le quoi), `PLAN_IMPLEMENTATION.md` (le plan et le guide d'entrée) et `CLAUDE.md` (règles de travail).
> Dernière mise à jour : 2026-11-07 (CI et release automatisée ajoutées (`.github/workflows/ci.yml`, `.github/workflows/release.yml`), `scripts/release.mjs --ci`, version passée à 0.3.0 dans `package.json`, `plugin.json` et `CHANGELOG.md`. D'après le statut git de début de session, ces fichiers ne sont pas committés ; aucun tag `v0.3.0`, rien de poussé, et les workflows n'ont jamais tourné sur GitHub. Voir §1, §5 (dettes R10) et §7. J12 bis ajouté : refonte à l'identique de la recherche native de SiYuan pour le chemin et les critères enregistrés, code committé `9b2951e` ; J12 committé `ae36b73`. `npm test`, `npm run typecheck` et `npm run test:coverage` relancés ce jour-là, chiffres du 2026-11-07, mesurés par l'agent TDD et à relancer par le coordinateur avant le commit ; `npm run build` relancé le 2026-11-06, pas depuis J12 bis ; `npm run package`, `npm run release:check` et `gh release view v0.2.0` datent du 2026-11-05 et n'ont pas été relancés).

Légende utilisée ci-dessous :
- **[SiYuan]** : validé à la main dans SiYuan 3.8.9 (webapp, ordinateur). Source : commits `docs:` et sections précédentes de ce fichier ; non rejouable depuis le dépôt.
- **[tests]** : couvert par les tests automatiques seulement.
- **[mesure]** : chiffre issu d'une mesure (Node ou SiYuan), non revérifié ici sauf mention.

---


- **Release 0.3.0 publiée le 2026-11-07 par le workflow** (tag léger `v0.3.0` sur `2d7c100`) : run `Release` en succès, release GitHub `DocSeeker 0.3.0` (non brouillon, non préversion) avec `package.zip` (157 766 octets, sha256 `7bee87af…`, identique au hash des notes après téléchargement). Avant le tag : `ci.yml` vert sur `main` (la CI a révélé un test d'octets compressés dépendant de la version de zlib, corrigé en `2d7c100`) et mode à blanc de `release.yml` vert. **Reste non fait** : protection de branche et de tag, environnement `release` avec relecteur, releases immuables (réglages du dépôt, à la main sur GitHub).
- **Version 0.4.0 (2026-11-07)** : recherche par sous-chaîne (≥ 3 caractères, `src/core/termMatch.ts`), commit `acd395f`, version passée à 0.4.0 ; la publication passe par le tag `v0.4.0` (workflow). Les scores des préfixes ne sont plus identiques à FTS5 (poids 0,6). Non essayé dans l'interface de l'application de bureau.
## 1. En une minute

- **Version publiée : 0.2.0.** Tag git `v0.2.0` sur le commit `4a83cb0`. **Version préparée : 0.3.0.** `package.json` et `plugin.json` indiquent `0.3.0`, et `CHANGELOG.md` a une section `## 0.3.0`. Rien n'est encore publié en 0.3.0 : pas de tag `v0.3.0`, pas de release. La section 0.3.0 du CHANGELOG porte la mention « Publiée le 2026-11-07 », à corriger avant le tag (elle ne reflète pas l'état réel).
- **CI et release automatisée (R10, fait côté code, non exécuté sur GitHub)** : `.github/workflows/ci.yml` (push sur `main` et PR : `npm ci`, `npm run typecheck`, `npm test`, `npm run package`) ; `.github/workflows/release.yml` (tag `vX.Y.Z` poussé = vérification tag/versions/CHANGELOG, typecheck, tests, paquet, SHA-256, puis release GitHub avec `package.zip` ; `workflow_dispatch` = mode à blanc, qui ne publie rien). Détail en §2 et limites en §5.
- **Release GitHub `DocSeeker 0.2.0` publiée** le 2026-11-05 (non brouillon, non préversion) avec `package.zip` (79 719 octets, sha256 `99f4e35c…`). Vérifié avec `gh release view v0.2.0`.
- **Branche `main`** : `origin/main` est à `9b2951e` (J12 bis poussé) (documentation de J12 poussée ; le code J12, `ae36b73`, est sur `origin/main`). **Le code J12 bis (refonte à l'identique de SiYuan : dialogue « Spécifier le chemin », ligne de critères) n'est pas committé** : il est dans l'arbre de travail, avec la documentation modifiée le 2026-11-07. Il sera committé par le coordinateur après relance des vérifications. `dist/` et `package.zip` sont ignorés par git.
- **Tests : 3 738 tests verts dans 101 fichiers** (`npm test`, mesure du 2026-11-07, code de sortie 0). Le rejet non géré de `tests/unit/searchTab.floating.test.ts` (R12) est corrigé depuis le commit `671d5f4` : il ne fait plus sortir `npm test` en code 1. Les mesures de `tests/perf` ne sont pas dans `npm test`.
- **Typage : propre** (`npm run typecheck` : `tsc --noEmit`, puis `tsconfig.test.json`, code de sortie 0 le 2026-11-07).
- **Couverture** (`npm run test:coverage`, seuil 80 % sur `src/**`, mesure du 2026-11-07, code de sortie 0) : instructions 98,77 %, branches 93,45 %, fonctions 96,75 %, lignes 97,54 %. Mesure de l'agent TDD ; à relancer par le coordinateur avant le commit de J12 bis.
- **Bundle** : `npm run build` relancé le 2026-11-06 : `dist/index.js` = 281 298 octets (83 360 octets gzip). Ce bundle est antérieur à J12 (construit le 2026-11-06) : il ne reflète ni J12 ni J12 bis. `package.zip` = 79 719 octets, celui de la release 0.2.0 (non reconstruit depuis). Le bundle installé dans `~/SiYuan` a été recopié le 2026-11-07 à 11 h 29, sur demande de l'utilisateur, à partir de l'état `970c48e` (ancien menu « Spécifier le chemin » et bouton signet). **Le bundle J12 bis n'y est pas copié.**
- **Ce qui marche dans SiYuan 3.8.9** : diagnostic M0, indexation de PDF réels, recherche, vignettes surlignées, clic → PDF à la bonne page avec calque, plusieurs onglets de recherche, pages dépliables, re-classement par proximité (phase 1). Détail en section 2.
- **Ce qui manque** : pause/reprise de l'indexation (le code existe, l'interface non), dossiers surveillés et taille des vignettes dans les réglages, `preview.png`, soumission au Marché, validation de la CI et de la release sur GitHub réel (§5). Voir section 5.
- **Depuis J12 bis, J12, J11 et J10** : ce qui est vérifié et ce qui ne l'est pas est détaillé dans la section 1 bis (rubriques « Vérifié » et « Non vérifié » par jalon ; liste à cocher des validations manuelles J10, J11, J12 et J12 bis).
- **J12 bis (code, committé `9b2951e`)** : le chemin se choisit dans un dialogue « Spécifier le chemin » identique à celui de la recherche native de SiYuan 3.8.9, et les critères enregistrés sont dans une ligne sous le champ, avec les boutons « Enregistrer les critères de requête » et « Réinitialiser les critères de recherche ». Le filtre par dossier d'assets est supprimé. Essayé à la main dans la webapp d'un noyau jetable SiYuan 3.8.9, avec captures d'écran ; pas dans l'application de bureau ni dans `~/SiYuan`.
- **J12 (committé `ae36b73`)** : la version committée (menu « Spécifier le chemin » à deux sections, bouton signet « Critères enregistrés », filtre par dossier d'assets) a été remplacée par J12 bis. Ne pas la décrire comme l'interface actuelle.
- **Attention** : `npm run release:check` échouait sur « le tag v0.2.0 existe déjà » ; c'est attendu après publication. Pour 0.3.0, il n'a pas été relancé depuis la mise à jour de version : son résultat est inconnu. La procédure à suivre est en section 7.

---

## 1 bis. Feuille de route en cours (décidée le 2026-11-06)

Ordre : **J7** (résultats compacts, recherche sur Entrée) → **J8** (paramètres du plugin : Réindexer, diagnostic, vider l'index, interrupteur d'indexation automatique) → **J9** (indexation automatique : démarrage, nouveaux PDF, suppressions, `removeStaleTmp`) → **J11** (classement phase 2, format `.dsx` v2, migration automatique grâce à J9) → **J10** (parité avec la recherche SiYuan : chemin, filtres, tris, onglet ou fenêtre flottante, raccourcis) → **J12** (filtre par documents SiYuan et critères de recherche enregistrés, `ae36b73`) → **J12 bis** (refonte à l'identique de la recherche SiYuan : dialogue « Spécifier le chemin », ligne de critères ; non committé).

**R10 (CI GitHub Actions et release automatisée, §6 étape 10) : fait côté code, non committé à la date de mise à jour, jamais exécuté sur GitHub.** Il reste à le valider : un run vert de `ci.yml` sur `main`, un mode à blanc de `release.yml`, puis un premier tag. Les limites sont en §5 (dettes R10).

**État : J7, J8, J9, J11, J10 et J12 sont faits côté code et committés. J12 bis est fait côté code et committé (`9b2951e`). Aucun n'est validé dans l'application de bureau ni dans le `~/SiYuan` de l'utilisateur.** La liste à cocher est plus bas, dans « Validations manuelles à faire ».

- **Banc d'essai (J10, étape 0)** : `npm run sandbox -- start|stop|reset|status|install` lance un noyau SiYuan jetable (port 6807, espace de travail marqué `.docseeker-sandbox` dans `$TMPDIR/docseeker-sandbox` par défaut), avec le plugin et 8 PDF générés par défaut (`--pdfs N`). Il refuse `~/SiYuan`, un espace de travail existant et les ports 6806 et 55165 (`scripts/dev-sandbox.mjs`, `scripts/lib/sandboxCore.mjs`). Le noyau charge le plugin (`loadPetals`). Les essais de J10 ont été faits dans la webapp de ce noyau.

- **J12 (filtre par documents SiYuan et critères enregistrés) : committé (`ae36b73`, 2026-11-07), interface remplacée par J12 bis.** Détail en section 2 (« Filtre par documents et critères enregistrés (J12, puis J12 bis) »).
  - **Ce que J12 a livré et qui reste valable** : résolution d'un document en PDF cités (sous-documents inclus), requêtes SQL sur `assets` et `blocks`, critères stockés dans `settings.json`, relecture avant écriture.
  - **Ce que J12 a livré et qui est remplacé par J12 bis** : le menu « Spécifier le chemin » à deux sections (« Dossiers de fichiers », « Documents SiYuan »), le bouton signet « Critères enregistrés » avec son menu, le filtre par dossier d'assets, la règle « un seul chemin actif à la fois ».
  - **Vérifié (2026-11-07, sur `ae36b73`)** : `npm test` code 0 (96 fichiers, 3 580 tests) ; revues indépendantes `ecc:typescript-reviewer`, `ecc:silent-failure-hunter` (deux fois), `ecc:security-reviewer` (deux fois), `ecc:pr-test-analyzer` (lecture des listes de cas, sans exécution) ; essai à la main dans la **webapp** d'un noyau jetable SiYuan 3.8.9 : menu de chemin, enregistrement d'un critère, écriture dans `settings.json`, rappel après rechargement, suppression.
  - **Dettes** : § 5, « Dettes ouvertes par J12 » (en partie caduques, voir la note de tête de cette rubrique).

- **J12 bis : refonte à l'identique de SiYuan (code, committé `9b2951e`, validation manuelle à faire).** Détail en section 2 (« Filtre par documents et critères enregistrés (J12, puis J12 bis) »). Ordre de l'utilisateur : même rendu et même comportement que la recherche native de SiYuan 3.8.9. Une première version (menu et bouton signet) était une erreur d'interprétation ; elle est corrigée.
  - **Ce qui change pour l'utilisateur** :
    - Le bouton « Spécifier le chemin » (icône dossier) ouvre un dialogue identique à celui de la recherche native : titre « Spécifier le chemin », champ « Recherche... » avec loupe, arbre des cahiers et documents chargé à la demande (dépliage), recherche de documents, libellés des chemins, boutons Annuler et Confirmer. Dialogue de 50 vw × 70 vh, classes CSS `b3-list` et `b3-list-item` de SiYuan.
    - Sélection multiple par Cmd+clic (Mac) ou Ctrl+clic, 20 chemins au plus ; flèches et Entrée. Écart : le chevron d'historique de saisie du natif n'est pas repris.
    - La portée est une liste de chemins : OU entre les chemins, ET avec les autres filtres. Elle est résolue par SQL sur la table `assets` (limite explicite de 50 000 lignes ; résultat tronqué refusé ; « index pas prêt » signalé).
    - L'étiquette du chemin dans la barre joint les libellés par un espace ; une croix retire le chemin. Le bouton « Inclure les documents enfants » est désactivé tant qu'aucun document n'est choisi, ou si seuls des cahiers le sont ; un cahier inclut toujours tous ses documents.
    - Le filtre par dossier d'assets est **supprimé** (décision de l'utilisateur). Un ancien `folder` dans une session ou un critère est lu et ignoré, avec une trace. Un ancien filtre `scope` (singulier) est lu comme une liste d'un élément.
    - Sous le champ de recherche : une ligne de critères (puces de nom ; croix pour supprimer, sans confirmation ; puce courante en surbrillance) et deux boutons, « Enregistrer les critères de requête » et « Réinitialiser les critères de recherche » (aussi dans le menu « Plus »). Le bouton signet et son menu sont supprimés.
    - Enregistrer : dialogue de nom (placeholder « Remarques ») avec les cas du natif : nom vide, nom dupliqué (écraser), renommer, fusionner, rien à faire.
    - Rappel par clic sur la puce : applique la requête, les filtres, le tri, le regroupement **et le chemin** (décision de l'utilisateur ; le natif garde le chemin courant). Si un chemin enregistré n'existe plus, il est retiré avec un message qui le nomme. Un document qui existe mais ne cite aucun PDF reste appliqué : résultat vide.
    - Réinitialiser : requête, tri, regroupement et filtres par défaut ; le chemin est conservé, comme dans le natif.
    - Stockage : `settings.json` (champ `savedCriteria`), et non `/api/storage` : les critères du plugin ne sont pas ceux de la recherche native. 30 critères au plus, nom de 80 caractères au plus. Les entrées illisibles du fichier sont conservées telles quelles (30 au plus).
  - **Sécurité (revues indépendantes, faille corrigée)** : faille HIGH trouvée et corrigée. Les infobulles de SiYuan (classe `ariaLabel`) insèrent `aria-label` comme HTML (constat dans la webapp 3.8.9 avec un élément `<b>` de test). L'étiquette de chemin contenait des noms de documents non échappés ; ils sont désormais échappés (`src/ui/tooltip.ts`), avec un test d'audit qui échoue si un nouveau fichier pose la classe `ariaLabel`. Autres durcissements : caractères bidi retirés de l'arbre ; plafonds (200 résultats de recherche de documents, 500 enfants) ; délai de 200 ms avant chaque requête de recherche de documents.
  - **Vérifié (2026-11-07)** : `npm run typecheck` code 0 ; `npm test` code 0 : 3 738 tests, 101 fichiers ; `npm run test:coverage` code 0 : 98,77 % instructions, 93,45 % branches, 96,75 % fonctions, 97,54 % lignes (mesure de l'agent TDD ; le coordinateur la relance avant le commit, à confirmer).
    - Revues : `ecc:typescript-reviewer`, `ecc:silent-failure-hunter`, `ecc:security-reviewer` ; relecture des tests par `ecc:pr-test-analyzer`, sans exécution.
    - Essai à la main dans la **webapp** d'un noyau jetable SiYuan 3.8.9, **avec captures d'écran** (la fenêtre du navigateur intégré n'était plus minimisée) : dialogue de chemin (arbre, dépliage, sélection de deux documents par Cmd+clic, ligne focalisée grisée comme dans le natif) ; étiquette du chemin avec croix ; ligne de critères avec ses deux boutons ; dialogue « Enregistrer les critères de requête » ; puce « Contrats compta ×» courante ; réinitialisation (chemin conservé) ; rappel par clic sur la puce.
  - **Non vérifié** : thème sombre ; largeur de 320 px ; rendu de l'étiquette longue (tronquée par la croix dans la fenêtre de 800 px) ; recherche dans le dialogue de chemin à la main ; comparaison pixel à pixel avec le natif ; application de bureau et `~/SiYuan` (le bundle installé est celui de `970c48e`, ancien menu). Le faux `Menu` et le faux `Dialog` des tests sont calqués sur le bundle SiYuan 3.8.9 ; ils ne sont pas prouvés identiques au code natif. Deux fenêtres : un réglage modifié par une fenêtre périmée peut encore écraser les autres (dernier écrivain gagne ; la relecture ne couvre que les critères).
  - **Décisions de conception** :
    - Chemin dans un dialogue, pas dans un menu, comme le natif. Le rappel applique le chemin (écart volontaire avec le natif) ; la réinitialisation le garde (comme le natif).
    - Le filtre de portée est appliqué avec les autres filtres, avant le re-classement (`applyFilters` dans `src/search/searchController.ts`).
    - Le filtre n'est jamais ignoré en silence : portée invalide, non résolue ou noyau indisponible donnent un message. Juste après le démarrage, le noyau répond « index pas prêt » ; le message invite à réessayer dans un instant (`scopeNotReady` dans `src/ui/searchView.ts`). Il n'y a pas de bouton « Réessayer ».
    - Le SQL n'accepte que des identifiants validés par expression régulière. Sans `limit` explicite, le noyau tronque à 64 lignes : le plugin demande 50 000 et refuse tout résultat tronqué (`src/siyuan/kernelApi.ts`).
    - Résolution de portée : cache de 30 s, 8 entrées (`src/search/docScope.ts`).
    - Critères : stockés dans `settings.json` (champ `savedCriteria`), validés à la lecture ; un critère invalide est ignoré avec avertissement (10 avertissements au plus). Limites : 80 caractères pour le nom, 200 pour la requête, 30 critères ; remplacement après confirmation. Une écriture échouée restaure l'état précédent. Relecture avant chaque écriture, pour ne pas écraser une autre fenêtre ; une erreur de lecture passagère n'efface rien.
    - Le dialogue de chemin ne construit pas de HTML : les noms de documents sont des données non fiables, insérées par `textContent` (`src/ui/dom.ts`, `src/ui/pathDialog.ts`).
  - **Dettes** : § 5, « Dettes ouvertes par J12 bis » et « Dettes ouvertes par J12 ».
- **J11 (classement phase 2, format `.dsx` v2, migration) : terminé côté code, committé (`148ee09`, 2026-11-06), validation manuelle SiYuan à faire.** Détail en section 2 (« Classement, phase 2 » et « Format `.dsx` »).
  - **Ce qui change pour l'utilisateur** : les passages en gros caractères remontent, y compris pour une requête d'un seul mot ; les index créés avant cette version sont mis à jour automatiquement, une fois, PDF par PDF (statut « Mise à jour de l'index ») ; la version 0.2.0 ne lit pas les index mis à jour.
  - **Réglages techniques (J11)** :
    - Manifeste rejeté (version globale inconnue, entrée invalide, JSON illisible, chemins en double) : avant toute écriture, l'original est sauvegardé dans `manifest.rejected.json`. Si cette sauvegarde existe avec un autre contenu, l'original va dans `manifest.rejected-<date>.json` et la première n'est pas écrasée. Si la sauvegarde est impossible, la passe échoue sans rien écrire. La sauvegarde ne peut pas passer par `<nom>.bak` : le suffixe `.bak` est réservé par `petalStore`, qui refuse ces noms (`src/siyuan/petalStore.ts`, `src/indexer/indexer.ts`).
    - `IndexerDeps.onWarn` est obligatoire (pas d'avertissement avalé).
    - `reindex(chemin)` ne migre que le PDF ciblé ; les autres passes migrent toute la bibliothèque.
    - L'événement `plan` porte `complete` (le parcours était-il complet).
    - Le journal du panneau de paramètres, à la fin de chaque passe, affiche « dont N migré(s) » (ancien index mis à jour) ; ces PDF sont déjà comptés dans « indexé » ou « sans texte ».
  - **Vérifié (2026-11-06)** : `npm run typecheck` propre ; `npm test` : 1 911 tests verts (54 fichiers) ; `npm run test:coverage` : instructions 97,42 %, branches 92,11 %, fonctions 96,24 %, lignes 98,62 % ; `npm run build` réussi ; parité du classement avec le vrai moteur Rust (`tests/fixtures/docseeker-ranking.json`, 29 scénarios d'entrées synthétiques, générés par `search_core` de DocSeeker).
  - **Non vérifié** : rien n'a été validé dans SiYuan ni sur de vrais PDF depuis J11. Le bundle J11 n'est pas copié dans `~/SiYuan` (le fichier installé est un autre bundle). La latence du re-classement et la durée de la migration d'une grosse bibliothèque ne sont pas mesurées.
  - **À valider à la main dans SiYuan** : migration d'une bibliothèque réelle ; recherche pendant la migration ; ordre des résultats sur une requête d'un mot ; latence perçue (re-classement et migration).
  - **Dettes** : § 5, « Dettes ouvertes par J11 ».
- **J10 (parité avec la recherche SiYuan) : terminé côté code, committé, validation manuelle à faire.** Commits (tous sur `origin/main`) : `3321227` (étape 0, banc d'essai), `93ad3c8` (10b, filtres), `c8cc7b4` (10c, tris et regroupement), `cb504ec` (10e, clavier, historique, ouverture à droite, commandes), `eecc374` (10f, barre d'icônes et menus natifs), `63021dd` (10d, fenêtre flottante).
  - **Ce qui change pour l'utilisateur** : filtres (nom du document, pages minimum et maximum, date de modification ; le filtre par dossier d'assets, présent en J10, est supprimé en J12 bis) ; huit tris ; regroupement par document ou liste à plat (60 cartes, puis « Afficher plus ») ; clavier complet dans les résultats ; historique des 20 dernières requêtes ; quatre commandes SiYuan (« Rechercher dans les PDF » existait depuis 0.2.0), sans raccourci par défaut ; réglage « Ouverture de la recherche » (onglet, par défaut, ou fenêtre flottante) ; barre d'outils et menus repris de SiYuan.
  - **Vérifié** : `npm run typecheck` (code 0, 2026-11-07) ; `npm test` : 3 115 tests verts dans 77 fichiers à la clôture de J10, avec code de sortie 1 (R12 ; ~~code de sortie 1~~ : corrigé depuis `671d5f4`, voir §5, point 26) ; couverture du 2026-11-07 : instructions 97,68 %, branches 93,44 %, fonctions 96,67 %, lignes 98,81 %. Essais à la main dans la **webapp** de SiYuan 3.8.9, sur un noyau jetable et 38 PDF de médecine réels (102 Mo) copiés dans l'espace jetable, jamais dans `~/SiYuan`. Défauts trouvés et corrigés pendant ces essais : menus natifs qui se fermaient aussitôt (le clic remontait jusqu'à `window`), sous-menu qui fermait le menu parent, focus perdu après un choix, flèches (R6, défaut de conception : ↓ allait à la carte voisine du DOM, pas à celle du dessous), et `workerSrc` de PDF.js non renseigné dans un espace neuf (corrigé dans `createLoadPdf`).
  - **Non vérifié** : aucun essai dans l'application de bureau Electron ; rien dans `~/SiYuan` ; aucune capture d'écran possible (fenêtre du navigateur intégré minimisée), donc rendu visuel, thème sombre, largeur de 320 px et surlignage dans le PDF ne sont pas vus. Le chemin exact des commandes dans les paramètres de SiYuan (onglet « Raccourci ») n'est pas vérifié non plus.
  - **Décisions de conception** :
    - Filtres en session seulement, jamais persistés. Ils s'appliquent après BM25 et avant le re-classement, pour que la fenêtre de re-classement ne contienne aucun document exclu (`src/search/searchController.ts`, `src/search/resultOptions.ts`).
    - Changer le tri ne relance ni BM25 ni le re-classement : la liste publiée est re-triée. Le tri ne touche qu'à l'ordre des documents ; l'ordre des pages suit le classement.
    - Tri, regroupement, mode d'ouverture et historique sont mémorisés dans `settings.json` (`src/settings.ts`). `settings.ready` : `update()` attend le chargement, donc plus de perte silencieuse de `autoIndex` ou `intervalMinutes`.
    - Clavier : fonctions pures dans `src/ui/keyboardNav.ts`. ↑/↓ vont à la carte au-dessus ou au-dessous d'après la géométrie (même ligne, puis centre horizontal le plus proche). Ctrl/⌘/Alt+Entrée et Alt+clic ouvrent à droite (`position: "right"`). Maj+Entrée est consommée sans effet, car une carte est un bouton. Échap sur une carte revient au champ sans le vider.
    - Menus, dialogue et icônes natifs : un seul adaptateur, `src/siyuan/nativeUi.ts`, qui importe `Menu` et `Dialog`. Les libellés sont échappés et nettoyés, car SiYuan les insère en `innerHTML`.
    - Fenêtre flottante : `Dialog` de 80 vw sur 90 vh, comme la recherche native ; une seule fenêtre ; session en mémoire (`src/search/searchSession.ts`) restaurée à la réouverture, avec relance de la recherche ; destruction lancée par SiYuan détectée ; « Ouvrir dans un nouvel onglet » transfère la session par un jeton placé dans `custom.data` (expiration à 30 s).
    - Liste des dossiers du menu bornée (J10) : 500 entrées, 8 niveaux d'indentation, 120 caractères par libellé. Supprimée en J12 bis avec le filtre par dossier d'assets.
  - **Dettes** : § 5, « Dettes ouvertes par J10 ».

- **Validations manuelles à faire (J10, J11, J12 et J12 bis)** : à cocher et dater une fois fait. Préalable : copier le bundle J12 bis+J12+J11+J10 dans l'application de bureau ou dans le `~/SiYuan` **seulement avec l'accord de l'utilisateur**, et sauvegarder ses données avant. Les cases J12 bis indiquent « [~] » quand l'essai a été fait dans la webapp du noyau jetable le 2026-11-07 ; la validation de bureau reste à faire.
  - [~] **Migration des index v1** : au premier démarrage du bundle, les `.dsx` v1 sont mis à jour une fois, PDF par PDF (statut « Mise à jour de l'index ») ; le journal indique « dont N migré(s) » ; la bibliothèque reste utilisable. (Date : 2026-11-07 ; lieu : bureau, `~/SiYuan`.) **Constaté** (lecture seule des fichiers) : 4 index sur 4 passés en v2 en ~15 s (165 Mo compris), `indexVersion` 2 au manifeste, aucun résidu `.tmp`/`.bak`/`manifest.rejected`. **Non vu** : le statut « Mise à jour de l'index » et la ligne « dont N migré(s) ».
  - [~] **Ordre des résultats (2026-11-07, bureau, `~/SiYuan`)** : requêtes « BPCO » (3 documents, 30 pages) et « BPCO exacerbation » (2 documents, 19 pages) : statut « Classement affiné par proximité des mots et taille de police » affiché, pages à deux mots proches en tête. **Non jugé** : bonus de police (aucun mot en gros caractères dans les pages de tête) et latence perçue.
  - [ ] **Recherche pendant la migration** : une recherche lancée pendant la migration répond avec l'ancien index, sans erreur ni blocage de l'interface.
  - [ ] **Flèches** : ↑ ↓ ← →, Début, Fin, Page précédente et suivante, Entrée, Échap. Depuis le champ, ↓ va à la première carte.
  - [ ] **Menus** : Plus > Tri, Plus > Groupe, Élargir, Réduire. (« Spécifier le chemin » et « Inclure les documents enfants » : voir J12 bis.) Fermeture au clic extérieur ; focus rendu après un choix.
  - [ ] **Dialogue « Filtres »** : Confirmer, Annuler, Réinitialiser les filtres ; messages d'erreur (pages, dates).
  - [ ] **Fenêtre flottante** : taille (80 % × 90 %), Échap par couches, ouvrir un PDF la ferme, réouverture relance la recherche, « Ouvrir dans un nouvel onglet », fermeture lancée par SiYuan.
  - [ ] **Ouvrir à droite** (Ctrl/⌘/Alt+Entrée, Alt+clic) : le PDF s'ouvre dans un volet à droite, et le **surlignage est visible dans ce volet**.
  - [ ] **Thème sombre** : résultats, barre d'outils, menus, dialogue, fenêtre flottante.
  - [ ] **Largeur de 320 px** : barre d'outils, cartes, dialogue des filtres.
  - [ ] **Alt+↓** ouvre l'historique. Sous macOS, vérifier que le système ne capte pas Alt+↓.
  - [ ] **Historique** : 20 entrées au plus, sans doublon, « Supprimer tout l'historique », conservé après désactivation et réactivation du plugin.
  - [ ] **Tri et regroupement mémorisés** après désactivation et réactivation du plugin.
  - [ ] **Réglage « Ouverture de la recherche »** : onglet, puis fenêtre flottante ; l'icône de la barre supérieure et la commande suivent le réglage.
  - [ ] **Commandes** : retrouver les quatre commandes dans les paramètres de SiYuan (onglet « Raccourci », libellé à confirmer), leur attribuer un raccourci, vérifier qu'il déclenche la commande.
  - [ ] **Trace des touches** (bouton « Tracer les touches », paramètres) : à utiliser si une touche n'arrive pas au plugin.
  - [ ] **Indexation et fenêtre** : `settings.json` conservé après rechargement ; indicateur d'état pendant une indexation (issu de J9, toujours à valider).
  - [~] **J12 bis : dialogue « Spécifier le chemin »** : titre, champ « Recherche... », arbre des cahiers et documents (dépliage à la demande), recherche de documents, Annuler et Confirmer ; taille de 50 vw × 70 vh ; aspect identique à la recherche native. Webapp du 2026-11-07 : arbre et dépliage vus, avec captures ; recherche dans le dialogue non essayée à la main. Bureau : à faire.
  - [~] **J12 bis : sélection multiple** : Cmd+clic (Mac) ou Ctrl+clic, 20 chemins au plus ; flèches et Entrée ; ligne focalisée grisée comme le natif. Webapp du 2026-11-07 : deux documents choisis par Cmd+clic, ligne focalisée grisée. Bureau : à faire.
  - [~] **J12 bis : étiquette du chemin et « Inclure les documents enfants »** : libellés joints par un espace, croix pour retirer ; bouton désactivé sans document choisi ou si seuls des cahiers le sont ; un cahier inclut tous ses documents. Webapp du 2026-11-07 : étiquette avec croix vue.
  - [~] **J12 bis : ligne de critères** : puces (nom, croix sans confirmation, puce courante en surbrillance), boutons « Enregistrer les critères de requête » et « Réinitialiser les critères de recherche », aussi dans « Plus ». Webapp du 2026-11-07 : vue avec ses deux boutons et la puce « Contrats compta ×» courante.
  - [~] **J12 bis : confirmations** : enregistrer (nom vide, nom dupliqué avec écrasement, renommer, fusionner, rien à faire) ; rappeler (requête, filtres, tri, regroupement et chemin ; chemin disparu retiré avec message ; document sans PDF : résultat vide) ; réinitialiser (chemin conservé). Webapp du 2026-11-07 : enregistrement, réinitialisation et rappel vus. Les cas de fusion, de renommage et de nom dupliqué ne figurent pas dans cet essai.
  - [ ] **J12 bis : thème sombre** : bouton de critères, dialogue de chemin (étiquette, arbre, lignes sélectionnées), dialogue d'enregistrement.
  - [ ] **J12 bis : largeur de 320 px** : ligne de critères, dialogue de chemin, étiquette longue.
  - [ ] **J12 bis : étiquette longue** : rendu dans la fenêtre de 800 px, tronquée par la croix ; à corriger si le texte est illisible.
  - [ ] **J12 bis : comparaison avec le natif** : même requête et même chemin dans la recherche native et dans DocSeeker, captures côte à côte (rendu, libellés, comportement).
  - [ ] **J12 bis : ancien filtre** : un `settings.json` contenant un `folder` (session ou critère) est lu, le filtre est ignoré et un avertissement l'indique ; un chemin disparu est retiré avec son nom dans le message.
  - [ ] **J12 bis : deux fenêtres** : un critère enregistré dans une fenêtre apparaît dans l'autre après réouverture ; une écriture n'écrase pas les critères de l'autre fenêtre.
  - [ ] **J12 bis : rechargement** : critères et portée restaurés après rechargement de la page, puis après désactivation et réactivation du plugin.
  - [ ] **J12 : états d'erreur** : « index pas prêt » juste après le démarrage du noyau (message « Réessayez dans un instant ») ; « Aucun résultat avec 1 filtre actif » ; document ou chemin introuvable ; noyau arrêté. Le filtre n'est jamais ignoré en silence.

- **J9 : fait et commité, non validé dans SiYuan.** Vérifié : typecheck propre, 1 621 tests verts (52 fichiers), cinq relectures indépendantes (TypeScript, échecs silencieux, performance, UX/accessibilité, revue finale des corrections). Nouveaux modules purs : `src/indexer/autoSync.ts` (planificateur : 3 s après `onLayoutReady`, retour de focus avec 30 s minimum, périodique 5/15/60 min depuis la fin de la passe précédente, jamais deux passes, `triggerNow` booléen), `src/indexer/indexActivity.ts` (états running/done/partial/failed pour l'indicateur), `src/settings.ts` (`settings.json` via `loadData`/`saveData`, sérialisé, réécrit si corrompu ; défaut : automatique activée, 5 min). `removeStaleTmp()` est appelé au démarrage (dette R3 fermée). Panneau : interrupteur (`role="switch"`) et fréquence (désactivée si coupé). Onglet : indicateur sous le champ, suffixe « des résultats peuvent manquer » pendant l'indexation. `IndexSummary` gagne `incomplete`/`failures` ; la garde « aucune suppression sur parcours incomplet » est intacte. Retrait progressif des PDF en échec (5 min, 30 min, 2 h ; mémoire seulement ; `resetFailures()` après vidage). `shouldYield` : les passes automatiques attendent pendant `keydown`/`pointerdown`/`wheel` (3 s). Les clés `pause`/`resume`/`indexingPaused` sont supprimées (R2 : pas de boutons pause/reprise).
  - **À valider à la main dans SiYuan** : focus/`visibilitychange` ; ajout et suppression réels d'un PDF dans `assets` ; `settings.json` conservé après rechargement ; rendu de l'interrupteur et de la liste ; vidage puis reconstruction automatique ; dossier illisible (état « partiel ») ; PDF de 0 octet (pas de clignotement, pas de rechargement toutes les 5 min) ; **latence de l'interface pendant une première indexation** (extraction dans le thread principal, non mesurée).
  - **Dette connue** : cache `(chemin, date)` dans la découverte (une passe vide fait ~1 requête HEAD par PDF) ; débounce du rafraîchissement de l'index partagé pendant un run ; une demande manuelle qui rejoint une passe automatique la laisse « automatique » ; le panneau peut afficher « 1 échec » à chaque passe automatique tant qu'un PDF échoue ; `describeEvent` en dur en français.
- **J8 : fait et commité, non validé dans SiYuan.** Vérifié : typecheck propre, 1 441 tests verts (49 fichiers), trois relectures indépendantes (TypeScript, échecs silencieux, UX/accessibilité) dont les défauts ont été corrigés. Panneau `Setting` (`src/ui/settingsPanel.ts`) : Réindexer, Vider l'index (confirmation ; `petalStore.clear()` supprime le manifeste d'abord, puis `.bak`/`.tmp` avant chaque `.dsx` ; `SharedIndex.refreshNow()` invalide les caches), Diagnostic technique, journal. Section « Avancé » retirée de l'onglet ; bouton « Ouvrir les paramètres » à la place de Réindexer. Garde commune vidage/indexation portée par le plugin.
  - **Retour de test manuel (2026-11-06)** : le panneau était quasi vide avec `direction: "column"` (SiYuan range titre et action côte à côte, action forcée à 200 px). Corrigé en `direction: "row"` (lu dans le code de SiYuan 3.8.9 : `createActionElement` est appelé à chaque ouverture, `destroyCallback` à la destruction du dialogue). Pas de croix native dans le champ de recherche de SiYuan : Échap vide le champ. Réindexation : « 1 échec » sur le corpus (PDF de 0 octet connu, non revérifié dans le journal).
  - **Pas d'interrupteur d'indexation automatique ici** : il arrive avec son implémentation en J9 (pas de réglage mort).
  - **À valider à la main dans SiYuan** : `createActionElement` appelé à chaque ouverture et `destroyCallback` à chaque fermeture (supposé d'après les types `siyuan.d.ts`, non prouvé) ; `confirm()` annulable (ses boutons Confirmer/Annuler ne sont pas personnalisables) ; vidage réel et recherche qui se vide dans les onglets ouverts ; fermer/rouvrir le panneau pendant un vidage ou une indexation ; rendu des boutons `aria-disabled` et du journal défilable ; annonces du lecteur d'écran.
  - **Reste (à l'époque de J8)** : `describeEvent` et quelques libellés d'état sont en dur en français ; clés mortes `pause`/`resume`/`indexingPaused` (supprimées en J9).
- **J7 : fait et commité, non validé dans SiYuan.** Vérifié : `npm run typecheck` propre, `npm test` 1 362 tests verts (47 fichiers), deux relectures indépendantes (TypeScript, accessibilité). Changements : `submit(query)` remplace `setQuery` et le débounce ; Entrée lance la recherche, la croix native et Échap vident ; dossier contenant seul affiché (`src/ui/pathLabel.ts`, ellipse par le début en CSS rtl, chemin complet en infobulle) ; « N pages » ; placeholder « (Entrée pour lancer) ».
  - **À valider à la main dans SiYuan** : rendu de l'ellipse rtl, Entrée dans le champ Electron (IME compris), croix native (émet-elle `search` ou `input` ?), annonces du lecteur d'écran.
  - **Écarts connus, non traités** : pas de bouton « Rechercher » (pointeur/commande vocale) ; pas d'`aria-busy` pendant le calcul ; chemin complet seulement en infobulle ; Échap efface les résultats.

---

## 2. Ce qui est fait, par jalon et capacité

Les jalons du plan initial sont décrits dans `PLAN_IMPLEMENTATION.md`. Dates : 47 commits au 2026-11-07 (22 le 2026-11-04, 13 le 2026-11-05, 10 le 2026-11-06, 2 le 2026-11-07 ; premier commit `cfa0773`). Les jalons J7 à J11 suivent M7 ; J10 est décrit en section 1 bis.

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
- **Fichiers** : `src/core/codec/format.ts` (constantes et contrat), `encode.ts`, `decode.ts`. Magic `DSX1`. Version de format 2 (`DSX_FORMAT_VERSION = 2`) ; le décodeur lit aussi la version 1.
- **Contenu** : 4 sections compressées en deflate-raw (longueurs par page, dictionnaire de termes, postings, boîtes de mots en fractions de 65 535). Bornes anti-bombe (`MAX_INFLATED_BYTES`, `MAX_TOTAL_INFLATED_BYTES`, `MAX_INFLATION_RATIO`, etc.) dans `format.ts`.
- **Version 2 (J11)** : en tête de chaque blob de boîtes, la largeur et la hauteur de la page en dixièmes de point (varints, 1 à 20 000 pt). La v1 n'a pas de taille de page : le décodeur applique alors le repli A4 (595 x 842). Version 0 : `CorruptDataError` ; version supérieure à 2 : `UnsupportedVersionError`. Une page aberrante est repliée sur A4 avec un avertissement (le PDF reste indexé). L'encodeur écrit toujours la v2.
- **Surcoût** : estimé à 2 à 6 octets par page (estimation de conception, non mesurée sur corpus).
- **Commits** : `cfa0773`, `e6020ee` (v1, durcissement après revues). La v2 n'est pas commitée (J11).
- **[tests]** : `tests/unit/codec*.test.ts` (aller-retour, fichiers tronqués, budgets, propriétés avec fast-check), `tests/unit/codec.v2.test.ts`. Taille mesurée : environ 3 Ko par page sur les vrais index v1 (2026-11-04).

### Index BM25 compact
- **Fichiers** : `src/core/bm25.ts` (un segment par document ; postings en `Uint32Array`), `src/core/indexMerge.ts` (fusion et mises à jour incrémentales), `src/core/normalize.ts` (équivalent FTS5 `unicode61 remove_diacritics 2`).
- **Parité** : avec SQLite FTS5 sur `tests/fixtures/fts5-parity.json` et `fts5-tokens.json` (`tests/unit/bm25.parity.test.ts`, `normalize.fts5.test.ts`).
- **Commit** : `276e2d4` (index compact).
- **[tests]**. Mémoire : 2,89 Ko par page après compaction (mesure `COPIES=20 npm run measure:memory` du 2026-11-04, non revérifiée ici).

### Indexeur reprenable
- **Fichiers** : `src/indexer/indexer.ts` (orchestrateur injectable), `src/core/queue.ts` (file : concurrence 2, pause, annulation, journal borné de 1 000 entrées), `src/core/manifest.ts` (diff, empreinte), `src/siyuan/discovery.ts` (lecture de `data/assets`, `complete` et `planIndexUpdate`), `src/siyuan/petalStore.ts` (écriture `.tmp` puis `.bak`).
- **Reprise** : un PDF n'entre dans `manifest.json` qu'après écriture réussie de son `.dsx`. Les PDF inchangés ne sont pas relus, sauf une fois après une migration de format (J11, voir ci-dessous). Aucune suppression sur un parcours incomplet.
- **Migration de format (J11)** : `EXTRACTOR_VERSION = "docseeker-extract-2"`. Chaque entrée du manifeste porte une version d'index (`indexVersion`, courante 2). Absente = 1 ; entier supérieur à 2 conservé tel quel et tracé ; valeur invalide traitée comme 1 et tracée (`onWarn`). `MANIFEST_VERSION` reste à 1. Un PDF inchangé dont l'entrée est en version < 2 est réindexé par la passe automatique, la passe manuelle et la réindexation. L'ancien `.dsx` reste lisible et interrogeable pendant la migration. Écriture atomique (`.tmp` → `.bak` → nom final), puis manifeste. Échec : l'ancien `.dsx` est conservé, backoff de 5 min, 30 min, 2 h. Un PDF sans texte est relu une fois (pas de `.dsx` pour le distinguer). `IndexSummary.migrated` compte les migrations ; pendant une passe qui ne fait que migrer, le libellé est « Mise à jour de l'index » (N/M). Un manifeste illisible ou ignoré est désormais tracé.
- **Fichiers J11** : `src/core/manifest.ts` (`CURRENT_INDEX_VERSION`, `readIndexVersion`, `entriesNeedingMigration`), `src/indexer/indexer.ts`, `src/indexer/indexActivity.ts`, `src/ui/searchView.ts`, `src/ui/settingsPanel.ts`.
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
- **Fichiers** : `src/search/proximity.ts` (occurrences géométriques : même ligne, écart < 25 pt, page supposée de 595 pt de large, remplacée par la taille réelle depuis J11 ; bonus +5 000 / partiel +2 000), `src/search/proximityRanker.ts` (fenêtres de 15 documents, jusqu'à 60, concurrence 2 en phase 1, 1 depuis J11), `src/search/searchController.ts` (grâce de 300 ms puis réordonnancement unique, statut « Classement affiné »), `src/core/constants.ts`.
- **Parité** : `tests/fixtures/docseeker-ranking.json` (17 scénarios à l'époque de la phase 1, 29 depuis J11 ; générés par le vrai moteur Rust, `npm run gen:ranking-fixture`) ; `tests/unit/search/proximity.parity.test.ts`.
- **Commits** : `959c71c`, `80a39d7`, `218becd`, validation `dcdb962`.
- **[SiYuan]** : validé le 2026-11-05 (`dcdb962`). **Non mesuré** : latence réelle du re-classement sur un serveur Docker.

### Classement, phase 2 : taille de police (J11, code seulement)
- **Fichiers** : `src/search/proximity.ts` (`fontSizePt`, `fontBonus`, `orderTopPages` à 4 clés), `src/search/proximityRanker.ts` (bonus de police par document, concurrence 1, cession de la main entre documents), `src/search/searchController.ts` (re-classement aussi pour une requête d'un seul mot ; pas de re-classement pendant l'indexation partielle), `src/search/pageMatches.ts` (les pages mesurées ne sont plus mises en cache, donc les vignettes sont redécodées), `src/core/constants.ts` (seuil 10, multiplicateur 25, plafond 400).
- **Règle** : bonus de police = clamp((taille − 10) × 25, 0, 400), où la taille est la hauteur de boîte du mot en points (hauteur fractionnaire × hauteur de page), arrondie au dixième, maximum sur le document. Il s'ajoute aux bonus de proximité. Tri des pages : mots distincts, puis police, puis score BM25, puis numéro de page.
- **Périmètre** : seules les 5 premières pages BM25 de chaque document sont mesurées (`PROXIMITY_PAGES`). Le moteur Rust mesure tout le document : divergence connue.
- **Parité** : `tests/fixtures/docseeker-ranking.json` régénérée avec le vrai moteur Rust (commit `148ee09`, `npm run gen:ranking-fixture`) : 29 scénarios : les 17 anciens sont inchangés, et 12 sont nouveaux (`police-seuil-arrondi`, `police-plafond`, `police-sur-requete-un-mot`, `police-mot-isole-deux-termes`, `police-max-du-groupe`, `police-egalite-arrondie`, `tri-distinct-avant-police`, `tri-police-avant-bm25`, `tri-meilleure-occurrence-par-page`, `police-hors-5-pages`, `page-letter`, `page-paysage`). `KNOWN_PAGE_ORDER_GAPS` est supprimé. Tests : `tests/unit/search/proximity.parity.test.ts`, `proximity.test.ts`, `proximityRanker.test.ts`.
- **Commits** : `148ee09` (2026-11-06), committé avec J11 ; la fixture est mise à jour dans le même commit.
- **[SiYuan]** : non validé. **[mesure]** : aucune. La latence du re-classement à un seul mot n'est pas mesurée (estimation de 0,3 à 1,8 s de CPU cumulé pour 60 documents, non fiable).
- **Écarts restants avec DocSeeker** : appariement (mot d'un caractère, sous-chaîne, accents sur un mot non final, phrases entre guillemets) ; hauteurs de boîte de mots mesurées par PDF.js d'environ 6 à 12 % plus grandes que celles mesurées par PyMuPDF (moteur d'extraction de DocSeeker), sans facteur de calibration (décision) : écart mesuré sur 3 PDF seulement ; pas de fusion des micro-fragments du Rust.

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
- **Fichiers** : `src/index.ts` (icône de barre supérieure, onglet « docseeker », panneau de paramètres `Setting` depuis J8 : Réindexer, Vider l'index, Diagnostic M0, journal des avertissements, indexation automatique depuis J9), `src/ui/settingsPanel.ts`, `src/settings.ts` (`settings.json`), `i18n/fr_FR.json` (178 clés au 2026-11-07 ; les libellés de la vue de recherche et de sa barre ont un repli, `DEFAULT_STRINGS` dans `src/ui/searchView.ts`, quand la clé manque), `icon.png` et `icon.svg` (`scripts/gen-icon.mjs`).
- **Section « Avancé »** : présente jusqu'à la version 0.2.0. Retirée de l'onglet de recherche en J8 (remplacée par « Ouvrir les paramètres ») ; ses réglages sont dans le panneau de paramètres.
- **[SiYuan]** : la section « Avancé » affichait la clé brute quand `fr_FR.json` installé était ancien (corrigé en recopiant le fichier). Constat de la version 0.2.0, sans objet après J8.

### Release 0.2.0
- **Fichiers** : `CHANGELOG.md`, `README.md` (français), `README_en_US.md`, `plugin.json`, `scripts/release.mjs`, `scripts/package.mjs`.
- **Commits** : `4a83cb0` (préparation), tag `v0.2.0` sur ce commit, release GitHub publiée le 2026-11-05.
- **Non fait** : `preview.png`, soumission au Marché (`siyuan-note/bazaar`) : aucune trace dans le dépôt.

### CI et release automatisée (R10, version 0.3.0)
- **Fichiers** : `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/release.mjs` (mode `--ci <tag> <fichier-notes>` : vérifie tag, `package.json`, `plugin.json` et la section `## x.y.z` du CHANGELOG, refuse une version non supérieure aux tags existants, écrit les notes), `tests/unit/scripts/workflows.test.ts` (contrôles statiques des deux workflows : permissions, actions épinglées sur un SHA, pas de `${{ github.* }}` dans `run:`, `GITHUB_TOKEN` seul secret, Node 22, déclencheurs, ordre des jobs, vérification du tag sur la tête de `main`), `tests/unit/scripts/release.test.ts`.
- **CI** (`ci.yml`) : sur push vers `main` et sur PR, lecture seule. `npm ci`, `npm run typecheck`, `npm test`, `npm run package`.
- **Release** (`release.yml`) : déclenchée par un tag `vX.Y.Z` poussé, ou par `workflow_dispatch` (mode à blanc : le job `publish` ne tourne pas). Job `build` : vérifie que le tag pointe sur la tête de `origin/main`, `scripts/release.mjs --ci`, typecheck, tests, paquet, SHA-256 de `package.zip` ajouté aux notes, artefact. Job `publish` (seul avec `contents: write`, seulement sur tag) : retélécharge l'artefact, revérifie que le tag pointe encore sur le commit, puis `gh release create --verify-tag --target <commit>`. Un seul run par tag, sans annulation en cours.
- **Mode à blanc** : échoue tant que le CHANGELOG n'a pas de section `## <version de package.json>` (« Non publié » ne suffit pas), voulu.
- **Vérifié** : la lecture des fichiers et des tests de workflows (titres lus en 2026-11-07). **Non vérifié** : aucune exécution des workflows sur GitHub ; aucun appel de `scripts/release.mjs --ci` pendant cette mise à jour.
- **Commits** : aucun à la date de mise à jour (fichiers non suivis dans le statut git de début de session).

### Parité avec la recherche SiYuan (J10)
- **Fichiers** : `src/search/resultOptions.ts` (filtres, huit tris, `sortDocs`, normalisation des options), `src/search/searchController.ts` (filtres avant re-classement ; tri seul sans relance), `src/search/searchSession.ts` (session en mémoire), `src/search/searchHistory.ts` (20 requêtes, dédoublonnées), `src/ui/searchToolbar.ts` (barre d'outils, menus Tri et Groupe, dialogue des filtres, liste des dossiers bornée), `src/ui/keyboardNav.ts` (fonctions pures du clavier), `src/ui/searchView.ts` (champ, cartes, historique, liste à plat de 60 cartes), `src/siyuan/nativeUi.ts` (adaptateur unique des menus et dialogues natifs), `src/siyuan/floatingSearch.ts` (fenêtre flottante), `src/searchTab.ts` (câblage ; `position: "right"` pour l'ouverture à droite), `src/settings.ts` (tri, regroupement, `openMode`, historique), `src/index.ts` (quatre commandes, réglage, transfert vers un onglet, `traceKeys`), `src/ui/pathLabel.ts`, `src/diagnostic/traceKeys.ts`, `src/indexer/loadPdf.ts` (`ensureWorkerSrc`).
- **Tests** : `tests/unit/search/resultOptions*.test.ts`, `searchController.sort.test.ts`, `searchHistory.test.ts`, `searchSession.test.ts`, `tests/unit/ui/keyboardNav.test.ts`, `searchView.keyboard.test.ts`, `searchView.history.test.ts`, `searchView.group.test.ts`, `searchView.flatLimit.test.ts`, `searchView.floating.test.ts`, `searchToolbar.test.ts`, `tests/unit/siyuan/nativeUi.test.ts`, `floatingSearch.test.ts`, `floatingDialog.test.ts`, `tests/unit/searchTab.floating.test.ts`, `tests/unit/settings.test.ts`, `tests/unit/scripts/devSandbox.*.test.ts`, `tests/unit/diagnostic/traceKeys.test.ts`. Tests de vue en jsdom : ils ne voient ni le rendu ni la mise en page.
- **Écarts volontaires avec la recherche SiYuan** : pas de pagination à 32 (liste plate à « Afficher plus », 60 cartes), pas de tri par nombre d'occurrences, pas de suppression d'une seule requête de l'historique (le menu natif n'offre que « Supprimer tout l'historique »). Les critères enregistrés, absents en J10, sont ajoutés en J12 (voir ci-dessous).

### Filtre par documents et critères enregistrés (J12, puis J12 bis)
- **Fichiers (état de l'arbre de travail, J12 bis)** : `src/search/docScope.ts` (résolution de chemins en ensemble de PDF, sous-documents, cache de 30 s et 8 entrées, identifiants validés, 20 chemins au plus, `MAX_SCOPES`), `src/siyuan/docQueries.ts` (requêtes SQL sur `assets` et `blocks`, liste des cahiers), `src/siyuan/kernelApi.ts` (`sql`, `lsNotebooks`, `listDocsByPath`, `searchDocs`, `getHPathsByPaths`), `src/ui/pathDialog.ts` (dialogue « Spécifier le chemin » : arbre paresseux, recherche à 200 ms, sélection, 500 enfants au plus, 200 résultats au plus, bidi retiré), `src/ui/criteriaBar.ts` (ligne de critères : puces, deux boutons, dialogue d'enregistrement), `src/ui/tooltip.ts` (échappement des infobulles `ariaLabel`), `src/ui/dom.ts` (construction du DOM sans HTML), `src/ui/pathLabel.ts` (étiquette du chemin), `src/ui/searchToolbar.ts` (bouton « Inclure les documents enfants », relecture des filtres), `src/ui/searchView.ts` (messages de portée), `src/siyuan/nativeUi.ts` et `src/ui/nativeUiTypes.ts` (dialogues natifs, dont le dialogue personnalisé), `src/search/resultOptions.ts` (lecture des anciens champs `folder` et `scope`), `src/search/savedCriteria.ts` (validation et normalisation des critères, 30 au plus, entrées illisibles conservées), `src/searchTab.ts` (câblage de la portée), `src/settings.ts` (champ `savedCriteria`, relecture avant écriture, restauration si l'écriture échoue), `i18n/fr_FR.json`.
- **Supprimés par J12 bis** : `src/search/docTree.ts`, `src/ui/docMenu.ts`, `src/ui/menuLabels.ts`, `src/ui/criteriaMenu.ts` et leurs tests (`tests/unit/search/docTree.test.ts`, `tests/unit/ui/docMenu.test.ts`, `tests/unit/ui/criteriaMenu.test.ts`).
- **Tests (J12 bis, nouveaux)** : `tests/unit/ui/pathDialog.test.ts`, `criteriaBar.test.ts`, `dom.test.ts`, `tooltip.test.ts` (avec `tests/unit/helpers/tooltip.ts`), `tests/unit/search/legacyFolder.test.ts`, `tests/unit/siyuan/customDialog.test.ts`, `inputConfirmDialog.test.ts`, `kernelApi.docs.test.ts`. Tests J12 modifiés : `tests/unit/search/docScope.test.ts`, `docScope.resolver.test.ts`, `savedCriteria.test.ts`, `resultOptions.scope.test.ts`, `searchController.scope.test.ts`, `searchSession.scope.test.ts` ; `tests/unit/siyuan/docQueries.test.ts`, `kernelApi.sql.test.ts` ; `tests/unit/ui/nativeFlow.scope.test.ts`, `searchToolbar.scope.test.ts`, `searchToolbar.criteria.test.ts`, `searchView.scope.test.ts`, `searchView.criteria.test.ts` ; `tests/unit/searchTab.scope.test.ts`, `searchTab.criteria.test.ts` ; `tests/unit/settings.criteria.test.ts`. Tests de vue en jsdom : ils ne voient ni le rendu ni la mise en page.
- **Commits** : `ae36b73` (J12, 2026-11-07). J12 bis : `9b2951e` (2026-11-07).
- **Faits vérifiés dans le code (SiYuan 3.8.9)** : colonnes `box`, `docpath`, `path` de la table `assets` ; `docpath` est la chaîne des ancêtres (`/A/B/C.sy`), les sous-documents s'obtiennent par préfixe `/A/B/C/%` ; table `blocks` lue avec `type='d'` (`box`, `path`, `hpath`) ; `/api/notebook/lsNotebooks` pour les cahiers ; `/api/filetree/listDocsByPath`, `/api/filetree/searchDocs` et `/api/filetree/getHPathsByPaths` pour le dialogue (même points d'entrée que le natif). Sans `limit`, le noyau répond au plus 64 lignes. Juste après le démarrage, il répond « index pas prêt ».
- **[SiYuan]** : essai à la main dans la webapp d'un noyau jetable 3.8.9. J12 (`ae36b73`) : ancienne interface, voir §1 bis. J12 bis : dialogue de chemin, sélection multiple, étiquette, ligne de critères, enregistrement, réinitialisation et rappel, avec captures (2026-11-07). **[tests]** : le reste.
- **Non vérifié** : voir § 1 bis (J12 bis, « Non vérifié ») et § 5 (« Dettes ouvertes par J12 bis »).

---

## 3. Architecture en une page

### Flux de données

```
Portée (J12 bis) : chemins choisis dans le dialogue « Spécifier le chemin »
   │  ui/pathDialog.ts         arbre paresseux (listDocsByPath), recherche de documents (searchDocs, 200 ms), libellés (getHPathsByPaths)
   │  search/docScope.ts       résolution : PDF cités par chaque document (+ sous-documents), cache de 30 s, 8 entrées ; liste de portées en OU
   │  siyuan/docQueries.ts     SQL sur `assets` (box, docpath, path ; sous-documents par `docpath LIKE '/A/B/C/%'`)
   │                           et sur `blocks` (type='d' : box, path, hpath) ; liste des cahiers
   │  siyuan/kernelApi.ts      sql() (LIMIT explicite, 50 000 ; résultat tronqué refusé), lsNotebooks()
   ▼  ensemble de chemins PDF, passé à search/searchController.ts (applyFilters, avant le re-classement)

Critères enregistrés (J12 bis) : ui/criteriaBar.ts ⇄ search/savedCriteria.ts ⇄ settings.ts (champ `savedCriteria` de settings.json)

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
   └─ manifest.json              état connu : PDF publiés (avec la version de leur index, `indexVersion`), plus les PDF sans texte (notés pour ne pas être relus)
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
| `src/index.ts` | Plugin : barre supérieure, onglet, commandes, panneau de paramètres (`Setting`, depuis J8), câblage réel. Avec `src/siyuan/nativeUi.ts`, seul fichier qui importe `siyuan` (API plugin) ; `nativeUi.ts` est le seul à importer `Menu` et `Dialog`. |
| `src/searchTab.ts` | Assemblage de l'onglet de recherche. Tout est injecté, aucun accès direct au noyau ou à `window`. |
| `src/core/` | Cœur pur : normalisation, codec `.dsx`, BM25, fusion d'index, extraction, manifeste, file, cadrage. Pas de DOM. |
| `src/search/` | Logique de recherche sans DOM : index partagé, magasin, contrôleur, correspondances, proximité, vignettes (plan et cache), filtres et tris (`resultOptions`), session et historique (J10), portée par document (`docScope`, J12) et critères enregistrés (`savedCriteria`, J12). |
| `src/siyuan/` | Adaptateur noyau : client HTTP (`kernelApi`, dont `sql` et `lsNotebooks` depuis J12), requêtes de l'arbre des documents (`docQueries`, J12), stockage des `.dsx` (`petalStore`), découverte, ouverture PDF, rendu PDF.js, menus et dialogues natifs (`nativeUi`), fenêtre flottante (`floatingSearch`, J10). |
| `src/indexer/` | Orchestrateur d'indexation injectable et chargeur PDF.js. |
| `src/ui/` | DOM : vue de recherche, barre d'outils et dialogue des filtres, dialogue « Spécifier le chemin » (`pathDialog`, J12 bis), ligne de critères (`criteriaBar`, J12 bis), clavier (fonctions pures dans `keyboardNav`), construction du DOM (`dom`) et infobulles (`tooltip`), chargeur de vignettes, calque de surlignage, CSS. |
| `src/diagnostic/` | Diagnostic M0 (spike technique), exécuté depuis l'interface ; trace des touches (`traceKeys`, J10). |
| `tests/unit/` | 101 fichiers Vitest (`npm test`, au 2026-11-07). Alias `siyuan` vers `tests/stubs/siyuan.ts`. |
| `tests/perf/` | Mesures hors `npm test` (`measure:*`). Lisent des données locales. |
| `tests/fixtures/` | Jeux de référence : parité FTS5 (BM25, tokenisation) et classement DocSeeker (29 scénarios depuis J11). |
| `tools/docseeker-ref/` | Harnais Rust qui appelle `search-core` de DocSeeker, utilisé par `gen:ranking-fixture`. |
| `scripts/` | Paquet (`package.mjs`), release (`release.mjs`), générateurs de fixtures et d'icône, banc d'essai SiYuan jetable (`dev-sandbox.mjs`, `lib/`, J10). |
| `i18n/` | `fr_FR.json` (178 clés au 2026-11-07). Seule langue. |

### Frontière : adaptateur SiYuan / cœur pur

- **Adaptateur SiYuan** : `src/index.ts`, `src/searchTab.ts` (câblage), `src/siyuan/*`, `src/indexer/loadPdf.ts` (`window.pdfjsLib`), `src/ui/*` (DOM).
- **Cœur pur** : `src/core/*` et `src/search/*`. Pas de DOM (vérifié par recherche). Une exception : `src/search/thumbnailCache.ts` utilise `globalThis.indexedDB` par défaut, injectable.
- **Règle** : toute dépendance à SiYuan, au noyau, à PDF.js ou au DOM passe par une fonction injectée (`deps`). Les tests remplacent ces dépendances.

---

## 4. Décisions d'architecture et pièges rencontrés

### Décisions
- **Cible v1** : SiYuan webapp sur ordinateur (testée en 3.8.9), y compris Docker. Le mobile n'a pas `openTab` pour les plugins (`openTab` y est un « TODO: Mobile » dans l'API de plugin, lu dans le dépôt SiYuan lors du plan : non revérifié ici) : hors v1. **Revérifié le 2026-11-08 dans SiYuan v3.8.9 : `openTab` et `addTab` sont bien des stubs sur mobile.** Le chantier mobile (PWA iOS et application) est planifié dans `PLAN_MOBILE.md` (plan validé le 2026-11-08, E0 à E6, non implémenté). L'application de bureau est déclarée (`plugin.json`) mais non testée.
- **PDF.js** : celui de SiYuan (`window.pdfjsLib`, 6.4.299), non embarqué. Le plugin ne vérifie pas la version à l'exécution (le plan le prévoyait) ; M0 la rapporte seulement.
- **Surlignage** : calque dessiné par le plugin dans le visualiseur natif, pas la barre de recherche de PDF.js (qui ne gère ni préfixes ni termes non adjacents). Les boîtes sont enregistrées en fractions de page pour être utilisées en pourcentages CSS.
- **Un `.dsx` par PDF**, nommé `<empreinte>.dsx` (empreinte = chemin et taille, `manifest.ts`). Dans `data/storage/petal/siyuan-docseeker/idx/`, synchronisé par SiYuan.
- **Pas de Worker d'indexation** : l'extraction tourne dans le thread principal (le seul `new Worker` sert au diagnostic M0). Écart avec le cahier des charges, non mesuré dans SiYuan.
- **Préfixe sur le dernier mot seulement**, comme DocSeeker. Écarts Unicode documentés dans les tests.
- **PDF sans texte** : ignorés, signalés, et notés au manifeste pour ne pas être relus à chaque passe.
- **Classement** : BM25 par page + score de document (titre, meilleur BM25, nombre de pages) comme DocSeeker ; re-classement par proximité (phase 1) et par taille de police (phase 2, J11). Écarts restants : section 5.
- **Index en segments** : un segment par document, postings en `Uint32Array`, parce que la version à objets était trop lourde (60 Ko par page mesurés avant compaction, 2,9 Ko après).
- **Écriture de `.dsx`** : `renameFile` du noyau répond 409 si la cible existe, donc `.tmp` → `.bak` → nom final, avec restauration en cas d'échec. Pas atomique au sens POSIX. `read()` et `list()` se rabattent sur `.bak`. `removeStaleTmp()` (`petalStore.ts`) est appelé au démarrage depuis J9 (`prepare` dans `src/index.ts`) : voir section 5, point 17.
- **Découverte** : aucune suppression d'index sur un parcours incomplet (`complete: false`).
- **Sécurité des `.dsx`** (fichiers synchronisés, donc non fiables) : bornes de taille, de pages, de termes, de boîtes et d'inflation dans `format.ts`, `BudgetExceededError` si dépassé.

### Pièges (vérifiés dans le code ou rapportés)
- **Rechargement du plugin** : ⌘R ne suffit pas. Désactiver puis réactiver le plugin dans Marché > Téléchargés > Plugins (vérifié dans le README, validé [SiYuan]).
- **Plusieurs onglets** : `openNewTab: true` dans `src/index.ts` (sinon SiYuan refocalise l'onglet à identifiant fixe).
- **PDF.js 6.4.299** : pas de `destroy()` sur le `PDFDocumentProxy`, seulement sur `loadingTask` (`src/indexer/loadPdf.ts`, commentaire et test).
- **Noms NFD (macOS)** : `HEAD /assets/…` répond 404 pour ces noms alors que `GET Range` répond 206. D'où le repli dans `kernelApi.headAsset`.
- **Navigation aux flèches entre vignettes (résolu en J10, essayé dans la webapp)** : le défaut venait de la conception, pas de SiYuan. ↓ allait à la carte voisine dans le DOM (une carte à droite, ou la première de la ligne suivante), pas à la carte du dessous. Les flèches atteignaient bien le plugin. Corrigé par une navigation géométrique (`src/ui/keyboardNav.ts`, `nextCardIndex`) et des touches supplémentaires. Non revérifié dans l'application de bureau.
- **Ancien `i18n/fr_FR.json`** : une clé absente de `fr_FR.json` s'affiche brute (constat sur la section « Avancé », retirée en J8). Recopier le fichier à chaque build (`npm run package` puis copie).
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
2. **Clos en J11 (code, non validé dans SiYuan)** : la taille de page est stockée dans le `.dsx` v2 ; bonus de police et tri des pages par police sont en place. Écart restant : la taille est approchée par la hauteur des mots (voir « Dettes ouvertes par J11 »).
3. **Clos en J11 (code)** : les dimensions de page sont stockées dans le `.dsx` v2 et utilisées par la proximité. Le repli A4 (`ASSUMED_PAGE_WIDTH_PT`, `ASSUMED_PAGE_HEIGHT_PT`) ne sert plus qu'aux index v1 et aux pages aberrantes. Test : fixture `page-letter`, `page-paysage`.
4. **Pause et reprise absentes de l'interface (code mort).** `src/indexer/indexer.ts` expose `pause()` et `resume()`, `src/core/queue.ts` aussi, mais aucun bouton ne les appelle : seuls les tests appellent `indexer.pause()` et `indexer.resume()` (`tests/unit/indexer/indexer.test.ts`). Les clés `pause`, `resume`, `indexingPaused` ne sont plus dans `i18n/fr_FR.json` (retirées en J9). Le CHANGELOG 0.2.0 reconnaît désormais que la pause/reprise n'a pas d'interface (sa note indique l'annonce « à tort »). Décider : ajouter les boutons ou retirer le code (§6, étape 2).
5. **Réglages partiels** : le panneau (J8, J9) gère Réindexer, Vider l'index, le diagnostic, le journal, l'interrupteur d'indexation automatique et sa fréquence (5, 15 ou 60 minutes), et depuis J10 le mode d'ouverture de la recherche (onglet ou fenêtre flottante), persistés dans `settings.json` (`src/settings.ts`). Manquent les dossiers surveillés et la taille des vignettes (cahier des charges F6).
6. **Indexation dans le thread principal** : pas de Worker d'indexation. Le cahier demande que l'interface ne soit jamais bloquée. Non mesuré dans SiYuan.
7. **Pas de grille virtualisée** : toutes les cartes du document sont dans le DOM (au plus 200 pages par document). Pas de file LIFO pour les vignettes (le plan la prévoyait).
8. **Latence réelle du re-classement** (lecture HTTP des `.dsx`) : non mesurée, y compris pour une requête d'un seul mot (depuis J11). Ressenti positif en webapp de bureau, pas de chiffre.

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
17. **`removeStaleTmp()` appelé au démarrage (J9, corrigé)** : `prepare` de `src/index.ts` l'appelle avant la première synchronisation ; un `<nom>.bak` orphelin (coupure entre les deux renames de `petalStore`) est restauré ou supprimé, et le journal signale le résultat. Couvert par `tests/unit/index.test.ts` et `tests/unit/siyuan/petalStore.test.ts`. Non vérifié dans SiYuan (pas de coupure provoquée).
18. Un blob de boîtes corrompu n'est détecté qu'à la lecture de la page : des vignettes peuvent manquer, sans erreur globale.

### Documentation et process
19. **`src/siyuan/openPdf.ts`** : en-tête mis à jour (constat du 2026-11-07) : l'ouverture à la page est dite vérifiée dans SiYuan 3.8.9, et quatre points restent à valider, dont l'ouverture à droite (`position: "right"`, J10). Le point 1 de cette liste est à relire après la validation de bureau.
20. **`CHANGELOG.md` 0.2.0** : la note de 0.2.0 reconnaît que pause/reprise n'a pas d'interface (point 4) ; la section « Non publié » n'annonce pas de pause. Rien à corriger avant la prochaine release sur ce point, sauf si la pause est ajoutée.
21. **`release:check`** : échouait sur le tag existant (`v0.2.0`), comportement normal après publication. Pour 0.3.0, résultat non relancé (voir §1). Il reste la vérification locale ; la publication passe désormais par le tag (§7).
22. **`preview.png`** absent (requis pour le Marché).
23. ~~**Pas de CI** : aucun `.github/`.~~ **CI et release ajoutées (R10, 0.3.0), non validées sur GitHub** : voir « Dettes ouvertes par R10 » ci-dessous.
24. **Pas de lint** : aucun script `lint` ni ESLint, alors que le plan initial le prévoyait.
25. **Couverture** : 97,54 % des lignes (mesure du 2026-11-07 ; instructions 98,77 %, branches 93,45 %, fonctions 96,75 %). Mesure de l'agent TDD, à relancer avant le commit de J12 bis.
26. ~~**`npm test` et `npm run test:coverage` sortent en code 1 (R12)** : un test de `tests/unit/searchTab.floating.test.ts` (ligne 378, « calque en échec détecté ») crée `Promise.reject(...)` dans `mockResolvedValue` avant d'attacher le gestionnaire ; la rejection est signalée comme erreur non gérée. Les 3 115 tests passent. À corriger par le test lui-même (création de la promesse à la demande), sans masquer l'erreur.~~ **Corrigé** (commit `671d5f4`) : `npm test` sort en code 0 (constat du 2026-11-07, avec 3 580 tests). Le test a été corrigé sans masquer l'erreur.

### Dettes ouvertes par R10 (CI et release automatisée, 0.3.0)
- **Jamais exécuté sur GitHub** : `ci.yml` et `release.yml` n'ont aucun run sur le dépôt. Un premier run réel (CI sur `main`, puis mode à blanc) est nécessaire avant tout tag. Les contrôles statiques de `tests/unit/scripts/workflows.test.ts` ne prouvent pas qu'ils passent.
- **Aucune protection de branche ni de tag** sur `git@github.com:mmxm/siyuan-docseeker.git`, à ce jour (non vérifié sur le dépôt lui-même). Recommandé, dans un ruleset GitHub : tags `v*` (création, modification et suppression restreintes), protection de `main` (PR obligatoire, check du job `verify` du workflow `CI` requis), environnement `release` avec relecteur obligatoire (le job `publish` n'utilise pas encore d'environnement), releases immuables. Sans ces protections, quelqu'un qui peut pousser un tag peut publier une release.
- **Tag léger et au sommet de `main`** : `git tag vX.Y.Z` (sans `-a`). Un tag annoté est refusé à la publication (`.object.sha` de l'API est le SHA de l'objet tag, pas du commit). Le job `build` refuse aussi un tag qui ne pointe pas sur `origin/main`.
- **Section 0.3.0 du CHANGELOG** : datée « Publiée le 2026-11-07 » alors qu'aucune release 0.3.0 n'existe. À corriger avant le tag.
- **Mode à blanc sans effet sur la publication** : `workflow_dispatch` ne construit que le tag simulé `v<version de package.json>`, et ne crée aucune release. Il ne prouve pas la publication, seulement le build et les vérifications.
- **Actions tierces épinglées sur un SHA** (`checkout`, `setup-node`, `upload-artifact`, `download-artifact`) : les SHA et les versions en commentaire sont à mettre à jour à la main (Dependabot non configuré).
- **Non vérifié** : `gh` et `unzip` sur `ubuntu-latest` (utilisés par `release.mjs` et le job `publish`) ; l'effet réel de `npm ci --ignore-scripts` sur le paquet.

### Dettes ouvertes par J12 bis (refonte à l'identique de SiYuan)
- **Rendu non vu** : thème sombre, largeur de 320 px, étiquette longue (tronquée par la croix dans la fenêtre de 800 px). Rien de tout cela n'a été capturé.
- **Recherche dans le dialogue de chemin** : pas essayée à la main ; couverte par les tests seulement.
- **Comparaison avec le natif** : ni pixel à pixel, ni côte à côte ; la ressemblance repose sur la lecture du code de SiYuan 3.8.9 (`movePathTo`, `search/util.ts`, `search/menu.ts`, `dialog/inputDialog.ts`, `confirmDialog.ts`) et sur un essai dans la webapp.
- **Faux `Menu` et faux `Dialog` des tests** : calqués sur le bundle SiYuan 3.8.9, pas prouvés identiques au code natif.
- **Infobulles** : l'infobulle réelle de SiYuan n'est simulée que par `innerHTML` dans les tests. L'échappement est vérifié, pas le rendu natif.
- **Historique de saisie** du dialogue de chemin (chevron du natif) : non repris, écart connu.
- **`savedCriteria` non tableau** : la lecture l'ignore, et la prochaine écriture le remplace.
- **Deux fenêtres Electron** : un réglage modifié par une fenêtre périmée peut encore écraser les autres réglages (dernier écrivain gagne). La relecture avant écriture ne couvre que les critères.
- **Application de bureau** : rien n'a été essayé. `~/SiYuan` : le bundle installé est celui de `970c48e` (ancien menu) ; le bundle J12 bis n'y est pas copié.
- **Document déplacé** : son chemin change. Un critère enregistré avec ce document peut ne plus rien trouver ; le message « Le chemin « … » de ce critère n'existe plus » apparaît si aucun PDF ne reste.
- **Console de la webapp** : 404 sur des ressources et « An unknown error occurred when fetching the script » pendant l'essai, sans lien établi avec le plugin (non investigué).

### Dettes ouvertes par J12 (restes du commit `ae36b73`, à reconfirmer après J12 bis)
- **Soumission différée** : pendant le chargement, les anciens résultats restent affichés, avec « Chargement du chemin… » (clé `scopeLoading`).
- **Tests** : la branche « liste précédente d'une autre portée » n'a pas été retrouvée dans les tests de J12 bis ; à reconfirmer ou à tester.

### Dettes ouvertes par J11 (classement phase 2, format v2, migration)
- **Annulation non propagée dans le décodeur** : `src/core/codec/decode.ts` n'accepte pas d'`AbortSignal`. L'annulation n'est vérifiée qu'entre deux décodages (`proximityRanker.ts`). À corriger : passer le signal au décodeur.
- **Latence du re-classement à un seul mot non mesurée** : estimation de 0,3 à 1,8 s de CPU cumulé pour 60 documents. Estimation non fiable.
- **Coût de la migration non mesuré** : une grosse bibliothèque est relue, et l'extraction PDF.js tourne sur le fil principal. Aucune mesure d'interface ni de durée.
- **Fast-path à un terme non fait** : `groupOccurrences` n'a pas de chemin rapide pour une requête à un seul terme.
- **Repli de cession de la main** : si `scheduler.yield` est absent, `setTimeout(0)` coûte environ 4 ms par document (`proximityRanker.ts`, `defaultYieldToMain`).
- **Coexistence des versions** : la version 0.2.0 refuse un `.dsx` v2 (`UnsupportedVersionError` ; vérifié dans `git show HEAD:src/core/codec/decode.ts`, où `DSX_FORMAT_VERSION = 1`). Documenté dans les deux README. Un ancien plugin et le nouveau ne doivent pas partager le même dossier `idx/`.
- **Surcoût de la v2** : 2 à 6 octets par page, estimation de conception, non mesurée sur corpus.
- **Divergences connues avec le moteur Rust** : appariement (mot d'un caractère, sous-chaîne, accents sur un mot non final, phrases entre guillemets) ; hauteurs de boîte de mots mesurées par PDF.js environ 6 à 12 % plus grandes que par PyMuPDF (mesuré sur 3 PDF seulement), sans calibration (décision) ; seules 5 pages par document sont mesurées ; pas de fusion des micro-fragments.
- **Pas de re-classement pendant l'indexation partielle** : choix. Le BM25 partiel est publié tel quel ; le re-classement a lieu à la fin du chargement.
- **Validations manuelles SiYuan restantes** : migration d'une bibliothèque réelle ; recherche pendant la migration ; ordre des résultats sur une requête d'un mot ; latence perçue.

### Dettes ouvertes par J10 (parité avec la recherche SiYuan)
- **Rendu non vu** : thème sombre, largeur de 320 px, surlignage dans le PDF ouvert à droite. Pas de capture d'écran possible dans le cycle (fenêtre du navigateur intégré minimisée) ; à voir dans l'application de bureau.
- **Ouverture à droite** : essayée dans la webapp (Ctrl/⌘/Alt+Entrée, Alt+clic) ; le surlignage dans le volet n'est pas contrôlé. `openPdf.ts` résout le panneau à partir de `panelElement` du Tab renvoyé par `openTab` ; si ce n'est pas exploitable, un avertissement est tracé.
- **Latence du re-classement à un mot** : 28 à 199 ms mesurés sur 38 PDF réels du banc d'essai. Ce n'est pas une mesure sur une grosse bibliothèque.
- **Annulation non propagée dans le décodeur** : même dette qu'en J11 (`src/core/codec/decode.ts`).
- **Historique** : pas de suppression d'une seule requête (Maj+Suppr retiré) : le menu natif n'offre que « Supprimer tout l'historique ». Les critères de recherche enregistrés, absents en J10, sont ajoutés en J12.
- **Liste plate** : pas de pagination à 32 comme la recherche native (60 cartes puis « Afficher plus »). Pas de tri par nombre d'occurrences (le tri « Pages correspondantes » compte les pages). Liste de dossiers bornée à 500 entrées (J10) : supprimée en J12 bis avec le filtre par dossier.
- **Libellé natif** : SiYuan affiche « Collapse » en anglais ; le plugin affiche « Réduire ».
- **Trace des touches** : le bouton « Tracer les touches » cible le **dernier** onglet de recherche visible (`src/index.ts`, `startKeyTrace` : `roots.at(-1)`), pas le premier (non vérifié dans l'interface : quel élément la fenêtre flottante occupe dans cet ordre).
- **Raccourcis** : Alt+↓ peut être capté par macOS avant le plugin. Le chemin des commandes dans les paramètres de SiYuan (onglet « Raccourci ») n'est pas vérifié.
- **Tactile** : non testé. **Lecteur d'écran** : non vérifié pendant J10.

---

## 6. Prochaines étapes priorisées

Chaque étape a un critère de fin. L'ordre est une proposition.

0. ~~**Faire sortir `npm test` avec le code 0 (R12, §5 point 26).**~~ **Fait** (commit `671d5f4`, constat du 2026-11-07 : code 0).
0 bis. ~~Committer J12~~ : fait (`ae36b73`, poussé sur `origin/main`, 2026-11-07).
0 bis bis. ~~Committer J12 bis~~ : fait (`9b2951e`, poussé sur `origin/main`, 2026-11-07).
   - Fin : `origin/main` contient le commit J12 bis ; `git log origin/main..HEAD` est vide ; §1 de ce fichier indique le hash.
0 ter. **Valider J12 bis, J12, J11 et J10 dans l'application de bureau et dans le `~/SiYuan` de l'utilisateur** (liste à cocher, §1 bis), après accord de l'utilisateur et sauvegarde. Le bundle J12 bis n'est pas copié dans `~/SiYuan` à ce jour.
   - Fin : chaque case de la liste est cochée ou marquée en échec, avec date et lieu (bureau ou `~/SiYuan`) ; les échecs ouvrent des tâches.
1. **Revalider dans SiYuan le cadrage multi-termes des vignettes** (`13b3c55`, non revalidé).
   - Fin : une requête à deux mots montre des vignettes cadrées sur la zone qui contient les deux mots, dans SiYuan 3.8.9, après un rebuild et une désactivation/réactivation du plugin.
2. **Décider de la pause/reprise** : ajouter les deux boutons ou retirer le code mort (`pause()`/`resume()` dans `src/indexer/indexer.ts` et `src/core/queue.ts`, sans appelant hors tests).
   - Fin : un bouton « Pause » qui arrête la file, un bouton « Reprendre » qui la relance, testés (`tests/unit/indexer/indexer.test.ts`) et vérifiés dans SiYuan ; ou bien le code mort est retiré, avec les tests associés. Dans les deux cas, la note de 0.2.0 et la section « Non publié » du CHANGELOG décrivent le comportement réel.
3. **Documents périmés** : fait pour `src/siyuan/openPdf.ts` (en-tête mis à jour le 2026-11-07, voir §5 point 19). Reste à relire après la validation de bureau.
   - Fin : aucun commentaire ne dit « non vérifié » pour une fonction validée. (`removeStaleTmp()` est câblé au démarrage depuis J9.)
4. **Phase 2 du classement** : **code fait (J11), validation SiYuan à faire.** Taille de page dans le `.dsx` v2 (`DSX_FORMAT_VERSION = 2`), bonus de police (plafond 400, seuil 10 pt), tri des pages par police, migration automatique des index v1.
   - Fait : `tests/fixtures/docseeker-ranking.json` régénérée avec le moteur Rust (29 scénarios, dont 12 nouveaux) ; parité verte ; `npm test` et `npm run typecheck` verts (2026-11-06).
   - Reste : une migration de la bibliothèque réelle dans SiYuan passe sans erreur, avec constat daté dans cette section.
5. **Lacunes d'appariement** : sous-chaîne (≥ 4 caractères), mot d'un caractère, expressions entre guillemets.
   - Fin : tests de parité ajoutés pour chaque cas, avec décision documentée dans le README (ce qui reste hors périmètre).
6. **Clavier dans l'application de bureau** : les flèches (défaut R6 résolu en J10, essayé dans la webapp), Alt+↓ et Ctrl/⌘+Entrée restent à vérifier sur l'application de bureau. Alt+↓ peut être capté par macOS.
   - Fin : les touches de la liste à cocher sont vérifiées dans l'application de bureau, avec constat daté.
7. **Mesure de latence sur serveur Docker** : temps de chargement des `.dsx` et du re-classement.
   - Fin : un chiffre (médiane, p95) pour une requête à deux mots sur le corpus de 47 PDF, publié dans ce fichier.
8. **`preview.png` et soumission au Marché** (`siyuan-note/bazaar`).
   - Fin : `preview.png` dans le dépôt, PR ouverte sur le dépôt Bazaar, lien noté ici.
9. **Réglages restants** (dossiers surveillés, taille des vignettes). Déjà faits : indexation automatique (interrupteur, fréquence), vider l'index (J8, J9).
   - Fin : chaque réglage restant est persisté dans `settings.json`, testé et visible dans le panneau de paramètres.
10. ~~**CI GitHub Actions** : `npm test`, `npm run typecheck`, `npm run package` sur chaque push.~~ **R10, fait côté code (0.3.0), non validé sur GitHub** : `ci.yml` et `release.yml`, voir §2 et « Dettes ouvertes par R10 » (§5).
    - Reste : un run vert de `ci.yml` sur `main` (constat daté ici) ; un mode à blanc de `release.yml` vert ; un premier tag `v0.3.0` publié par le workflow, constaté ici.
    - Fin : workflow vert sur `main`, puis release 0.3.0 constatée. Badge dans le README : non fait (le README n'est pas modifié ici).
11. **Améliorations** : grille virtualisée si le document a beaucoup de pages, réduction de la duplication de termes entre segments, validation des données IndexedDB, clé de vignette avec recadrage.
    - Fin : chaque point fermé par un test ou une mesure.

---

## 7. Commandes utiles

```bash
# Installation et vérifications (à lancer avant chaque commit)
npm install
npm test                       # 3 738 tests, 101 fichiers (Vitest, tests/unit), code de sortie 0 (au 2026-11-07)
npm run typecheck              # tsc --noEmit (src), puis tsconfig.test.json
npm run test:coverage          # couverture, seuil 80 % (src/**)
npm run package                # vite build -> dist/index.js, puis package.zip
npm run release:check          # vérifie une release SANS rien publier (tag, version, CHANGELOG, tests, zip)

# Banc d'essai SiYuan jetable (J10) : noyau sur le port 6807, espace marqué, jamais ~/SiYuan
npm run build && npm run sandbox -- start     # --dir D, --port P, --pdfs N (8 par défaut) ; ouvrir l'URL affichée
npm run build && npm run sandbox -- install   # réinstalle le bundle, puis F5 dans le navigateur
npm run sandbox -- status | stop | reset      # reset ne supprime que le dossier marqué .docseeker-sandbox

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

### Procédure de publication (depuis 0.3.0 : par tag, le workflow publie)
1. Incrémenter la version à l'identique dans `package.json` et `plugin.json` (format `x.y.z`, `release.mjs` le vérifie), et ajouter une section `## x.y.z` dans `CHANGELOG.md` (« Non publié » ne suffit pas).
2. `npm run release:check` (vérification locale, rien n'est publié) : doit afficher `Release X.Y.Z prête. Rien n'a été publié.`. Exige un arbre git propre et la branche `main`.
3. Commit (voir section 8), puis `git push origin main`. Le workflow `ci.yml` se lance sur ce push.
4. `git tag vX.Y.Z` (tag léger, sans `-a`) sur la tête de `main`, puis `git push origin vX.Y.Z`.
5. Le workflow `release.yml` construit, vérifie et publie la release GitHub avec `package.zip` et le SHA-256 dans les notes. Le suivre dans l'onglet Actions du dépôt. Ne pas créer la release à la main.

Le mode à blanc (`workflow_dispatch` de `release.yml`) construit et vérifie la version courante sans rien publier ; il échoue sans section CHANGELOG. Un tag annoté, un tag qui ne pointe pas sur la tête de `main`, ou une version non supérieure aux tags existants est refusé. Limites et protections recommandées : « Dettes ouvertes par R10 » (§5).

`release:check` ne publie rien. Il affiche les commandes à lancer à la main (génération des notes, `git tag`, `git push` du tag) ; la release elle-même est créée par le workflow, jamais à la main.

---

## 8. Conventions de travail (CLAUDE.md)

- **Délégation** : l'agent principal coordonne. Le code et les corrections de bug passent par `ecc:tdd-guide` (tests d'abord). Relecture : `ecc:typescript-reviewer`, `ecc:code-reviewer`, et selon le sujet `ecc:silent-failure-hunter`, `ecc:security-reviewer`, `ecc:performance-optimizer`, `ecc:pr-test-analyzer`.
- **Skills** : `ecc:coding-standards`, `ecc:tdd-workflow`, `ecc:verification-loop` à chaque tâche de code.
- **Commit seulement si** `npm run typecheck` et `npm test` sont verts.
- **Push** : `git push origin main`. Si GitHub refuse la clé, ne pas contourner : signaler et pousser plus tard. Vérifier `git log origin/main..HEAD`.
- **Identité git** : passée à la volée à la commande `git commit`, sans modifier la configuration globale. Les 47 commits existants (au 2026-11-07) portent la ligne `Co-Authored-By: Claude Sonnet 5.5`.
- **Données SiYuan** : ne jamais modifier sans demander.
- **Documentation** : pas de fichiers de rapport créés à la volée. Ce fichier et `PLAN_IMPLEMENTATION.md` sont mis à jour à chaque jalon.

---

## 9. Glossaire

- **`.dsx`** : fichier d'index binaire d'un PDF (magic `DSX1`, version de format 2 ; la version 1 reste lisible), stocké dans `data/storage/petal/siyuan-docseeker/idx/`.
- **`indexVersion`** : version d'index d'une entrée du manifeste (courante 2 ; absente = 1). Une entrée plus ancienne est migrée (`src/core/manifest.ts`).
- **Taille de police (classement)** : hauteur de boîte d'un mot, en points. Approximation de la taille de police, utilisée pour le bonus (`src/search/proximity.ts`).
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

### Mobile — E0 (spike), partie bureau, 2026-11-08

Bac à sable SiYuan 3.8.9, manifeste de développement avec `mobile` et `browser-mobile` (hors dépôt), Chrome émulé en 375×812 (UA Android, donc ni WebKit ni iOS réels) :
- Le noyau charge le plugin pour `browser-mobile` (`loadPetals`) ; l'entrée « Ouvrir la recherche dans les PDF » apparaît dans le menu principal.
- Un clic sur cette entrée n'ouvre rien et ne produit aucune erreur : échec silencieux, comme prévu (`addTab` renvoie `undefined`, `openTab` est un stub).
- `window.pdfjsLib` est `undefined` au démarrage. Injecter `pdf.min.mjs?v=6.4.299-siyuan.1` en `<script type=module>` le définit en 22 ms ; avec le worker `pdf.worker.compat.mjs?v=6.4.299-siyuan.2`, un PDF de 3 pages s'ouvre et la page 1 se rend à l'échelle 1,5 en 16 ms (canvas 892×1263). `CompressionStream` existe dans ce Chrome.
- Non vérifié : tout ce qui dépend de WebKit/iOS (workers module, mémoire, `CompressionStream` dans Safari, clavier, zone sûre), dialogues empilés, réglages, `sharedIndex.load()` sur un gros index, lien `assets/x.pdf?page=N`, comparaison des visionneurs PWA et application.
- Partie iPhone : en attente de l'accord de l'utilisateur (le noyau jetable n'écoute que sur 127.0.0.1).
- **iPhone réel (2026-11-08, Safari/PWA, SiYuan 3.8.9, bac à sable) :** l'entrée « Ouvrir la recherche dans les PDF » est présente, mais la toucher ne fait rien. Même échec silencieux que dans l'émulation. Restent à mesurer sur iPhone : fluidité du visionneur PDF de SiYuan, `CompressionStream`, workers module, mémoire.

### Mobile — E1 (profil de plateforme), 2026-11-08
Fait : `src/platform/frontend.ts` (type `Frontend`, `readFrontend` avec valeur injectée, dégradation vers le bureau avec avertissement) et `src/platform/profile.ts` (profils bureau et mobile, `applySettingsOverride` sans mutation ni écriture). Constantes de rendu et de cache déplacées dans `src/core/constants.ts` (valeurs bureau inchangées). Typecheck vert, 3866 tests verts. Pas encore branché : le câblage (`index.ts`, rendu, cache, réglages) est dans E3. Relectures : ecc:tdd-guide (écrit le code), ecc:typescript-reviewer et ecc:pr-test-analyzer (aucun bloquant, mineurs corrigés).

### Mobile — E2 (chargeur PDF.js), 2026-11-08
Fait : `src/siyuan/pdfjsLoader.ts` (`createLazyPdfjs` : aucune injection si `window.pdfjsLib` existe, une seule balise module sinon, échec rapide sur `error`/`load`, échec non mis en cache, balise toujours retirée). `createLoadPdf` accepte un getter asynchrone (annulation prise en compte pendant l'attente, sans `await` ajouté pour un getter synchrone). Le diagnostic rapporte la cause d'un échec de chargement. Typecheck, 3893 tests et build verts. Relectures : ecc:security-reviewer, ecc:silent-failure-hunter, ecc:typescript-reviewer (aucun bloquant, mineurs corrigés). Limite connue : l'URL `?v=6.4.299-siyuan.1` est figée sur SiYuan 3.8.9 (test de garde). Non testé en conditions réelles sur iPhone : à faire avec E3/E4.

### Mobile — E3 (plafonds injectés, lecture seule), 2026-11-08
Fait : le profil de plateforme est branché de bout en bout (`index.ts` → `searchTab.ts`) : concurrence de rendu, documents ouverts, échelle de recadrage (suffixe de clé de cache `:s<échelle>` seulement hors 1,5, donc caches bureau intacts), cache de vignettes, plafond de `pageMatches`, concurrence de décodage, `disableAutoFetch` (flux conservé pour les plages). Mobile = lecture seule : pas d'auto-indexation, pas d'écriture d'index, ni `settings.json` (réglages, historique, critères en mémoire seulement), ni `m0-probe.bin` du diagnostic ; le panneau affiche les valeurs effectives. 3952 tests, typecheck et build verts. Relectures : ecc:performance-optimizer, ecc:typescript-reviewer, ecc:silent-failure-hunter (3 bloquants trouvés par ce dernier, corrigés : écriture du diagnostic, écriture des réglages, refus présenté comme panne).
À savoir / reste : (1) les boutons « Réindexer » et « Vider l'index » ne sont pas encore masqués (E4) ; (2) l'index BM25 global n'a pas de plafond de mémoire, seul le pic de décodage est réduit : à mesurer sur iPhone ; (3) `disableAutoFetch` suppose que SiYuan sert les plages d'octets (Accept-Ranges) : à vérifier sur appareil ; (4) un `.bak`/`.tmp` laissé par le bureau n'est jamais restauré côté mobile ; (5) un seul fichier de langue existe (`i18n/fr_FR.json`).

### Mobile — E4 (entrée mobile), 2026-11-08
Fait : dialogue plein écran (`openFloatingDialog` avec `layout: "fullscreen"`) ; sur mobile aucun chemin ne passe par `openTab`/`addTab` (commandes, réglage `openMode`, Alt+clic, bouton « Ouvrir dans un onglet » supprimés) ; clic sur un résultat = repli `window.open(/assets/x.pdf#page=N)` derrière l'adaptateur `openPdfInBrowser` (message distinct si bloqué ou en erreur), la recherche reste ouverte ; réglages dans un dialogue personnalisé avec seulement Diagnostic et Journal ; texte d'aide adapté (« L'index se construit dans SiYuan sur ordinateur »). Bureau inchangé (prouvé par tests). 4029 tests, typecheck et build verts. Relectures : ecc:security-reviewer, ecc:typescript-reviewer, ecc:silent-failure-hunter (aucun bloquant, mineurs corrigés).
Risques ouverts, à tester sur iPhone avant E6 : (1) dans la WebView de l'application SiYuan, `window.open` peut renvoyer un objet sans rien afficher (aucun message) ; (2) en PWA, ouverture du PDF dans un nouvel onglet Safari ; (3) hauteur du dialogue avec le clavier virtuel (`dvh`) ; (4) l'URL `/assets/...` suppose SiYuan servi à la racine du domaine.

### Correctif — décodeurs d'images PDF.js (JBIG2/JPEG2000), 2026-11-08
Constaté sur iPhone puis reproduit dans Chrome : sur « Pilly - 2E 2023 », les vignettes étaient blanches (seuls les surlignages apparaissaient). Cause : `getDocument` n'était appelé qu'avec `{url}` ; sans `wasmUrl`, PDF.js ne décode pas les images JBIG2/JPEG2000 des référentiels scannés (page 90 : 2 256 pixels sombres sans, 72 318 avec). Corrigé sur toutes les plateformes (bureau compris) : `wasmUrl`, `iccUrl`, `standardFontDataUrl`, `cMapUrl`, `cMapPacked` passés à `getDocument` (constantes dans `pdfjsLoader.ts`). Vérification visuelle du Pilly sur iPhone à refaire après E5.

### Mobile — E5 (visionneur de page), 2026-11-08
Fait : `src/ui/mobilePdfViewer.ts`. Sur mobile, toucher une vignette ouvre la page entière dans un second dialogue plein écran (rendu par `renderCrop`, échelle = largeur d'écran × devicePixelRatio plafonné à 2 et 8 M pixels), avec les surlignages du chemin des vignettes (plafonnés à 500), « Page N / M », précédent/suivant et Fermer de 48 px. Recherche rendue `inert` dessous (levée dès `onClosing`), focus rendu à la carte (repli champ de recherche). États : chargement, page, erreur avec Réessayer (délai 30 s), PDF illisible, page hors bornes. Repli `window.open` seulement si le visionneur ne s'ouvre pas. Relectures : ecc:security-reviewer, ecc:silent-failure-hunter, ecc:typescript-reviewer (1 bloquant : fuite à `dispose()`, corrigé ; mineurs corrigés). Un vrai bug trouvé par les tests de navigation rapide (charge obsolète qui lisait la page courante). 4133 tests, typecheck et build verts. Vérifié en émulation mobile (Chrome 375 px) : vignettes du Pilly rendues, visionneur page 249/482 avec 2 surlignages, navigation, fermeture. Pas encore testé sur iPhone.
Reste : pas de zoom ni de pincement (texte petit sur les pages denses) ; document PDF libéré à l'éviction du LRU et non à la fermeture du visionneur.

### Mobile — E4b (ergonomie tactile), 2026-11-08
Fait : `--docseeker-hit` (32 px, 44 px sous `pointer: coarse`) sur toutes les commandes interactives, champs et `select` à 16 px (pas de zoom iOS), `:hover` sous `@media (hover: hover)` + `:active`, `touch-action: manipulation`, dialogue plein écran avec `dvh` + hauteur réelle du clavier (`--docseeker-vvh`) et décalage `offsetTop` (`--docseeker-vv-top`), zones sûres (haut, bas, gauche, droite), barre basse « Fermer » de 48 px masquée clavier ouvert, chemin complet lisible sans survol, dialogues `min(520px, 94vw)` (validation `CSS_SIZE` durcie et testée), forced-colors. Relectures : ecc:a11y-architect, ecc:typescript-reviewer (2 bloquants : style inline qui annulait la hauteur du clavier, `offsetTop` non suivi ; corrigés). 4327 tests, typecheck et build verts. Bureau inchangé (rendu identique au-delà de 553 px).
À vérifier sur iPhone uniquement : non-zoom au focus, liste visible clavier ouvert, `translateY(var(--docseeker-vv-top))` selon le positionnement natif du conteneur de SiYuan, seuil de 150 px du clavier, zones sûres, cibles de 44 px réelles, `pointer: coarse` dans le WebView de l'application.
