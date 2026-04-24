import type { BrowserContext } from "playwright";

/**
 * Charge la session LinkedIn depuis le profil Chrome persistant.
 * La session est créée par `supersocial linkedin login` (navigateur Chrome
 * ouvert, connexion manuelle, cookies persistés automatiquement par Playwright
 * dans `.chrome-profile/`).
 */
export async function hasLinkedInSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://www.linkedin.com");
  return cookies.some((c) => c.name === "li_at" && c.value.length > 0);
}
