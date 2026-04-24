import type { Page } from "playwright";
import type { Comment } from "../../../core/provider.js";
import { sleep, humanPause } from "../../../core/throttle.js";
import { safeEval } from "../../../core/extract.js";
import { dumpPageState } from "../../../core/debug.js";
import { cleanProfileUrl, extractProfileUrn } from "../profile-url.js";

export function extractPostIdFromUrl(url: string): string | null {
  const m1 = url.match(/urn:li:activity:(\d+)/);
  if (m1?.[1]) return m1[1];
  const m2 = url.match(/-activity-(\d+)(?:-|$|[?#/])/);
  if (m2?.[1]) return m2[1];
  return null;
}

export function normalizePostUrl(input: string): string {
  const id = extractPostIdFromUrl(input);
  if (!id) return input;
  return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
}

async function countCommentBlocks(page: Page): Promise<number> {
  const n = await page
    .evaluate(() => document.querySelectorAll(".comments-comment-entity").length)
    .catch(() => 0);
  return typeof n === "number" ? n : 0;
}

async function clickLoadMoreComments(page: Page): Promise<number> {
  const clicked = await page
    .evaluate(async () => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("button"));
      // Match "charger/afficher/voir ... commentaires/réponses" en FR et EN,
      // y compris les variantes avec compte ("3 réponses précédentes").
      const loadRe =
        /(charger|afficher|voir|load|view|show).*(commentaire|comment|r[ée]ponse|repl)/i;
      // Exclure les boutons d'écriture
      const writeRe = /^(commenter|comment|r[ée]pondre|reply)$/i;
      let c = 0;
      for (const n of nodes) {
        const text = (n.innerText ?? "").trim();
        if (writeRe.test(text)) continue;
        if (!loadRe.test(text)) continue;
        try {
          n.scrollIntoView({ behavior: "smooth", block: "center" });
          await wait(400 + Math.random() * 300);
          n.click();
          c++;
          await wait(200 + Math.random() * 200);
        } catch {
          /* ignore */
        }
      }
      return c;
    })
    .catch(() => 0);
  return typeof clicked === "number" ? clicked : 0;
}

async function expandCommentBodies(page: Page): Promise<number> {
  const clicked = await page
    .evaluate(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("button, span[role='button']"));
      let c = 0;
      for (const n of nodes) {
        const text = (n.innerText ?? "").trim().toLowerCase();
        if (/^(…\s*plus|\.\.\.?\s*plus|…\s*see more|\.\.\.?\s*see more|voir plus|see more)$/i.test(text)) {
          try {
            n.click();
            c++;
          } catch {
            /* ignore */
          }
        }
      }
      return c;
    })
    .catch(() => 0);
  return typeof clicked === "number" ? clicked : 0;
}

interface RawComment {
  depth: number;
  authorName: string;
  authorUrl: string | null;
  authorUrn: string | null;
  publishedLabel: string | null;
  body: string;
  reactions: number | null;
}

export async function listCommentsOnPage(
  page: Page,
  postUrl: string,
): Promise<{ postId: string; comments: Comment[] }> {
  const debug = process.env.SUPERSOCIAL_DEBUG === "true";
  const url = normalizePostUrl(postUrl);
  const postId = extractPostIdFromUrl(url);
  if (!postId) throw new Error(`Impossible d'extraire un activity ID depuis ${postUrl}`);

  await page.goto(url, { waitUntil: "domcontentloaded" });

  if (page.url().includes("/login") || page.url().includes("/checkpoint/")) {
    throw new Error(`Redirigé vers ${page.url()}. Session LinkedIn expirée, relance \`linkedin login\`.`);
  }

  await sleep(5000);

  // Scroll vers la zone commentaires pour trigger leur chargement
  await page.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement ?? document.body;
    scroller.scrollTo({ top: scroller.scrollHeight / 2, behavior: "auto" });
  });
  await sleep(2000);

  // Phase 1: charger tous les commentaires (clicks "voir plus" tant qu'il y en a)
  const loadDeadline = Date.now() + 10 * 60_000;
  let prevCount = -1;
  let plateauStreak = 0;
  const maxPlateau = 3;

  while (Date.now() < loadDeadline) {
    const count = await countCommentBlocks(page);
    const morePresent = await clickLoadMoreComments(page);
    if (debug) console.error(`[comments.load] count=${count} loadMoreClicked=${morePresent} plateau=${plateauStreak}`);

    if (morePresent > 0) {
      plateauStreak = 0;
      await humanPause("read");
      continue;
    }

    if (count === prevCount) {
      plateauStreak++;
      if (plateauStreak >= maxPlateau) break;
    } else {
      plateauStreak = 0;
    }
    prevCount = count;

    // Pas de bouton trouvé mais count peut encore bouger: scroll pour charger via lazy-load
    await page.evaluate(() => {
      const scroller = document.scrollingElement ?? document.documentElement ?? document.body;
      scroller.scrollBy(0, 500);
    });
    await sleep(1500);
  }

  // Phase 2: expand les "...plus" dans les corps de commentaire
  const expanded = await expandCommentBodies(page);
  if (debug) console.error(`[comments.expand] clicked=${expanded}`);
  if (expanded > 0) await sleep(1200);

  // Phase 3: extract
  const raw = await extractCommentsFromPage(page);
  if (debug) {
    console.error(`[comments.extract] got=${raw.length}`);
    for (const r of raw.slice(0, 5)) {
      console.error(
        `  - author=${JSON.stringify(r.authorName)} body[${r.body.length}]=${JSON.stringify(r.body.slice(0, 80))}`,
      );
    }
  }

  if (raw.length === 0) await dumpPageState(page, "linkedin-comments-zero", { postId, url });
  else if (debug && raw.filter((r) => r.body.length < 10).length > raw.length / 2) {
    await dumpPageState(page, "linkedin-comments-bodies-empty", {
      postId,
      url,
      sample: raw.slice(0, 10).map((r) => ({ author: r.authorName, bodyLen: r.body.length })),
    });
  }

  const now = new Date().toISOString();
  const comments: Comment[] = raw.map((r, idx) => {
    const cleanedUrl = cleanProfileUrl(r.authorUrl);
    const urn = r.authorUrn ?? extractProfileUrn(r.authorUrl);
    return {
      id: `${postId}-${idx.toString().padStart(3, "0")}`,
      postId,
      depth: r.depth,
      author: {
        name: r.authorName || "Inconnu",
        ...(cleanedUrl ? { profileUrl: cleanedUrl } : {}),
        ...(urn ? { profileUrn: urn } : {}),
      },
      body: r.body,
      ...(r.publishedLabel ? { publishedAt: r.publishedLabel } : {}),
      ...(r.reactions != null ? { reactions: r.reactions } : {}),
    };
  });

  return { postId, comments };
}

async function extractCommentsFromPage(page: Page): Promise<RawComment[]> {
  const raw = await safeEval<RawComment[]>(
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

      const items = Array.from(
        document.querySelectorAll<HTMLElement>(".comments-comment-entity"),
      );
      const out: RawComment[] = [];

      for (const item of items) {
        // Profondeur: nombre d'ancêtres .comments-comment-entity au-dessus.
        // 0 = top-level, 1 = réponse, 2 = réponse à une réponse, etc.
        let depth = 0;
        let anc: Element | null = item.parentElement;
        while (anc) {
          if (anc.classList.contains("comments-comment-entity")) depth++;
          anc = anc.parentElement;
        }

        // Auteur: l'aria-label du bouton "Options" du commentaire, ou le lien profil
        const optBtn = item.querySelector<HTMLElement>(
          '[aria-label^="Options possibles pour le commentaire de"], [aria-label^="Options pour le commentaire de"], [aria-label^="Options for comment by"]',
        );
        const label = optBtn?.getAttribute("aria-label") ?? "";
        const authorMatch =
          label.match(/commentaire (?:de|par)\s+(.+?)\s*$/i) ??
          label.match(/comment (?:by|of)\s+(.+?)\s*$/i);
        let authorName = authorMatch?.[1]?.trim() ?? "";

        let authorUrl: string | null = null;
        let authorUrn: string | null = null;
        const profileAnchors = Array.from(
          item.querySelectorAll<HTMLAnchorElement>(
            ".comments-comment-meta__image-link, .comments-comment-meta__description-container, a[href*='/in/'], a[href*='/company/']",
          ),
        );
        for (const a of profileAnchors) {
          const href = a.getAttribute("href") ?? "";
          if (!authorUrl && href) authorUrl = href;
          // miniProfileUrn contient l'URN stable, prioritaire si présent
          const urnMatch = href.match(/(urn:li:fsd_profile:[A-Za-z0-9_-]+)/);
          if (urnMatch?.[1]) {
            authorUrn = urnMatch[1];
            break;
          }
        }

        if (!authorName) {
          const titleEl = item.querySelector<HTMLElement>(".comments-comment-meta__description-title");
          authorName = (titleEl ? innerText(titleEl) : "").trim();
        }

        // Body: le content principal du commentaire
        const bodyEl = item.querySelector<HTMLElement>(
          ".comments-comment-item__main-content, .comments-comment-entity__content .break-words, .update-components-text .break-words, .break-words",
        );
        const body = (bodyEl ? innerText(bodyEl) : "").trim();

        // Date label
        const timeEl = item.querySelector<HTMLElement>(
          ".comments-comment-meta__data, time, .comments-comment-meta__description-subtitle",
        );
        const timeText = timeEl ? innerText(timeEl).trim() : "";
        const publishedLabel = timestampRe.test(timeText) ? timeText : null;

        // Reactions
        const reactionsEl = item.querySelector<HTMLElement>(
          ".comments-comment-social-bar__reactions-count--cr, .social-details-social-counts__reactions-count",
        );
        const reactionsText = reactionsEl ? innerText(reactionsEl).trim() : "";
        const reactions = parseNum(reactionsText);

        out.push({
          depth,
          authorName,
          authorUrl,
          authorUrn,
          publishedLabel,
          body,
          reactions,
        });
      }

      return out;
    },
    { label: "linkedin-comments-extract" },
  );
  return raw ?? [];
}
