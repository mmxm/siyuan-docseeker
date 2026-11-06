// Générateur de PDF texte minimal (PDF 1.4, police Helvetica standard, WinAnsi), sans dépendance.
// Sert à fabriquer des PDF de test avec un vrai texte extractible. Sortie déterministe.

const A4 = [595, 842];

function checkNumber(value, what) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`makePdf : ${what} invalide (${String(value)})`);
}

function escapeText(text) {
  if (typeof text !== "string") throw new Error("makePdf : texte invalide (chaîne attendue)");
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") throw new Error("makePdf : saut de ligne interdit dans un texte (un texte = une ligne)");
    if (ch.codePointAt(0) > 255) throw new Error(`makePdf : caractère hors latin1 non pris en charge : ${JSON.stringify(ch)}`);
  }
  return text.replace(/[\\()]/g, "\\$&");
}

function contentStream(texts) {
  return texts
    .map(({ x, y, size, text }) => {
      checkNumber(x, "position x");
      checkNumber(y, "position y");
      checkNumber(size, "taille de police");
      if (size <= 0) throw new Error(`makePdf : taille de police invalide (${size}), > 0 attendu`);
      return `BT /F1 ${size} Tf ${x} ${y} Td (${escapeText(text)}) Tj ET`;
    })
    .join("\n");
}

/**
 * @param {{ pages: { width?: number, height?: number, texts: { x: number, y: number, size: number, text: string }[] }[] }} spec
 * @returns {Buffer}
 */
export function makePdf(spec) {
  if (!spec || !Array.isArray(spec.pages)) throw new Error("makePdf : `pages` (tableau) attendu");
  if (spec.pages.length === 0) throw new Error("makePdf : au moins une page est requise");
  const n = spec.pages.length;
  // Numéros d'objets : 1 catalogue, 2 arbre des pages, 3 police, puis (page, contenu) par page.
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${n} /Kids [${spec.pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  spec.pages.forEach((page, i) => {
    const width = page.width ?? A4[0];
    const height = page.height ?? A4[1];
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error(`makePdf : dimension de page invalide (${width} x ${height}), entiers > 0 attendus`);
    }
    if (!Array.isArray(page.texts)) throw new Error("makePdf : `texts` (tableau) attendu pour chaque page");
    const stream = contentStream(page.texts);
    objects[4 + 2 * i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
    objects[5 + 2 * i] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
