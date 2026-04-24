import type { BrowserContext } from "playwright";
import { sleep } from "../../../core/throttle.js";
import { hasLinkedInSession } from "../../../core/session.js";

const LOGIN_URL = "https://www.linkedin.com/login";

export interface LoginOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export async function runLinkedInLogin(
  context: BrowserContext,
  opts: LoginOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 2000;

  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());

  console.error("Ouverture de la page de login LinkedIn. Connecte-toi dans la fenêtre Chrome, je détecte la session automatiquement.");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasLinkedInSession(context)) {
      console.error("Session détectée, cookies persistés dans .chrome-profile/. Tu peux fermer la fenêtre (ou je la ferme dans 2s).");
      await sleep(2000);
      return;
    }
    await sleep(pollMs);
  }
  throw new Error("Timeout login: pas de cookie li_at détecté après 5min.");
}
