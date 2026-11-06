// Corpus de PDF de test : texte réel, sous-dossiers, plusieurs pages, tailles variées, un paysage. Déterministe.
import { makePdf } from "./makePdf.mjs";

const line = (y, size, text, x = 56) => ({ x, y, size, text });

function doc(title, bodyPages, { landscape = false } = {}) {
  const width = landscape ? 842 : 595;
  const height = landscape ? 595 : 842;
  return makePdf({
    pages: bodyPages.map((body, p) => ({
      width,
      height,
      texts: [
        line(height - 70, p === 0 ? 28 : 16, p === 0 ? title : `${title} - page ${p + 1}`),
        ...body.map((t, i) => line(height - 120 - i * 22, i % 4 === 3 ? 18 : 11, t)),
      ],
    })),
  });
}

const TEMPLATES = [
  ["assets/rapport-annuel.pdf", () => doc("Rapport annuel", [
    ["Le contrat principal a été renouvelé cette année.", "Les résultats financiers progressent de douze pour cent.", "Perspectives et budget prévisionnel.", "Synthèse générale"],
    ["Analyse détaillée du budget et des dépenses.", "Le contrat de maintenance reste inchangé.", "Annexes disponibles sur demande."],
    ["Conclusion : la facture moyenne baisse légèrement.", "Merci de votre attention."],
  ])],
  ["assets/contrats/contrat-bail.pdf", () => doc("Contrat de bail", [
    ["Entre le bailleur et le locataire, il est convenu ce qui suit.", "Article premier : durée du contrat de location.", "Le loyer mensuel est payable d'avance.", "Conditions générales"],
    ["Article deux : charges, dépôt de garantie et préavis.", "Le contrat peut être résilié avec un préavis de trois mois."],
  ])],
  ["assets/contrats/archives/2019/facture-2019-014.pdf", () => doc("Facture 2019-014", [
    ["Facture numéro 2019-014, date : 12 mars 2019.", "Désignation : prestation de conseil, 12 heures.", "Montant total hors taxes et taxe sur la valeur ajoutée.", "Total à payer"],
  ])],
  ["assets/recettes/tarte-aux-pommes.pdf", () => doc("Tarte aux pommes", [
    ["Ingrédients : pommes, farine, beurre, sucre et un peu de cannelle.", "Étaler la pâte, disposer les pommes en rosace.", "Cuire quarante minutes à cent quatre-vingts degrés.", "Bon appétit"],
    ["Astuce : un peu de citron évite que les pommes noircissent."],
  ])],
  ["assets/cours/mecanique-quantique.pdf", () => doc("Mécanique quantique", [
    ["Introduction : la fonction d'onde décrit l'état d'un système.", "L'équation de Schrödinger gouverne son évolution.", "Un principe d'incertitude limite la précision des mesures.", "Chapitre un"],
    ["Opérateurs hermitiens et valeurs propres.", "Exemple : l'oscillateur harmonique."],
    ["Exercices corrigés et rappel du contrat pédagogique."],
    ["Bibliographie sélective."],
  ])],
  ["assets/presentations/plan-strategique.pdf", () => doc("Plan stratégique", [
    ["Objectifs : croissance, qualité, budget maîtrisé.", "Le contrat cadre sera renégocié au troisième trimestre.", "Indicateurs de suivi mensuels.", "Vision"],
    ["Calendrier des jalons et responsables."],
  ], { landscape: true })],
  ["assets/notes/reunion-du-lundi.pdf", () => doc("Notes de réunion", [
    ["Présents : toute l'équipe, sauf deux personnes en congé.", "Point sur la facture en retard et le contrat de sous-traitance.", "Prochaine réunion : lundi à neuf heures.", "Actions"],
  ])],
  ["assets/voyage/itineraire-japon.pdf", () => doc("Itinéraire", [
    ["Jour un : arrivée à l'aéroport, train vers le centre.", "Jour deux : temples, jardins et marché du matin.", "Réserver les billets de train à l'avance.", "Conseils"],
    ["Budget estimé par jour et par personne."],
  ])],
];

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];

/** @param {number} n nombre de PDF (>= 1) */
export function makeCorpus(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`pdfs invalide : ${n} (entier >= 1 attendu)`);
  const files = [];
  for (let i = 0; i < n; i++) {
    if (i < TEMPLATES.length) {
      files.push({ relPath: TEMPLATES[i][0], bytes: TEMPLATES[i][1]() });
    } else {
      const k = i - TEMPLATES.length + 1;
      const word = WORDS[k % WORDS.length];
      files.push({
        relPath: `assets/extra/lot-${Math.ceil(k / 10)}/document-${String(k).padStart(3, "0")}.pdf`,
        bytes: doc(`Document ${k}`, [[`Texte du document ${k} : mot ${word}, contrat et facture.`, "Ligne de remplissage numéro deux.", "Ligne de remplissage numéro trois.", "Titre de section"]]),
      });
    }
  }
  return files;
}
