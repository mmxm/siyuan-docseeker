# Consignes pour ce projet

> **Règle n°1 : exploite au maximum les skills et les agents du plugin ECC.** Avant chaque tâche, cherche dans la liste des agents `ecc:*` et des skills `ecc:*` ceux qui correspondent, et utilise-les (plusieurs à la fois si possible, en parallèle quand les fichiers sont distincts). Ne fais pas toi-même ce qu'un agent ou un skill ECC sait faire. Cette consigne est répétée dans les sections ci-dessous : elle est volontairement insistante.

## Contexte et état du projet

Plugin SiYuan 100 % frontend de recherche plein texte dans les PDF, avec vignettes surlignées (voir `CAHIER_DES_CHARGES.md`, `PLAN_IMPLEMENTATION.md`). **Lis `AVANCEMENT.md` en début de session** : il dit où on en est, les risques ouverts et les prochaines étapes.

## Dépôt GitHub

Un dépôt GitHub est disponible : `git@github.com:mmxm/siyuan-docseeker.git` (branche `main`, remote `origin`). La clé SSH est présente sur la machine. Commite régulièrement et pousse (`git push origin main`) ; si GitHub est en panne ou refuse la clé, ne contourne pas (pas d'autre clé, pas de HTTPS improvisé) : signale-le et pousse plus tard. Vérifie `git log origin/main..HEAD` pour voir ce qui reste à pousser.

## Délégation : ne fais pas tout toi-même

**Rappel : utilise au maximum les agents et skills ECC, systématiquement, sans attendre que l'utilisateur le redemande.** À chaque étape, demande-toi quel agent ou skill ECC s'applique (conception, code, relecture, sécurité, performance, tests, documentation, vérification) et lance-le, y compris les revues en parallèle pendant qu'un autre agent code sur d'autres fichiers.

L'agent principal **coordonne** ; il ne doit pas tout faire lui-même. Pour chaque tâche, choisis le skill et/ou l'agent le plus adapté et délègue-lui le travail via l'outil Agent (`subagent_type`), en donnant un brief précis (fichiers, comportement attendu, critère de fin). Garde pour toi la décision, l'intégration et la vérification finale des résultats.

- Écriture de code et correction de bug : `ecc:tdd-guide` (tests d'abord, RED puis GREEN). Ne rédige pas toi-même un module non trivial.
- Relecture après modification : `ecc:typescript-reviewer`, `ecc:code-reviewer`, et selon le sujet `ecc:silent-failure-hunter` (erreurs avalées), `ecc:security-reviewer` (entrées non fiables, formats binaires), `ecc:performance-optimizer` (mémoire/temps), `ecc:pr-test-analyzer` (qualité des tests).
- Erreurs de build ou de types : `ecc:build-error-resolver`. Nettoyage : `ecc:refactor-cleaner`, `ecc:code-simplifier`.
- Conception d'une fonctionnalité : `ecc:planner` / `ecc:architect` / `ecc:code-architect`. Documentation : `ecc:doc-updater`.
- Utilise d'autres skills et agents ECC dès qu'ils correspondent mieux à la tâche, même s'ils ne sont pas listés ici. Parcours la liste des agents et skills `ecc:*` disponibles à chaque nouvelle phase (par exemple `ecc:frontend-design-direction`, `ecc:a11y-architect`, `ecc:frontend-a11y`, `ecc:security-review`, `ecc:error-handling`, `ecc:typescript-patterns`, `ecc:ai-regression-testing`, `ecc:code-tour`) plutôt que de te limiter à cette liste.
- Pour l'interface et l'ergonomie, associe les skills `design-skills:*` (interaction-design, ux-writing, design-critique, accessibility-audit) aux agents ECC.
- Chaque jalon doit mentionner, dans le compte rendu à l'utilisateur, quels agents et skills ECC ont été utilisés et lesquels ont été écartés (avec la raison).
- Plusieurs tâches indépendantes (fichiers distincts) : lance plusieurs agents en parallèle, jamais deux agents sur les mêmes fichiers.
- Ne fais toi-même que les petites modifications ponctuelles (une ligne, une constante, un renommage, de la documentation), les vérifications (`npm run typecheck`, `npm test`, build) et la synthèse. Vérifie toujours le travail d'un agent avant de le présenter comme fait (relance les tests, lis le diff) : son rapport n'est pas une preuve.

## Skills à utiliser systématiquement

**Les skills et agents ECC sont à exploiter au maximum, à chaque tâche, pas seulement ceux de cette liste.**

Pour chaque tâche de code dans ce projet (écriture, modification, test, revue ou configuration), applique les skills ECC ci-dessous avant de répondre. Invoque-les avec le Skill tool, sous le nom `ecc:<nom>`. Si plusieurs skills s'appliquent, utilise-les tous. Si un skill ne s'applique pas à la tâche, ignore-le et dis-le brièvement.

- `ecc:coding-standards` : avant d'écrire ou de modifier du code, respecte ses règles.
- `ecc:tdd-workflow` : pour l'écriture de code et les corrections de bugs, écris d'abord les tests, puis le code qui les fait passer.
- `ecc:tdd-guide` : agent spécialisé TDD. Pour une nouvelle fonctionnalité ou une correction, délègue-lui la conduite du cycle de tests (via l'outil Agent, `subagent_type` = `ecc:tdd-guide`).
- `ecc:plan` : avant une implémentation non triviale, établis le plan et attends la validation.
- `ecc:verification-loop` : après une modification, vérifie le résultat (tests, build, lint) avant de conclure.
- `ecc:strategic-compact` : quand la conversation devient longue, applique-le pour compacter le contexte.
- `ecc:configure-ecc`, `ecc:continuous-learning`, `ecc:continuous-learning-v2` : utilise-les à chaque tâche pour configurer ECC et apprendre des sessions.



