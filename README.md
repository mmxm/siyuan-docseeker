# DocSeeker pour SiYuan

Recherche plein texte dans les PDF de `data/assets`, avec vignettes surlignées. Un clic ouvre le PDF dans le visualiseur natif de SiYuan, à la bonne page, avec les mots trouvés surlignés.

**État : version 0.1, en développement.** Cette version contient l'onglet du plugin et un diagnostic technique (« Diagnostic M0 ») qui vérifie, dans votre SiYuan, les hypothèses dont dépend la suite. La recherche elle-même n'est pas encore branchée.

## Utilisation

1. Installer le plugin (dossier `data/plugins/siyuan-docseeker` ou `package.zip`).
2. Cliquer sur l'icône de recherche de la barre supérieure.
3. Lancer « Diagnostic M0 (technique) » et lire le résultat.

Cible : SiYuan webapp sur ordinateur. Interface en français.

## Développement

```bash
npm install
npm test
npm run typecheck
npm run package   # construit dist/index.js puis package.zip
```

Voir `CAHIER_DES_CHARGES.md`, `PLAN_IMPLEMENTATION.md` et `AVANCEMENT.md`.
