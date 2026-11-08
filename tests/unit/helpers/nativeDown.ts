// Banc commun des tests mobiles : le visionneur natif de SiYuan est indisponible (éditeur absent), donc les tests de repli
// exercent les replis. `openPdfAtPage` factice appelle son `openTab` (= openNativePdf) comme le vrai ; l'erreur remonte à l'onglet.
import { vi } from "vitest";

export const nativeDown = () => ({
  openNativePdf: vi.fn(async () => {
    throw new Error("éditeur mobile absent (test)");
  }) as never,
  openPdfAtPage: vi.fn(async (options: { openTab: (target: unknown) => unknown }) => {
    await options.openTab({});
    throw new Error("inatteignable");
  }) as never,
});
