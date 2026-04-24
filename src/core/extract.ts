import type { Page } from "playwright";
import { sleep } from "./throttle.js";
import { dumpPageState } from "./debug.js";

export interface SafeEvalOptions {
  retries?: number;
  delayMs?: number;
  label?: string;
  dumpOnFailure?: boolean;
  dumpMeta?: Record<string, unknown>;
}

/**
 * Exécuter une évaluation côté navigateur en résistant aux navigations concurrentes
 * et au bug tsx/esbuild `__name is not defined`. Dump auto sur échec final.
 */
export async function safeEval<R>(
  page: Page,
  fn: () => R,
  opts: SafeEvalOptions = {},
): Promise<R | null> {
  const retries = opts.retries ?? 4;
  const delayMs = opts.delayMs ?? 1500;
  const label = opts.label ?? "safe-eval";

  let lastErr: unknown = null;
  for (let i = 0; i < retries; i++) {
    try {
      await page.evaluate(() => {
        const w = window as unknown as { __name?: (f: unknown) => unknown };
        if (!w.__name) w.__name = (f) => f;
      });
      return (await page.evaluate(fn)) as R;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient =
        msg.includes("Execution context was destroyed") ||
        msg.includes("Target closed") ||
        msg.includes("navigating and changing");
      if (!transient) break;
      await sleep(delayMs);
    }
  }

  if (opts.dumpOnFailure !== false) {
    await dumpPageState(page, `${label}-failed`, {
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      ...(opts.dumpMeta ?? {}),
    });
  }
  return null;
}
