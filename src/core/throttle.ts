import type { Page } from "playwright";
import { config } from "./config.js";

export type ActionType =
  | "invite"
  | "dm"
  | "profile_view"
  | "like"
  | "comment"
  | "post"
  | "search"
  | "read";

interface ProfileSpec {
  meanMs: number;
  stdMs: number;
  minMs: number;
  maxMs: number;
}

const BASE_PROFILES: Record<ActionType, ProfileSpec> = {
  invite: { meanMs: 120_000, stdMs: 60_000, minMs: 30_000, maxMs: 400_000 },
  dm: { meanMs: 180_000, stdMs: 80_000, minMs: 45_000, maxMs: 500_000 },
  profile_view: { meanMs: 35_000, stdMs: 20_000, minMs: 10_000, maxMs: 120_000 },
  like: { meanMs: 25_000, stdMs: 15_000, minMs: 8_000, maxMs: 80_000 },
  comment: { meanMs: 60_000, stdMs: 30_000, minMs: 20_000, maxMs: 180_000 },
  post: { meanMs: 300_000, stdMs: 120_000, minMs: 90_000, maxMs: 900_000 },
  search: { meanMs: 8_000, stdMs: 4_000, minMs: 3_000, maxMs: 25_000 },
  read: { meanMs: 6_000, stdMs: 3_000, minMs: 2_000, maxMs: 20_000 },
};

const PROFILE_MULTIPLIERS: Record<"conservative" | "normal" | "aggressive", number> = {
  conservative: 1.3,
  normal: 1.0,
  aggressive: 0.6,
};

function gaussian(mean: number, std: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + std * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function humanDelayMs(action: ActionType): number {
  const spec = BASE_PROFILES[action];
  const mult = PROFILE_MULTIPLIERS[config.throttleProfile];
  const mean = spec.meanMs * mult;
  const std = spec.stdMs * mult;
  for (let i = 0; i < 20; i++) {
    const d = gaussian(mean, std);
    if (d >= spec.minMs && d <= spec.maxMs) return Math.round(d);
  }
  return Math.round(mean);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function humanPause(action: ActionType): Promise<void> {
  await sleep(humanDelayMs(action));
}

export function isWorkingWindow(now: Date = new Date()): boolean {
  const zoned = new Date(now.toLocaleString("en-US", { timeZone: config.timezone }));
  const day = zoned.getDay();
  const hour = zoned.getHours();
  if (day === 0 || day === 6) return Math.random() < 0.15;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

export async function waitForWorkingWindow(): Promise<void> {
  while (!isWorkingWindow()) {
    await sleep(5 * 60 * 1000);
  }
}

const HARD_RATE_LIMIT_STATUSES = new Set([429, 999]);
const RED_FLAG_PHRASES = [
  "weekly invitation limit",
  "unusual activity",
  "visiting a very high number",
  "verify your identity",
  "restricted your account",
  "votre compte a été restreint",
];

export class RateLimitHitError extends Error {
  constructor(
    public readonly reason: string,
    public readonly url?: string,
    public readonly status?: number,
  ) {
    super(`Rate limit hit: ${reason}${status ? ` (status ${status})` : ""}${url ? ` on ${url}` : ""}`);
    this.name = "RateLimitHitError";
  }
}

/**
 * Levée quand LinkedIn refuse de rendre le composer DM et le remplace par
 * l'upsell Premium/InMail (cas typique: 2e/3e degré sans Premium, ou
 * restriction temporaire sur le compte après un burst de compose-DM). Le
 * symptôme côté DOM est `.card-upsell-v2__headline` présent et `.msg-form`
 * absent. À traiter comme un signal "stop le batch", car les autres items
 * non-1ère relation auront le même sort dans la même session.
 */
export class LinkedInDmRestrictedError extends Error {
  constructor(
    public readonly recipient: string,
    public readonly headline?: string,
  ) {
    super(
      `DM refusé par LinkedIn (upsell Premium/InMail affiché) pour ${recipient}${headline ? `: "${headline}"` : ""}. La cible n'est probablement pas en 1ère relation, ou le compte est temporairement restreint suite à un burst d'envois.`,
    );
    this.name = "LinkedInDmRestrictedError";
  }
}

export interface KillSwitchState {
  tripped: RateLimitHitError | null;
}

export function attachKillSwitch(page: Page): KillSwitchState {
  const state: KillSwitchState = { tripped: null };
  page.on("response", (resp) => {
    if (state.tripped) return;
    const status = resp.status();
    const url = resp.url();
    if (HARD_RATE_LIMIT_STATUSES.has(status)) {
      state.tripped = new RateLimitHitError("HTTP status", url, status);
    }
  });
  return state;
}

export function assertKillSwitchOk(state: KillSwitchState): void {
  if (state.tripped) throw state.tripped;
}

export async function checkPageForRedFlags(page: Page): Promise<void> {
  let bodyText = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      bodyText = (await page.evaluate(() => document.body.innerText ?? "")).toLowerCase();
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Execution context was destroyed") || msg.includes("navigating")) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      return;
    }
  }
  for (const phrase of RED_FLAG_PHRASES) {
    if (bodyText.includes(phrase)) {
      throw new RateLimitHitError(`Red flag phrase: "${phrase}"`, page.url());
    }
  }
}
