/**
 * Session de recherche en mémoire : la dernière requête soumise et les options (tri, filtres), partagées entre la
 * fenêtre flottante (qui les restaure à chaque ouverture) et le transfert vers un onglet. Module pur.
 *
 * Aucun instantané du modèle de vue : à la restauration, la recherche est RELANCÉE (l'index a pu changer). Sans requête
 * soumise (`query` vide), seules les options sont restaurées. Rien n'est persisté : les filtres sont de l'état de session.
 */
import type { SearchOptions } from "./resultOptions";

export interface SearchSessionState {
  readonly query: string;
  readonly options: SearchOptions;
}

export interface SearchSessionStore {
  /** Copie de l'état mémorisé ; `undefined` si rien n'a été mémorisé. */
  get(): SearchSessionState | undefined;
  /** Remplace entièrement l'état (copié : l'appelant peut réutiliser ses objets). */
  set(state: SearchSessionState): void;
  clear(): void;
}

const copy = (state: SearchSessionState): SearchSessionState => ({
  query: state.query,
  options: {
    sort: { ...state.options.sort },
    filters: {
      ...state.options.filters,
      ...(state.options.filters.scope ? { scope: { ...state.options.filters.scope } } : {}),
    },
  },
});

export function createSearchSessionStore(): SearchSessionStore {
  let current: SearchSessionState | undefined;
  return {
    get: () => (current ? copy(current) : undefined),
    set(state) {
      current = copy(state);
    },
    clear() {
      current = undefined;
    },
  };
}
