import { chromium as chromiumExtra } from "playwright-extra";
import { chromium as chromiumPlain } from "playwright";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { BrowserContext } from "playwright";
import { mkdirSync } from "node:fs";
import { config } from "./config.js";

const useStealth = process.env.SUPERSOCIAL_STEALTH !== "false";

let stealthRegistered = false;

function ensureStealth(): void {
  if (stealthRegistered) return;
  chromiumExtra.use(StealthPlugin());
  stealthRegistered = true;
}

export interface BrowserLaunchOptions {
  headless?: boolean;
  locale?: string;
  timezone?: string;
  viewport?: { width: number; height: number };
}

export async function launchPersistentChrome(opts: BrowserLaunchOptions = {}): Promise<BrowserContext> {
  if (useStealth) ensureStealth();
  mkdirSync(config.chromeProfileDir, { recursive: true });

  const launcher = useStealth ? chromiumExtra : chromiumPlain;

  const context = await launcher.launchPersistentContext(config.chromeProfileDir, {
    channel: "chrome",
    headless: opts.headless ?? config.headless,
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    locale: opts.locale ?? "fr-FR",
    timezoneId: opts.timezone ?? config.timezone,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  await context.addInitScript(() => {
    const w = globalThis as unknown as { __name?: (fn: unknown) => unknown };
    if (!w.__name) w.__name = (fn: unknown) => fn;
  });

  return context;
}

export async function closeContext(context: BrowserContext): Promise<void> {
  try {
    await context.close();
  } catch {
    // best-effort
  }
}
