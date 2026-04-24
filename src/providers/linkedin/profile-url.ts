/**
 * Nettoie une URL de profil LinkedIn en retirant les query params et le fragment,
 * pour ne garder que la forme canonique `https://www.linkedin.com/in/slug/` ou
 * `https://www.linkedin.com/company/slug/`.
 */
export function cleanProfileUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, "https://www.linkedin.com");
    u.search = "";
    u.hash = "";
    // Normalise le pathname pour terminer par `/`
    if (!u.pathname.endsWith("/")) u.pathname += "/";
    return u.toString();
  } catch {
    return raw;
  }
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
