# Journal des modifications

## Non publié

- La recherche se lance uniquement avec Entrée (plus de recherche à la frappe).
- Les résultats n'affichent plus que le dossier contenant le PDF ; le compteur indique « N pages ».

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
