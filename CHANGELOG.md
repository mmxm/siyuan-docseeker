# Journal des modifications

## 0.6.1

Publiée le 2026-11-10.

- Résultats plus compacts sur ordinateur : espacements réduits, boutons « et N autres pages » et des critères moins hauts, chemin du document sur la ligne du titre.
- Les vignettes de chaque document s'affichent sur une rangée qui défile horizontalement, plus grandes (240 px) et plus serrées ; le numéro de page est inscrit sur la vignette.
- La molette fait de nouveau défiler les résultats dans Chrome. Seule la liste défile : le champ de recherche et les critères restent visibles.

## 0.6.0

Publiée le 2026-11-09.

- Vignettes plus rapides : sur un PDF scanné lourd, 12 vignettes s'affichent en environ 4 s au lieu de 7,8 s ; sur un PDF de texte, la première vignette apparaît en environ 180 ms au lieu de 270 ms.
- Beaucoup moins de données téléchargées : le plugin ne lit plus que les parties utiles du PDF (environ 1 Mo par page au lieu du fichier entier). Une recherche sur cinq gros PDF passe de 875 Mo à 15 Mo, ce qui compte surtout sur mobile et sur un serveur distant.
- Les PDF lourds (20 Mo et plus) sont rendus par plusieurs moteurs en parallèle ; les vignettes visibles dès l'affichage des résultats se chargent sans attendre.
- Si le navigateur ne sait pas produire d'images WebP (Safari à confirmer), les vignettes sont enregistrées en JPEG plutôt qu'en PNG, quatre fois plus lourd.

## 0.5.0

Publiée le 2026-11-09.

- Mobile (iPhone, Android, navigateur du téléphone) : la recherche s'ouvre en plein écran, avec une mise en page compacte et des cibles tactiles de 44 px. Toucher une vignette ouvre le PDF dans le visionneur de SiYuan, à la bonne page, avec les mots surlignés.
- Sur mobile, le plugin est en lecture seule : il utilise l'index construit sur ordinateur et n'indexe pas lui-même. Les PDF ajoutés depuis le téléphone apparaissent après une indexation sur ordinateur.
- Sur mobile, le rendu des vignettes est limité (une à la fois, cache réduit, taille des images plafonnée) pour tenir dans la mémoire de Safari.
- Les vignettes des PDF scannés compressés en JBIG2 ou JPEG 2000 ne sont plus blanches : les décodeurs de PDF.js sont activés.
- Sur iPhone, Safari est très lent si SiYuan est ouvert en HTTP par une adresse IP du réseau local (une page de scan lourd peut prendre une minute). Utilisez une adresse en HTTPS.

## 0.4.0

Publiée le 2026-11-07.

- Recherche par sous-chaîne : « pco » trouve « BPCO », pour chaque mot de la requête à partir de 3 caractères. Le classement place les mots entiers avant les préfixes, puis les sous-chaînes ; le surlignage suit la même règle que la recherche. Les scores ne sont plus identiques à ceux de FTS5 pour les préfixes.

## 0.3.0

Publiée le 2026-11-07.

- Release automatisée : un tag `vX.Y.Z` poussé sur `main` construit le paquet et publie la release GitHub (GitHub Actions) ; une intégration continue lance types, tests et paquet sur chaque push vers `main` et chaque PR.

- Indexation automatique : au démarrage, au retour sur la fenêtre, puis périodiquement (5, 15 ou 60 minutes). Les PDF ajoutés ou modifiés sont indexés, les PDF supprimés sont retirés de l'index. Réglable dans les paramètres.
- Indicateur d'état sous le champ de recherche : indexation en cours (résultats éventuellement incomplets), échecs, dossiers non lisibles.
- Les PDF en échec permanent sont retentés à intervalles espacés ; l'indexation attend pendant la saisie.
- Nettoyage des fichiers temporaires orphelins au démarrage.

- Nouveau panneau de paramètres du plugin : Réindexer, Vider l'index (avec confirmation), Diagnostic technique et journal des avertissements. La section « Avancé » de l'onglet disparaît ; l'onglet propose « Ouvrir les paramètres ».
- La recherche se lance uniquement avec Entrée (plus de recherche à la frappe).
- Les résultats n'affichent plus que le dossier contenant le PDF ; le compteur indique « N pages ».
- Classement affiné par la taille de police : les passages écrits en gros caractères (titres) remontent. La taille est approchée par la hauteur des mots telle que PDF.js la fournit. Ce critère s'applique aussi aux requêtes d'un seul mot. Seules les 5 meilleures pages de chaque document sont mesurées.
- Format d'index `.dsx` version 2 (taille des pages). Les index créés par la version précédente sont mis à jour automatiquement, une fois, PDF par PDF : l'ancien index reste utilisable pendant la mise à jour (statut « Mise à jour de l'index »). Cette mise à jour relit donc chaque PDF une fois ; son coût sur une grosse bibliothèque n'est pas mesuré.
- Une page aux dimensions aberrantes est ramenée au format A4 avec un avertissement dans le journal ; le PDF reste indexé.
- Attention : un `.dsx` version 2 n'est pas lisible par la version 0.2.0 du plugin, à ne pas faire cohabiter sur le même dossier de SiYuan.
- Filtres des résultats (bouton « Filtres ») : nom du document ; nombre de pages minimum et maximum ; date de modification. Les filtres ne sont pas conservés d'une session à l'autre. Le filtre par dossier de fichiers n'existe plus : voir « Spécifier le chemin » ci-dessous.
- Tri des résultats (menu « Plus », « Tri ») : pertinence, date de modification, nom, chemin, nombre de pages correspondantes.
- Résultats regroupés par document, ou liste de pages à plat (60 pages, puis « Afficher plus »). Boutons « Élargir » et « Réduire » pour les documents. Le tri et le regroupement sont mémorisés.
- Clavier dans les résultats : flèches haut et bas pour passer d'une vignette à l'autre, flèches gauche et droite, Début et Fin, Page précédente et Page suivante pour changer de document, Entrée pour ouvrir le PDF. Ctrl+Entrée (⌘+Entrée sur Mac), Alt+Entrée ou Alt+clic ouvre le PDF à droite. Échap revient au champ de recherche sans le vider.
- Historique des 20 dernières recherches : Alt+↓ dans le champ, ou l'icône à droite du champ. Il peut être vidé.
- La barre d'outils et les menus de la recherche sont ceux de SiYuan (icônes, menus, dialogue des filtres). Une croix dans le champ efface la recherche.
- Fenêtre flottante, au choix dans les paramètres (« Ouverture de la recherche ») ; l'onglet reste le réglage par défaut. La fenêtre a la même taille que la recherche de SiYuan. Ouvrir un PDF la ferme ; à la réouverture, la dernière recherche est relancée avec ses options. Un bouton permet d'ouvrir la recherche dans un nouvel onglet.
- Trois nouvelles commandes SiYuan : « Rechercher dans les PDF (fenêtre flottante) », « Rechercher dans les PDF (onglet) » et « Aller au champ de recherche PDF ». Aucune n'a de raccourci par défaut : un raccourci se choisit dans les paramètres de SiYuan.
- Quand le tri n'est pas celui de la pertinence, le statut indique « Pages classées par proximité et taille de police ».
- Spécifier le chemin : le bouton ouvre un dialogue identique à celui de la recherche de SiYuan (titre, champ de recherche, arbre des cahiers et documents chargé au fil du dépliage, Annuler et Confirmer). Les cahiers et les documents SiYuan peuvent être choisis ; plusieurs chemins peuvent l'être (Cmd+clic ou Ctrl+clic, 20 au plus). Les résultats ne gardent que les PDF cités par les documents choisis, combinés aux autres filtres. Le chemin choisi s'affiche dans la barre, avec une croix pour le retirer.
- « Inclure les documents enfants » : exclut les sous-documents ; le bouton est désactivé tant qu'aucun document n'est choisi, ou si seuls des cahiers le sont. Un cahier inclut toujours tous ses documents.
- Un filtre par document qui ne peut pas être appliqué (noyau de SiYuan pas encore prêt juste après son démarrage, chemin introuvable, plus de 50 000 PDF cités) affiche un message au lieu d'être ignoré en silence.
- Un filtre par dossier d'une version précédente, dans une session ou un critère, est ignoré avec un avertissement.
- Ligne de critères sous le champ de recherche : les critères enregistrés apparaissent en puces (la puce courante est en surbrillance ; une croix supprime un critère, sans confirmation). Deux boutons, « Enregistrer les critères » et « Réinitialiser les critères », sont aussi dans le menu « Plus ».
- Enregistrer les critères : requête, chemin, filtres, tri et regroupement sous un nom de 80 caractères au plus, 30 critères au plus. Un nom déjà utilisé peut être écrasé, renommé ou fusionné, comme dans SiYuan.
- Cliquer sur une puce applique le critère et relance la recherche, y compris le chemin. Un chemin enregistré qui n'existe plus est retiré, avec un message qui le nomme. « Réinitialiser » efface la requête, le tri, le regroupement et les filtres, mais garde le chemin, comme SiYuan.
- Les critères sont stockés dans les réglages du plugin (`settings.json`). Un critère illisible est ignoré avec un avertissement dans le journal des paramètres ; il reste dans le fichier.

## 0.2.0 — 2026-11-05

Première version utilisable de DocSeeker. Depuis la 0.1.0 (diagnostic technique seul), la recherche est complète.

### Recherche

- Onglet « Recherche PDF » : saisie avec délai, résultats groupés par document, vignettes chargées à la demande.
- Requêtes multi-mots (tous les mots doivent figurer dans la page), préfixe sur le dernier mot, accents et casse ignorés.
- Re-classement par proximité des mots pour les requêtes de deux mots ou plus, fait en arrière-plan (statut « Classement affiné »). Classement proche de DocSeeker, sans être identique.
- Pages dépliables : « et N autres pages » se déplie par lots de 10 (plafond de 200 pages par document).
- Plusieurs onglets de recherche possibles ; ils partagent un seul index chargé au démarrage.
- Accessibilité clavier et ARIA ; thème clair et sombre.

### Vignettes et ouverture des PDF

- Vignettes cadrées sur la zone de la page qui contient le plus de mots de la requête, mots surlignés.
- Clic sur une vignette : le PDF s'ouvre dans le visualiseur de SiYuan à la bonne page, centré sur la zone trouvée, avec un calque de surlignage. Fonctionne aussi si le PDF est déjà ouvert.

### Indexation

- Un fichier d'index `.dsx` par PDF, stocké dans `data/storage/petal/siyuan-docseeker/idx/`.
- Indexation incrémentale : les PDF modifiés ou ajoutés sont réindexés, les PDF supprimés sont retirés, reprise après interruption.
- Bouton « Réindexer » dans la section « Avancé ». (Pause/reprise : le code existe mais n'a pas d'interface ; annoncé à tort dans la première version de cette note.)
- PDF sans texte (scannés) ignorés et signalés.
- Libération effective des documents PDF.js après extraction (`loadingTask.destroy`), pour limiter la mémoire.

### Installation

- Compatible SiYuan 3.8.0 et plus, webapp sur ordinateur (y compris Docker).
- Icône, README en français et en anglais.

## 0.1.0

- Version de développement : diagnostic technique, pas de recherche.
