/**
 * Vue de l'onglet de recherche : DOM natif, aucun innerHTML (le texte issu
 * des PDF/titres passe uniquement par textContent / setAttribute).
 */
import type { ResultDoc, SearchViewModel } from "../search/searchController";
import { containingFolder } from "./pathLabel";
import { ensureSearchStyle } from "./searchStyles";

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
  onReindex?(): void;
  getDocMeta(docId: string): { pdfSize: number; pdfModifiedMs: number } | undefined;
  readonly t?: (key: string) => string;
}

export interface SearchView {
  dispose(): void;
  focusInput(): void;
}

export const MAX_CARDS_PER_DOC = 5;
/** Nombre de cartes ajoutées à chaque clic sur « et N autres pages ». */
export const EXPAND_BATCH = 10;

interface DocEntry {
  li: HTMLLIElement;
  signature: string;
  /** Un détacheur par carte affichée, dans l'ordre des cartes. */
  detachers: (() => void)[];
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
  noIndex: "Aucun index : lancez la réindexation",
  reindex: "Réindexer",
  docOne: "{n} document",
  docMany: "{n} documents",
  pageOne: "{n} page",
  pageMany: "{n} pages",
  moreOne: "et {n} autre page",
  moreMany: "et {n} autres pages",
  showLess: "Replier",
  truncated: "{n} pages non affichées",
  shownStatus: "{n} pages affichées pour {title}",
  failedOne: "{n} index illisible : réindexer",
  failedMany: "{n} index illisibles : réindexer",
  cardLabel: "{title}, p. {page}",
  cardPage: "p. {page}",
  rankingRefined: "Classement affiné par proximité des mots",
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
  let reindexButton: HTMLButtonElement | undefined;
  if (deps.onReindex) {
    reindexButton = doc.createElement("button");
    reindexButton.type = "button";
    reindexButton.className = "b3-button b3-button--outline docseeker-reindex";
    reindexButton.textContent = tr("reindex");
    reindexButton.hidden = true;
    reindexButton.addEventListener("click", () => deps.onReindex?.());
    actions.appendChild(reindexButton);
  }

  const list = doc.createElement("ul");
  list.className = "docseeker-list";
  list.setAttribute("aria-label", tr("resultsList"));

  root.append(input, statusEl, alertEl, actions, list);
  host.appendChild(root);

  const entries = new Map<string, DocEntry>();
  let disposed = false;
  // Nombre de cartes affichées par document déplié ; valable pour une seule requête.
  const expanded = new Map<string, number>();
  let expandedQuery: string | undefined;
  let cardsSeq = 0;

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

  const setStatus = (text: string, opts: { error?: boolean; reindex?: boolean } = {}): void => {
    if (opts.error) {
      setText(statusEl, "");
      setText(alertEl, text);
    } else {
      setText(statusEl, text);
      setText(alertEl, "");
    }
    if (reindexButton) {
      const show = opts.reindex === true;
      if (!show && !reindexButton.hidden && doc.activeElement === reindexButton) input.focus();
      reindexButton.hidden = !show;
    }
  };

  const dropEntry = (entry: DocEntry): void => {
    for (const d of entry.detachers) d();
    entry.detachers = [];
    entry.li.remove();
  };

  const clearList = (): void => {
    for (const entry of entries.values()) dropEntry(entry);
    entries.clear();
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
    cardsEl.id = `docseeker-cards-${++cardsSeq}`;
    const entry: DocEntry = { li, signature, detachers: [] };
    const meta = deps.getDocMeta(result.docId);
    const total = result.pages.length;

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
      entry.detachers.push(
        deps.thumbnails.attach(frame, {
          docId: result.docId,
          path: result.path,
          page,
          query,
          pdfSize: meta?.pdfSize ?? 0,
          pdfModifiedMs: meta?.pdfModifiedMs ?? 0,
        }),
      );
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
    };
    more.addEventListener("click", () => {
      const from = shownCount();
      for (const { page } of result.pages.slice(from, from + EXPAND_BATCH)) addCard(page);
      sync();
      announce();
    });
    lessBtn.addEventListener("click", () => {
      const focusWasInCards = cardsEl.contains(doc.activeElement);
      while (entry.detachers.length > MAX_CARDS_PER_DOC) {
        entry.detachers.pop()?.();
        cardsEl.lastElementChild?.remove();
      }
      sync();
      if (focusWasInCards) (more.hidden ? lessBtn : more).focus();
      announce();
    });
    sync();
    return entry;
  };

  const renderResults = (docs: readonly ResultDoc[], query: string): void => {
    const active = doc.activeElement as HTMLElement | null;
    const keyOf = (el: HTMLElement): string =>
      `${el.dataset["docId"]}|${el.dataset["page"] ?? el.dataset["action"]}`;
    const focusedKey = active && list.contains(active) ? keyOf(active) : undefined;
    if (query !== expandedQuery) {
      expanded.clear();
      expandedQuery = query;
    }
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
      const expectedNext: Element | null = previous ? previous.nextElementSibling : list.firstElementChild;
      if (expectedNext !== entry.li) list.insertBefore(entry.li, expectedNext);
      previous = entry.li;
    }
    for (const [id, entry] of [...entries]) {
      if (!seen.has(id)) {
        dropEntry(entry);
        entries.delete(id);
        expanded.delete(id);
      }
    }
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

  const withFailed = (text: string, failedCount: number): string =>
    failedCount > 0 ? `${text}. ${count(failedCount, "failedOne", "failedMany")}` : text;

  const render = (): void => {
    if (disposed) return;
    const vm = deps.controller.getViewModel();
    const hadFocus = list.contains(doc.activeElement);
    if (vm.kind !== "results") {
      // Un état transitoire (loading, erreur...) vide la liste : l'expansion est volontairement abandonnée.
      clearList();
      expanded.clear();
      expandedQuery = undefined;
    }
    switch (vm.kind) {
      case "empty-query":
        setStatus(tr("emptyQuery"));
        break;
      case "loading":
        setStatus(tr("loadingPartial", { loaded: vm.progress.loaded, total: vm.progress.total }));
        break;
      case "no-result": {
        const base = vm.partial ? `${tr("noResults")}${tr("partialSuffix")}` : tr("noResults");
        setStatus(withFailed(base, vm.failedCount), { reindex: vm.failedCount > 0 });
        break;
      }
      case "error":
        setStatus(tr("error", { message: vm.message }), { error: true, reindex: true });
        break;
      case "no-index":
        if (vm.indexing) setStatus(tr("indexing"));
        else setStatus(tr("noIndex"), { reindex: true });
        break;
      case "results": {
        const pages = vm.docs.reduce((n, d) => n + d.matchingPages, 0);
        const base = `${count(vm.total, "docOne", "docMany")}, ${count(pages, "pageOne", "pageMany")}`;
        const counted = vm.partial ? `${base}${tr("partialSuffix")}` : base;
        // Texte identique tant que le classement reste affiné : la région live ne le ré-annonce pas.
        const refined = vm.ranking === "proximity" ? `${counted}. ${tr("rankingRefined")}` : counted;
        setStatus(withFailed(refined, vm.failedCount), { reindex: vm.failedCount > 0 });
        renderResults(vm.docs, vm.query);
        break;
      }
    }
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

  return {
    focusInput: () => input.focus(),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      clearList();
      root.remove();
    },
  };
}
