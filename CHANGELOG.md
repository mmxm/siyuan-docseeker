# Journal des modifications

## Non publié

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
- Filtres des résultats (bouton « Filtres ») : dossier, avec ou sans sous-dossiers ; nom du document ; nombre de pages minimum et maximum ; date de modification. Les filtres ne sont pas conservés d'une session à l'autre.
- Tri des résultats (menu « Plus », « Tri ») : pertinence, date de modification, nom, chemin, nombre de pages correspondantes.
- Résultats regroupés par document, ou liste de pages à plat (60 pages, puis « Afficher plus »). Boutons « Élargir » et « Réduire » pour les documents. Le tri et le regroupement sont mémorisés.
- Clavier dans les résultats : flèches haut et bas pour passer d'une vignette à l'autre, flèches gauche et droite, Début et Fin, Page précédente et Page suivante pour changer de document, Entrée pour ouvrir le PDF. Ctrl+Entrée (⌘+Entrée sur Mac), Alt+Entrée ou Alt+clic ouvre le PDF à droite. Échap revient au champ de recherche sans le vider.
- Historique des 20 dernières recherches : Alt+↓ dans le champ, ou l'icône à droite du champ. Il peut être vidé.
- La barre d'outils et les menus de la recherche sont ceux de SiYuan (icônes, menus, dialogue des filtres). Une croix dans le champ efface la recherche.
- Fenêtre flottante, au choix dans les paramètres (« Ouverture de la recherche ») ; l'onglet reste le réglage par défaut. La fenêtre a la même taille que la recherche de SiYuan. Ouvrir un PDF la ferme ; à la réouverture, la dernière recherche est relancée avec ses options. Un bouton permet d'ouvrir la recherche dans un nouvel onglet.
- Trois nouvelles commandes SiYuan : « Rechercher dans les PDF (fenêtre flottante) », « Rechercher dans les PDF (onglet) » et « Aller au champ de recherche PDF ». Aucune n'a de raccourci par défaut : un raccourci se choisit dans les paramètres de SiYuan.
- Quand le tri n'est pas celui de la pertinence, le statut indique « Pages classées par proximité et taille de police ».
- Filtre par document SiYuan : le menu « Spécifier le chemin » propose aussi les cahiers et les documents SiYuan, en plus des dossiers de fichiers. Seuls les PDF cités par le document choisi restent dans les résultats. Les sous-documents sont inclus, sauf si l'on décoche « Inclure les documents enfants » ; pour un cahier, seuls ses documents de premier niveau restent. Un seul chemin est actif à la fois. Tant que ce filtre est actif, les PDF qu'aucun document ne cite sont exclus.
- Un filtre par document qui ne peut pas être appliqué (noyau de SiYuan pas encore prêt juste après son démarrage, chemin introuvable) affiche un message au lieu d'être ignoré en silence, avec « Réessayer ».
- Critères enregistrés (bouton « Critères enregistrés ») : enregistrer la requête, le chemin, les filtres, le tri et le regroupement sous un nom (30 critères au plus), rappeler un critère (la recherche est relancée) ou le supprimer. Un critère illisible est ignoré, avec un avertissement dans le journal des paramètres.

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
