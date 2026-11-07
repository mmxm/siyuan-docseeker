import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FREQUENCY_MINUTES } from "../../src/settings";
import { DEFAULT_STRINGS } from "../../src/ui/searchView";

const fr = JSON.parse(readFileSync("i18n/fr_FR.json", "utf8")) as Record<string, string>;
const NEW_KEYS = [
  "autoIndexRunning", "autoIndexCount", "autoIndexUpToDate", "autoIndexFailed", "autoIndexDiscoveryFailed",
  "autoIndexPartialOne", "autoIndexPartialMany", "indexingMayMiss", "clearDoneRebuilding", "clearDoneWillRebuild",
  "settingsSaveFailed", "autoIndexIntervalDisabledHint", "autoIndexMigrating",
  "filtersLabel", "filtersActiveOne", "filtersActiveMany",
  "pathSearchPlaceholder", "pathNoResult", "pathDialogError", "pathDialogTooMany",
  "filterName", "filterMinPages", "filterMaxPages", "filterModifiedAfter", "filterReset", "filterError",
  "filterErrMinMax", "filterErrInteger", "filterErrDate", "hiddenByFiltersOne", "hiddenByFiltersMany",
  "noResultFiltersOne", "noResultFiltersMany",
  "sortRelevanceDesc", "sortRelevanceAsc", "sortModifiedAsc", "sortModifiedDesc", "sortNameAsc", "sortNameDesc",
  "sortPathAsc", "sortMatchesDesc", "groupByDocument", "expandAll", "collapseAll", "rankingRefinedPages",
  "flatMoreOne", "flatMoreMany", "settingNotSaved",
  "pathSpecify", "includeChildren", "moreMenu", "sortMenu", "groupMenu", "groupNone", "removePath", "clearField",
  "dialogCancel", "dialogConfirm",
  "historyClear", "historyEmpty", "historyIcon", "commandOpenSearch", "commandFocusSearch",
  "openInNewTab", "floatingTitle", "openMode", "openModeDesc", "openModeTab", "openModeDialog",
  "commandOpenSearchFloating", "commandOpenSearchTab",
  "highlightUnavailable", "floatingOpenFailed", "openTabFailed", "transferTabFailed",
  "docFilterNoPdf", "scopeLoading", "scopeNotReady", "scopeTooLarge", "scopeFailed", "scopeRefreshFailed",
  "scopeInvalid", "kernelUnavailable",
  "traceKeys", "traceKeysRunning", "traceKeysDone", "traceKeysNoTab", "traceKeysFailed", "traceKeysNoKey",
];
const read = (path: string): string => readFileSync(path, "utf8");
/** Contenu de tous les .ts d'un dossier (récursif), commentaires de ligne et de bloc retirés. */
function collectSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectSources(path);
    return path.endsWith(".ts") ? [read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")] : [];
  });
}

describe("i18n/fr_FR.json", () => {
  it("contient toutes les clés demandées par le panneau et le plugin", () => {
    const sources = ["src/ui/settingsPanel.ts", "src/index.ts", "src/searchTab.ts"].map(read).join("\n");
    const keys = new Set([...sources.matchAll(/\bt\("([A-Za-z]+)"\)/g)].map((m) => m[1]!));
    // Clés construites dynamiquement : titre et `<clé>Desc` de chaque item du panneau.
    for (const key of ["openMode", "autoIndex", "autoIndexInterval", "reindex", "clearIndex", "diagnostic", "warnLog"]) {
      keys.add(key);
      keys.add(`${key}Desc`);
    }
    for (const key of ["clearPartialOne", "clearPartialMany"]) keys.add(key);
    // Libellés de fréquence construits à partir de la liste des fréquences.
    for (const minutes of FREQUENCY_MINUTES) keys.add(`freq${minutes}`);
    // Clés lues avec un texte par défaut (searchTab) : elles doivent quand même exister en français.
    for (const key of NEW_KEYS) keys.add(key);
    const missing = [...keys].filter((k) => typeof fr[k] !== "string");
    expect(missing).toEqual([]);
  });

  it("les textes des notifications d'erreur (toasts) sont du texte brut : ni <, ni > ni &, SiYuan les insérant comme HTML", () => {
    for (const key of ["highlightUnavailable", "floatingOpenFailed", "openTabFailed", "transferTabFailed"]) {
      expect(fr[key], key).toBeTypeOf("string");
      expect(fr[key]!.length, key).toBeGreaterThan(0);
      expect(fr[key], key).not.toMatch(/[<>&]/);
    }
  });

  it("n'a plus de clé de l'ancienne section Avancé et pas d'usage de « fichier(s) »", () => {
    expect(fr).not.toHaveProperty("advanced");
    expect(Object.values(fr).join("\n")).not.toMatch(/\(s\)/);
    expect(fr.diagnostic).toBe("Diagnostic technique");
  });

  it("ne code pas le nombre d'entrées du journal dans le texte", () => {
    expect(fr.warnLogDesc).not.toMatch(/\d/);
  });

  it("les titres et descriptions du panneau ne contiennent pas de balise ni d'entité (SiYuan les insère comme HTML)", () => {
    for (const key of ["openMode", "autoIndex", "autoIndexInterval", "reindex", "clearIndex", "diagnostic", "warnLog"]) {
      for (const k of [key, `${key}Desc`]) expect(fr[k], k).not.toMatch(/[<>&]/);
    }
  });

  it("les libellés de fréquence et les textes d'indexation automatique sont sans balise ni entité", () => {
    const keys = [...FREQUENCY_MINUTES.map((m) => `freq${m}`), ...NEW_KEYS];
    for (const k of keys) expect(fr[k], k).not.toMatch(/[<>&]/);
  });

  it("a retiré les clés mortes (pause/reprise, fréquence d'une minute, anciens libellés d'indicateur)", () => {
    for (const key of ["pause", "resume", "indexingPaused", "freq1", "autoIndexRunningShort"]) expect(fr).not.toHaveProperty(key);
  });

  it("a retiré les clés de l'ancienne barre (select de tri, case sous-dossiers, liste d'historique maison)", () => {
    for (const key of ["filterFolder", "filterSubfolders", "sortBy", "historyLabel", "historyShow"]) expect(fr).not.toHaveProperty(key);
  });

  it("le bouton de diagnostic a son propre libellé, distinct du titre de l'item", () => {
    expect(fr.diagnosticRun).toBe("Lancer le diagnostic");
    expect(fr.diagnosticRun).not.toBe(fr.diagnostic);
    expect(fr.diagnosticRun).not.toMatch(/[<>&]/);
  });

  it("les fréquences proposées ont chacune un libellé", () => {
    expect(FREQUENCY_MINUTES).toEqual([5, 15, 60]);
    for (const m of FREQUENCY_MINUTES) expect(fr[`freq${m}`], `freq${m}`).toBeTypeOf("string");
  });

  it("les descriptions disent « ou modifiés », la limite de 30 secondes, l'attente de la saisie et la reconstruction automatique", () => {
    expect(fr.autoIndexDesc).toMatch(/modifiés/);
    expect(fr.autoIndexIntervalDesc).toMatch(/30 secondes/);
    expect(fr.autoIndexIntervalDesc).toMatch(/taper/);
    expect(fr.clearConfirmText).toMatch(/indexation automatique/);
    expect(fr.clearIndexDesc).toMatch(/indexation automatique/);
  });

  it("les textes de l'indicateur ont leurs variables et les pluriels par clés One/Many", () => {
    expect(fr.autoIndexCount).toBe("{done}/{total} PDF");
    expect(fr.autoIndexRunning).toBe("Indexation en cours");
    expect(fr.autoIndexMigrating).toBe("Mise à jour de l'index");
    expect(fr.autoIndexFailed).toContain("{n}");
    expect(fr.autoIndexPartialOne).toContain("{n}");
    expect(fr.autoIndexPartialMany).toContain("{n}");
    expect(fr.autoIndexPartialMany).toContain("n'ont pas pu être lus");
    expect(fr.settingsSaveFailed).toBe("Réglage appliqué mais non enregistré : il sera perdu au redémarrage.");
  });

  it("annonce les nouveaux états d'indexation, avec les variables attendues", () => {
    expect(fr.autoIndexCount).toContain("{done}");
    expect(fr.autoIndexCount).toContain("{total}");
    expect(fr.autoIndexFailed).toContain("{n}");
    expect(fr.clearDoneRebuilding).toBe("Index vidé. Reconstruction en cours…");
    expect(fr.clearDone).toBe("Index vidé. Lancez Réindexer pour le reconstruire.");
  });

  it("les textes des filtres sont en français, sans balise ni entité, avec les variables attendues", () => {
    expect(fr.filtersLabel).toBe("Filtres");
    expect(fr.filtersActiveOne).toBe("Filtres (1 actif)");
    expect(fr.filtersActiveMany).toBe("Filtres ({n} actifs)");
    expect(fr.filterError).toBe("Erreur : ");
    expect(fr.hiddenByFiltersOne).toBe("1 document masqué par les filtres");
    expect(fr.hiddenByFiltersMany).toBe("{n} documents masqués par les filtres");
    expect(fr.noResultFiltersMany).toContain("{n}");
    expect(fr.noResultFiltersOne).not.toContain("{n}");
  });

  it.each(["filtersActiveMany", "hiddenByFiltersMany", "noResultFiltersMany"])("%s contient {n} exactement une fois", (key) => {
    expect(String(fr[key]).match(/\{n\}/g)).toHaveLength(1);
  });

  it.each(["filtersActiveOne", "hiddenByFiltersOne", "noResultFiltersOne"])("%s ne contient pas {n}", (key) => {
    expect(String(fr[key])).not.toContain("{n}");
  });

  it("DEFAULT_STRINGS de la vue et fr_FR.json disent la même chose pour les clés de filtres", async () => {
    const { DEFAULT_STRINGS } = await import("../../src/ui/searchView");
    for (const key of NEW_KEYS.filter((k) => k.startsWith("filter") || k.startsWith("hiddenBy") || k.startsWith("noResultFilters"))) {
      expect(DEFAULT_STRINGS[key], key).toBe(fr[key]);
    }
  });

  it.each(["historyClear", "historyEmpty", "historyIcon"])("%s : valeur non vide, identique dans la vue et fr_FR.json", async (key) => {
    const { DEFAULT_STRINGS } = await import("../../src/ui/searchView");
    expect(fr[key]?.trim()).toBeTruthy();
    expect(DEFAULT_STRINGS[key]?.trim()).toBeTruthy();
    expect(DEFAULT_STRINGS[key]).toBe(fr[key]);
  });

  it("libellés du tri et du regroupement : ceux de la recherche native de SiYuan quand ils existent", () => {
    expect(fr.sortRelevanceDesc).toBe("Pertinence");
    expect(fr.sortRelevanceAsc).toBe("ASC de pertinence");
    expect(fr.sortModifiedAsc).toBe("Modifier le temps croissant");
    expect(fr.sortModifiedDesc).toBe("Modifier le temps décroissant");
    expect(fr.sortNameAsc).toBe("Nom croissant");
    expect(fr.sortNameDesc).toBe("Nom décroissant");
    expect(fr.sortPathAsc).toBe("Chemin croissant");
    expect(fr.sortMatchesDesc).toBe("Pages correspondantes décroissant");
    expect(fr.groupByDocument).toBe("Regrouper par document");
    expect(fr.expandAll).toBe("Élargir");
    expect(fr.collapseAll).toBe("Réduire");
    expect(fr.rankingRefinedPages).toBe("Pages classées par proximité et taille de police");
  });

  it("DEFAULT_STRINGS de la vue et fr_FR.json coïncident pour TOUTES les clés qu'ils partagent, et chaque clé de la vue existe en français", async () => {
    const { DEFAULT_STRINGS } = await import("../../src/ui/searchView");
    const missing = Object.keys(DEFAULT_STRINGS).filter((k) => typeof fr[k] !== "string");
    expect(missing).toEqual([]);
    const different = Object.keys(DEFAULT_STRINGS).filter((k) => DEFAULT_STRINGS[k] !== fr[k]);
    expect(different).toEqual([]);
  });

  it("chaque clé de tri proposée par le sélecteur a un libellé français sans < > &", async () => {
    const { SORT_CHOICES } = await import("../../src/search/resultOptions");
    for (const c of SORT_CHOICES) expect(fr[c.labelKey], c.labelKey).toMatch(/^[^<>&]+$/);
  });

  it("liste plate et échec d'écriture : textes français, variables attendues, identiques aux textes par défaut de la vue", async () => {
    expect(fr.flatMoreOne).toBe("Afficher plus ({n} page restante)");
    expect(fr.flatMoreMany).toBe("Afficher plus ({n} pages restantes)");
    expect(String(fr.flatMoreMany).match(/\{n\}/g)).toHaveLength(1);
    expect(String(fr.flatMoreOne)).toContain("{n}");
    expect(fr.settingNotSaved).toBe("Réglage non enregistré");
    const { DEFAULT_STRINGS } = await import("../../src/ui/searchView");
    expect(DEFAULT_STRINGS["flatMoreOne"]).toBe(fr.flatMoreOne);
    expect(DEFAULT_STRINGS["flatMoreMany"]).toBe(fr.flatMoreMany);
  });

  it("libellés de la barre d'icônes : ceux de la recherche native de SiYuan 3.8.9 (français)", () => {
    expect(fr.pathSpecify).toBe("Spécifier le chemin");
    expect(fr.includeChildren).toBe("Inclure les documents enfants");
    expect(fr.moreMenu).toBe("Plus");
    expect(fr.sortMenu).toBe("Tri");
    expect(fr.groupMenu).toBe("Groupe");
    expect(fr.groupNone).toBe("Aucun regroupement");
    expect(fr.filtersLabel).toBe("Filtres");
    expect(fr.removePath).toBe("Supprimer");
    expect(fr.clearField).toBe("Effacer");
    expect(fr.dialogCancel).toBe("Annuler");
    expect(fr.dialogConfirm).toBe("Confirmer");
    expect(fr.historyEmpty).toBe("Historique vide");
    expect(fr.historyIcon).toBe("⌥↓");
    expect(fr.historyClear).toBe("Supprimer tout l'historique");
  });

  it("aucun libellé de la barre, du menu ni du dialogue ne contient < > & (SiYuan les insère comme HTML)", () => {
    const keys = [
      "pathSpecify", "includeChildren", "moreMenu", "sortMenu", "groupMenu", "groupNone", "removePath", "clearField",
      "dialogCancel", "dialogConfirm", "historyEmpty", "historyIcon", "historyClear", "filtersLabel", "filtersActiveOne",
      "filtersActiveMany", "groupByDocument", "expandAll", "collapseAll",
      ...(["Desc", "Asc"].flatMap((d) => ["Relevance", "Modified", "Name"].map((k) => `sort${k}${d}`))),
    ];
    for (const key of keys.filter((k) => typeof fr[k] === "string")) expect(fr[key], key).not.toMatch(/[<>&]/);
  });

  it("chaque clé de la barre existe dans fr_FR.json ET dans les chaînes par défaut de la vue, avec le même texte", async () => {
    const { DEFAULT_STRINGS } = await import("../../src/ui/searchView");
    const keys = ["pathSpecify", "includeChildren", "moreMenu", "sortMenu", "groupMenu", "groupNone", "removePath", "clearField", "dialogCancel", "dialogConfirm", "historyEmpty", "historyIcon"];
    for (const key of keys) {
      expect(fr[key], key).toBeTypeOf("string");
      expect(DEFAULT_STRINGS[key], key).toBe(fr[key]);
    }
  });

  it("les clés RETIRÉES de l'ancienne barre ne sont plus référencées dans src (aucune référence morte)", () => {
    const sources = ["src/ui/searchView.ts", "src/ui/searchToolbar.ts", "src/search/resultOptions.ts", "src/searchTab.ts"].map(read).join("\n");
    const dead = ["filterFolder", "filterSubfolders", "sortBy", "historyLabel", "historyShow"].filter((k) => new RegExp(`\\b${k}\\b`).test(sources));
    expect(dead).toEqual([]);
  });

  it("balayage : chaque clé des chaînes par défaut de la vue est UTILISÉE dans src (entre guillemets : t(), tr(), labelKey...)", async () => {
    const { DEFAULT_STRINGS } = await import("../../src/ui/searchView");
    const sources = collectSources("src").join("\n");
    // La définition de DEFAULT_STRINGS écrit les clés sans guillemets : seule une vraie utilisation les entoure.
    const unused = Object.keys(DEFAULT_STRINGS).filter((k) => !new RegExp(`["'\`]${k}["'\`]`).test(sources));
    expect(unused).toEqual([]);
  });
});

describe("libellés de la fenêtre flottante (J10 10d)", () => {
  it("libellés exacts demandés, ceux de la recherche native pour « Ouvrir dans un nouvel onglet »", () => {
    expect(fr.floatingTitle).toBe("Recherche dans les PDF");
    expect(fr.openInNewTab).toBe("Ouvrir dans un nouvel onglet");
    expect(fr.openMode).toBe("Ouverture de la recherche");
    expect(fr.openModeTab).toBe("Onglet");
    expect(fr.openModeDialog).toBe("Fenêtre flottante");
    expect(fr.commandOpenSearchFloating).toBe("Rechercher dans les PDF (fenêtre flottante)");
    expect(fr.commandOpenSearchTab).toBe("Rechercher dans les PDF (onglet)");
  });

  it("la description du réglage est non vide et sans < > &", () => {
    expect(fr.openModeDesc?.trim()).toBeTruthy();
    expect(fr.openModeDesc).not.toMatch(/[<>&]/);
  });

  it("aucune des clés de cette étape ne contient < > & (le titre et les libellés passent par innerHTML dans SiYuan)", () => {
    const keys = ["floatingTitle", "openInNewTab", "openMode", "openModeDesc", "openModeTab", "openModeDialog", "commandOpenSearchFloating", "commandOpenSearchTab"];
    for (const k of keys) expect(fr[k], k).toMatch(/^[^<>&]+$/);
  });

  it("DEFAULT_STRINGS de la vue dit la même chose que fr_FR.json pour « Ouvrir dans un nouvel onglet »", async () => {
    const { DEFAULT_STRINGS } = await import("../../src/ui/searchView");
    expect(DEFAULT_STRINGS["openInNewTab"]).toBe(fr.openInNewTab);
  });
});

describe("portée de documents SiYuan : textes", () => {
  const SCOPE_KEYS = [
    "docFilterNoPdf", "scopeLoading", "scopeNotReady", "scopeTooLarge",
    "scopeFailed", "scopeRefreshFailed", "scopeInvalid", "kernelUnavailable",
  ];

  it.each(SCOPE_KEYS)("%s : non vide, identique dans la vue et fr_FR.json, sans balise", async (key) => {
    const { DEFAULT_STRINGS } = await import("../../src/ui/searchView");
    expect(fr[key]?.trim()).toBeTruthy();
    expect(DEFAULT_STRINGS[key]).toBe(fr[key]);
    expect(fr[key]).not.toMatch(/[<>]/);
  });

  it("textes exacts demandés", () => {
    expect(fr.docFilterNoPdf).toBe("Les PDF qu'aucun document ne cite sont exclus.");
    expect(fr.scopeLoading).toBe("Chargement du chemin…");
  });
});

describe("critères enregistrés : textes", () => {
  const EXPECTED: Record<string, string> = {
    criteriaSave: "Enregistrer les critères",
    criteriaReset: "Réinitialiser les critères",
    criteriaResetHint: "Les conditions de requête actuelles ne seront plus utilisées pour la prochaine requête",
    criteriaMemo: "Remarques",
    criteriaErrEmpty: "L'entrée ne peut pas être vide",
    criteriaOverwrite: "Le nom de la requête est dupliqué, voulez-vous l'écraser ?",
    criteriaMerge: "Voulez-vous supprimer {x} et affecter sa condition de requête à {y} ?",
    criteriaRename: "Mettre à jour le nom {x} en {y} ?",
    criteriaErrTooLong: "Le nom ne peut pas dépasser 80 caractères.",
    criteriaErrQuery: "La requête ne peut pas dépasser 200 caractères.",
    criteriaErrLimit: "Vous avez déjà 30 critères. Supprimez-en un pour enregistrer celui-ci.",
    criteriaSaveFailed: "Impossible d'enregistrer les critères (voir le journal dans les paramètres)",
    criteriaDeleteFailed: "Impossible de supprimer le critère (voir le journal dans les paramètres)",
    criteriaResetFailed: "Impossible de réinitialiser la recherche (voir le journal dans les paramètres)",
    criteriaLoadFailed: "Critères illisibles : ils sont ignorés (voir le journal dans les paramètres)",
    criteriaMissingPath: "Le chemin « {x} » de ce critère n'existe plus. Il a été retiré de la recherche.",
    criteriaAlreadyDeleted: "Ce critère était déjà supprimé.",
    criteriaRecallFailed: "Impossible d'appliquer ce critère (voir le journal dans les paramètres)",
  };

  it("a retiré les clés de l'ancien bouton signet, de son menu et de l'ancien dialogue (nom, résumé, mode Remplacer)", () => {
    const dead = [
      "criteriaMenu", "criteriaApplied", "criteriaSaveTitle", "criteriaName", "criteriaSaveConfirm", "criteriaReplaceConfirm",
      "criteriaReplaceAsk", "criteriaSummary", "criteriaDelete", "criteriaEmpty", "criteriaSaved", "criteriaReplaced",
      "criteriaDeleted", "criteriaErrNothing",
    ];
    for (const key of dead) {
      expect(fr, key).not.toHaveProperty(key);
      expect(DEFAULT_STRINGS, key).not.toHaveProperty(key);
    }
  });

  it.each(Object.entries(EXPECTED))("%s : texte exact, identique dans la vue et fr_FR.json", async (key, text) => {
    const { DEFAULT_STRINGS } = await import("../../src/ui/searchView");
    expect(fr[key]).toBe(text);
    expect(DEFAULT_STRINGS[key]).toBe(text);
  });

  it("les messages affichés en toast ou en infobulle sont du texte brut (ni <, ni >, ni &)", () => {
    for (const key of Object.keys(EXPECTED)) expect(fr[key], key).not.toMatch(/[<>&]/);
  });

  it("les variables attendues sont présentes exactement une fois", () => {
    for (const [key, variable] of [["criteriaMerge", "x"], ["criteriaMerge", "y"], ["criteriaRename", "x"], ["criteriaRename", "y"]] as const) {
      expect(String(fr[key]).match(new RegExp(`\\{${variable}\\}`, "g")), `${key} ${variable}`).toHaveLength(1);
    }
  });

  it("le dialogue « Spécifier le chemin » a les textes du dialogue natif, identiques en français et dans les textes par défaut", () => {
    const expected: Record<string, string> = {
      pathSpecify: "Spécifier le chemin",
      pathSearchPlaceholder: "Recherche...",
      pathNoResult: "Aucun contenu connexe trouvé",
      dialogCancel: "Annuler",
      dialogConfirm: "Confirmer",
      includeChildren: "Inclure les documents enfants",
      pathDialogError: "Impossible de lire les documents (voir le journal dans les paramètres).",
    };
    for (const [key, text] of Object.entries(expected)) {
      expect(fr[key], key).toBe(text);
      expect(DEFAULT_STRINGS[key], key).toBe(text);
    }
    expect(fr.pathDialogTooMany).toContain("{n}");
    expect(DEFAULT_STRINGS["pathDialogTooMany"]).toBe(fr.pathDialogTooMany);
  });

  it("a retiré les clés de l'ancien menu du chemin et de l'arbre SQL (dossiers de fichiers, chargement, réessai...)", () => {
    const dead = [
      "filterAllFolders", "foldersMoreOne", "foldersMoreMany", "pathSectionFolders", "pathSectionDocs", "docsLoading",
      "docsNotReady", "docsRetry", "docsTooLarge", "docsFailed", "docsNone", "docsMoreOne", "docsMoreMany",
    ];
    for (const key of dead) {
      expect(fr, key).not.toHaveProperty(key);
      expect(DEFAULT_STRINGS, key).not.toHaveProperty(key);
    }
  });

  it("les messages d'erreur du dialogue du chemin sont du texte brut (aucune balise ni entité)", () => {
    for (const key of ["pathDialogError", "pathDialogTooMany", "pathNoResult", "pathSearchPlaceholder"]) expect(fr[key], key).not.toMatch(/[<>&]/);
  });
});
