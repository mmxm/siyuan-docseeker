/**
 * Dialogue « Spécifier le chemin », reproduction de celui de la recherche native de SiYuan 3.8.9 (`movePathTo`) : champ de
 * recherche, arbre paresseux des cahiers et documents, liste de résultats, Annuler / Confirmer. Le DOM est construit sans HTML
 * (les noms de documents sont des données non fiables : toujours `textContent`). Le dialogue ne touche ni au noyau ni à SiYuan
 * autrement que par ses dépendances injectées.
 *
 * Différence assumée avec le natif : pas de chevron d'historique de saisie à côté de la loupe (hors périmètre).
 * Identifiants : `data-docseeker` plutôt que les `id` globaux du natif (`foldList`, `foldTree`), pour ne jamais les dupliquer.
 */
import { MAX_SCOPES, normalizedScopes, type DocumentScope } from "../search/docScope";
import type { DocFile, DocSearchHit, NotebookInfo } from "../siyuan/kernelApi";
import { el } from "./dom";
import { svgIcon } from "./icons";
import type { CustomDialogHandle, OpenCustomDialog } from "./nativeUiTypes";

export interface PathKernel {
  lsNotebooks(signal?: AbortSignal): Promise<readonly NotebookInfo[]>;
  listDocsByPath(notebook: string, path: string, signal?: AbortSignal): Promise<readonly DocFile[]>;
  searchDocs(k: string, signal?: AbortSignal): Promise<readonly DocSearchHit[]>;
  getHPathsByPaths(paths: readonly string[], signal?: AbortSignal): Promise<readonly string[]>;
}

export interface PathDialogDeps {
  readonly doc: Document;
  readonly t: (key: string, vars?: Readonly<Record<string, string | number>>) => string;
  readonly kernel: PathKernel;
  readonly openCustomDialog: OpenCustomDialog;
  /** Trace des incidents (lecture des cahiers, des documents, de la recherche, des libellés). */
  readonly onWarn: (message: string, error?: unknown) => void;
  /** Reçoit les portées choisies (1 à 20, valides) ; le dialogue se ferme ensuite. */
  readonly onConfirm: (scopes: readonly DocumentScope[]) => void;
  /** Appelé une fois, quand SiYuan a réellement détruit le dialogue (quelle que soit la cause de la fermeture). */
  readonly onDestroyed?: () => void;
  /** Cmd+clic (Mac) ou Ctrl+clic (ailleurs) pour la sélection multiple ; détecté par défaut dans le navigateur. */
  readonly isMac?: () => boolean;
}

const FOCUS = "b3-list-item--focus";
const ARROW_OPEN = "b3-list-item__arrow--open";
const NARROW_WINDOW_PX = 768;
const ROW = "li.b3-list-item";
const EMOJI_CODE = /^[0-9a-f]{1,6}(-[0-9a-f]{1,6}){0,7}$/i;
const MIN_CODE_POINT = 0xa0; // ni contrôles ni caractères de format ASCII
const MAX_CODE_POINT = 0x10ffff;
/** Délai avant chaque requête de recherche (la frappe suivante l'annule). */
const SEARCH_DEBOUNCE_MS = 200;
/** Plafonds d'affichage : résultats d'une recherche, enfants d'un dépliage (une note dit que la liste est tronquée). */
const MAX_SEARCH_ROWS = 200;
const MAX_CHILD_ROWS = 500;
const FORMAT_OR_CONTROL = /[\p{Cf}\p{Cc}]/gu;
const FORMAT_CHAR = /\p{Cf}/u;
const ZWJ = 0x200d;
const TAG_FIRST = 0xe0020;
const TAG_LAST = 0xe007f;
/** Nom affiché : sans marques de format (bidi, largeur nulle) ni contrôles, qui permettraient d'usurper l'affichage. */
const displayName = (text: string): string => text.replace(FORMAT_OR_CONTROL, "");

/** Icône SiYuan (code hexadécimal Unicode, « 1f4c4 » ou « 1f468-200d-1f4bb ») -> caractère ; undefined si illisible. */
function emojiOf(hex: string): string | undefined {
  if (!EMOJI_CODE.test(hex)) return undefined;
  const points = hex.split("-").map((h) => Number.parseInt(h, 16));
  if (points.some((p) => p < MIN_CODE_POINT || p > MAX_CODE_POINT || (p >= 0xd800 && p <= 0xdfff))) return undefined;
  // Caractères de format (bidi U+202A-202E, largeur nulle U+200B-200F...) refusés. Seules exceptions : la jonction ZWJ des emojis
  // composés (« 1f468-200d-1f4bb ») et les étiquettes des drapeaux régionaux, jamais en tête ni en queue.
  const isFormat = (p: number): boolean => FORMAT_CHAR.test(String.fromCodePoint(p));
  const allowedGlue = (p: number): boolean => p === ZWJ || (p >= TAG_FIRST && p <= TAG_LAST);
  if (points.some((p) => isFormat(p) && !allowedGlue(p))) return undefined;
  if (isFormat(points[0] as number) || isFormat(points[points.length - 1] as number)) return undefined;
  return String.fromCodePoint(...points);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface RowInfo {
  readonly box: string;
  readonly path: string;
  /** Nom du cahier (lignes de cahier seulement). */
  readonly name: string;
}

interface Expansion {
  ul: HTMLElement | undefined;
  loading: boolean;
  failed: boolean;
}

export function openPathDialog(deps: PathDialogDeps): CustomDialogHandle {
  const { doc, t, kernel } = deps;
  const isMac = deps.isMac ?? ((): boolean => /Mac|iPhone|iPad|iPod/.test(doc.defaultView?.navigator.platform ?? ""));
  const lifetime = new AbortController();
  let destroyed = false;
  let handle: CustomDialogHandle | undefined;
  const alive = (): boolean => !destroyed && handle?.isOpen() === true;

  // --- Squelette (structure du dialogue natif).
  const searchIcon = el(doc, "span", "b3-form__icon-list");
  searchIcon.appendChild(svgIcon(doc, "iconSearch", "svg--mid"));
  const input = el(doc, "input", "b3-text-field fn__block", {
    spellcheck: "false",
    style: "padding-left:42px",
    placeholder: t("pathSearchPlaceholder"),
  });
  const form = el(doc, "div", "b3-form__icon", { style: "margin:8px" });
  form.append(searchIcon, input);
  const list = el(doc, "ul", "fn__flex-1 fn__none b3-list b3-list--background", {
    "data-docseeker": "list",
    style: "overflow:auto;position:relative",
  });
  const tree = el(doc, "div", "fn__flex-1", { "data-docseeker": "tree", style: "overflow:auto;position:relative" });
  const cancel = el(doc, "button", "b3-button b3-button--cancel");
  cancel.textContent = t("dialogCancel");
  const confirmButton = el(doc, "button", "b3-button b3-button--text");
  confirmButton.textContent = t("dialogConfirm");
  const action = el(doc, "div", "b3-dialog__action");
  action.append(cancel, el(doc, "div", "fn__space"), confirmButton);
  const content = doc.createDocumentFragment();
  content.append(form, list, tree, el(doc, "div", "fn__hr"), action);

  // --- État.
  let searching = false;
  const meta = new WeakMap<HTMLElement, RowInfo>();
  const expansions = new WeakMap<HTMLElement, Expansion>();
  /** Dernière ligne touchée (clic ou flèche) : point de départ des flèches. */
  let cursor: HTMLElement | undefined;
  let topError: HTMLElement | undefined;
  let confirming = false;
  let searchSeq = 0;
  let searchAbort: AbortController | undefined;

  const panel = (): HTMLElement => (searching ? list : tree);
  /** Lignes visibles du panneau actif, dans l'ordre d'affichage (les sous-arbres repliés sont écartés). */
  const visibleRows = (): HTMLElement[] =>
    [...panel().querySelectorAll<HTMLElement>(ROW)].filter((row) => row.closest("ul.fn__none") === null);
  const focusedRows = (): HTMLElement[] => [...panel().querySelectorAll<HTMLElement>(`${ROW}.${FOCUS}`)];

  const fail = (message: string, error: unknown): void => {
    deps.onWarn(message, error);
  };
  const messageItem = (text: string, isError: boolean): HTMLElement => {
    const item = el(doc, "li", `b3-list--empty${isError ? " docseeker-pathdialog-error" : ""}`);
    item.textContent = text;
    return item;
  };
  const messageList = (text: string, isError: boolean): HTMLElement => {
    const ul = el(doc, "ul");
    ul.appendChild(messageItem(text, isError));
    return ul;
  };
  const clearTopError = (): void => {
    topError?.remove();
    topError = undefined;
  };
  /** Message d'erreur en tête de la zone de liste visible. */
  const showTopError = (text: string): void => {
    clearTopError();
    topError = searching ? messageItem(text, true) : messageList(text, true);
    panel().prepend(topError);
  };
  const readError = (): string => t("pathDialogError");

  // --- Construction des lignes.
  const graphic = (hex: string, fallbackId: string): Element => {
    const emoji = emojiOf(hex);
    if (emoji === undefined) return svgIcon(doc, fallbackId, "b3-list-item__graphic");
    const span = el(doc, "span", "b3-list-item__graphic");
    span.textContent = emoji;
    return span;
  };
  const toggleNode = (hidden: boolean, indent?: number): HTMLElement => {
    const toggle = el(doc, "span", `b3-list-item__toggle b3-list-item__toggle--hl${hidden ? " fn__hidden" : ""}`);
    if (indent !== undefined) toggle.setAttribute("style", `padding-left:${indent}px`);
    toggle.appendChild(svgIcon(doc, "iconRight", "b3-list-item__arrow"));
    return toggle;
  };
  const rowElement = (info: RowInfo, focus: boolean): HTMLElement => {
    const row = el(doc, "li", `b3-list-item${focus ? ` ${FOCUS}` : ""}`, { "data-path": info.path, "data-box": info.box });
    meta.set(row, info);
    return row;
  };
  const notebookRow = (notebook: NotebookInfo, focus: boolean): HTMLElement => {
    const name = displayName(notebook.name);
    const row = rowElement({ box: notebook.id, path: "/", name }, focus);
    const text = el(doc, "span", "b3-list-item__text");
    text.textContent = name;
    row.append(toggleNode(false), graphic(notebook.icon, "iconFilesRoot"), text);
    return row;
  };
  const docRow = (box: string, file: DocFile): HTMLElement => {
    const row = rowElement({ box, path: file.path, name: "" }, false);
    const text = el(doc, "span", "b3-list-item__text");
    text.textContent = displayName(file.name);
    row.append(toggleNode(file.subFileCount === 0, file.path.split("/").length * 8), graphic(file.icon, "iconFile"), text);
    return row;
  };

  // --- Arbre : dépliage paresseux.
  const arrowOf = (row: HTMLElement): Element | null => row.querySelector(".b3-list-item__arrow");
  const setOpen = (row: HTMLElement, open: boolean): void => {
    arrowOf(row)?.classList.toggle(ARROW_OPEN, open);
  };
  const isOpen = (row: HTMLElement): boolean => arrowOf(row)?.classList.contains(ARROW_OPEN) === true;
  const hasToggle = (row: HTMLElement): boolean => {
    const toggle = row.querySelector(".b3-list-item__toggle");
    return toggle !== null && !toggle.classList.contains("fn__hidden");
  };

  async function toggleRow(row: HTMLElement): Promise<void> {
    const info = meta.get(row);
    if (!info || !hasToggle(row)) return;
    const state = expansions.get(row) ?? { ul: undefined, loading: false, failed: false };
    expansions.set(row, state);
    if (state.loading) return;
    if (state.ul && !state.failed) {
      const hidden = state.ul.classList.toggle("fn__none");
      setOpen(row, !hidden);
      return;
    }
    if (state.ul) {
      state.ul.remove(); // le message d'échec précédent : nouvel essai
      state.ul = undefined;
      state.failed = false;
    }
    state.loading = true;
    row.setAttribute("data-loading", "true");
    let ul: HTMLElement;
    try {
      const files = await kernel.listDocsByPath(info.box, info.path, lifetime.signal);
      if (destroyed) return;
      ul = el(doc, "ul");
      if (files.length === 0) ul.appendChild(messageItem(t("pathNoResult"), false));
      for (const file of files.slice(0, MAX_CHILD_ROWS)) ul.appendChild(docRow(info.box, file));
      if (files.length > MAX_CHILD_ROWS) ul.appendChild(messageItem(t("pathResultsTruncated", { n: MAX_CHILD_ROWS }), false));
    } catch (error) {
      if (destroyed) return;
      fail("Documents du chemin illisibles", error);
      state.failed = true;
      ul = messageList(readError(), true);
    } finally {
      state.loading = false;
      row.removeAttribute("data-loading");
    }
    state.ul = ul;
    row.after(ul);
    setOpen(row, true);
  }

  const toggleSafely = (row: HTMLElement): void => {
    toggleRow(row).catch((error: unknown) => fail("Dépliage du chemin en échec", error));
  };

  async function loadNotebooks(): Promise<void> {
    try {
      const notebooks = (await kernel.lsNotebooks(lifetime.signal)).filter((n) => !n.closed);
      if (destroyed) return;
      if (notebooks.length === 0) {
        tree.appendChild(messageList(t("pathNoResult"), false));
        return;
      }
      notebooks.forEach((notebook, index) => {
        const ul = el(doc, "ul", "b3-list b3-list--background");
        ul.appendChild(notebookRow(notebook, index === 0));
        tree.appendChild(ul);
      });
    } catch (error) {
      if (destroyed) return;
      fail("Cahiers SiYuan illisibles", error);
      tree.appendChild(messageList(readError(), true));
    }
  }

  // --- Sélection.
  const reveal = (row: HTMLElement): void => row.scrollIntoView?.({ block: "nearest" });
  const selectOnly = (row: HTMLElement): void => {
    for (const other of panel().querySelectorAll(`${ROW}.${FOCUS}`)) other.classList.remove(FOCUS);
    row.classList.add(FOCUS);
    cursor = row;
    reveal(row);
  };
  const toggleSelection = (row: HTMLElement): void => {
    cursor = row;
    if (!row.classList.contains(FOCUS)) {
      if (focusedRows().length >= MAX_SCOPES) {
        showTopError(t("pathDialogTooMany", { n: MAX_SCOPES }));
        return;
      }
      row.classList.add(FOCUS);
    } else if (focusedRows().length > 1) {
      row.classList.remove(FOCUS); // au moins une ligne reste sélectionnée
    }
  };

  const onRowClick = (e: MouseEvent): void => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>(ROW);
    if (!row) return;
    clearTopError();
    if (target.closest(".b3-list-item__toggle")) {
      toggleSafely(row);
    } else if (isMac() ? e.metaKey : e.ctrlKey) {
      toggleSelection(row);
    } else {
      selectOnly(row);
      // Un clic sur un cahier le déplie (sans jamais le replier : le toggle sert à cela).
      if (!searching && meta.get(row)?.path === "/" && !isOpen(row)) toggleSafely(row);
    }
    input.focus();
  };
  tree.addEventListener("click", onRowClick);
  list.addEventListener("click", onRowClick);

  // --- Clavier dans le champ.
  const moveSelection = (delta: 1 | -1): void => {
    const rows = visibleRows();
    if (rows.length === 0) return;
    const from = cursor ? rows.indexOf(cursor) : -1;
    const base = from >= 0 ? from : (() => {
      const last = focusedRows().at(-1);
      return last ? rows.indexOf(last) : -1;
    })();
    const next = base < 0 ? (delta === 1 ? 0 : rows.length - 1) : Math.min(Math.max(base + delta, 0), rows.length - 1);
    selectOnly(rows[next] as HTMLElement);
  };
  const currentRow = (): HTMLElement | undefined => {
    const rows = visibleRows();
    return cursor && rows.includes(cursor) ? cursor : focusedRows().at(-1);
  };
  const parentRow = (row: HTMLElement): HTMLElement | undefined => {
    const previous = row.parentElement?.previousElementSibling;
    return previous instanceof HTMLElement && previous.matches(ROW) ? previous : undefined;
  };
  const arrowRight = (): void => {
    const row = currentRow();
    if (!row || !hasToggle(row)) return;
    if (!isOpen(row)) {
      toggleSafely(row);
      return;
    }
    const next = visibleRows()[visibleRows().indexOf(row) + 1];
    if (next && next.parentElement === row.nextElementSibling) selectOnly(next);
  };
  const arrowLeft = (): void => {
    const row = currentRow();
    if (!row) return;
    if (hasToggle(row) && isOpen(row)) {
      toggleSafely(row);
      return;
    }
    const parent = parentRow(row);
    if (parent) selectOnly(parent);
  };

  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        moveSelection(e.key === "ArrowDown" ? 1 : -1);
        break;
      case "ArrowRight":
      case "ArrowLeft":
        if (searching) return; // le curseur du champ garde sa fonction
        e.preventDefault();
        if (e.key === "ArrowRight") arrowRight();
        else arrowLeft();
        break;
      case "Enter":
        e.preventDefault();
        void confirm();
        break;
      default:
    }
  });

  // --- Recherche.
  const showResults = (allHits: readonly DocSearchHit[], needle: string): void => {
    if (allHits.length === 0) {
      list.replaceChildren(messageItem(t("pathNoResult"), false));
      return;
    }
    const hits = allHits.slice(0, MAX_SEARCH_ROWS);
    const pattern = new RegExp(escapeRegExp(needle), "giu");
    const rows = hits.map((hit) => {
      const hPath = displayName(hit.hPath);
      const row = rowElement({ box: hit.box, path: hit.path, name: displayName(hit.title) }, false);
      const text = el(doc, "span", "b3-list-item__showall fn__flex-1", { style: "padding:4px 0;min-width:0" });
      let last = 0;
      for (const m of hPath.matchAll(pattern)) {
        if (m[0] === "") continue;
        if (m.index > last) text.append(hPath.slice(last, m.index));
        const mark = el(doc, "mark");
        mark.textContent = m[0];
        text.appendChild(mark);
        last = m.index + m[0].length;
      }
      if (last < hPath.length) text.append(hPath.slice(last));
      row.append(graphic(hit.boxIcon, hit.path === "/" ? "iconFilesRoot" : "iconFile"), text);
      return row;
    });
    if (allHits.length > MAX_SEARCH_ROWS) rows.push(messageItem(t("pathResultsTruncated", { n: MAX_SEARCH_ROWS }), false));
    list.replaceChildren(...rows);
  };
  const setSearching = (on: boolean): void => {
    searching = on;
    tree.classList.toggle("fn__none", on);
    list.classList.toggle("fn__none", !on);
    cursor = undefined;
  };
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelSearch = (): void => {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
    searchAbort?.abort();
    searchAbort = undefined;
  };
  // Un seul écouteur pour toute la vie du dialogue (jamais un par frappe) : sa fermeture coupe le délai et la requête en cours.
  lifetime.signal.addEventListener("abort", cancelSearch, { once: true });
  input.addEventListener("input", () => {
    const needle = input.value.trim();
    clearTopError();
    cancelSearch();
    const mine = ++searchSeq;
    if (needle === "") {
      setSearching(false);
      return;
    }
    if (!searching) setSearching(true);
    // Résultats de la saisie précédente retirés tout de suite, sélection comprise : rien de périmé ne reste confirmable.
    list.replaceChildren();
    cursor = undefined;
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      if (mine !== searchSeq || destroyed) return;
      const controller = new AbortController();
      searchAbort = controller;
      kernel.searchDocs(needle, controller.signal).then(
        (hits) => {
          if (mine === searchSeq && !destroyed) showResults(hits, needle);
        },
        (error: unknown) => {
          if (mine !== searchSeq || destroyed) return; // réponse périmée : ni message ni trace
          fail("Recherche de chemin en échec", error);
          list.replaceChildren(messageItem(readError(), true));
        },
      );
    }, SEARCH_DEBOUNCE_MS);
  });

  // --- Confirmation.
  async function scopesOf(rows: readonly HTMLElement[]): Promise<readonly DocumentScope[]> {
    const infos = rows.map((row) => meta.get(row)).filter((info): info is RowInfo => info !== undefined);
    // Une ligne sans métadonnée ne doit jamais être écartée en silence (la sélection appliquée serait plus petite que celle vue).
    if (infos.length !== rows.length) throw new Error("Ligne sélectionnée sans métadonnées de chemin");
    // Un appel par document : chaque libellé est associé à son chemin sans dépendre de l'ordre de la réponse.
    const labels = new Map<string, string>();
    await Promise.all(
      infos
        .filter((info) => info.path !== "/")
        .map(async (info) => {
          const answer = await kernel.getHPathsByPaths([info.path], lifetime.signal);
          const label = answer.length === 1 ? answer[0] : undefined;
          if (label === undefined || label === "") throw new Error("Le noyau n'a pas renvoyé le chemin lisible du document");
          labels.set(info.path, label);
        }),
    );
    const scopes = infos.map((info): DocumentScope =>
      info.path === "/"
        ? { kind: "notebook", box: info.box, label: info.name }
        : { kind: "document", box: info.box, docPath: info.path, label: labels.get(info.path) ?? "" },
    );
    const valid = normalizedScopes(scopes);
    if (valid === undefined) throw new Error("Sélection de chemins invalide");
    return valid;
  }

  async function confirm(): Promise<void> {
    if (confirming || !alive()) return;
    clearTopError();
    const rows = focusedRows();
    if (rows.length === 0) return;
    confirming = true;
    let applied = false;
    try {
      const scopes = await scopesOf(rows);
      if (!alive()) return; // fermé entre-temps (Échap, Annuler) : rien n'est appliqué
      deps.onConfirm(scopes);
      applied = true;
    } catch (error) {
      if (!alive()) return;
      fail("Chemins choisis non appliqués", error);
      showTopError(readError());
    } finally {
      confirming = false;
    }
    if (!applied) return;
    // Le filtre est appliqué : une fermeture qui échoue ne doit pas passer pour une erreur de lecture (trace seulement).
    try {
      handle?.close();
    } catch (error) {
      fail("Fermeture du dialogue du chemin en échec", error);
    }
  }

  cancel.addEventListener("click", () => handle?.close());
  confirmButton.addEventListener("click", () => void confirm());

  // --- Ouverture.
  const narrow = (doc.defaultView?.innerWidth ?? Infinity) < NARROW_WINDOW_PX;
  handle = deps.openCustomDialog({
    title: t("pathSpecify"),
    width: narrow ? "92vw" : "50vw",
    height: narrow ? "80vh" : "70vh",
    dataKey: "dialog-movepathto",
    content,
    onDestroyed: () => {
      destroyed = true;
      lifetime.abort();
      deps.onDestroyed?.();
    },
  });
  input.focus();
  void loadNotebooks();
  return handle;
}
