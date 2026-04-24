import type { Page } from "playwright";
import { createHash } from "node:crypto";
import type { Post, PostMedia } from "../../core/provider.js";
import { sleep, humanPause } from "../../core/throttle.js";
import { safeEval } from "../../core/extract.js";
import { dumpPageState } from "../../core/debug.js";
import { decodeActivityTimestamp, parseRelativeLabel } from "./urn.js";

export async function humanScroll(page: Page): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.mouse.move(vp.width / 2, vp.height / 2);
  const delta = 700 + Math.floor(Math.random() * 500);
  await page.mouse.wheel(0, delta);
  await humanPause("read");
}

export async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement ?? document.body;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" });
  });
  await page.keyboard.press("End").catch(() => undefined);
  await sleep(2500);
}

export async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await sleep(500);
}

async function getVisibleActivityIds(page: Page): Promise<string[]> {
  const ids = await page
    .evaluate(() => {
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-urn]"))) {
        const v = el.getAttribute("data-urn") ?? "";
        const m = v.match(/urn:li:(?:activity|ugcPost|share|fsd_post):(\d+)/);
        if (m?.[1]) out.push(m[1]);
      }
      return out;
    })
    .catch(() => [] as string[]);
  return Array.isArray(ids) ? ids : [];
}

export async function countPostOptionButtons(page: Page): Promise<number> {
  const n = await page
    .evaluate(
      () =>
        document.querySelectorAll(
          '[aria-label*="post de "], [aria-label*="post by "], [aria-label*="post of "]',
        ).length,
    )
    .catch(() => 0);
  return typeof n === "number" ? n : 0;
}

/**
 * Clique un à un tous les boutons dont le texte match un des patterns fournis.
 * Smooth-scroll chaque bouton jusqu'au viewport avant clic (comportement humain).
 * Retourne le nombre de clics effectifs.
 */
export async function clickButtonsByText(
  page: Page,
  patterns: RegExp[],
): Promise<number> {
  const sources = patterns.map((p) => p.source);
  const clicked = await page
    .evaluate(
      async ({ sources }) => {
        const regexes = sources.map((s: string) => new RegExp(s, "i"));
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>("button, span[role='button']"),
        );
        let c = 0;
        for (const n of nodes) {
          const text = (n.innerText ?? "").trim();
          if (!regexes.some((r) => r.test(text))) continue;
          try {
            n.scrollIntoView({ behavior: "smooth", block: "center" });
            await wait(500 + Math.random() * 500);
            n.click();
            c++;
            await wait(250 + Math.random() * 350);
          } catch {
            /* ignore */
          }
        }
        return c;
      },
      { sources },
    )
    .catch(() => 0);
  return typeof clicked === "number" ? clicked : 0;
}

const SEE_MORE_PATTERNS = [
  /^(…\s*plus|\.\.\.?\s*plus)$/,
  /^(…\s*see more|\.\.\.?\s*see more)$/,
  /^(…\s*more|\.\.\.?\s*more)$/,
  /^voir plus$/,
  /^see more$/,
];

export async function expandAllSeeMore(page: Page): Promise<number> {
  return clickButtonsByText(page, SEE_MORE_PATTERNS);
}

export interface LoadAndExtractOptions {
  targetCount: number;
  label: string;
  initialWaitMs?: number;
  loadTimeoutMs?: number;
  maxPlateau?: number;
  /**
   * Si fourni, la phase de load s'arrête dès qu'un batch ne contient plus que
   * des URNs déjà connus (tous les activity IDs visibles sont dans ce set).
   * Utile pour la synchro incrémentale.
   */
  stopWhenAllKnown?: Set<string>;
}

/**
 * Pipeline complet de collecte de posts sur une page déjà chargée:
 * 1. Scroll jusqu'à atteindre `targetCount` boutons d'options OU plateau
 * 2. Remonter en haut et expand tous les "...plus"
 * 3. Extraire via aria-label du bouton d'options
 * 4. Matérialiser en Post[] (ID via URN ou synthetic hash, date décodée de l'URN)
 */
export async function loadAndExtractPosts(
  page: Page,
  opts: LoadAndExtractOptions,
): Promise<Post[]> {
  const debug = process.env.SUPERSOCIAL_DEBUG === "true";
  const initialWaitMs = opts.initialWaitMs ?? 5000;
  const loadTimeoutMs = opts.loadTimeoutMs ?? 60_000;
  const maxPlateau = opts.maxPlateau ?? 3;

  await sleep(initialWaitMs);

  // Phase 1
  const deadline = Date.now() + loadTimeoutMs;
  let lastCount = 0;
  let plateauStreak = 0;
  while (Date.now() < deadline) {
    const count = await countPostOptionButtons(page);
    if (debug) console.error(`[${opts.label}.load] posts=${count} target=${opts.targetCount} plateau=${plateauStreak}`);
    if (count >= opts.targetCount) break;

    // Mode incrémental: stop dès qu'on ne trouve plus que des URNs déjà connus
    if (opts.stopWhenAllKnown) {
      const visibleUrns = await getVisibleActivityIds(page);
      if (visibleUrns.length > 0 && visibleUrns.every((id) => opts.stopWhenAllKnown!.has(id))) {
        if (debug) console.error(`[${opts.label}.load] incremental: tous les ${visibleUrns.length} URNs visibles sont connus, arrêt`);
        break;
      }
    }

    if (count === lastCount && count > 0) {
      plateauStreak++;
      if (plateauStreak >= maxPlateau) break;
    } else {
      plateauStreak = 0;
    }
    lastCount = count;
    await humanScroll(page);
    if (plateauStreak >= 1) await scrollToBottom(page);
  }

  // Phase 2
  await scrollToTop(page);
  const expanded = await expandAllSeeMore(page);
  if (debug) console.error(`[${opts.label}.expand] clicked=${expanded}`);

  // Phase 3
  const raw = await extractVisiblePosts(page, opts.label);
  if (debug) {
    console.error(`[${opts.label}.extract] got=${raw.length}`);
    for (const r of raw) {
      console.error(
        `  - author=${JSON.stringify(r.authorName)} urn=${r.activityUrn ?? "-"} body[${r.body.length}]=${JSON.stringify(r.body.slice(0, 80))}`,
      );
    }
  }

  if (raw.length === 0) await dumpPageState(page, `linkedin-${opts.label}-zero-posts`, {});
  else if (debug && raw.filter((r) => r.body.length < 30).length > raw.length / 2) {
    await dumpPageState(page, `linkedin-${opts.label}-bodies-empty`, {
      raw: raw.map((r) => ({ author: r.authorName, bodyLen: r.body.length, urn: r.activityUrn })),
    });
  }

  return materializePosts(raw);
}

export function materializePosts(raw: RawPostOnPage[]): Post[] {
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const out: Post[] = [];
  for (const r of raw) {
    const id = r.activityUrn
      ? r.activityUrn.replace("urn:li:activity:", "")
      : syntheticId(r.authorName, r.body);
    if (seen.has(id)) continue;
    seen.add(id);
    const url = r.activityUrn
      ? `https://www.linkedin.com/feed/update/${r.activityUrn}/`
      : r.authorUrl ?? "https://www.linkedin.com/";
    const urnIso = r.activityUrn ? decodeActivityTimestamp(r.activityUrn) : null;
    const approxIso = !urnIso && r.publishedLabel ? parseRelativeLabel(r.publishedLabel) : null;
    out.push({
      id,
      provider: "linkedin",
      url,
      author: {
        name: r.authorName || "Inconnu",
        ...(r.authorUrl ? { profileUrl: r.authorUrl } : {}),
      },
      body: r.body,
      ...(urnIso ? { publishedAt: urnIso } : approxIso ? { publishedAt: approxIso, publishedAtApprox: true } : {}),
      ...(r.publishedLabel ? { publishedLabel: r.publishedLabel } : {}),
      ...(r.reactions != null ? { reactions: r.reactions } : {}),
      ...(r.commentCount != null ? { commentCount: r.commentCount } : {}),
      ...(r.repostCount != null ? { repostCount: r.repostCount } : {}),
      ...(r.media.length > 0 ? { media: r.media } : {}),
      fetchedAt: now,
    });
  }
  return out;
}

function syntheticId(author: string, body: string): string {
  return createHash("sha1").update(`${author}|${body.slice(0, 200)}`).digest("hex").slice(0, 16);
}

export interface RawPostOnPage {
  authorName: string;
  authorUrl: string | null;
  publishedLabel: string | null;
  body: string;
  reactions: number | null;
  commentCount: number | null;
  repostCount: number | null;
  media: PostMedia[];
  activityUrn: string | null;
}

/**
 * Extrait tous les posts visibles sur la page courante.
 * Fonctionne sur les pages search, profile recent-activity, permalien post, etc.
 * Identifie chaque post via l'aria-label du bouton d'options, récupère le body via
 * le premier <p> qui suit ce bouton dans l'ordre DOM.
 */
export async function extractVisiblePosts(page: Page, label: string): Promise<RawPostOnPage[]> {
  const raw = await safeEval<RawPostOnPage[]>(
    page,
    () => {
      const innerText = (el: Element): string => (el as HTMLElement).innerText ?? "";

      const parseNum = (s: string | null | undefined): number | null => {
        if (!s) return null;
        const cleaned = s.replace(/\s| /g, "");
        const m = cleaned.match(/([\d.,]+)\s*([KMkm])?/);
        if (!m || !m[1]) return null;
        const n = parseFloat(m[1].replace(",", "."));
        if (Number.isNaN(n)) return null;
        const suf = m[2];
        if (suf === "K" || suf === "k") return Math.round(n * 1000);
        if (suf === "M" || suf === "m") return Math.round(n * 1_000_000);
        return Math.round(n);
      };

      const timestampRe = /^\d+\s*(s|min|h|j|sem|mois|an|y|mo|w|d|hr|hour|day|week|month|year|second)\b/i;

      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[aria-label*="post de "], [aria-label*="post by "], [aria-label*="post of "]',
        ),
      );
      const out: RawPostOnPage[] = [];
      const seen = new Set<HTMLElement>();

      const urnSelector =
        'a[href*="urn:li:activity:"], a[href*="urn:li:ugcPost:"], a[href*="-activity-"], a[href*="/analytics/post-summary/"]';
      const bodySelector =
        "p, .inline-show-more-text, .update-components-text, .break-words, .feed-shared-update-v2__description, .feed-shared-text";

      for (const btn of buttons) {
        // Remonte jusqu'au post card. Priorité 1: un ancestor qui porte lui-même
        // `data-urn` (c'est le wrapper outermost du post, unique par post, même
        // pour les reshares). Priorité 2: un ancestor qui contient à la fois un
        // lien URN et un élément body.
        let container: HTMLElement | null = btn;
        for (let i = 0; i < 25; i++) {
          if (!container?.parentElement) break;
          container = container.parentElement;
          if (container.hasAttribute("data-urn")) break;
          const hasUrn = container.querySelector(urnSelector);
          const hasBody = container.querySelector(bodySelector);
          if (hasUrn && hasBody) break;
          if (innerText(container).length > 5000) break;
        }
        if (!container || seen.has(container)) continue;
        seen.add(container);

        const label = btn.getAttribute("aria-label") ?? "";
        const authorMatch = label.match(/post (?:de|by|of)\s+(.+?)(?:\s*[-•|].*)?$/i);
        const authorName = authorMatch?.[1]?.trim() ?? "";

        // Author URL: premier <a> profil/company du conteneur qui correspond au nom
        let authorUrl: string | null = null;
        const anchors = Array.from(
          container.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="/company/"]'),
        );
        for (const a of anchors) {
          const t = (a.innerText ?? "").trim().split("\n")[0]?.trim() ?? "";
          if (t === authorName) {
            authorUrl = a.href;
            break;
          }
        }
        if (!authorUrl && anchors[0]) authorUrl = anchors[0].href;

        // Body: plus long candidat parmi <p> (nouveau DOM search React) et
        // .inline-show-more-text / .update-components-text / .break-words /
        // .feed-shared-update-v2__description (DOM classique LinkedIn, utilisé sur
        // recent-activity). Exclut l'echo du nom d'auteur.
        const bodyCandidates = Array.from(
          container.querySelectorAll<HTMLElement>(
            "p, .inline-show-more-text, .update-components-text, .break-words, .feed-shared-update-v2__description, .feed-shared-text",
          ),
        );
        let bodyP: HTMLElement | null = null;
        let bodyLen = 0;
        for (const el of bodyCandidates) {
          const t = innerText(el).trim();
          if (t.length <= bodyLen) continue;
          if (authorName && t === authorName) continue;
          bodyP = el;
          bodyLen = t.length;
        }
        const body = (bodyP ? innerText(bodyP) : "").trim();

        const lines = innerText(container).split("\n").map((l) => l.trim()).filter(Boolean);
        const publishedLabel = lines.find((l) => timestampRe.test(l)) ?? null;

        // Compteurs: élément dédié prioritaire (DOM classique recent-activity),
        // fallback sur lignes innerText (DOM React search).
        const reactionsEl = container.querySelector<HTMLElement>(
          ".social-details-social-counts__reactions, .social-details-social-counts__social-proof-fallback-number",
        );
        const commentsEl = container.querySelector<HTMLElement>(
          ".social-details-social-counts__comments",
        );
        const countItems = Array.from(
          container.querySelectorAll<HTMLElement>(".social-details-social-counts__item"),
        );
        const repostItem = countItems.find((el) => {
          const t = (el.innerText ?? "").toLowerCase();
          return /republi|repost|repartage/.test(t);
        });

        const reactions =
          (reactionsEl ? parseNum(innerText(reactionsEl)) : null) ??
          parseNum(lines.find((l) => /r[ée]action/i.test(l)) ?? null);
        const commentCount =
          (commentsEl ? parseNum(innerText(commentsEl)) : null) ??
          parseNum(lines.find((l) => /\bcommentaire|\bcomment\b/i.test(l)) ?? null);
        const repostCount =
          (repostItem ? parseNum(innerText(repostItem)) : null) ??
          parseNum(lines.find((l) => /republi|repost|repartage/i.test(l)) ?? null);

        // Medias: images feedshare directes + poster des vidéos
        const media: PostMedia[] = [];
        const mediaImgs = Array.from(
          container.querySelectorAll<HTMLImageElement>(
            'img[src*="feedshare"], img[src*="/dms/image/"][src*="feedshare"]',
          ),
        );
        const seenUrls = new Set<string>();
        for (const img of mediaImgs) {
          const src = img.getAttribute("src") ?? "";
          if (!src || seenUrls.has(src)) continue;
          // Filtrer les icônes UI (static.licdn.com/aero-v1 etc.)
          if (src.includes("feedshare")) {
            seenUrls.add(src);
            media.push({ type: "image", url: src });
          }
        }
        const videos = Array.from(container.querySelectorAll<HTMLVideoElement>("video"));
        for (const v of videos) {
          const poster = v.getAttribute("poster") ?? "";
          if (poster && !seenUrls.has(poster)) {
            seenUrls.add(poster);
            media.push({ type: "video", url: poster });
          }
        }

        // URN: priorité au data-urn du conteneur lui-même (wrapper outermost
        // du post). Sinon chercher dans les hrefs et attributs data-* descendants.
        // Tous ces URNs (activity, ugcPost, share, fsd_post) partagent le même
        // encodage snowflake donc décodables par decodeSnowflakeTimestamp.
        let activityUrn: string | null = null;
        const extractFromSource = (src: string): string | null => {
          const m =
            src.match(/urn:li:activity:(\d+)/) ??
            src.match(/urn:li:ugcPost:(\d+)/) ??
            src.match(/urn:li:share:(\d+)/) ??
            src.match(/urn:li:fsd_post:(\d+)/) ??
            src.match(/-activity-(\d+)(?:-|$|[?#])/);
          return m?.[1] ? `urn:li:activity:${m[1]}` : null;
        };

        const containerUrn = container.getAttribute("data-urn") ?? "";
        activityUrn = extractFromSource(containerUrn);

        if (!activityUrn) {
          const urnCandidates = Array.from(
            container.querySelectorAll<HTMLElement>(
              'a[href*="urn:li:"], a[href*="-activity-"], a[href*="/analytics/post-summary/"], [data-urn], [data-id*="urn:li:"]',
            ),
          );
          for (const el of urnCandidates) {
            const sources = [
              el.getAttribute("href") ?? "",
              el.getAttribute("data-urn") ?? "",
              el.getAttribute("data-id") ?? "",
            ];
            for (const src of sources) {
              activityUrn = extractFromSource(src);
              if (activityUrn) break;
            }
            if (activityUrn) break;
          }
        }

        out.push({
          authorName,
          authorUrl,
          publishedLabel,
          body,
          reactions,
          commentCount,
          repostCount,
          media,
          activityUrn,
        });
      }

      return out;
    },
    { label: `linkedin-${label}-extract` },
  );
  return raw ?? [];
}
