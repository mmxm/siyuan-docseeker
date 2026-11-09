# DocSeeker pour SiYuan

Recherche plein texte dans les PDF de votre espace SiYuan. Les résultats s'affichent en vignettes de la page, avec les mots trouvés surlignés. Un clic ouvre le PDF dans le visualiseur de SiYuan, à la bonne page, centré sur la zone trouvée.

[English version](README_en_US.md)

## Ce que fait le plugin

- **Recherche plein texte** dans les PDF du dossier `data/assets` (sous-dossiers inclus).
- **Vignettes surlignées** : pour chaque page trouvée, un extrait de la page cadré sur la zone qui contient le plus de mots de la requête, avec les mots surlignés.
- **Ouverture à la bonne page** : un clic ouvre le PDF dans le visualiseur de SiYuan, à la page trouvée, centré sur la zone, avec un calque de surlignage. Fonctionne aussi quand le PDF est déjà ouvert.
- **Classement par proximité des mots et taille de police** : pour une requête de plusieurs mots, les pages où les mots sont proches (sur la même ligne) remontent. Les passages écrits en gros caractères (titres) remontent aussi, y compris pour une requête d'un seul mot. Le classement reste proche de celui de DocSeeker, l'application d'origine, sans lui être identique.
- **Pages dépliables** : chaque document n'affiche d'abord que quelques pages. « et N autres pages » en déplie 10 de plus à chaque clic (200 pages au maximum par document).
- **Filtres, tris et clavier** : filtrer par cahier ou document SiYuan, nom, nombre de pages ou date ; trier et regrouper les résultats ; naviguer au clavier ; reprendre une recherche précédente dans l'historique ou dans les critères enregistrés.
- **Fenêtre flottante ou onglet** : la recherche s'ouvre dans un onglet (par défaut) ou dans une fenêtre flottante, au choix dans les paramètres du plugin.

## Installation

Prérequis : SiYuan 3.8.0 ou plus, utilisé dans le **navigateur sur ordinateur** (webapp), y compris en Docker. Sur mobile (navigateur du téléphone ou application SiYuan), le plugin fonctionne en lecture seule : l'indexation se fait sur ordinateur.

### Par le Marché de SiYuan

Une fois le plugin publié dans le Marché : menu **Marché** de SiYuan, onglet **Plugins**, rechercher « DocSeeker », puis **Installer**.

### Par fichier zip

1. Télécharger `package.zip` depuis la page des versions du dépôt : https://github.com/mmxm/siyuan-docseeker/releases
2. Extraire le contenu dans le dossier `data/plugins/siyuan-docseeker/` de votre espace SiYuan. Le dossier doit contenir directement `index.js` et `plugin.json` (pas de sous-dossier intermédiaire).

### Copie manuelle

Copier dans `data/plugins/siyuan-docseeker/` : `index.js`, `plugin.json`, le dossier `i18n/`, `README.md`, `README_en_US.md` et `icon.png`.

Sur macOS, avec SiYuan installé dans son dossier par défaut : `~/SiYuan/data/plugins/siyuan-docseeker/`.

### SiYuan dans Docker

Le dossier monté dans le conteneur (par exemple `-v /chemin/hote:/siyuan/workspace`) contient le dossier `data/`. Placez le plugin dans `/chemin/hote/data/plugins/siyuan-docseeker/`. Il n'est pas nécessaire de reconstruire ni de redémarrer le conteneur.

### Activer ou recharger le plugin

Après une installation ou une mise à jour : menu **Marché**, onglet **Téléchargés**, section **Plugins**. Désactivez DocSeeker puis réactivez-le. Inutile de relancer SiYuan ; un simple rechargement de la page ne suffit pas.

## Première indexation

Avant de pouvoir chercher, les PDF doivent être indexés.

1. Cliquer sur l'icône de recherche de la barre supérieure (« Ouvrir la recherche dans les PDF »).
2. Ouvrir les paramètres du plugin (engrenage de DocSeeker dans **Marché > Téléchargés > Plugins**, ou bouton **Ouvrir les paramètres** de l'onglet de recherche), puis cliquer sur **Réindexer**.
3. Attendre la fin. Pendant l'indexation, le statut indique « Index en cours de construction » et les résultats sont partiels.

Comportement à connaître :

- L'indexation est **automatique** (réglable dans les paramètres du plugin) : quelques secondes après le démarrage, au retour sur la fenêtre (au plus une fois toutes les 30 secondes), puis toutes les 5, 15 ou 60 minutes. Les PDF ajoutés ou modifiés sont indexés, les PDF supprimés sont retirés de l'index, les PDF inchangés ne sont pas relus (sauf une fois, après une mise à jour du format d'index, voir ci-dessous). Elle attend que vous ayez fini de taper ou de défiler. **Réindexer** force une vérification immédiate.
- **Mise à jour du format** : les index créés par la version précédente du plugin sont mis à jour automatiquement, une fois, PDF par PDF (le statut indique « Mise à jour de l'index »). Pendant la mise à jour, la recherche reste possible avec l'ancien index. Sur une grande bibliothèque, cette mise à jour peut prendre longtemps : sa durée n'a pas été mesurée.
- Un PDF qui échoue (corrompu, vide) est retenté à intervalles espacés ; l'onglet de recherche signale les échecs et les dossiers non lisibles, le détail est dans le journal des paramètres.
- Si l'indexation s'interrompt (fermeture de SiYuan, par exemple), la prochaine réindexation reprend là où elle s'était arrêtée.
- **Durée indicative** : environ 191 s pour 44 PDF, mesurés avec Node sur un disque local. Dans le navigateur, c'est plus long. Ces chiffres sont donnés à titre indicatif.
- **Taille des index** : environ 3 Ko par page indexée.

## Utilisation

- **Plusieurs mots** : tous les mots doivent figurer dans la même page. « sévérité bpco » ne renvoie que les pages contenant les deux mots.
- **Préfixe sur le dernier mot** : `diab` trouve « diabète », « diabétique », etc. Seul le dernier mot est traité ainsi.
- **Accents et casse ignorés** : « diabete » trouve « Diabète ». La ponctuation est également ignorée.
- Les résultats sont regroupés par document (réglable, voir « Tri et regroupement »). Un clic sur une vignette ouvre le PDF à la page correspondante.
- Une fois le classement par proximité et taille de police calculé, le statut indique « Classement affiné par proximité des mots et taille de police ». Si le tri n'est pas celui de la pertinence, il indique « Pages classées par proximité et taille de police ».
- L'interface est en français uniquement.

### Filtrer les résultats

Le bouton **Filtres** de la barre d'outils ouvre un dialogue avec :

- le **nom du document** : une partie du titre suffit, sans tenir compte de la casse ni des accents ;
- le **nombre de pages** : au moins et au plus ;
- la **date de modification** : PDF modifié après une date.

**Confirmer** applique les filtres, **Annuler** les ignore, **Réinitialiser les filtres** les efface. Les filtres ne restreignent pas la recherche : ils masquent des documents dans les résultats. Ils ne sont pas conservés d'une session à l'autre.

Le chemin ne se choisit pas dans ce dialogue, mais avec le bouton **Spécifier le chemin** (voir ci-dessous).

### Filtrer par document SiYuan

Le bouton **Spécifier le chemin** ouvre un dialogue qui reprend celui de la recherche de SiYuan : même titre, champ **Recherche...**, arbre des cahiers et des documents qui se déplie à la demande, boutons **Annuler** et **Confirmer**.

- Choisir un cahier ou un document ne garde que les PDF cités par ce document.
- Plusieurs chemins peuvent être choisis : **Cmd+clic** sur Mac, **Ctrl+clic** ailleurs (20 chemins au plus). Un PDF reste dans les résultats s'il est cité par l'un des chemins choisis, et les autres filtres s'appliquent en plus.
- Les sous-documents sont inclus. Le bouton **Inclure les documents enfants** les exclut. Il est désactivé tant qu'aucun document n'est choisi, ou si seuls des cahiers le sont ; un cahier inclut toujours tous ses documents.
- Le chemin choisi s'affiche dans la barre, avec une croix pour le retirer. Tant qu'il est actif, les PDF qu'aucun document ne cite sont exclus. L'infobulle de l'étiquette le rappelle.
- Le filtre par dossier de fichiers n'existe plus. Une session ou un critère enregistré qui le contenait s'applique sans lui, avec un avertissement.

Le plugin lit l'arborescence dans votre noyau SiYuan. Juste après le démarrage de SiYuan, son index n'est parfois pas prêt : le plugin l'indique alors (« Réessayez dans un instant »). Un filtre qui ne peut pas être appliqué n'est jamais ignoré en silence : un message l'explique.

### Trier et regrouper

Menu **Plus** de la barre d'outils :

- **Tri** : « Pertinence » (ordre par défaut) ou « ASC de pertinence » (ordre inverse), date de modification (croissant ou décroissant), nom (croissant ou décroissant), chemin (croissant), pages correspondantes (décroissant).
- **Groupe** : regrouper par document (par défaut) ou aucun regroupement. Sans regroupement, les pages s'affichent à plat, 60 à la fois, avec « Afficher plus ». Les boutons **Élargir** et **Réduire** ne servent que quand les résultats sont regroupés.

Changer de tri ne relance pas la recherche. Le tri et le regroupement sont mémorisés.

### Clavier

Dans le champ de recherche :

- **Entrée** lance la recherche (la recherche ne part pas à la frappe) ;
- **Échap** vide le champ ;
- **↓** va à la première vignette ;
- **Alt+↓** ouvre l'historique des recherches.

Dans les résultats :

- **↑** et **↓** vont à la vignette au-dessus ou au-dessous ; **←** et **→** à la précédente ou à la suivante ;
- **Début** et **Fin** vont à la première ou à la dernière vignette ;
- **Page précédente** et **Page suivante** vont au document précédent ou suivant ;
- **Entrée** ouvre le PDF à la page de la vignette ;
- **Ctrl+Entrée** (**⌘+Entrée** sur Mac), **Alt+Entrée** ou **Alt+clic** ouvre le PDF **à droite**, dans un volet à côté ;
- **Échap** revient au champ de recherche sans le vider ;
- **Maj+Entrée** ne fait rien.

### Historique

L'icône à droite du champ, ou **Alt+↓**, affiche les 20 dernières recherches. Un clic relance la recherche. **Supprimer tout l'historique** vide la liste. L'historique est conservé dans les réglages du plugin.

### Critères enregistrés

Une ligne sous le champ de recherche affiche les **critères enregistrés** sous forme de puces. Un critère garde une recherche complète : la requête, le chemin, les filtres, le tri et le regroupement. La puce du critère courant est en surbrillance.

La même ligne porte deux boutons : **Enregistrer les critères** et **Réinitialiser les critères**. Ces deux actions sont aussi dans le menu **Plus**.

- **Enregistrer** : donnez un nom de 80 caractères au plus, dans le dialogue qui s'ouvre (champ **Remarques**). La requête est limitée à 200 caractères, et 30 critères au plus peuvent être enregistrés. Si le nom existe déjà, le plugin demande s'il faut l'écraser ; renommer et fusionner suivent les règles de SiYuan.
- **Rappeler** : cliquer sur une puce applique le critère, chemin compris, et relance la recherche. Si un chemin enregistré n'existe plus, il est retiré et un message le nomme. Un document qui existe mais ne cite aucun PDF reste appliqué : le résultat est vide.
- **Supprimer** : la croix de la puce supprime le critère, sans confirmation.
- **Réinitialiser** : efface la requête, le tri, le regroupement et les filtres. Le chemin est conservé, comme dans SiYuan.

Le rappel applique aussi le chemin, alors que SiYuan garde le chemin courant : c'est un choix du plugin.

Les critères sont conservés dans les réglages du plugin (`settings.json`), pas dans la recherche de SiYuan. Un critère illisible est ignoré, avec un avertissement dans le journal des paramètres ; il reste dans le fichier.

### Fenêtre flottante ou onglet

Le réglage **Ouverture de la recherche** (paramètres du plugin) choisit où s'ouvre la recherche :

- **Onglet** (par défaut) : un onglet de recherche, comme dans les versions précédentes ;
- **Fenêtre flottante** : une fenêtre de la taille de la recherche de SiYuan. Ouvrir un PDF la ferme. Fermée puis rouverte, elle relance la dernière recherche avec ses options. Le bouton **Ouvrir dans un nouvel onglet** transfère la recherche vers un onglet. **Échap** referme d'abord le menu ouvert, puis vide le champ, puis ferme la fenêtre si le champ est vide.

L'icône de la barre supérieure suit ce réglage. Les commandes décrites ci-dessous permettent d'ouvrir l'un ou l'autre quel que soit le réglage.

### Commandes et raccourcis

Le plugin propose quatre commandes :

- **Rechercher dans les PDF** : ouvre la recherche selon le réglage « Ouverture de la recherche » ;
- **Rechercher dans les PDF (fenêtre flottante)** et **Rechercher dans les PDF (onglet)** ;
- **Aller au champ de recherche PDF** : place le focus sur le champ de la fenêtre flottante si elle est ouverte, sinon sur le champ du dernier onglet de recherche visible, ou ouvre un onglet.

Aucune commande n'a de raccourci par défaut. Pour en attribuer un, ouvrez les paramètres de SiYuan, à l'onglet **Raccourci**, retrouvez les commandes de DocSeeker et ajoutez un raccourci. Le choix du raccourci se fait dans SiYuan, pas dans le plugin.

## Limites connues

- **Cible : webapp SiYuan sur ordinateur**, testée avec SiYuan 3.8.9. Sur mobile, le plugin est en lecture seule et a été essayé sur iPhone (Safari) ; Android et l'application mobile SiYuan n'ont pas été testés. Ouvrez SiYuan en HTTPS : en HTTP par une adresse IP du réseau local, Safari est très lent sur les PDF scannés. L'application de bureau est déclarée dans le manifeste mais n'a pas été testée.
- **Filtres, filtre par document SiYuan, critères enregistrés, tris, clavier, historique et fenêtre flottante** ont été essayés dans la webapp de SiYuan 3.8.9, sur un espace de test (le dialogue de chemin et la ligne de critères ont été vérifiés avec des captures d'écran). Ils ne sont pas encore validés dans l'application de bureau. Le rendu en thème sombre, en largeur de 320 px, l'étiquette de chemin longue et le surlignage dans le volet ouvert à droite n'ont pas encore été contrôlés. Le dialogue de chemin n'a pas été comparé pixel à pixel à celui de SiYuan, et il n'a pas l'historique de saisie du chevron de SiYuan. Sous macOS, **Alt+↓** peut être capté par le système avant d'atteindre le plugin.
- **PDF sans texte ignorés** : un PDF scanné (image sans couche de texte) n'est pas indexé. Il est signalé dans l'onglet. Il n'y a pas d'OCR.
- **Sous-chaîne à partir de 3 caractères** : « pco » trouve « BPCO ». En dessous de 3 caractères, la recherche porte sur des mots entiers, avec préfixe sur le dernier mot. Les mots entiers passent avant les préfixes, puis les sous-chaînes.
- **Classement proche de DocSeeker, pas identique** : la taille de police est approchée par la hauteur des mots telle que PDF.js la fournit. Sur 3 PDF seulement, cette hauteur s'est révélée environ 6 à 12 % plus grande que celle que donne PyMuPDF, le moteur d'extraction de DocSeeker ; cet écart n'est pas corrigé. Seules les 5 meilleures pages de chaque document sont mesurées pour le classement. Les expressions entre guillemets ne sont pas gérées.
- **Version précédente du plugin** : la version 0.2.0 ne sait pas lire les index mis à jour. Ne pas utiliser les deux versions sur le même dossier de SiYuan.
- **Périmètre** : seuls les PDF de `data/assets` sont indexés, pas les documents SiYuan. Ceux-ci ne servent qu'à filtrer les résultats.
- **Document déplacé** : son chemin change. Un critère enregistré qui le visait peut alors ne plus rien trouver ; le plugin l'indique si aucun PDF ne reste.
- **Chemin trop large** : un chemin qui cite plus de 50 000 PDF ne peut pas être appliqué ; le plugin l'indique au lieu de filtrer partiellement.

## Confidentialité

Tout fonctionne en local. DocSeeker lit vos PDF et ses index uniquement via l'API de votre propre noyau SiYuan, et utilise le moteur PDF.js fourni par SiYuan. Il n'envoie rien vers Internet, n'utilise aucun compte et ne collecte aucune statistique. Les index sont des fichiers dans `data/storage/petal/siyuan-docseeker/idx/` : ils suivent donc les sauvegardes de votre dossier `data/`.

## Développement

```bash
npm install
npm test                      # tests unitaires (Vitest)
npm run typecheck             # TypeScript strict : src, puis tests
npm run package               # construit dist/index.js puis package.zip
npm run release:check         # vérifie une release sans rien publier
```

Banc d'essai (vraie interface SiYuan, sans toucher à `~/SiYuan`) : un noyau jetable sur le port 6807, avec le plugin et des PDF de test.

```bash
npm run build && npm run sandbox -- start      # ajoute --dir D, --port P, --pdfs N (8 PDF par défaut) ; ouvrir l'URL affichée
npm run build && npm run sandbox -- install    # réinstalle le bundle, puis F5 dans le navigateur
npm run sandbox -- status | stop | reset       # reset ne supprime que le dossier marqué .docseeker-sandbox
```

Dossier par défaut : `$TMPDIR/docseeker-sandbox`. Les ports 6806 et 55165 et tout chemin dans `~/SiYuan` ou dans un workspace existant sont refusés. Variable `DOCSEEKER_KERNEL` : autre binaire du noyau.

Mesures et outils (lecture seule sur les données, sauf `gen:ranking-fixture`) :

```bash
npm run measure:memory        # mémoire des index décodés ; COPIES=20 extrapole à un grand corpus
npm run measure:multiword     # requêtes multi-mots sur les vrais index ; DSX_DIR=dossier des .dsx
npm run measure:corpus        # indexation puis requêtes sur un corpus de PDF ; CORPUS_DIR, PDFJS_DIR, CORPUS_LIMIT
npm run gen:ranking-fixture   # régénère tests/fixtures/docseeker-ranking.json avec le moteur Rust de DocSeeker
```

- `DSX_DIR` vaut par défaut `~/SiYuan/data/storage/petal/siyuan-docseeker/idx`.
- `PDFJS_DIR` vaut par défaut le dossier `stage/protyle/js/pdf` de SiYuan installé dans `/Applications`.
- `gen:ranking-fixture` exige `DOCSEEKER_RUST_DIR` (dossier `backend-rust` de DocSeeker) et `cargo`. Le dépôt Rust n'est jamais modifié.

Pour publier une version : `npm run release:check` affiche les commandes manuelles à lancer ensuite. Le script ne publie rien lui-même.

Documentation de projet : `CAHIER_DES_CHARGES.md` (le quoi), `PLAN_IMPLEMENTATION.md` (le comment), `AVANCEMENT.md` (l'état), `CHANGELOG.md` (les versions).
