/**
 * Point unique de manipulation des URLs de comptes LinkedIn.
 *
 * Un slug de profil peut contenir des caractères non-ASCII (accents, emoji):
 * LinkedIn les sert percent-encodés (`/in/michael-disdero-%F0%9F%8C%80-.../`)
 * mais un copier-coller, un `decodeURIComponent` d'extraction ou une
 * sérialisation YAML/JSON les ramènent sous d'autres formes. On tranche ici:
 * la forme canonique stockée et navigable est percent-encodée, la forme
 * décodée sert uniquement aux libellés lisibles.
 */

const LINKEDIN_BASE = "https://www.linkedin.com";
const PROFILE_PATH_RE = /\/in\/([^/?#]+)/i;

/**
 * Reconstruit les caractères derrière les échappements textuels `\uXXXX`,
 * `\u{XXXXX}`, `\UXXXXXXXX` et `\xNN` qu'un copier-coller de YAML, de JSON ou
 * d'un `repr` Python laisse dans une URL. Une séquence hors plage Unicode est
 * conservée telle quelle plutôt que de faire échouer tout l'input.
 */
function decodeTextEscapes(input: string): string {
  if (!input.includes("\\")) return input;
  const toChar = (hex: string, original: string): string => {
    const cp = Number.parseInt(hex, 16);
    if (!Number.isFinite(cp) || cp > 0x10ffff) return original;
    try {
      return String.fromCodePoint(cp);
    } catch {
      return original;
    }
  };
  return input
    .replace(/\\U([0-9a-fA-F]{8})/g, (m, hex: string) => toChar(hex, m))
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, hex: string) => toChar(hex, m))
    .replace(/\\u([0-9a-fA-F]{4})/g, (m, hex: string) => toChar(hex, m))
    .replace(/\\x([0-9a-fA-F]{2})/g, (m, hex: string) => toChar(hex, m));
}

/**
 * Répare un input avant tout parsing: espaces autour, guillemets encadrants
 * (une valeur YAML/JSON recollée telle quelle) et échappements textuels.
 */
export function normalizeUrlInput(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  while (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    s = s.slice(1, -1).trim();
  }
  return decodeTextEscapes(s);
}

/** Forme lisible d'un slug (emoji et accents rendus tels quels). */
export function decodeProfileSlug(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/** Forme canonique d'un slug: ASCII percent-encodé, sans double encodage. */
export function encodeProfileSlug(slug: string): string {
  return encodeURIComponent(decodeProfileSlug(slug));
}

/** Slug lisible extrait d'une URL profil, pour les libellés et les noms de fichiers dérivés. */
export function extractProfileSlug(input: string | null | undefined): string | null {
  const m = normalizeUrlInput(input).match(PROFILE_PATH_RE);
  return m?.[1] ? decodeProfileSlug(m[1]) : null;
}

/** Slug canonique ASCII, à utiliser comme clé de cache ou de fichier. */
export function profileSlugKey(input: string | null | undefined): string | null {
  const m = normalizeUrlInput(input).match(PROFILE_PATH_RE);
  return m?.[1] ? encodeProfileSlug(m[1]) : null;
}

/** URL profil canonique, ou null quand l'input ne porte pas de chemin `/in/<slug>`. */
export function tryCanonicalProfileUrl(input: string | null | undefined): string | null {
  const slug = profileSlugKey(input);
  return slug ? `${LINKEDIN_BASE}/in/${slug}/` : null;
}

/** Idem, en erreur explicite quand l'input n'est pas une URL profil exploitable. */
export function canonicalProfileUrl(input: string): string {
  const url = tryCanonicalProfileUrl(input);
  if (!url) {
    throw new Error(
      `URL profil invalide: ${input}. Format attendu: https://www.linkedin.com/in/<slug>/`,
    );
  }
  return url;
}

/**
 * Nettoie une URL LinkedIn en retirant les query params et le fragment, pour
 * ne garder que la forme canonique `https://www.linkedin.com/in/slug/` ou
 * `https://www.linkedin.com/company/slug/`.
 */
export function cleanProfileUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const input = normalizeUrlInput(raw);
  if (!input) return null;
  const profile = tryCanonicalProfileUrl(input);
  if (profile) return profile;
  try {
    const u = new URL(input, LINKEDIN_BASE);
    u.search = "";
    u.hash = "";
    // Normalise le pathname pour terminer par `/`
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.toString();
  } catch {
    return input;
  }
}

/**
 * Forme comparable d'un destinataire outbox ou invitation. Une URL profil
 * devient canonique, une URL thread ou un thread ID restent tels quels après
 * nettoyage, ce qui garde la dédup fiable quel que soit l'encodage saisi.
 */
export function canonicalRecipient(raw: string | null | undefined): string {
  const input = normalizeUrlInput(raw);
  return tryCanonicalProfileUrl(input) ?? input;
}

/** Compare deux destinataires sur leur forme canonique. */
export function sameRecipient(a: string | null | undefined, b: string | null | undefined): boolean {
  return canonicalRecipient(a) === canonicalRecipient(b);
}

/**
 * Extrait l'URN interne du profil depuis une URL LinkedIn. LinkedIn ajoute
 * souvent `?miniProfileUrn=urn:li:fsd_profile:ACoAAA...` aux liens auteur.
 */
export function extractProfileUrn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/(urn:li:fsd_profile:[A-Za-z0-9_-]+)/);
  return m?.[1] ?? null;
}
