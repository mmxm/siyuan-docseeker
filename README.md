# DocSeeker pour SiYuan

Recherche plein texte dans les PDF de votre espace SiYuan. Les résultats s'affichent en vignettes de la page, avec les mots trouvés surlignés. Un clic ouvre le PDF dans le visualiseur de SiYuan, à la bonne page, centré sur la zone trouvée.

[English version](README_en_US.md)

## Ce que fait le plugin

- **Recherche plein texte** dans les PDF du dossier `data/assets` (sous-dossiers inclus).
- **Vignettes surlignées** : pour chaque page trouvée, un extrait de la page cadré sur la zone qui contient le plus de mots de la requête, avec les mots surlignés.
- **Ouverture à la bonne page** : un clic ouvre le PDF dans le visualiseur de SiYuan, à la page trouvée, centré sur la zone, avec un calque de surlignage. Fonctionne aussi quand le PDF est déjà ouvert.
- **Classement par proximité des mots et taille de police** : pour une requête de plusieurs mots, les pages où les mots sont proches (sur la même ligne) remontent. Les passages écrits en gros caractères (titres) remontent aussi, y compris pour une requête d'un seul mot. Le classement reste proche de celui de DocSeeker, l'application d'origine, sans lui être identique.
- **Pages dépliables** : chaque document n'affiche d'abord que quelques pages. « et N autres pages » en déplie 10 de plus à chaque clic (200 pages au maximum par document).
- **Filtres, tris et clavier** : filtrer par dossier, nom, nombre de pages ou date ; trier et regrouper les résultats ; naviguer au clavier ; reprendre une recherche précédente dans l'historique.
- **Fenêtre flottante ou onglet** : la recherche s'ouvre dans un onglet (par défaut) ou dans une fenêtre flottante, au choix dans les paramètres du plugin.

## Installation

Prérequis : SiYuan 3.8.0 ou plus, utilisé dans le **navigateur sur ordinateur** (webapp), y compris en Docker. Le plugin ne fonctionne pas sur mobile.

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

- le **dossier**, à choisir dans la liste (menu du bouton **Spécifier le chemin**), avec ou sans ses sous-dossiers (bouton **Inclure les documents enfants**, actif seulement quand un dossier est choisi) ;
- le **nom du document** : une partie du titre suffit, sans tenir compte de la casse ni des accents ;
- le **nombre de pages** : au moins et au plus ;
- la **date de modification** : PDF modifié après une date.

**Confirmer** applique les filtres, **Annuler** les ignore, **Réinitialiser les filtres** les efface. Les filtres ne restreignent pas la recherche : ils masquent des documents dans les résultats. Ils ne sont pas conservés d'une session à l'autre.

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

- **Cible : webapp SiYuan sur ordinateur**, testée avec SiYuan 3.8.9. Le mobile n'est pas pris en charge. L'application de bureau est déclarée dans le manifeste mais n'a pas été testée.
- **Filtres, tris, clavier, historique et fenêtre flottante** ont été essayés dans la webapp de SiYuan 3.8.9, sur un espace de test. Ils ne sont pas encore validés dans l'application de bureau. Le rendu en thème sombre, en largeur de 320 px et le surlignage dans le volet ouvert à droite n'ont pas encore été contrôlés. Sous macOS, **Alt+↓** peut être capté par le système avant d'atteindre le plugin.
- **PDF sans texte ignorés** : un PDF scanné (image sans couche de texte) n'est pas indexé. Il est signalé dans l'onglet. Il n'y a pas d'OCR.
- **Pas de sous-chaîne** : la recherche porte sur des mots entiers, avec préfixe sur le dernier mot. « pco » ne trouve pas « BPCO ».
- **Classement proche de DocSeeker, pas identique** : la taille de police est approchée par la hauteur des mots telle que PDF.js la fournit. Sur 3 PDF seulement, cette hauteur s'est révélée environ 6 à 12 % plus grande que celle que donne PyMuPDF, le moteur d'extraction de DocSeeker ; cet écart n'est pas corrigé. Seules les 5 meilleures pages de chaque document sont mesurées pour le classement. Les expressions entre guillemets ne sont pas gérées.
- **Version précédente du plugin** : la version 0.2.0 ne sait pas lire les index mis à jour. Ne pas utiliser les deux versions sur le même dossier de SiYuan.
- **Périmètre** : seuls les PDF de `data/assets` sont indexés, pas les documents SiYuan.

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
