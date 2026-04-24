/**
 * Les activity URN LinkedIn sont des snowflake 64 bits dont les 41 bits de poids
 * fort encodent le timestamp de création en ms depuis l'epoch Unix (méthode
 * documentée sur linkedindateextractor.com). Un shift de 22 bits à droite donne
 * directement la date. ugcPost et share URNs utilisent le même encodage.
 */
export function decodeSnowflakeTimestamp(id: string): string | null {
  try {
    const cleaned = id.replace(/^urn:li:[a-zA-Z_]+:/, "").trim();
    if (!/^\d+$/.test(cleaned)) return null;
    const n = BigInt(cleaned);
    const ms = Number(n >> 22n);
    if (ms < 1_000_000_000_000 || ms > Date.now() + 24 * 3600 * 1000) return null;
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/** Alias conservé pour compatibilité; l'encodage est identique pour tous les URN. */
export const decodeActivityTimestamp = decodeSnowflakeTimestamp;

/**
 * Parse un label relatif LinkedIn ("3 h •", "1 mois", "2 sem.", "45 min") et
 * retourne une date ISO approximative. La précision dépend de l'unité (exacte
 * pour s/min/h, jour pour j/sem, mois pour mois/an).
 */
export function parseRelativeLabel(label: string, now: Date = new Date()): string | null {
  const m = label.match(/^(\d+)\s*(s|min|h|j|sem|mois|an|y|mo|w|d|hr|hour|day|week|month|year|second)\b/i);
  if (!m || !m[1] || !m[2]) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const d = new Date(now);
  switch (unit) {
    case "s":
    case "second":
      d.setSeconds(d.getSeconds() - n);
      break;
    case "min":
      d.setMinutes(d.getMinutes() - n);
      break;
    case "h":
    case "hr":
    case "hour":
      d.setHours(d.getHours() - n);
      break;
    case "j":
    case "d":
    case "day":
      d.setDate(d.getDate() - n);
      break;
    case "sem":
    case "w":
    case "week":
      d.setDate(d.getDate() - n * 7);
      break;
    case "mois":
    case "mo":
    case "month":
      d.setMonth(d.getMonth() - n);
      break;
    case "an":
    case "y":
    case "year":
      d.setFullYear(d.getFullYear() - n);
      break;
    default:
      return null;
  }
  return d.toISOString();
}
