# DocSeeker pour SiYuan

Recherche plein texte dans les PDF de votre espace SiYuan. Les résultats s'affichent en vignettes de la page, avec les mots trouvés surlignés. Un clic ouvre le PDF dans le visualiseur de SiYuan, à la bonne page, centré sur la zone trouvée.

[English version](README_en_US.md)

## Ce que fait le plugin

- **Recherche plein texte** dans les PDF du dossier `data/assets` (sous-dossiers inclus).
- **Vignettes surlignées** : pour chaque page trouvée, un extrait de la page cadré sur la zone qui contient le plus de mots de la requête, avec les mots surlignés.
- **Ouverture à la bonne page** : un clic ouvre le PDF dans le visualiseur de SiYuan, à la page trouvée, centré sur la zone, avec un calque de surlignage. Fonctionne aussi quand le PDF est déjà ouvert.
- **Classement par proximité des mots** : pour une requête de plusieurs mots, les pages où les mots sont proches (sur la même ligne) remontent. Le classement reste proche de celui de DocSeeker, l'application d'origine, sans lui être identique.
- **Pages dépliables** : chaque document n'affiche d'abord que quelques pages. « et N autres pages » en déplie 10 de plus à chaque clic (200 pages au maximum par document).

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

- L'indexation est **automatique** (réglable dans les paramètres du plugin) : quelques secondes après le démarrage, au retour sur la fenêtre (au plus une fois toutes les 30 secondes), puis toutes les 5, 15 ou 60 minutes. Les PDF ajoutés ou modifiés sont indexés, les PDF supprimés sont retirés de l'index, les PDF inchangés ne sont pas relus. Elle attend que vous ayez fini de taper ou de défiler. **Réindexer** force une vérification immédiate.
- Un PDF qui échoue (corrompu, vide) est retenté à intervalles espacés ; l'onglet de recherche signale les échecs et les dossiers non lisibles, le détail est dans le journal des paramètres.
- Si l'indexation s'interrompt (fermeture de SiYuan, par exemple), la prochaine réindexation reprend là où elle s'était arrêtée.
- **Durée indicative** : environ 191 s pour 44 PDF, mesurés avec Node sur un disque local. Dans le navigateur, c'est plus long. Ces chiffres sont donnés à titre indicatif.
- **Taille des index** : environ 3 Ko par page indexée.

## Utilisation

- **Plusieurs mots** : tous les mots doivent figurer dans la même page. « sévérité bpco » ne renvoie que les pages contenant les deux mots.
- **Préfixe sur le dernier mot** : `diab` trouve « diabète », « diabétique », etc. Seul le dernier mot est traité ainsi.
- **Accents et casse ignorés** : « diabete » trouve « Diabète ». La ponctuation est également ignorée.
- Les résultats sont regroupés par document. Un clic sur une vignette ouvre le PDF à la page correspondante.
- Une fois le classement par proximité calculé, le statut indique « Classement affiné par proximité des mots ».
- L'interface est en français uniquement.

## Limites connues

- **Cible : webapp SiYuan sur ordinateur**, testée avec SiYuan 3.8.9. Le mobile n'est pas pris en charge. L'application de bureau est déclarée dans le manifeste mais n'a pas été testée.
- **PDF sans texte ignorés** : un PDF scanné (image sans couche de texte) n'est pas indexé. Il est signalé dans l'onglet. Il n'y a pas d'OCR.
- **Pas de sous-chaîne** : la recherche porte sur des mots entiers, avec préfixe sur le dernier mot. « pco » ne trouve pas « BPCO ».
- **Classement proche de DocSeeker, pas identique** : la taille de police n'est pas prise en compte (ni dans le classement, ni dans le tri des occurrences). Les expressions entre guillemets ne sont pas gérées.
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
