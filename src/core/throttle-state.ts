import { join } from "node:path";
import { readJson, writeJson, ensureStateDir } from "./storage.js";
import type { ActionType } from "./throttle.js";

/**
 * Les actions comptabilisées correspondent aux types d'actions LinkedIn eux-mêmes
 * (voir BASE_PROFILES dans throttle.ts), pas aux commandes CLI supersocial.
 * Une seule commande peut consommer plusieurs actions (ex: posts:sync consomme un
 * `profile_view`).
 */
export type CountedAction = ActionType;

/**
 * Limites journalières volontairement sous les "safe limits" publics pour un
 * compte établi (source: recoupement growth tools Waalaxy, Expandi, PhantomBuster).
 */
const DAILY_LIMITS: Record<CountedAction, number> = {
  invite: 15,
  dm: 40,
  profile_view: 80,
  like: 30,
  comment: 10,
  post: 5,
  search: 15,
  read: 300,
};

interface DailyCounters {
  // Clé: "YYYY-MM-DD"
  [date: string]: Partial<Record<CountedAction, number>>;
}

const STATE_FILE = () => join(ensureStateDir(), "throttle-counters.json");

function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function pruneOld(state: DailyCounters, keepDays: number = 35): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffIso = isoDate(cutoff);
  for (const date of Object.keys(state)) {
    if (date < cutoffIso) delete state[date];
  }
}

export class ThrottleLimitError extends Error {
  constructor(
    public readonly action: CountedAction,
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(
      `Limite journalière atteinte pour "${action}": ${current}/${limit}. Réessaye demain ou ajuste DAILY_LIMITS dans src/core/throttle-state.ts si tu assumes le risque.`,
    );
    this.name = "ThrottleLimitError";
  }
}

export function getTodayCount(action: CountedAction): number {
  const state = readJson<DailyCounters>(STATE_FILE()) ?? {};
  const today = state[isoDate()];
  return today?.[action] ?? 0;
}

export function checkAndRecord(action: CountedAction): void {
  const state = readJson<DailyCounters>(STATE_FILE()) ?? {};
  const today = isoDate();
  const day = state[today] ?? {};
  const current = day[action] ?? 0;
  const limit = DAILY_LIMITS[action];
  if (current >= limit) {
    throw new ThrottleLimitError(action, current, limit);
  }
  day[action] = current + 1;
  state[today] = day;
  pruneOld(state);
  writeJson(STATE_FILE(), state);
}

export function getDailyLimits(): Record<CountedAction, number> {
  return { ...DAILY_LIMITS };
}
