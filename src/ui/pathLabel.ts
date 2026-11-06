/**
 * Dossier qui contient un PDF : le chemin jusqu'au dernier « / » inclus, sans le nom du fichier
 * (« /assets/sous/doc.pdf » -> « /assets/sous/ »). Fonction pure, sans normalisation Unicode :
 * le texte est restitué tel quel. Un chemin sans « / » n'a pas de dossier (chaîne vide).
 */
export function containingFolder(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}
