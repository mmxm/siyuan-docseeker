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

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function mountSearchView(host: HTMLElement, deps: SearchViewDeps): SearchView {
  const doc = host.ownerDocument;
  const tr = (key: string): string => deps.t?.(key) ?? key;
  ensureSearchStyle(doc);

  const root = doc.createElement("div");
  root.className = "docseeker-search";
  root.setAttribute("role", "search");

  const input = doc.createElement("input");
  input.type = "search";
  input.className = "b3-text-field fn__block";
  input.placeholder = "Rechercher dans les PDF";
  input.setAttribute("aria-label", "Rechercher dans les PDF");

  const statusEl = doc.createElement("div");
  statusEl.className = "docseeker-status";
  statusEl.setAttribute("aria-live", "polite");
  const statusText = doc.createElement("span");
  statusEl.appendChild(statusText);

  const list = doc.createElement("ul");
  list.className = "docseeker-list";

  root.append(input, statusEl, list);
  host.appendChild(root);

  const entries = new Map<string, DocEntry>();
  let reindexButton: HTMLButtonElement | undefined;
  let disposed = false;

  const allCards = (): HTMLButtonElement[] =>
    Array.from(list.querySelectorAll<HTMLButtonElement>("button.docseeker-card"));

  const focusCard = (card: HTMLButtonElement): void => {
    for (const c of allCards()) c.tabIndex = c === card ? 0 : -1;
    card.focus();
  };

  const setStatus = (text: string, error = false): void => {
    statusText.textContent = text;
    statusEl.classList.toggle("docseeker-status--error", error);
    reindexButton?.remove();
    reindexButton = undefined;
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
    const title = doc.createElement("div");
    const name = doc.createElement("span");
    name.className = "docseeker-doc-title";
    name.textContent = result.title;
    const count = doc.createElement("span");
    count.className = "docseeker-doc-count";
    count.textContent = plural(result.matchingPages, "page correspondante", "pages correspondantes");
    title.append(name, count);
    const path = doc.createElement("div");
    path.className = "docseeker-doc-path";
    path.textContent = result.path;
    const cardsEl = doc.createElement("div");
    cardsEl.className = "docseeker-cards";
    const entry: DocEntry = { li, signature, detachers: [] };
    const meta = deps.getDocMeta(result.docId);
    for (const { page } of result.pages.slice(0, MAX_CARDS_PER_DOC)) {
      const card = doc.createElement("button");
      card.type = "button";
      card.className = "docseeker-card";
      card.tabIndex = -1;
      card.dataset["docId"] = result.docId;
      card.dataset["page"] = String(page);
      card.setAttribute("aria-label", `${result.title}, page ${page}`);
      const frame = doc.createElement("span");
      frame.className = "docseeker-thumb";
      const label = doc.createElement("span");
      label.className = "docseeker-card-page";
      label.textContent = `p. ${page}`;
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

  const render = (): void => {
    if (disposed) return;
    const vm = deps.controller.getViewModel();
    if (vm.kind !== "results") clearList();
    switch (vm.kind) {
      case "empty-query":
        setStatus("Saisissez des mots à rechercher");
        break;
      case "loading":
        setStatus(
          `Résultats partiels, index en cours de construction (${vm.progress.loaded}/${vm.progress.total})`,
        );
        break;
      case "no-result":
        setStatus(vm.partial ? "Aucun résultat (résultats partiels, index en cours de construction)" : "Aucun résultat");
        break;
      case "error":
        setStatus(`Erreur : ${vm.message}`, true);
        break;
      case "no-index":
        if (vm.indexing) {
          setStatus("Index en cours de construction");
        } else {
          setStatus("Aucun index : lancez la réindexation");
          if (deps.onReindex) {
            const button = doc.createElement("button");
            button.type = "button";
            button.className = "b3-button b3-button--outline docseeker-reindex";
            button.textContent = "Réindexer";
            button.addEventListener("click", () => deps.onReindex?.());
            statusEl.appendChild(button);
            reindexButton = button;
          }
        }
        break;
      case "results": {
        const pages = vm.docs.reduce((n, d) => n + d.matchingPages, 0);
        const base = `${plural(vm.total, "document", "documents")}, ${plural(pages, "page", "pages")}`;
        setStatus(vm.partial ? `${base} (résultats partiels, index en cours de construction)` : base);
        renderResults(vm.docs, vm.query);
        break;
      }
    }
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
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const cards = allCards();
      const i = cards.indexOf(card);
      if (e.key === "ArrowDown") {
        const next = cards[i + 1];
        if (next) focusCard(next);
      } else if (i > 0) {
        focusCard(cards[i - 1]!);
      } else {
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
