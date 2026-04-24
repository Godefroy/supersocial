import type { Page } from "playwright";
import { createHash } from "node:crypto";
import type { Author, Message } from "../../../core/provider.js";
import { sleep } from "../../../core/throttle.js";
import { safeEval } from "../../../core/extract.js";
import { dumpPageState } from "../../../core/debug.js";
import { cleanProfileUrl, extractProfileUrn } from "../profile-url.js";

const MESSAGING_BASE = "https://www.linkedin.com/messaging/thread/";
const PROFILE_URL_RE = /https?:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#]+)/i;
const THREAD_URL_RE = /https?:\/\/(?:www\.)?linkedin\.com\/messaging\/thread\/([^/?#]+)/i;
const THREAD_ID_RE = /^2-[A-Za-z0-9_\-+/]+=*$/;

export function extractThreadIdFromInput(input: string): string | null {
  const mUrl = input.match(THREAD_URL_RE);
  if (mUrl?.[1]) return decodeURIComponent(mUrl[1]);
  const trimmed = input.trim();
  if (THREAD_ID_RE.test(trimmed)) return trimmed;
  return null;
}

export function extractProfileSlugFromInput(input: string): string | null {
  const m = input.match(PROFILE_URL_RE);
  return m?.[1] ?? null;
}

export function threadIdToUrl(threadId: string): string {
  // LinkedIn accepte le thread ID base64 tel quel dans l'URL. encodeURIComponent
  // casserait la navigation (le `=` de padding est significatif pour LinkedIn).
  return `${MESSAGING_BASE}${threadId}/`;
}

export interface ThreadState {
  threadId: string;
  threadUrl: string;
  participants: Author[];
  messages: Message[];
  self: { name: string | null; profileSlug: string | null };
}

export interface ResolvedTarget {
  /** thread ID si le thread existe déjà et a pu être résolu. null pour un profil sans thread préalable (compose neuf). */
  threadId: string | null;
  threadUrl: string | null;
  /** URN profil du destinataire, présent quand l'input était une URL profil. */
  recipientProfileUrn?: string;
  /** Nom d'affichage extrait de la page profil. */
  recipientDisplayName?: string;
  /** URL compose à utiliser pour un envoi neuf si threadId == null. */
  composeUrl?: string;
}

/**
 * Résout un input utilisateur vers une cible d'envoi/lecture.
 * - URL thread ou thread ID: retourne {threadId, threadUrl}.
 * - URL profil: clique le lien "Message" pré-rendu pour déclencher le routing
 *   overlay de LinkedIn, puis extrait le thread ID depuis plusieurs signaux
 *   (URL, lien dans le DOM, data-event-urn des messages). Si rien ne se résout
 *   en 15s, retourne {threadId: null, composeUrl} pour un envoi neuf.
 */
export async function resolveTarget(
  page: Page,
  input: string,
): Promise<ResolvedTarget> {
  const directId = extractThreadIdFromInput(input);
  if (directId) {
    return { threadId: directId, threadUrl: threadIdToUrl(directId) };
  }

  const slug = extractProfileSlugFromInput(input);
  if (!slug) {
    throw new Error(
      `Impossible de parser "${input}": donne une URL profil (/in/slug/), une URL thread (/messaging/thread/id/) ou un thread ID (2-...).`,
    );
  }

  const profileUrl = `https://www.linkedin.com/in/${slug}/`;
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  assertNotBlocked(page);
  await sleep(2500);

  const identity = await extractProfileIdentity(page);
  if (!identity.profileUrn) {
    await dumpPageState(page, "linkedin-profile-urn-missing", { profileUrl });
    throw new Error(
      `URN profil introuvable sur ${profileUrl}. Le profil est peut-être inaccessible (privé, restreint, compte désactivé).`,
    );
  }

  const existing = await tryResolveExistingThreadViaMessageOverlay(
    page,
    identity.profileUrn,
  );
  if (existing) {
    const target: ResolvedTarget = {
      threadId: existing,
      threadUrl: threadIdToUrl(existing),
      recipientProfileUrn: identity.profileUrn,
    };
    if (identity.displayName) target.recipientDisplayName = identity.displayName;
    return target;
  }

  const target: ResolvedTarget = {
    threadId: null,
    threadUrl: null,
    recipientProfileUrn: identity.profileUrn,
    composeUrl: `https://www.linkedin.com/messaging/compose/?recipient=${identity.profileUrn}`,
  };
  if (identity.displayName) target.recipientDisplayName = identity.displayName;
  return target;
}

/**
 * Récupère le href du lien "Message" pré-rendu sur la page profil (href
 * contenant `profileUrn` et `interop=msgOverlay`) puis y navigue directement.
 * LinkedIn redirige vers /messaging/thread/<id>/ si un thread existe, ou
 * reste sur /messaging/compose/ pour un thread neuf. Le page.goto(href)
 * évite la gestion complexe de l'overlay qu'un click() déclencherait.
 */
async function tryResolveExistingThreadViaMessageOverlay(
  page: Page,
  profileUrn: string,
): Promise<string | null> {
  const debug = process.env.SUPERSOCIAL_DEBUG === "true";

  const href = await page
    .evaluate((urn) => {
      const selector = `a[href*="profileUrn=urn%3Ali%3Afsd_profile%3A${urn}"][href*="interop=msgOverlay"]`;
      const candidates = Array.from(document.querySelectorAll<HTMLAnchorElement>(selector));
      // Préférence: le lien sans body= préfillé (bouton Message standard vs suggestion templatée)
      const standard = candidates.find((a) => !(a.getAttribute("href") ?? "").includes("body="));
      const chosen = standard ?? candidates[0];
      return chosen?.getAttribute("href") ?? null;
    }, profileUrn)
    .catch(() => null);

  if (!href) {
    if (debug) console.error(`[resolve] message anchor not found for urn=${profileUrn}`);
    return null;
  }
  if (debug) console.error(`[resolve] navigating to message link: ${href}`);

  const target = href.startsWith("http") ? href : `https://www.linkedin.com${href}`;
  await page.goto(target, { waitUntil: "domcontentloaded" });
  assertNotBlocked(page);

  // Soit LinkedIn redirige vers /messaging/thread/<id>/ dans l'URL, soit il charge
  // les messages du thread existant dans le panneau droit sans changer l'URL.
  // Dans le second cas, on dérive le thread ID depuis les data-event-urn des
  // messages: le message URN encode <msgMeta>&<threadUuid> en base64, et
  // <threadUuid> re-encodé en base64 (préfixé de 2-) est le thread ID canonique.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const url = page.url();
    const urlMatch = url.match(THREAD_URL_RE);
    if (urlMatch?.[1]) {
      const id = decodeURIComponent(urlMatch[1]);
      if (debug) console.error(`[resolve] thread URL detected: ${id}`);
      return id;
    }

    const derived = await deriveThreadIdFromMessageUrns(page, profileUrn);
    if (derived) {
      if (debug) console.error(`[resolve] thread id derived from data-event-urn: ${derived}`);
      return derived;
    }

    await sleep(500);
  }

  if (debug) {
    console.error(`[resolve] no thread resolved after 30s, stayed on ${page.url()}`);
    await dumpPageState(page, "linkedin-compose-no-redirect", {
      profileUrn,
      linkHref: href,
      currentUrl: page.url(),
    });
  }
  return null;
}

async function deriveThreadIdFromMessageUrns(
  page: Page,
  targetProfileUrn: string,
): Promise<string | null> {
  const id = await page
    .evaluate((targetUrn) => {
      // Le panneau droit montre un thread actif. Sa liste messages est dans
      // .msg-s-message-list-container. On valide que c'est le thread avec la
      // cible en vérifiant qu'un lien vers /in/<urn> de la cible y figure,
      // puis on dérive l'ID thread depuis n'importe quel data-event-urn du
      // conteneur (le sender est indifférent: tous les messages partagent le
      // même thread UUID après le `&`).
      const containers = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".msg-s-message-list-container, .msg-s-message-list",
        ),
      );
      for (const container of containers) {
        const targetLink = container.querySelector<HTMLAnchorElement>(
          `a[href*="/in/${targetUrn}"]`,
        );
        if (!targetLink) continue;
        const evts = Array.from(
          container.querySelectorAll<HTMLElement>("[data-event-urn]"),
        );
        for (const el of evts) {
          const eurn = el.getAttribute("data-event-urn") ?? "";
          const m = eurn.match(/2-([A-Za-z0-9_\-+/]+=*)\)/) ??
            eurn.match(/(2-[A-Za-z0-9_\-+/]+=*)/);
          if (!m || !m[1]) continue;
          const encodedPart = m[1].startsWith("2-") ? m[1].slice(2) : m[1];
          try {
            const decoded = atob(encodedPart);
            const sepIdx = decoded.indexOf("&");
            if (sepIdx < 0) continue;
            const threadUuid = decoded.slice(sepIdx + 1);
            const threadIdB64 = btoa(threadUuid);
            return `2-${threadIdB64}`;
          } catch {
            continue;
          }
        }
      }
      return null;
    }, targetProfileUrn)
    .catch(() => null);
  return typeof id === "string" ? id : null;
}

/**
 * Wrapper de compatibilité: refuse les URLs profil pour les opérations qui
 * requièrent un thread existant (lecture d'historique par exemple).
 */
export async function resolveThreadFromInput(
  page: Page,
  input: string,
): Promise<{ threadId: string; threadUrl: string }> {
  const target = await resolveTarget(page, input);
  if (!target.threadId || !target.threadUrl) {
    throw new Error(
      `Pas de thread résolu depuis "${input}". Donne l'URL du thread (/messaging/thread/<id>/) pour lire l'historique. Une URL profil n'est acceptée que pour \`dm\` (envoi, pas de lecture d'historique).`,
    );
  }
  return { threadId: target.threadId, threadUrl: target.threadUrl };
}

interface ProfileIdentity {
  profileUrn: string | null;
  displayName: string | null;
}

/**
 * Extrait l'URN profil et le nom d'affichage depuis la page profil ouverte.
 * L'URN se déduit de la fréquence des compose links (le plus fréquent est
 * celui de la personne regardée, par opposition aux suggestions).
 * Le nom vient du `<h1>` principal ou du `<title>` de la page.
 */
async function extractProfileIdentity(page: Page): Promise<ProfileIdentity> {
  const result = await page
    .evaluate(() => {
      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>('a[href*="/messaging/compose/"]'),
      );
      const counts = new Map<string, number>();
      for (const a of anchors) {
        const href = a.getAttribute("href") ?? "";
        const m = href.match(/profileUrn=urn%3Ali%3Afsd_profile%3A([A-Za-z0-9_-]+)/);
        if (m?.[1]) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
      let profileUrn: string | null = null;
      let bestCount = 0;
      for (const [k, v] of counts) {
        if (v > bestCount) {
          profileUrn = k;
          bestCount = v;
        }
      }
      const h1 = document.querySelector<HTMLHeadingElement>("h1");
      let displayName: string | null = null;
      if (h1) {
        displayName = (h1.innerText ?? "").trim().split("\n")[0]?.trim() ?? null;
      }
      if (!displayName) {
        const title = (document.title ?? "").trim();
        // Format type "Pierre-Luc Lelouch | LinkedIn" ou "(2) Pierre-Luc Lelouch - CEO | LinkedIn".
        // On coupe au séparateur `|` uniquement (garder les traits d'union dans le nom).
        const m = title.match(/^(?:\(\d+\)\s*)?([^|]+?)(?:\s*\|.*)?$/);
        displayName = m?.[1]?.trim() ?? null;
      }
      return { profileUrn, displayName };
    })
    .catch(() => ({ profileUrn: null, displayName: null }));
  return result ?? { profileUrn: null, displayName: null };
}

/**
 * Envoie un message depuis une URL compose (profil + recipient URN) et attend
 * que LinkedIn redirige vers /messaging/thread/<id>/. Utilisé pour les envois
 * où on n'a qu'une URL profil et pas encore de thread. Retourne le thread ID
 * capturé après l'envoi.
 */
export async function sendFromComposeUrl(
  page: Page,
  composeUrl: string,
  body: string,
): Promise<{ threadId: string; threadUrl: string }> {
  await page.goto(composeUrl, { waitUntil: "domcontentloaded" });
  assertNotBlocked(page);
  await sleep(3000);

  await sendMessageInOpenThread(page, body);

  // Attend la redirection vers /messaging/thread/<id>/
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const url = page.url();
    const m = url.match(THREAD_URL_RE);
    if (m?.[1]) {
      const threadId = decodeURIComponent(m[1]);
      return { threadId, threadUrl: threadIdToUrl(threadId) };
    }
    await sleep(500);
  }

  await dumpPageState(page, "linkedin-compose-post-send-no-redirect", { composeUrl });
  throw new Error(
    `Message envoyé depuis compose, mais pas de redirection vers /messaging/thread/ après 15s. Vérifie la page LinkedIn.`,
  );
}

function assertNotBlocked(page: Page): void {
  const u = page.url();
  if (u.includes("/login") || u.includes("/checkpoint/")) {
    throw new Error(`Redirigé vers ${u}. Session LinkedIn expirée, relance \`linkedin login\`.`);
  }
}

/**
 * Navigue vers la thread URL et attend que la liste des messages apparaisse.
 * Charge tout l'historique en scrollant vers le haut jusqu'à plateau.
 */
export async function openAndLoadThread(
  page: Page,
  threadUrl: string,
): Promise<void> {
  const debug = process.env.SUPERSOCIAL_DEBUG === "true";
  await page.goto(threadUrl, { waitUntil: "domcontentloaded" });
  assertNotBlocked(page);

  // Attend que le conteneur messages apparaisse
  const deadline = Date.now() + 20_000;
  let listVisible = false;
  while (Date.now() < deadline) {
    const n = await page
      .evaluate(
        () =>
          document.querySelectorAll(
            ".msg-s-message-list__event, .msg-s-event-listitem, .msg-s-message-list-container",
          ).length,
      )
      .catch(() => 0);
    if (typeof n === "number" && n > 0) {
      listVisible = true;
      break;
    }
    await sleep(500);
  }
  if (!listVisible) {
    await dumpPageState(page, "linkedin-thread-list-not-found", { threadUrl });
    throw new Error(`Liste de messages introuvable sur ${threadUrl}.`);
  }

  await sleep(1500);

  // Scroll up phase: LinkedIn lazy-loads l'historique quand on remonte
  const loadDeadline = Date.now() + 2 * 60_000;
  let prevCount = -1;
  let plateau = 0;
  while (Date.now() < loadDeadline) {
    const count = await countMessageItems(page);
    if (debug) console.error(`[thread.load] messages=${count} plateau=${plateau}`);
    if (count === prevCount) {
      plateau++;
      if (plateau >= 3) break;
    } else {
      plateau = 0;
    }
    prevCount = count;
    const scrolled = await scrollMessageListUp(page);
    if (!scrolled) break;
    await sleep(1500);
  }

  // Expand les "Voir plus" au cas où certains messages soient tronqués
  await expandLongMessages(page);
  await sleep(500);
}

async function countMessageItems(page: Page): Promise<number> {
  const n = await page
    .evaluate(
      () =>
        document.querySelectorAll(".msg-s-message-list__event, .msg-s-event-listitem").length,
    )
    .catch(() => 0);
  return typeof n === "number" ? n : 0;
}

async function scrollMessageListUp(page: Page): Promise<boolean> {
  const ok = await page
    .evaluate(() => {
      const container =
        document.querySelector<HTMLElement>(".msg-s-message-list-container") ??
        document.querySelector<HTMLElement>(".msg-s-message-list") ??
        document.querySelector<HTMLElement>(".scaffold-layout__list");
      if (!container) return false;
      const before = container.scrollTop;
      container.scrollTop = 0;
      // Force un petit delta pour déclencher le lazy-load
      return before > 0 || container.scrollHeight > container.clientHeight;
    })
    .catch(() => false);
  return ok === true;
}

async function expandLongMessages(page: Page): Promise<number> {
  const n = await page
    .evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>("button, span[role='button']"),
      );
      let c = 0;
      for (const b of buttons) {
        const text = ((b as HTMLElement).innerText ?? "").trim();
        if (/^(…\s*voir plus|\.\.\.?\s*voir plus|…\s*see more|\.\.\.?\s*see more|voir plus|see more)$/i.test(text)) {
          try {
            b.click();
            c++;
          } catch {
            /* ignore */
          }
        }
      }
      return c;
    })
    .catch(() => 0);
  return typeof n === "number" ? n : 0;
}

interface RawMessage {
  eventUrn: string | null;
  /** URN du sender extrait directement du data-event-urn du message (source fiable). */
  senderProfileUrnFromEvent: string | null;
  senderName: string;
  senderProfileUrl: string | null;
  senderProfileUrn: string | null;
  senderSlug: string | null;
  timestampText: string | null;
  datetime: string | null;
  body: string;
}

interface RawThread {
  self: { name: string | null; profileSlug: string | null };
  participants: Array<{
    name: string;
    profileUrl: string | null;
    profileUrn: string | null;
    slug: string | null;
  }>;
  rawMessages: RawMessage[];
}

export async function extractThreadState(
  page: Page,
  threadId: string,
  threadUrl: string,
): Promise<ThreadState> {
  const debug = process.env.SUPERSOCIAL_DEBUG === "true";
  const raw = await safeEval<RawThread>(
    page,
    () => {
      const innerText = (el: Element): string => (el as HTMLElement).innerText ?? "";

      const getSelf = (): { name: string | null; profileSlug: string | null } => {
        const meLink = document.querySelector<HTMLAnchorElement>(
          ".global-nav__me a[href*='/in/'], .global-nav__me-photo-link, a.global-nav__me-photo-link",
        );
        const href = meLink?.getAttribute("href") ?? "";
        const slugMatch = href.match(/\/in\/([^/]+)/);
        const img = document.querySelector<HTMLImageElement>(".global-nav__me-photo");
        // LinkedIn expose le nom complet dans l'attribut alt de l'image du nav
        // (ex: "Godefroy de Compreignac"). C'est notre signal le plus fiable
        // pour identifier les messages sortants, car les comparaisons de slug
        // (humain dans le nav, URN dans les messages) ne matchent pas.
        const name =
          img?.getAttribute("alt")?.trim() ||
          meLink?.getAttribute("aria-label")?.replace(/^Moi:?\s*/i, "").trim() ||
          null;
        return { name: name || null, profileSlug: slugMatch?.[1] ?? null };
      };

      const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() ?? "";

      const extractParticipants = (): RawThread["participants"] => {
        // On considère les liens profil dans les group headers comme source de
        // vérité: c'est l'auteur du message (nom + URN). On exclut "moi".
        const container =
          document.querySelector<HTMLElement>(".msg-s-message-list-container") ??
          document.querySelector<HTMLElement>(".msg-s-message-list") ??
          document.body;

        const links = Array.from(
          container.querySelectorAll<HTMLAnchorElement>(
            "a.msg-s-message-group__profile-link[href*='/in/'], .msg-s-message-group__meta a[href*='/in/']",
          ),
        );

        const seen = new Set<string>();
        const out: RawThread["participants"] = [];
        for (const a of links) {
          const href = a.getAttribute("href") ?? "";
          const slugMatch = href.match(/\/in\/([^/?#]+)/);
          const slug = slugMatch?.[1] ?? null;
          if (slug && seen.has(slug)) continue;
          if (slug) seen.add(slug);
          // innerText du lien contient le nom (et parfois le statut). On prend
          // la première ligne uniquement, et on nettoie les badges vérifiés.
          const rawName = firstLine(innerText(a));
          const name = rawName.replace(/\s*•\s*.+$/, "").trim();
          const urnMatch = href.match(/(urn:li:fsd_profile:[A-Za-z0-9_-]+)/) ??
            (slug?.match(/^ACoAA/) ? [null, `urn:li:fsd_profile:${slug}`] as const : null);
          out.push({
            name,
            profileUrl: href || null,
            profileUrn: urnMatch?.[1] ?? null,
            slug,
          });
        }

        if (out.length === 0) {
          const titleEl =
            document.querySelector<HTMLElement>(".msg-thread__title-bar .msg-entity-lockup__entity-title") ??
            document.querySelector<HTMLElement>(".msg-entity-lockup__entity-title");
          const title = titleEl ? firstLine(innerText(titleEl)) : "";
          if (title) {
            for (const part of title.split(/,| et /)) {
              const name = part.trim();
              if (name) out.push({ name, profileUrl: null, profileUrn: null, slug: null });
            }
          }
        }

        return out;
      };

      const extractMessages = (): RawMessage[] => {
        const container =
          document.querySelector<HTMLElement>(".msg-s-message-list-container") ??
          document.querySelector<HTMLElement>(".msg-s-message-list") ??
          document.body;

        const items = Array.from(
          container.querySelectorAll<HTMLElement>(".msg-s-event-listitem"),
        );

        let currentSender = {
          name: "",
          profileUrl: null as string | null,
          profileUrn: null as string | null,
          slug: null as string | null,
          timestampText: null as string | null,
        };

        const out: RawMessage[] = [];

        for (const it of items) {
          // Avant cet item, chercher un .msg-s-message-group__meta ascendant ou précédent
          // qui indique le sender et la date du groupe.
          const groupMeta =
            it.closest(".msg-s-message-group")?.querySelector<HTMLElement>(
              ".msg-s-message-group__meta",
            ) ?? null;

          if (groupMeta) {
            const nameLink = groupMeta.querySelector<HTMLAnchorElement>(
              "a.msg-s-message-group__profile-link, a[href*='/in/']",
            );
            const nameEl = groupMeta.querySelector<HTMLElement>(
              ".msg-s-message-group__name, .msg-s-message-group__profile-link",
            );
            const tsEl = groupMeta.querySelector<HTMLElement>(
              ".msg-s-message-group__timestamp, time",
            );
            const href = nameLink?.getAttribute("href") ?? "";
            const slugMatch = href.match(/\/in\/([^/?#]+)/);
            const urnMatch = href.match(/(urn:li:fsd_profile:[A-Za-z0-9_-]+)/);
            const rawName = (nameEl ? innerText(nameEl) : innerText(groupMeta)).trim().split("\n")[0]?.trim() ?? "";
            const name = rawName.replace(/\s*•\s*.+$/, "").trim();

            currentSender = {
              name,
              profileUrl: href || null,
              profileUrn: urnMatch?.[1] ?? (slugMatch?.[1]?.startsWith("ACoAA") ? `urn:li:fsd_profile:${slugMatch[1]}` : null),
              slug: slugMatch?.[1] ?? null,
              timestampText: tsEl ? innerText(tsEl).trim() : null,
            };
          }

          // URN de l'event: capture complète jusqu'à la `)` fermante s'il y a
          // des parenthèses, sinon jusqu'au prochain whitespace.
          let eventUrn: string | null = null;
          const urnAttrs = [
            it.getAttribute("data-event-urn"),
            it.getAttribute("data-id"),
            it.closest(".msg-s-message-list__event")?.getAttribute("data-event-urn") ?? null,
          ];
          for (const a of urnAttrs) {
            if (!a) continue;
            const paren = a.match(/urn:li:msg[a-zA-Z_]*:\([^)]+\)/);
            if (paren?.[0]) {
              eventUrn = paren[0];
              break;
            }
            const simple = a.match(/urn:li:msg[a-zA-Z_]*:[^\s"]+/);
            if (simple?.[0]) {
              eventUrn = simple[0];
              break;
            }
            if (a.startsWith("urn:li:")) {
              eventUrn = a;
              break;
            }
          }

          // URN sender extrait du data-event-urn (source fiable: le meta du
          // group header affiche souvent l'autre participant pour tous les
          // messages, y compris nos messages sortants).
          let senderProfileUrnFromEvent: string | null = null;
          if (eventUrn) {
            const senderMatch = eventUrn.match(
              /urn:li:msg[a-zA-Z_]*:\(urn:li:fsd_profile:([A-Za-z0-9_-]+),/,
            );
            if (senderMatch?.[1]) {
              senderProfileUrnFromEvent = `urn:li:fsd_profile:${senderMatch[1]}`;
            }
          }

          // Body du message
          const bodyEl = it.querySelector<HTMLElement>(
            ".msg-s-event-listitem__body, .msg-s-event__content .msg-s-event-listitem__body, .msg-s-event-with-indicator__body",
          );
          const body = (bodyEl ? innerText(bodyEl) : "").trim();
          if (!body) continue;

          // Timestamp au niveau du message lui-même si présent
          const tsEl2 = it.querySelector<HTMLElement>(
            "time.msg-s-message-list__time-heading, time, .msg-s-event-listitem__timestamp",
          );
          const dtAttr = tsEl2?.getAttribute("datetime") ?? null;
          const tsText = tsEl2 ? innerText(tsEl2).trim() : null;

          out.push({
            eventUrn,
            senderProfileUrnFromEvent,
            senderName: currentSender.name,
            senderProfileUrl: currentSender.profileUrl,
            senderProfileUrn: currentSender.profileUrn,
            senderSlug: currentSender.slug,
            timestampText: tsText || currentSender.timestampText,
            datetime: dtAttr,
            body,
          });
        }

        return out;
      };

      return {
        self: getSelf(),
        participants: extractParticipants(),
        rawMessages: extractMessages(),
      };
    },
    { label: "linkedin-thread-extract", dumpMeta: { threadUrl, threadId } },
  );

  if (!raw) {
    throw new Error(`Extraction thread échouée pour ${threadUrl}.`);
  }

  const self = raw.self;
  const selfSlug = self.profileSlug;
  const selfName = self.name ?? null;

  // LinkedIn rend un header par groupe de messages, et ce header pointe vers
  // le profil de l'expéditeur du groupe. Donc pour nos messages sortants, le
  // header pointe sur notre propre profil. On doit donc filtrer par nom
  // contre `self.name` (lu dans l'alt de global-nav__me-photo) avant de
  // construire l'ensemble "autres" servant à détecter outgoing.
  const othersOnly = raw.participants.filter((p) => {
    if (selfName && p.name === selfName) return false;
    if (selfSlug && p.slug === selfSlug) return false;
    return true;
  });
  const otherParticipantUrns = new Set(
    othersOnly.map((p) => p.profileUrn).filter((u): u is string => Boolean(u)),
  );
  const participantByUrn = new Map(
    othersOnly
      .filter((p) => p.profileUrn)
      .map((p) => [p.profileUrn!, p]),
  );
  if (debug) {
    console.error(
      `[thread.extract] self.name=${raw.self.name} selfSlug=${raw.self.profileSlug} participants_raw=${JSON.stringify(raw.participants.map((p) => p.name))} others=${JSON.stringify(othersOnly.map((p) => p.name))}`,
    );
    const uniqSenders = new Set(
      raw.rawMessages.map((m) => m.senderProfileUrnFromEvent).filter(Boolean),
    );
    console.error(`[thread.extract] unique msg sender urns=${JSON.stringify([...uniqSenders])}`);
  }

  const participants: Author[] = raw.participants
    .filter((p) => {
      if (selfSlug && p.slug === selfSlug) return false;
      if (selfName && p.name === selfName) return false;
      return true;
    })
    .map((p) => ({
      name: p.name || "Inconnu",
      ...(cleanProfileUrl(p.profileUrl) ? { profileUrl: cleanProfileUrl(p.profileUrl)! } : {}),
      ...(p.profileUrn ? { profileUrn: p.profileUrn } : {}),
    }));

  const messages: Message[] = raw.rawMessages.map((m, idx) => {
    // Règle: si on connaît le URN sender via data-event-urn, on déclare
    // outgoing quand ce URN n'est pas dans l'ensemble des autres participants.
    // Fallback: comparer le nom lu dans le group header avec mon nom.
    let outgoing = false;
    if (m.senderProfileUrnFromEvent) {
      outgoing = !otherParticipantUrns.has(m.senderProfileUrnFromEvent);
    } else if (selfName && m.senderName) {
      outgoing = m.senderName === selfName;
    }

    const senderInfo = m.senderProfileUrnFromEvent
      ? participantByUrn.get(m.senderProfileUrnFromEvent)
      : null;

    const sentAt = m.datetime ?? m.timestampText ?? "";
    const id = m.eventUrn ?? hashMessageId(threadId, m.senderName, sentAt, m.body, idx);
    const cleanedUrl = cleanProfileUrl(senderInfo?.profileUrl ?? m.senderProfileUrl);
    const urn =
      m.senderProfileUrnFromEvent ??
      senderInfo?.profileUrn ??
      m.senderProfileUrn ??
      extractProfileUrn(m.senderProfileUrl);
    const fromName = outgoing
      ? self.name || "Moi"
      : senderInfo?.name || m.senderName || "Inconnu";

    return {
      id,
      conversationId: threadId,
      sentAt,
      from: {
        name: fromName,
        ...(cleanedUrl ? { profileUrl: cleanedUrl } : {}),
        ...(urn ? { profileUrn: urn } : {}),
      },
      body: m.body,
      outgoing,
    };
  });

  return {
    threadId,
    threadUrl,
    participants,
    messages,
    self,
  };
}

function hashMessageId(
  threadId: string,
  sender: string,
  ts: string,
  body: string,
  idx: number,
): string {
  const h = createHash("sha1")
    .update(`${threadId}|${sender}|${ts}|${body}|${idx}`)
    .digest("hex")
    .slice(0, 16);
  return `synthetic:${h}`;
}

/**
 * Tape et envoie un message dans le thread actuellement ouvert.
 * Retourne le body envoyé après confirmation visuelle (attente que le message
 * apparaisse dans la liste). Lève si le bouton "Envoyer" reste inactif.
 */
export async function sendMessageInOpenThread(
  page: Page,
  body: string,
): Promise<void> {
  const debug = process.env.SUPERSOCIAL_DEBUG === "true";

  const composer = await page.waitForSelector(
    ".msg-form__contenteditable[contenteditable='true'], [data-editor-container] [contenteditable='true']",
    { timeout: 15_000 },
  );
  await composer.click();
  await sleep(400);

  // Focus puis typing. On type ligne par ligne pour gérer les sauts de ligne.
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    await page.keyboard.type(line, { delay: 18 });
    if (i < lines.length - 1) {
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
    }
  }
  await sleep(600);

  const sendClicked = await page
    .evaluate(() => {
      const btns = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          "button.msg-form__send-button, button.msg-form__send-btn, button[type='submit']",
        ),
      );
      const candidates = btns.filter((b) => {
        const aria = (b.getAttribute("aria-label") ?? "").toLowerCase();
        const text = (b.innerText ?? "").toLowerCase().trim();
        return (
          aria.includes("envoyer") ||
          aria.includes("send") ||
          text === "envoyer" ||
          text === "send"
        );
      });
      for (const b of candidates) {
        if (b.disabled) continue;
        b.click();
        return true;
      }
      return false;
    })
    .catch(() => false);

  if (!sendClicked) {
    await dumpPageState(page, "linkedin-dm-send-button-missing");
    throw new Error(`Bouton "Envoyer" introuvable ou inactif.`);
  }

  if (debug) console.error(`[dm.sent] body.length=${body.length}`);

  // Attend que le contenteditable soit vidé (signe d'envoi réussi)
  const cleared = await page
    .waitForFunction(
      () => {
        const el = document.querySelector<HTMLElement>(
          ".msg-form__contenteditable[contenteditable='true']",
        );
        return !el || (el.innerText ?? "").trim().length === 0;
      },
      null,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);

  if (!cleared) {
    await dumpPageState(page, "linkedin-dm-send-not-confirmed", { bodyLen: body.length });
    throw new Error(`Envoi non confirmé: l'éditeur n'a pas été vidé après 10s.`);
  }

  await sleep(1200);
}
