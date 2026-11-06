/**
 * Vue de l'onglet de recherche : DOM natif, aucun innerHTML (le texte issu
 * des PDF/titres passe uniquement par textContent / setAttribute).
 */
import type { IndexActivitySnapshot } from "../indexer/indexActivity";
import type { ResultDoc, SearchViewModel } from "../search/searchController";
import { countActiveFilters, type SearchOptions } from "../search/resultOptions";
import { containingFolder } from "./pathLabel";
import { ensureSearchStyle } from "./searchStyles";
import { mountSearchToolbar, type SearchToolbar } from "./searchToolbar";
import { nextUiId } from "./uniqueId";

export interface ThumbnailRequest {
  readonly docId: string;
  readonly path: string;
  readonly page: number;
  readonly query: string;
  readonly pdfSize: number;
  readonly pdfModifiedMs: number;
}

export interface ThumbnailAttacher {
  attach(el: HTMLElement, req: ThumbnailRequest): () => void;
}

export interface SearchViewDeps {
  readonly controller: { submit(q: string): void; getViewModel(): SearchViewModel };
  readonly subscribe: (listener: () => void) => () => void;
  readonly thumbnails: ThumbnailAttacher;
  onOpen(docId: string, page: number, query: string): void;
  /** Ouvre le panneau de paramètres du plugin (où se lance l'indexation). */
  onOpenSettings?(): void;
  getDocMeta(docId: string): { pdfSize: number; pdfModifiedMs: number } | undefined;
  readonly t?: (key: string) => string;
  /** Activité d'indexation (indicateur discret sous le champ de recherche, avis « des résultats peuvent manquer »). */
  readonly indexActivity?: {
    getSnapshot(): IndexActivitySnapshot;
    subscribe(listener: () => void): () => void;
  };
  readonly schedule?: (fn: () => void, ms: number) => unknown;
  readonly clear?: (handle: unknown) => void;
  /** Filtres de résultats : absents, la vue n'affiche pas la barre de filtres. */
  readonly options?: {
    getOptions(): SearchOptions;
    setOptions(next: SearchOptions): void;
    getFolders(): readonly string[];
  };
  /** Regroupement par document au montage (défaut : oui). État de VUE : changer de mode ne relance aucune recherche. */
  readonly initialGroupByDocument?: boolean;
  /** Appelé à chaque changement de la case « Regrouper par document » (pour le mémoriser). */
  readonly onGroupByDocumentChange?: (groupByDocument: boolean) => void;
}

export interface SearchView {
  dispose(): void;
  focusInput(): void;
  /** Change le regroupement sans notifier `onGroupByDocumentChange` (réglage mémorisé lu après le montage). */
  setGroupByDocument(groupByDocument: boolean): void;
  /** Resynchronise la barre d'outils (tri, filtres) avec les options courantes, sans attendre un rendu de résultats. */
  refreshOptions(): void;
}

export const MAX_CARDS_PER_DOC = 5;
/** Durée d'affichage de « Index à jour » après une passe qui a travaillé. */
export const UP_TO_DATE_VISIBLE_MS = 8000;
/** Nombre de cartes ajoutées à chaque clic sur « et N autres pages ». */
export const EXPAND_BATCH = 10;
/** Liste plate : nombre de cartes affichées au départ, et ajoutées à chaque clic sur « Afficher plus ». */
export const FLAT_PAGE_SIZE = 60;

interface DocEntry {
  li: HTMLLIElement;
  signature: string;
  /** Un détacheur par carte affichée, dans l'ordre des cartes. */
  detachers: (() => void)[];
  /** Pages encore dépliables / pages dépliées au-delà du minimum (« Élargir » / « Réduire » globaux). */
  canExpand(): boolean;
  canCollapse(): boolean;
  expandAll(): void;
  collapseAll(): void;
}

/** Chaînes par défaut (français) : `deps.t` les remplace quand une clé i18n existe. */
export const DEFAULT_STRINGS: Readonly<Record<string, string>> = {
  searchLabel: "Rechercher dans les PDF",
  searchPlaceholder: "Rechercher dans vos PDF (Entrée pour lancer)",
  resultsList: "Résultats de la recherche",
  emptyQuery: "Saisissez des mots puis appuyez sur Entrée",
  loadingPartial: "Résultats partiels, index en cours de construction ({loaded}/{total})",
  partialSuffix: " (résultats partiels, index en cours de construction)",
  noResults: "Aucun résultat",
  error: "Erreur : {message}",
  indexing: "Index en cours de construction",
  noIndex: "Aucun index : ouvrez les paramètres du plugin pour lancer l'indexation",
  openSettings: "Ouvrir les paramètres",
  docOne: "{n} document",
  docMany: "{n} documents",
  pageOne: "{n} page",
  pageMany: "{n} pages",
  moreOne: "et {n} autre page",
  moreMany: "et {n} autres pages",
  showLess: "Replier",
  truncated: "{n} pages non affichées",
  flatMoreOne: "Afficher plus ({n} page restante)",
  flatMoreMany: "Afficher plus ({n} pages restantes)",
  shownStatus: "{n} pages affichées pour {title}",
  failedOne: "{n} index illisible : réindexez depuis les paramètres (détails dans le journal)",
  failedMany: "{n} index illisibles : réindexez depuis les paramètres (détails dans le journal)",
  cardLabel: "{title}, p. {page}",
  cardPage: "p. {page}",
  rankingRefined: "Classement affiné par proximité des mots et taille de police",
  autoIndexRunning: "Indexation en cours",
  autoIndexMigrating: "Mise à jour de l'index",
  autoIndexCount: "{done}/{total} PDF",
  autoIndexUpToDate: "Index à jour",
  autoIndexFailed: "{n} PDF en échec : voir le journal dans les paramètres",
  autoIndexDiscoveryFailed: "La découverte des PDF a échoué : voir le journal dans les paramètres",
  autoIndexPartialOne: "Index à jour, mais {n} élément n'a pas pu être lu : voir le journal des paramètres",
  autoIndexPartialMany: "Index à jour, mais {n} éléments n'ont pas pu être lus : voir le journal des paramètres",
  indexingMayMiss: "Indexation en cours : des résultats peuvent manquer",
  filtersLabel: "Filtres",
  filtersActiveOne: "Filtres (1 actif)",
  filtersActiveMany: "Filtres ({n} actifs)",
  filterFolder: "Dossier",
  filterAllFolders: "Tous les dossiers",
  filterSubfolders: "Inclure les sous-dossiers",
  filterName: "Nom du document contient",
  filterMinPages: "Pages au moins",
  filterMaxPages: "Pages au plus",
  filterModifiedAfter: "Modifié après",
  filterReset: "Réinitialiser les filtres",
  filterError: "Erreur : ",
  filterErrMinMax: "Pages au moins ne peut pas dépasser Pages au plus.",
  filterErrInteger: "Saisissez un nombre entier supérieur ou égal à 1.",
  filterErrDate: "Saisissez une date valide.",
  hiddenByFiltersOne: "1 document masqué par les filtres",
  hiddenByFiltersMany: "{n} documents masqués par les filtres",
  noResultFiltersOne: "Aucun résultat avec 1 filtre actif.",
  noResultFiltersMany: "Aucun résultat avec {n} filtres actifs.",
  sortBy: "Trier par",
  sortRelevanceDesc: "Pertinence",
  sortRelevanceAsc: "ASC de pertinence",
  sortModifiedAsc: "Modifier le temps croissant",
  sortModifiedDesc: "Modifier le temps décroissant",
  sortNameAsc: "Nom croissant",
  sortNameDesc: "Nom décroissant",
  sortPathAsc: "Chemin croissant",
  sortMatchesDesc: "Pages correspondantes décroissant",
  groupByDocument: "Regrouper par document",
  expandAll: "Élargir",
  collapseAll: "Réduire",
  rankingRefinedPages: "Pages classées par proximité et taille de police",
};

const fmt = (template: string, vars: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));

export function mountSearchView(host: HTMLElement, deps: SearchViewDeps): SearchView {
  const doc = host.ownerDocument;
  const tr = (key: string, vars: Readonly<Record<string, string | number>> = {}): string => {
    const custom = deps.t?.(key);
    const text = custom && custom !== key ? custom : (DEFAULT_STRINGS[key] ?? key);
    return fmt(text, vars);
  };
  const count = (n: number, one: string, many: string): string => tr(n === 1 ? one : many, { n });
  ensureSearchStyle(doc);

  const root = doc.createElement("div");
  root.className = "docseeker-search";
  root.lang = "fr";
  root.setAttribute("role", "search");

  const input = doc.createElement("input");
  input.type = "search";
  input.className = "b3-text-field fn__block";
  input.placeholder = tr("searchPlaceholder");
  input.setAttribute("aria-label", tr("searchLabel"));
  input.setAttribute("enterkeyhint", "search");

  // Deux régions live présentes dès le montage (sinon certains lecteurs d'écran n'annoncent rien).
  const statusEl = doc.createElement("div");
  statusEl.className = "docseeker-status";
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  statusEl.setAttribute("aria-atomic", "true");
  const alertEl = doc.createElement("div");
  alertEl.className = "docseeker-alert";
  alertEl.setAttribute("role", "alert");

  // Le bouton est hors des régions live : il n'est pas relu à chaque changement d'état.
  const actions = doc.createElement("div");
  actions.className = "docseeker-actions";
  let settingsButton: HTMLButtonElement | undefined;
  if (deps.onOpenSettings) {
    settingsButton = doc.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "b3-button b3-button--outline docseeker-open-settings";
    settingsButton.textContent = tr("openSettings");
    settingsButton.hidden = true;
    actions.hidden = true;
    settingsButton.addEventListener("click", () => deps.onOpenSettings?.());
    actions.appendChild(settingsButton);
  }

  // Bouton de réinitialisation à côté du statut quand les filtres masquent tous les résultats.
  let resetButton: HTMLButtonElement | undefined;
  if (deps.options) {
    resetButton = doc.createElement("button");
    resetButton.type = "button";
    resetButton.className = "b3-button b3-button--outline docseeker-reset-filters";
    resetButton.textContent = tr("filterReset");
    resetButton.hidden = true;
    actions.appendChild(resetButton);
  }

  const list = doc.createElement("ul");
  list.className = "docseeker-list";
  list.setAttribute("aria-label", tr("resultsList"));

  // Indicateur d'indexation, juste sous le champ : la région live (texte fixe) est stable dans l'arbre, vidée par son
  // contenu ; la fraction N/M est un nœud visuel aria-hidden hors de la région ; le bouton aussi.
  let activityRow: HTMLElement | undefined;
  if (deps.indexActivity) {
    activityRow = doc.createElement("div");
    activityRow.className = "docseeker-index-row";
  }

  let toolbarEl: HTMLElement | undefined;
  if (deps.options) {
    toolbarEl = doc.createElement("div");
    toolbarEl.className = "docseeker-toolbar";
  }

  // Pied de la liste plate : « Afficher plus » et note de troncature (aucune région live ajoutée).
  const flatFooter = doc.createElement("div");
  flatFooter.className = "docseeker-flat-footer";
  flatFooter.hidden = true;
  const flatMore = doc.createElement("button");
  flatMore.type = "button";
  flatMore.className = "docseeker-flat-more b3-button b3-button--outline";
  flatMore.hidden = true;
  const flatNote = doc.createElement("span");
  flatNote.className = "docseeker-truncated";
  flatNote.hidden = true;
  flatFooter.append(flatMore, flatNote);

  root.append(input, ...(toolbarEl ? [toolbarEl] : []), ...(activityRow ? [activityRow] : []), statusEl, alertEl, actions, list, flatFooter);
  host.appendChild(root);
  const opts = deps.options;
  // Fonctions liées explicitement : pas de spread de méthodes (qui perdrait `this` d'un objet à classe).
  const toolbar: SearchToolbar | undefined =
    opts && toolbarEl
      ? mountSearchToolbar(toolbarEl, {
          getOptions: () => opts.getOptions(),
          setOptions: (next) => opts.setOptions(next),
          getFolders: () => opts.getFolders(),
          t: (key, vars) => tr(key, vars),
        })
      : undefined;

  const entries = new Map<string, DocEntry>();
  /** Mode liste plate : une entrée par page, clé « docId|page ». Vide en mode regroupé. */
  const flatEntries = new Map<string, DocEntry>();
  let groupByDocument = deps.initialGroupByDocument ?? true;
  let disposed = false;

  // Commandes de regroupement (état de vue), dans la barre d'outils : sélecteur de tri, regroupement, Élargir, Réduire,
  // puis le panneau Filtres (ordre du DOM = ordre de tabulation).
  let groupBox: HTMLInputElement | undefined;
  let expandBtn: HTMLButtonElement | undefined;
  let collapseBtn: HTMLButtonElement | undefined;
  if (toolbarEl) {
    const wrap = doc.createElement("div");
    wrap.className = "docseeker-view-options";
    const label = doc.createElement("label");
    label.className = "docseeker-group";
    groupBox = doc.createElement("input");
    groupBox.type = "checkbox";
    groupBox.id = nextUiId("docseeker-group");
    groupBox.checked = groupByDocument;
    label.htmlFor = groupBox.id;
    label.append(groupBox, tr("groupByDocument"));
    const makeBtn = (cls: string, key: string): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = `b3-button b3-button--outline ${cls}`;
      b.textContent = tr(key);
      b.setAttribute("aria-disabled", "true");
      return b;
    };
    expandBtn = makeBtn("docseeker-expand-all", "expandAll");
    collapseBtn = makeBtn("docseeker-collapse-all", "collapseAll");
    wrap.append(label, expandBtn, collapseBtn);
    const filters = Array.from(toolbarEl.children).find((c) => c.tagName === "DETAILS");
    toolbarEl.insertBefore(wrap, filters ?? null);
  }

  /** « Élargir » / « Réduire » : désactivés (aria-disabled, focus conservé) quand l'état demandé est déjà atteint. */
  const refreshExpansionButtons = (): void => {
    if (!expandBtn || !collapseBtn) return;
    const all = [...entries.values()];
    expandBtn.setAttribute("aria-disabled", String(!all.some((e) => e.canExpand())));
    collapseBtn.setAttribute("aria-disabled", String(!all.some((e) => e.canCollapse())));
  };
  const applyGroupChrome = (): void => {
    list.classList.toggle("docseeker-list--flat", !groupByDocument);
    if (expandBtn) expandBtn.hidden = !groupByDocument;
    if (collapseBtn) collapseBtn.hidden = !groupByDocument;
  };
  applyGroupChrome();
  // Nombre de cartes affichées par document déplié ; valable pour une seule requête.
  const expanded = new Map<string, number>();
  let expandedQuery: string | undefined;

  const allCards = (): HTMLButtonElement[] =>
    Array.from(list.querySelectorAll<HTMLButtonElement>("button.docseeker-card"));

  const focusCard = (card: HTMLButtonElement): void => {
    for (const c of allCards()) c.tabIndex = c === card ? 0 : -1;
    card.focus();
  };

  /** Garantit une seule carte tabbable (roving tabindex) après ajout ou retrait de cartes. */
  const ensureTabStop = (): void => {
    const cards = allCards();
    if (cards.length === 0 || cards.some((c) => c.tabIndex === 0)) return;
    cards[0]!.tabIndex = 0;
  };

  const setText = (el: HTMLElement, text: string): void => {
    if (el.textContent !== text) el.textContent = text;
  };

  const setStatus = (text: string, opts: { error?: boolean; settings?: boolean; reset?: boolean } = {}): void => {
    if (opts.error) {
      setText(statusEl, "");
      setText(alertEl, text);
    } else {
      setText(statusEl, text);
      setText(alertEl, "");
    }
    if (settingsButton) {
      const show = opts.settings === true;
      if (!show && !settingsButton.hidden && doc.activeElement === settingsButton) input.focus();
      settingsButton.hidden = !show;
    }
    if (resetButton) {
      const show = opts.reset === true;
      if (!show && !resetButton.hidden && doc.activeElement === resetButton) input.focus();
      resetButton.hidden = !show;
    }
    if (settingsButton || resetButton) actions.hidden = (settingsButton?.hidden ?? true) && (resetButton?.hidden ?? true);
  };

  const dropEntry = (entry: DocEntry): void => {
    for (const d of entry.detachers) d();
    entry.detachers = [];
    entry.li.remove();
  };

  const dropAll = (map: Map<string, DocEntry>): void => {
    for (const entry of map.values()) dropEntry(entry);
    map.clear();
  };

  const hideFlatFooter = (): void => {
    flatMore.hidden = true;
    flatNote.hidden = true;
    flatFooter.hidden = true;
  };

  const clearList = (): void => {
    dropAll(entries);
    dropAll(flatEntries);
    hideFlatFooter();
  };

  const thumbnailRequest = (result: ResultDoc, page: number, query: string): ThumbnailRequest => {
    const meta = deps.getDocMeta(result.docId);
    return {
      docId: result.docId,
      path: result.path,
      page,
      query,
      pdfSize: meta?.pdfSize ?? 0,
      pdfModifiedMs: meta?.pdfModifiedMs ?? 0,
    };
  };

  /** Une carte seule (liste plate) : vignette, titre du document et page. */
  const buildFlat = (result: ResultDoc, page: number, query: string, signature: string): DocEntry => {
    const li = doc.createElement("li");
    li.className = "docseeker-flat-item";
    const card = doc.createElement("button");
    card.type = "button";
    card.className = "docseeker-card docseeker-card--flat";
    card.tabIndex = -1;
    card.dataset["docId"] = result.docId;
    card.dataset["page"] = String(page);
    card.setAttribute("aria-label", tr("cardLabel", { title: result.title, page }));
    const frame = doc.createElement("span");
    frame.className = "docseeker-thumb";
    const name = doc.createElement("span");
    name.className = "docseeker-card-title";
    name.textContent = result.title;
    const label = doc.createElement("span");
    label.className = "docseeker-card-page";
    label.textContent = tr("cardPage", { page });
    card.append(frame, name, label);
    li.appendChild(card);
    return {
      li,
      signature,
      detachers: [deps.thumbnails.attach(frame, thumbnailRequest(result, page, query))],
      canExpand: () => false,
      canCollapse: () => false,
      expandAll: () => undefined,
      collapseAll: () => undefined,
    };
  };

  const buildDoc = (result: ResultDoc, query: string, signature: string): DocEntry => {
    const li = doc.createElement("li");
    li.className = "docseeker-doc";
    const title = doc.createElement("h3");
    title.className = "docseeker-doc-heading";
    const name = doc.createElement("span");
    name.className = "docseeker-doc-title";
    name.textContent = result.title;
    const counter = doc.createElement("span");
    counter.className = "docseeker-doc-count";
    counter.textContent = `— ${count(result.matchingPages, "pageOne", "pageMany")}`;
    title.append(name, " ", counter);
    const path = doc.createElement("div");
    path.className = "docseeker-doc-path";
    const folder = containingFolder(result.path);
    const pathText = doc.createElement("span");
    pathText.className = "docseeker-doc-path-text";
    pathText.textContent = folder;
    path.appendChild(pathText);
    path.hidden = folder === "";
    path.title = result.path; // chemin complet en infobulle
    const cardsEl = doc.createElement("div");
    cardsEl.className = "docseeker-cards";
    cardsEl.id = nextUiId("docseeker-cards");
    const total = result.pages.length;
    const entry: DocEntry = {
      li,
      signature,
      detachers: [],
      canExpand: () => false,
      canCollapse: () => false,
      expandAll: () => undefined,
      collapseAll: () => undefined,
    };

    const addCard = (page: number): void => {
      const card = doc.createElement("button");
      card.type = "button";
      card.className = "docseeker-card";
      card.tabIndex = -1;
      card.dataset["docId"] = result.docId;
      card.dataset["page"] = String(page);
      card.setAttribute("aria-label", tr("cardLabel", { title: result.title, page }));
      const frame = doc.createElement("span");
      frame.className = "docseeker-thumb";
      const label = doc.createElement("span");
      label.className = "docseeker-card-page";
      label.textContent = tr("cardPage", { page });
      card.append(frame, label);
      cardsEl.appendChild(card);
      entry.detachers.push(deps.thumbnails.attach(frame, thumbnailRequest(result, page, query)));
    };

    const wanted = Math.min(Math.max(expanded.get(result.docId) ?? MAX_CARDS_PER_DOC, MAX_CARDS_PER_DOC), total);
    for (const { page } of result.pages.slice(0, wanted)) addCard(page);
    li.append(title, path, cardsEl);
    if (total <= MAX_CARDS_PER_DOC) {
      expanded.delete(result.docId); // état périmé d'un document qui avait été déplié puis a rétréci
      return entry;
    }

    const more = doc.createElement("button");
    more.type = "button";
    more.className = "docseeker-more b3-button b3-button--outline";
    more.dataset["docId"] = result.docId;
    more.dataset["action"] = "more";
    const lessBtn = doc.createElement("button");
    lessBtn.type = "button";
    lessBtn.className = "docseeker-less b3-button b3-button--outline";
    lessBtn.dataset["docId"] = result.docId;
    lessBtn.dataset["action"] = "less";
    lessBtn.textContent = tr("showLess");
    for (const b of [more, lessBtn]) b.setAttribute("aria-controls", cardsEl.id);
    const note = doc.createElement("span");
    note.className = "docseeker-truncated";
    const actionsEl = doc.createElement("div");
    actionsEl.className = "docseeker-more-actions";
    actionsEl.append(more, lessBtn, note);
    li.appendChild(actionsEl);

    const announce = (): void =>
      setText(statusEl, tr("shownStatus", { n: shownCount(), title: result.title }));
    const shownCount = (): number => entry.detachers.length;
    // Le bouton qui a le focus ne doit jamais être masqué sans rendre le focus à son vis-à-vis.
    const sync = (): void => {
      const shown = shownCount();
      const remaining = total - shown;
      const moveFocus = (from: HTMLButtonElement, to: HTMLButtonElement): void => {
        if (doc.activeElement === from) to.focus();
      };
      // Vrai reste (matchingPages) tant que des pages sont dépliables ; au-delà du plafond, note non interactive.
      const realRemaining = Math.max(result.matchingPages - shown, remaining);
      more.textContent = count(realRemaining, "moreOne", "moreMany");
      more.setAttribute("aria-label", `${more.textContent}, ${result.title}`);
      lessBtn.setAttribute("aria-label", `${tr("showLess")}, ${result.title}`);
      const isExpanded = String(shown > MAX_CARDS_PER_DOC);
      more.setAttribute("aria-expanded", isExpanded);
      lessBtn.setAttribute("aria-expanded", isExpanded);
      const notShown = result.matchingPages - total;
      note.hidden = remaining > 0 || notShown <= 0;
      note.textContent = notShown > 0 ? tr("truncated", { n: notShown }) : "";
      lessBtn.hidden = shown <= MAX_CARDS_PER_DOC;
      more.hidden = remaining <= 0;
      if (more.hidden) moveFocus(more, lessBtn);
      if (lessBtn.hidden) moveFocus(lessBtn, more);
      if (shown > MAX_CARDS_PER_DOC) expanded.set(result.docId, shown);
      else expanded.delete(result.docId);
      ensureTabStop();
      refreshExpansionButtons();
    };
    const collapseCards = (): void => {
      while (entry.detachers.length > MAX_CARDS_PER_DOC) {
        entry.detachers.pop()?.();
        cardsEl.lastElementChild?.remove();
      }
      sync();
    };
    entry.canExpand = () => shownCount() < total;
    entry.canCollapse = () => shownCount() > MAX_CARDS_PER_DOC;
    entry.expandAll = () => {
      for (const { page } of result.pages.slice(shownCount())) addCard(page);
      sync();
    };
    entry.collapseAll = collapseCards;
    more.addEventListener("click", () => {
      const from = shownCount();
      for (const { page } of result.pages.slice(from, from + EXPAND_BATCH)) addCard(page);
      sync();
      announce();
    });
    lessBtn.addEventListener("click", () => {
      const focusWasInCards = cardsEl.contains(doc.activeElement);
      collapseCards();
      if (focusWasInCards) (more.hidden ? lessBtn : more).focus();
      announce();
    });
    sync();
    return entry;
  };

  const keyOf = (el: HTMLElement): string => `${el.dataset["docId"]}|${el.dataset["page"] ?? el.dataset["action"]}`;

  /** Remet le focus sur l'élément de même clé après un re-rendu (les <li> déplacés perdent le focus) ; une seule carte tabbable. */
  const settleFocus = (focusedKey: string | undefined): void => {
    const cards = allCards();
    const focusable = Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-doc-id]")).filter(
      (b) => !b.hidden,
    );
    const keep =
      focusable.find((b) => keyOf(b) === focusedKey) ??
      // « Plus » masqué par le re-rendu : le focus passe à « Replier » du même document.
      (focusedKey?.endsWith("|more") ? focusable.find((b) => keyOf(b) === focusedKey.replace(/\|more$/, "|less")) : undefined);
    const keptCard = keep && keep.classList.contains("docseeker-card") ? keep : undefined;
    const tabbable = keptCard ?? cards[0];
    for (const c of cards) c.tabIndex = c === tabbable ? 0 : -1;
    if (keep) keep.focus();
  };

  /** Place `li` à la suite de `previous` (ne déplace rien s'il y est déjà) ; renvoie le nouveau « précédent ». */
  const place = (li: HTMLLIElement, previous: Element | null): Element => {
    const expectedNext: Element | null = previous ? previous.nextElementSibling : list.firstElementChild;
    if (expectedNext !== li) list.insertBefore(li, expectedNext);
    return li;
  };

  const dropMissing = (map: Map<string, DocEntry>, seen: ReadonlySet<string>, onDrop?: (key: string) => void): void => {
    for (const [key, entry] of [...map]) {
      if (!seen.has(key)) {
        dropEntry(entry);
        map.delete(key);
        onDrop?.(key);
      }
    }
  };

  const renderGrouped = (docs: readonly ResultDoc[], query: string): void => {
    const seen = new Set<string>();
    let previous: Element | null = null;
    for (const result of docs) {
      seen.add(result.docId);
      // Signature compacte : longueur, 5 premières pages et empreinte de toute la liste ordonnée.
      let hash = 2166136261;
      for (const p of result.pages) hash = Math.imul(hash ^ p.page, 16777619) >>> 0;
      const pages = [result.pages.length, result.pages.slice(0, MAX_CARDS_PER_DOC).map((p) => p.page), hash];
      const meta = deps.getDocMeta(result.docId);
      const signature = JSON.stringify([
        result.title, result.path, result.matchingPages, pages, query, meta?.pdfSize, meta?.pdfModifiedMs,
      ]);
      let entry = entries.get(result.docId);
      if (entry && entry.signature !== signature) {
        dropEntry(entry);
        entry = undefined;
      }
      if (!entry) {
        entry = buildDoc(result, query, signature);
        entries.set(result.docId, entry);
      }
      previous = place(entry.li, previous);
    }
    dropMissing(entries, seen, (id) => expanded.delete(id));
  };

  /** Plafond global de la liste plate (toutes pages de tous les documents) ; remis à 60 quand la requête change. */
  let flatLimit = FLAT_PAGE_SIZE;
  let flatQuery: string | undefined;
  let lastDocs: readonly ResultDoc[] = [];
  let lastQuery = "";

  const renderFlat = (docs: readonly ResultDoc[], query: string, focusedKey: string | undefined): void => {
    // Totaux d'abord (sans rien créer) : pages affichables, et pages au-delà du plafond de 200 par document.
    let total = 0;
    let notShown = 0;
    let focusedRank = -1;
    for (const result of docs) {
      if (focusedKey !== undefined && focusedRank < 0) {
        const at = result.pages.findIndex((p) => `${result.docId}|${p.page}` === focusedKey);
        if (at >= 0) focusedRank = total + at;
      }
      total += result.pages.length;
      notShown += Math.max(0, result.matchingPages - result.pages.length);
    }
    // La carte focalisée ne doit pas sortir du rendu : le plafond s'étend jusqu'à elle (par paliers de 60).
    if (focusedRank >= flatLimit) flatLimit = Math.ceil((focusedRank + 1) / FLAT_PAGE_SIZE) * FLAT_PAGE_SIZE;
    const rendered = Math.min(flatLimit, total);
    const seen = new Set<string>();
    let previous: Element | null = null;
    let left = rendered;
    for (const result of docs) {
      if (left <= 0) break;
      const meta = deps.getDocMeta(result.docId);
      for (const { page } of result.pages) {
        if (left <= 0) break;
        left--;
        const key = `${result.docId}|${page}`;
        seen.add(key);
        const signature = JSON.stringify([result.title, result.path, page, query, meta?.pdfSize, meta?.pdfModifiedMs]);
        let entry = flatEntries.get(key);
        if (entry && entry.signature !== signature) {
          dropEntry(entry);
          entry = undefined;
        }
        if (!entry) {
          entry = buildFlat(result, page, query, signature);
          flatEntries.set(key, entry);
        }
        previous = place(entry.li, previous);
      }
    }
    dropMissing(flatEntries, seen);
    const remaining = total - rendered;
    const hadFocus = doc.activeElement === flatMore;
    flatMore.hidden = remaining <= 0;
    flatMore.textContent = remaining > 0 ? count(remaining, "flatMoreOne", "flatMoreMany") : "";
    flatNote.hidden = remaining > 0 || notShown <= 0;
    flatNote.textContent = notShown > 0 ? tr("truncated", { n: notShown }) : "";
    flatFooter.hidden = flatMore.hidden && flatNote.hidden;
    // Le bouton qui a le focus ne doit pas disparaître sans le rendre : dernière carte affichée.
    if (hadFocus && flatMore.hidden) {
      const last = allCards().at(-1);
      if (last) focusCard(last);
    }
  };

  const renderResults = (docs: readonly ResultDoc[], query: string): void => {
    const active = doc.activeElement as HTMLElement | null;
    const focusedKey = active && list.contains(active) ? keyOf(active) : undefined;
    if (query !== expandedQuery) {
      expanded.clear();
      expandedQuery = query;
    }
    if (query !== flatQuery) {
      flatLimit = FLAT_PAGE_SIZE;
      flatQuery = query;
    }
    lastDocs = docs;
    lastQuery = query;
    // Un seul mode à la fois dans la liste : l'autre est vidé (vignettes détachées).
    if (groupByDocument) {
      dropAll(flatEntries);
      hideFlatFooter();
      renderGrouped(docs, query);
    } else {
      dropAll(entries);
      renderFlat(docs, query, focusedKey);
    }
    settleFocus(focusedKey);
  };

  const hiddenText = (n: number): string => count(n, "hiddenByFiltersOne", "hiddenByFiltersMany");
  const withFailed = (text: string, failedCount: number): string =>
    failedCount > 0 ? `${text}. ${count(failedCount, "failedOne", "failedMany")}` : text;
  /**
   * Vrai pendant une indexation qui peut laisser des documents hors de l'index. Faux pendant une simple
   * migration d'anciens index (tous les documents restent interrogeables).
   */
  const isIndexingNow = (): boolean => {
    const snap = deps.indexActivity?.getSnapshot();
    return snap?.phase === "running" && snap.migrating !== true;
  };
  /** Pendant l'indexation, les résultats (ou leur absence) peuvent être incomplets. */
  const withIndexing = (text: string): string => (isIndexingNow() ? `${text}. ${tr("indexingMayMiss")}` : text);

  const render = (): void => {
    if (disposed) return;
    const vm = deps.controller.getViewModel();
    toolbar?.refresh(); // bon marché (signature des dossiers) : liste et résumé suivent l'index et les options
    const hadFocus = list.contains(doc.activeElement);
    if (vm.kind !== "results") {
      // Un état transitoire (loading, erreur...) vide la liste : l'expansion est volontairement abandonnée.
      clearList();
      expanded.clear();
      expandedQuery = undefined;
      // Le plafond de la liste plate survit aux états transitoires de la même requête (filtres), pas à une saisie vidée.
      if (vm.kind === "empty-query") {
        flatLimit = FLAT_PAGE_SIZE;
        flatQuery = undefined;
      }
    }
    switch (vm.kind) {
      case "empty-query":
        setStatus(tr("emptyQuery"));
        break;
      case "loading":
        setStatus(tr("loadingPartial", { loaded: vm.progress.loaded, total: vm.progress.total }));
        break;
      case "no-result": {
        const byFilters = vm.hiddenByFilters > 0 && opts !== undefined;
        const partialNote = vm.partial ? tr("partialSuffix") : "";
        const base = opts !== undefined && byFilters
          ? `${count(countActiveFilters(opts.getOptions().filters), "noResultFiltersOne", "noResultFiltersMany")} ${hiddenText(vm.hiddenByFilters)}${partialNote}`
          : `${tr("noResults")}${partialNote}`;
        const text = withIndexing(withFailed(base, vm.failedCount));
        setStatus(byFilters ? `${text}.` : text, { settings: vm.failedCount > 0, reset: byFilters });
        break;
      }
      case "error":
        setStatus(tr("error", { message: vm.message }), { error: true });
        break;
      case "no-index":
        if (vm.indexing) setStatus(tr("indexing"));
        else setStatus(tr("noIndex"), { settings: true });
        break;
      case "results": {
        const pages = vm.docs.reduce((n, d) => n + d.matchingPages, 0);
        const base = `${count(vm.total, "docOne", "docMany")}, ${count(pages, "pageOne", "pageMany")}`;
        const withPartial = vm.partial ? `${base}${tr("partialSuffix")}` : base;
        const counted = vm.hiddenByFilters > 0 ? `${withPartial}. ${hiddenText(vm.hiddenByFilters)}` : withPartial;
        // Texte identique tant que le classement reste affiné : la région live ne le ré-annonce pas.
        // Hors tri par pertinence, l'ordre des documents vient du tri : seules les pages sont classées par proximité.
        const sortKey = opts?.getOptions().sort.key ?? "relevance";
        const refinedText = tr(sortKey === "relevance" ? "rankingRefined" : "rankingRefinedPages");
        const refined = vm.ranking === "proximity" ? `${counted}. ${refinedText}` : counted;
        setStatus(withIndexing(withFailed(refined, vm.failedCount)), { settings: vm.failedCount > 0 });
        renderResults(vm.docs, vm.query);
        break;
      }
    }
    refreshExpansionButtons();
    // La carte focalisée a disparu : le focus retombait sur <body>, on le rend à la saisie.
    if (hadFocus && !list.contains(doc.activeElement) && !disposed) input.focus();
  };

  // Champ vidé sans clavier (croix native de type=search) : retour immédiat à l'état vide.
  // Du texte tapé ne lance rien.
  const submitIfCleared = (): void => {
    if (input.value === "") deps.controller.submit("");
  };
  input.addEventListener("search", submitIfCleared);
  input.addEventListener("input", submitIfCleared);
  // Taper ne lance rien : la recherche part à Entrée (hors composition IME).
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (e.isComposing) return;
      e.preventDefault();
      deps.controller.submit(input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      deps.controller.submit("");
    } else if (e.key === "ArrowDown") {
      const first = allCards()[0];
      if (first) {
        e.preventDefault();
        focusCard(first);
      }
    }
  });

  groupBox?.addEventListener("change", () => {
    if (!groupBox) return;
    groupByDocument = groupBox.checked;
    applyGroupChrome();
    render();
    deps.onGroupByDocumentChange?.(groupByDocument);
  });
  flatMore.addEventListener("click", () => {
    const wasFocused = doc.activeElement === flatMore;
    const before = allCards().length;
    flatLimit += FLAT_PAGE_SIZE;
    renderResults(lastDocs, lastQuery);
    refreshExpansionButtons();
    // Dernier lot : le bouton disparaît, le focus passe à la première carte ajoutée.
    const firstNew = allCards()[before];
    if (wasFocused && flatMore.hidden && firstNew) focusCard(firstNew);
  });
  expandBtn?.addEventListener("click", () => {
    if (expandBtn?.getAttribute("aria-disabled") === "true") return;
    for (const entry of entries.values()) entry.expandAll();
    refreshExpansionButtons();
  });
  collapseBtn?.addEventListener("click", () => {
    if (collapseBtn?.getAttribute("aria-disabled") === "true") return;
    for (const entry of entries.values()) entry.collapseAll();
    refreshExpansionButtons();
  });

  resetButton?.addEventListener("click", () => {
    toolbar?.reset();
    // Le panneau de filtres est peut-être replié : si le focus n'a pas pu y aller, retour à la saisie.
    if (!root.contains(doc.activeElement) || doc.activeElement === doc.body || doc.activeElement === resetButton) input.focus();
  });

  list.addEventListener("click", (e) => {
    const card = (e.target as Element).closest<HTMLButtonElement>("button.docseeker-card");
    if (!card) return;
    const query = deps.controller.getViewModel();
    deps.onOpen(card.dataset["docId"] ?? "", Number(card.dataset["page"]), query.kind === "results" ? query.query : input.value);
  });
  list.addEventListener("keydown", (e) => {
    const card = (e.target as Element).closest<HTMLButtonElement>("button.docseeker-card");
    if (!card) return;
    if (e.key === "Enter") {
      e.preventDefault();
      card.click();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const cards = allCards();
      const target = e.key === "Home" ? cards[0] : cards[cards.length - 1];
      if (target) focusCard(target);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const cards = allCards();
      const i = cards.indexOf(card);
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        const next = cards[i + 1];
        if (next) focusCard(next);
      } else if (i > 0) {
        focusCard(cards[i - 1]!);
      } else if (e.key === "ArrowUp") {
        input.focus();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      deps.controller.submit("");
      input.focus();
    }
  });

  const unsubscribe = deps.subscribe(render);
  render();

  // --- Indicateur d'indexation.
  let cleanupActivity: (() => void) | undefined;
  if (deps.indexActivity && activityRow) {
    const source = deps.indexActivity;
    const schedule = deps.schedule ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
    const clearTimer = deps.clear ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const region = doc.createElement("div");
    region.className = "docseeker-index-activity";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    const countEl = doc.createElement("span");
    countEl.className = "docseeker-index-count";
    countEl.setAttribute("aria-hidden", "true");
    const settingsBtn = doc.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "b3-button b3-button--outline docseeker-index-settings";
    settingsBtn.textContent = tr("openSettings");
    settingsBtn.hidden = true;
    if (deps.onOpenSettings) {
      settingsBtn.addEventListener("click", () => deps.onOpenSettings?.());
      activityRow.append(region, countEl, settingsBtn);
    } else {
      activityRow.append(region, countEl);
    }
    let hideHandle: unknown;
    let hasHide = false;
    let lastRunning = false;
    const stopHide = (): void => {
      if (!hasHide) return;
      hasHide = false;
      clearTimer(hideHandle);
    };
    const show = (text: string, countText: string, withButton: boolean): void => {
      if (region.textContent !== text) region.textContent = text; // inchangé : pas de ré-annonce
      if (countEl.textContent !== countText) countEl.textContent = countText;
      settingsBtn.hidden = !withButton;
    };
    const renderActivity = (): void => {
      if (disposed) return;
      const snap = source.getSnapshot();
      stopHide();
      switch (snap.phase) {
        case "running":
          show(
            tr(snap.migrating === true ? "autoIndexMigrating" : "autoIndexRunning"),
            snap.total > 0 ? tr("autoIndexCount", { done: snap.done, total: snap.total }) : "",
            false,
          );
          break;
        case "done":
          show(tr("autoIndexUpToDate"), "", false);
          hasHide = true;
          hideHandle = schedule(() => {
            hasHide = false;
            if (!disposed) show("", "", false);
          }, UP_TO_DATE_VISIBLE_MS);
          break;
        case "partial":
          show(count(snap.incomplete, "autoIndexPartialOne", "autoIndexPartialMany"), "", true);
          break;
        case "failed":
          show(snap.discovery ? tr("autoIndexDiscoveryFailed") : tr("autoIndexFailed", { n: snap.failed }), "", true);
          break;
        default:
          show("", "", false);
      }
      const running = isIndexingNow();
      if (running !== lastRunning) {
        lastRunning = running;
        render(); // l'avis « des résultats peuvent manquer » apparaît ou disparaît, sans relancer la requête
      }
    };
    const unsubscribeActivity = source.subscribe(renderActivity);
    lastRunning = isIndexingNow();
    renderActivity();
    cleanupActivity = () => {
      stopHide();
      unsubscribeActivity();
    };
  }

  return {
    focusInput: () => input.focus(),
    setGroupByDocument(next) {
      if (disposed || next === groupByDocument) return;
      groupByDocument = next;
      if (groupBox) groupBox.checked = next;
      applyGroupChrome();
      render();
    },
    refreshOptions() {
      if (!disposed) toolbar?.refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      cleanupActivity?.();
      toolbar?.dispose();
      clearList();
      root.remove();
    },
  };
}
