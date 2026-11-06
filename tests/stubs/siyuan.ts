// Stub résolu à la place du paquet `siyuan` (types seulement) ; les tests le remplacent via vi.mock.
export class Plugin {}
export const openTab = (): void => undefined;
export const showMessage = (): void => undefined;
export const confirm = (_title: string, _text: string, onConfirm?: () => void): void => onConfirm?.();
/** Enregistre ses items ; `open()` appelle `createActionElement` de chacun (comme SiYuan à l'ouverture, d'après les types). */
export class Setting {
  readonly items: { title: string; createActionElement?: () => HTMLElement; actionElement?: HTMLElement }[] = [];
  constructor(public readonly options: { destroyCallback?: () => void } = {}) {}
  addItem(item: { title: string; createActionElement?: () => HTMLElement; actionElement?: HTMLElement }): void {
    this.items.push(item);
  }
  open(_name: string): void {
    for (const item of this.items) item.createActionElement?.();
  }
}
