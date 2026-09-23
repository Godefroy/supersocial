import type { ConnectionDegree } from "../../core/provider.js";

/**
 * Source unique de vérité pour les fragments de DOM LinkedIn dépendants de la
 * langue: tokens de degré de relation et libellés de boutons d'action. La
 * session LinkedIn de l'utilisateur peut être en français, anglais ou allemand
 * selon son compte, donc chaque signal lexical y est décliné dans les trois
 * langues.
 *
 * Une partie du matching tourne dans le contexte navigateur (`page.evaluate`),
 * qui ne peut pas importer ce module. On y injecte donc les données
 * sérialisables (`DEGREE_TOKEN_ALT`, `LABELS`) en argument, et la fonction de
 * matching via sa source (`MATCHES_LABEL_SRC`), reconstruite avec `new Function`
 * (même patron que `findTopcardSrc`).
 */

// --- Degré de relation ---

/**
 * Alternation regex des tokens de degré, ensemble fermé et stable FR + EN + DE.
 * L'allemand rend le degré "1." / "2." / "3.+". À injecter dans une regex
 * ancrée selon le site (Topcard, aria-label, ligne de résultat de recherche).
 */
export const DEGREE_TOKEN_ALT = "1er|1ère|1st|1\\.|2e|2nd|2\\.|3e\\+?|3rd|3\\.\\+?";

/**
 * Mappe un token de degré extrait vers le degré canonique. Retourne `undefined`
 * si le token n'appartient pas à l'ensemble connu, à charge de l'appelant
 * d'appliquer sa valeur par défaut (`unknown`, heuristique bouton, etc.).
 */
export function degreeFromToken(token: string | null | undefined): ConnectionDegree | undefined {
  if (!token) return undefined;
  const t = token.trim().toLowerCase();
  if (t === "1er" || t === "1ère" || t === "1st" || t === "1.") return "1st";
  if (t === "2e" || t === "2nd" || t === "2.") return "2nd";
  if (t === "3e" || t === "3e+" || t === "3rd" || t === "3." || t === "3.+") return "3rd";
  return undefined;
}

/**
 * Libellé d'affichage (français) d'un degré canonique, pour le rendu des
 * tableaux de résultats. Inverse d'affichage de `degreeFromToken`.
 */
export function degreeLabel(degree: ConnectionDegree | null | undefined): string {
  switch (degree) {
    case "1st": return "1er";
    case "2nd": return "2e";
    case "3rd": return "3e";
    case "out-of-network": return "hors réseau";
    default: return "?";
  }
}

// --- Libellés de boutons d'action ---

/**
 * Spécification déclarative des libellés d'un bouton, par champ (`aria-label`
 * ou texte visible) et par mode (égalité, préfixe, sous-chaîne). Toutes les
 * valeurs sont en minuscules; `matchesLabel` normalise les entrées.
 */
export interface LabelSpec {
  ariaExact?: string[];
  ariaPrefix?: string[];
  ariaIncludes?: string[];
  textExact?: string[];
  textPrefix?: string[];
  textIncludes?: string[];
}

/**
 * Jeux de libellés localisés par action. Pensés comme des sur-ensembles sûrs
 * (aucun faux positif attendu sur une page profil), réutilisables tels quels
 * sur tous les sites qui détectent ou cliquent l'action correspondante.
 */
export const LABELS = {
  // Se connecter / Inviter / Vernetzen ("als Kontakt einladen").
  connect: {
    ariaPrefix: ["inviter "],
    textPrefix: ["inviter "],
    ariaIncludes: ["se connecter", "als kontakt einladen", "vernetzen"],
    textIncludes: ["se connecter", "vernetzen"],
  },
  // Message / Nachricht.
  message: {
    ariaPrefix: ["envoyer un message à"],
    ariaExact: ["message"],
    ariaIncludes: ["nachricht"],
    textExact: ["message", "nachricht"],
  },
  // Invitation en attente / Pending / Ausstehend.
  pending: {
    ariaIncludes: ["en attente", "pending", "ausstehend"],
    textExact: ["en attente", "pending", "ausstehend"],
  },
  // Menu "Plus" / "More actions" / "Mehr" (exact pour éviter les "Mehr anzeigen").
  more: {
    ariaExact: ["plus", "mehr"],
    ariaPrefix: ["plus d'actions", "more actions", "mehr aktion"],
  },
  // Ajouter une note / Add a note / Notiz hinzufügen.
  addNote: {
    ariaIncludes: ["ajouter une note", "notiz hinzufügen"],
    textIncludes: ["ajouter une note", "add a note", "notiz hinzufügen"],
  },
  // Envoyer l'invitation (bouton final de la modale), toutes variantes.
  send: {
    ariaExact: ["envoyer"],
    ariaIncludes: ["envoyer maintenant", "envoyer sans note", "ohne notiz senden"],
    textExact: ["envoyer", "send", "senden"],
    textIncludes: ["envoyer maintenant", "envoyer sans note", "send now", "send without", "ohne notiz senden"],
  },
  // Accepter une demande de connexion reçue / Accept / Annehmen. L'aria-label
  // porte en général le nom ("Accepter l'invitation de X", "Accept X's
  // invitation"), le texte visible est le verbe seul.
  accept: {
    ariaIncludes: ["accepter", "accept", "annehmen", "akzeptieren"],
    textExact: ["accepter", "accept", "annehmen", "akzeptieren"],
  },
  // Noyau "envoyer" (sous-chaîne), pour le bouton primaire et les checks de
  // présence/absence (modale prête, envoi confirmé, composer legacy).
  sendCore: {
    ariaIncludes: ["envoyer", "send", "senden"],
    textIncludes: ["envoyer", "send", "senden"],
  },
} satisfies Record<string, LabelSpec>;

/**
 * Teste si un couple (`aria-label`, texte visible) correspond à une spec de
 * libellé. Écrite sans dépendance externe pour être injectable en contexte
 * navigateur via `MATCHES_LABEL_SRC`.
 */
export function matchesLabel(ariaRaw: string, textRaw: string, spec: LabelSpec): boolean {
  const aria = (ariaRaw || "").toLowerCase();
  const text = (textRaw || "").toLowerCase().trim();
  const hit = (arr: string[] | undefined, fn: (v: string) => boolean): boolean =>
    Array.isArray(arr) && arr.some(fn);
  return (
    hit(spec.ariaExact, (v) => aria === v) ||
    hit(spec.ariaPrefix, (v) => aria.startsWith(v)) ||
    hit(spec.ariaIncludes, (v) => aria.includes(v)) ||
    hit(spec.textExact, (v) => text === v) ||
    hit(spec.textPrefix, (v) => text.startsWith(v)) ||
    hit(spec.textIncludes, (v) => text.includes(v))
  );
}

/**
 * Source de `matchesLabel` sans annotations TypeScript, à reconstruire dans un
 * `page.evaluate` via `new Function("return (" + MATCHES_LABEL_SRC + ")")()`.
 */
export const MATCHES_LABEL_SRC = `(ariaRaw, textRaw, spec) => {
  const aria = (ariaRaw || "").toLowerCase();
  const text = (textRaw || "").toLowerCase().trim();
  const hit = (arr, fn) => Array.isArray(arr) && arr.some(fn);
  return (
    hit(spec.ariaExact, (v) => aria === v) ||
    hit(spec.ariaPrefix, (v) => aria.startsWith(v)) ||
    hit(spec.ariaIncludes, (v) => aria.includes(v)) ||
    hit(spec.textExact, (v) => text === v) ||
    hit(spec.textPrefix, (v) => text.startsWith(v)) ||
    hit(spec.textIncludes, (v) => text.includes(v))
  );
}`;

// --- En-têtes de jour de la messagerie ---

const DAY_RELATIVE: Record<string, number> = {
  "aujourd'hui": 0, today: 0, heute: 0,
  hier: 1, yesterday: 1, gestern: 1,
};

// getDay(): 0 = dimanche.
const WEEKDAYS: Record<string, number> = {
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6,
};

// Préfixes de mois FR + EN + DE, sans accents. "juin/jun" et "juil/jul" se
// départagent sur leurs premières lettres, testées dans cet ordre.
const MONTH_PREFIXES: Array<[string, number]> = [
  ["janv", 1], ["jan", 1], ["fev", 2], ["feb", 2], ["mar", 3], ["avr", 4], ["apr", 4],
  ["mai", 5], ["may", 5], ["juin", 6], ["jun", 6], ["juil", 7], ["jul", 7],
  ["aou", 8], ["aug", 8], ["sep", 9], ["oct", 10], ["okt", 10], ["nov", 11],
  ["dec", 12], ["dez", 12],
];

function monthFromToken(token: string): number | undefined {
  return MONTH_PREFIXES.find(([p]) => token.startsWith(p))?.[1];
}

const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Convertit l'en-tête de jour d'un fil de messagerie ("Aujourd’hui", "Hier",
 * "lundi", "26 juin", "24 avr. 2025", "Jun 26", "Apr 24, 2025", "26. Juni")
 * en date ISO `YYYY-MM-DD`, relativement à `now`. Retourne `null` si le
 * libellé n'est pas reconnu.
 */
export function resolveDayHeading(label: string | null | undefined, now: Date = new Date()): string | null {
  if (!label) return null;
  const t = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .trim();

  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (t in DAY_RELATIVE) {
    day.setDate(day.getDate() - DAY_RELATIVE[t]!);
    return isoDay(day);
  }
  if (t in WEEKDAYS) {
    const back = (day.getDay() - WEEKDAYS[t]! + 7) % 7 || 7;
    day.setDate(day.getDate() - back);
    return isoDay(day);
  }

  const dayNum = t.match(/\b(\d{1,2})\b/)?.[1];
  const year = t.match(/\b(\d{4})\b/)?.[1];
  const monthToken = t.match(/\p{L}+/u)?.[0];
  const month = monthToken ? monthFromToken(monthToken) : undefined;
  if (!dayNum || !month) return null;

  const d = new Date(year ? Number(year) : now.getFullYear(), month - 1, Number(dayNum));
  // Sans année, LinkedIn désigne une date passée de l'année en cours.
  if (!year && d > now) d.setFullYear(d.getFullYear() - 1);
  return isoDay(d);
}
