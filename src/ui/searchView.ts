/**
 * Vue de l'onglet de recherche : DOM natif, aucun innerHTML (le texte issu
 * des PDF/titres passe uniquement par textContent / setAttribute).
 */
import type { ResultDoc, SearchViewModel } from "../search/searchController";
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
  readonly controller: { setQuery(q: string): void; getViewModel(): SearchViewModel };
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

interface DocEntry {
  li: HTMLLIElement;
  signature: string;
  detachers: (() => void)[];
}

/** Chaînes par défaut (français) : `deps.t` les remplace quand une clé i18n existe. */
export const DEFAULT_STRINGS: Readonly<Record<string, string>> = {
  searchLabel: "Rechercher dans les PDF",
  searchPlaceholder: "Rechercher dans les PDF",
  resultsList: "Résultats de la recherche",
  emptyQuery: "Saisissez des mots à rechercher",
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
  matchOne: "{n} page correspondante",
  matchMany: "{n} pages correspondantes",
  moreOne: "et {n} autre page",
  moreMany: "et {n} autres pages",
  failedOne: "{n} index illisible : réindexer",
  failedMany: "{n} index illisibles : réindexer",
  cardLabel: "{title}, p. {page}",
  cardPage: "p. {page}",
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

  const allCards = (): HTMLButtonElement[] =>
    Array.from(list.querySelectorAll<HTMLButtonElement>("button.docseeker-card"));

  const focusCard = (card: HTMLButtonElement): void => {
    for (const c of allCards()) c.tabIndex = c === card ? 0 : -1;
    card.focus();
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
    counter.textContent = `— ${count(result.matchingPages, "matchOne", "matchMany")}`;
    title.append(name, " ", counter);
    const path = doc.createElement("div");
    path.className = "docseeker-doc-path";
    path.textContent = result.path;
    const cardsEl = doc.createElement("div");
    cardsEl.className = "docseeker-cards";
    const entry: DocEntry = { li, signature, detachers: [] };
    const meta = deps.getDocMeta(result.docId);
    const shown = result.pages.slice(0, MAX_CARDS_PER_DOC);
    for (const { page } of shown) {
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
    }
    li.append(title, path, cardsEl);
    const hidden = result.matchingPages - shown.length;
    if (hidden > 0) {
      const more = doc.createElement("p");
      more.className = "docseeker-more";
      more.textContent = count(hidden, "moreOne", "moreMany");
      li.appendChild(more);
    }
    return entry;
  };

  const renderResults = (docs: readonly ResultDoc[], query: string): void => {
    const active = doc.activeElement as HTMLElement | null;
    const focusedKey =
      active && list.contains(active) ? `${active.dataset["docId"]}|${active.dataset["page"]}` : undefined;
    const seen = new Set<string>();
    let previous: Element | null = null;
    for (const result of docs) {
      seen.add(result.docId);
      const pages = result.pages.slice(0, MAX_CARDS_PER_DOC).map((p) => p.page);
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
      }
    }
    const cards = allCards();
    const keep = cards.find((c) => `${c.dataset["docId"]}|${c.dataset["page"]}` === focusedKey);
    const tabbable = keep ?? cards[0];
    for (const c of cards) c.tabIndex = c === tabbable ? 0 : -1;
    if (keep) keep.focus();
  };

  const withFailed = (text: string, failedCount: number): string =>
    failedCount > 0 ? `${text}. ${count(failedCount, "failedOne", "failedMany")}` : text;

  const render = (): void => {
    if (disposed) return;
    const vm = deps.controller.getViewModel();
    const hadFocus = list.contains(doc.activeElement);
    if (vm.kind !== "results") clearList();
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
        setStatus(withFailed(vm.partial ? `${base}${tr("partialSuffix")}` : base, vm.failedCount), {
          reindex: vm.failedCount > 0,
        });
        renderResults(vm.docs, vm.query);
        break;
      }
    }
    // La carte focalisée a disparu : le focus retombait sur <body>, on le rend à la saisie.
    if (hadFocus && !list.contains(doc.activeElement) && !disposed) input.focus();
  };

  input.addEventListener("input", () => deps.controller.setQuery(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      input.value = "";
      deps.controller.setQuery("");
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
      deps.controller.setQuery("");
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
