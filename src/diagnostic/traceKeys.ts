/**
 * Diagnostic clavier (R6) : journalise le chemin d'un `keydown` (window, document, root, listes)
 * pour savoir où une touche est interceptée. Observateur pur : ne modifie jamais l'événement.
 * Aucune donnée utilisateur dans les lignes (ni valeur de champ, ni texte) : seulement balise, id et classes.
 * Aucun accès à SiYuan ; document et horloge sont injectables.
 */

export const DEFAULT_TRACE_KEYS: readonly string[] = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Enter",
  "Escape",
  "Tab",
];

export const LIST_SELECTOR = ".docseeker-list";

export interface TraceKeysOptions {
  readonly doc?: Document;
  /** Horloge en ms epoch (défaut : Date.now). */
  readonly now?: () => number;
  readonly keys?: readonly string[];
  /** Planifie le contrôle d'interception après le dispatch (défaut : setTimeout 0). */
  readonly defer?: (fn: () => void) => void;
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

function describeNode(node: unknown): string {
  if (node === null || node === undefined) return "none";
  const el = node as Partial<Element>;
  if (typeof el.tagName !== "string") return "non-element";
  const classes = (el.getAttribute?.("class") ?? "").trim().split(/\s+/).filter(Boolean).join(".");
  return `${el.tagName.toLowerCase()}#${el.id ?? ""}.${classes}`;
}

export function traceKeys(
  root: HTMLElement,
  log: (line: string) => void,
  options: TraceKeysOptions = {},
): () => void {
  const doc = options.doc ?? root.ownerDocument;
  const win = doc.defaultView;
  const now = options.now ?? Date.now;
  const keys = new Set(options.keys ?? DEFAULT_TRACE_KEYS);
  const defer = options.defer ?? ((fn: () => void) => void setTimeout(fn, 0));

  let nextId = 1;
  const ids = new WeakMap<Event, number>();
  const reachedRoot = new Set<number>();

  const emit = (phase: string, e: KeyboardEvent): void => {
    log(
      `${formatTime(now())} ${phase} key=${e.key} target=${describeNode(e.target)} ` +
        `active=${describeNode(doc.activeElement)} prevented=${e.defaultPrevented} stopped=unknown`,
    );
  };

  const idOf = (e: Event): number => {
    let id = ids.get(e);
    if (id === undefined) {
      id = nextId++;
      ids.set(e, id);
    }
    return id;
  };

  const wrap = (phase: string, onSeen?: (e: KeyboardEvent, id: number) => void) => (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (!keys.has(e.key)) return;
    emit(phase, e);
    onSeen?.(e, idOf(e));
  };

  const lists = new Set<Element>();
  const onListCapture = wrap("list capture", (_e, id) => reachedRoot.add(id));

  const watchLists = (): void => {
    for (const l of Array.from(root.querySelectorAll(LIST_SELECTOR))) {
      if (lists.has(l)) continue;
      lists.add(l);
      l.addEventListener("keydown", onListCapture, true);
    }
  };

  const onWindow = wrap("window capture", (e, id) => {
    const t = e.target;
    // Interception détectable seulement si root est sur le chemin de l'événement.
    if (!(t instanceof Node) || !root.contains(t)) return;
    defer(() => {
      const reached = reachedRoot.delete(id);
      if (!reached) log(`${formatTime(now())} INTERCEPTÉ avant root key=${e.key}`);
    });
  });
  const onDocument = wrap("document capture");
  const onRootCapture = wrap("root capture", (_e, id) => {
    reachedRoot.add(id);
    watchLists();
  });
  const onRootBubble = wrap("root bubble");

  watchLists();
  win?.addEventListener("keydown", onWindow, true);
  doc.addEventListener("keydown", onDocument, true);
  root.addEventListener("keydown", onRootCapture, true);
  root.addEventListener("keydown", onRootBubble, false);

  return () => {
    win?.removeEventListener("keydown", onWindow, true);
    doc.removeEventListener("keydown", onDocument, true);
    root.removeEventListener("keydown", onRootCapture, true);
    root.removeEventListener("keydown", onRootBubble, false);
    for (const l of lists) l.removeEventListener("keydown", onListCapture, true);
    lists.clear();
    reachedRoot.clear();
  };
}
