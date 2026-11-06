/**
 * Identifiants DOM uniques pour tout le document : le compteur est global au module, pas à une vue,
 * car deux vues peuvent coexister (onglet et fenêtre flottante) et partagent le même `document`.
 */
let sequence = 0;

export function nextUiId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}
