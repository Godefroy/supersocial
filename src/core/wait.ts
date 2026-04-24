import type { Page } from "playwright";
import { sleep } from "./throttle.js";
import { dumpPageState } from "./debug.js";

export interface WaitForRenderedOptions {
  timeoutMs?: number;
  pollMs?: number;
  stableForMs?: number;
  label?: string;
}

/**
 * Attendre qu'un prédicat (évalué côté navigateur) retourne un nombre > 0.
 * On attend aussi que ce nombre soit stable pendant `stableForMs` (anti-rerender).
 * Dump automatique à l'échec.
 */
export async function waitForRenderedCount(
  page: Page,
  predicate: string,
  opts: WaitForRenderedOptions = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const pollMs = opts.pollMs ?? 500;
  const stableForMs = opts.stableForMs ?? 1500;
  const label = opts.label ?? "wait-rendered";

  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  let stableSince: number | null = null;

  while (Date.now() < deadline) {
    let count = 0;
    try {
      count = (await page.evaluate(`(() => { try { return Number(${predicate}) || 0 } catch { return 0 } })()`)) as number;
    } catch {
      count = 0;
    }
    if (count > 0 && count === lastCount) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableForMs) return count;
    } else {
      stableSince = null;
    }
    lastCount = count;
    await sleep(pollMs);
  }

  await dumpPageState(page, `${label}-timeout`, { predicate, lastCount, timeoutMs });
  return lastCount;
}

export async function waitForDomSettled(page: Page, ms: number = 2000): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => { /* ignore */ });
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => { /* ignore */ });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => { /* ignore */ });
  await sleep(ms);
}
