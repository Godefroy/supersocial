import type { Page } from "playwright";
import type { ReceivedInvitation, AcceptInvitationResult } from "../../../core/provider.js";
import { sleep, LoginRequiredError } from "../../../core/throttle.js";
import { dumpPageState } from "../../../core/debug.js";
import { LABELS, MATCHES_LABEL_SRC } from "../locale.js";
import { humanScroll, scrollToBottom, scrollToTop } from "../page-ops.js";
import { canonicalProfileUrl, extractProfileSlug } from "./profile.js";

/**
 * Gestionnaire des invitations reçues. Page dédiée hors du feed algorithmique,
 * donc sans effet sur les recommandations personnalisées de l'utilisateur.
 * LinkedIn redirige vers l'onglet `/received/`, d'où le préfixe comme test
 * d'appartenance plutôt qu'une égalité d'URL.
 */
export const INVITATION_MANAGER_URL = "https://www.linkedin.com/mynetwork/invitation-manager/";

/** Nombre maximum de rounds de scroll pendant le déroulé de la liste. */
const MAX_LOAD_ROUNDS = 12;
/** Rounds consécutifs sans nouvelle carte avant de considérer la liste complète. */
const MAX_PLATEAU = 3;

/** Délai maximum d'attente de la première carte au chargement de la page. */
const FIRST_CARD_TIMEOUT_MS = 10_000;

/** Délai maximum d'attente du retrait de la carte après un clic "Accepter". */
const CONFIRM_TIMEOUT_MS = 8000;

/** Attribut jetable posé sur le bouton à cliquer, le temps de le viser depuis Playwright. */
const ACCEPT_MARKER = "data-supersocial-accept";

function assertNotBlocked(page: Page): void {
  const u = page.url();
  if (u.includes("/login") || u.includes("/checkpoint/")) {
    throw new LoginRequiredError(`redirigé vers ${u}`, u);
  }
}

/**
 * Localise les cartes d'invitation dans le DOM, côté navigateur. Chaque carte
 * est atteinte depuis son bouton "Accepter" en remontant jusqu'au premier
 * ancêtre qui contient un lien profil. Si cet ancêtre contient plusieurs
 * boutons "Accepter", c'est qu'on a dépassé la carte et remonté dans la liste:
 * la carte est marquée ambiguë plutôt que rattachée au mauvais profil.
 *
 * Source partagée entre l'extraction et le ciblage du clic, reconstruite dans
 * les `page.evaluate` via `new Function` (même patron que `MATCHES_LABEL_SRC`).
 */
const FIND_CARDS_SRC = `(matchesLabel, labels) => {
  const isAccept = (el) =>
    matchesLabel(el.getAttribute("aria-label") || "", el.innerText || "", labels.accept);
  const countAccepts = (el) =>
    Array.from(el.querySelectorAll("button, [role='button']")).filter(isAccept).length;

  const buttons = Array.from(document.querySelectorAll("button, [role='button']")).filter(isAccept);
  const out = [];
  const seen = new Set();
  for (const btn of buttons) {
    // Racine de carte: l'item de liste ARIA qui porte le bouton.
    let container = btn.closest('[role="listitem"]');
    // Repli si LinkedIn cesse de baliser les cartes: remonter jusqu'au premier
    // ancêtre qui contient un lien profil, en abandonnant dès qu'un second
    // bouton "Accepter" apparaît (on a alors dépassé la carte).
    if (!container) {
      let node = btn;
      for (let i = 0; i < 12; i++) {
        if (!node || !node.parentElement) break;
        node = node.parentElement;
        if (countAccepts(node) > 1) { node = null; break; }
        if (node.querySelector('a[href*="/in/"]')) break;
      }
      container = node;
    }
    if (!container || seen.has(container)) continue;
    seen.add(container);
    const usable = countAccepts(container) === 1 && !!container.querySelector('a[href*="/in/"]');
    out.push({ button: btn, container: container, ambiguous: !usable });
  }
  return out;
}`;


/** Extrait le slug d'une URL profil, côté navigateur. */
const SLUG_OF_SRC = `(href) => {
  const m = String(href || "").match(/\\/in\\/([^/?#]+)/);
  return m ? m[1] : null;
}`;

/** Contexte sérialisable injecté dans les évaluations navigateur. */
const ctx = () => ({
  matchesSrc: MATCHES_LABEL_SRC,
  findCardsSrc: FIND_CARDS_SRC,
  slugOfSrc: SLUG_OF_SRC,
  labels: LABELS,
  marker: ACCEPT_MARKER,
});

async function clearAcceptMarker(page: Page): Promise<void> {
  await page
    .evaluate((marker) => {
      for (const el of Array.from(document.querySelectorAll(`[${marker}]`))) {
        el.removeAttribute(marker);
      }
    }, ACCEPT_MARKER)
    .catch(() => undefined);
}

/** Compte les cartes d'invitation rendues (un bouton "Accepter" par carte). */
async function countCards(page: Page): Promise<number> {
  const n = await page
    .evaluate((c) => {
      const matchesLabel = new Function("return (" + c.matchesSrc + ")")() as
        (aria: string, text: string, spec: unknown) => boolean;
      const findCards = new Function("return (" + c.findCardsSrc + ")")() as
        (m: unknown, l: unknown) => unknown[];
      return findCards(matchesLabel, c.labels).length;
    }, ctx())
    .catch(() => 0);
  return typeof n === "number" ? n : 0;
}

/**
 * Trace les navigations du frame principal en mode debug. Sert à vérifier
 * qu'une session n'en fait bien qu'une (le reste du travail se passe sur la
 * page déjà chargée) et à repérer une redirection subie.
 */
const navLogged = new WeakSet<Page>();
function logNavigations(page: Page): void {
  if (process.env.SUPERSOCIAL_DEBUG !== "true" || navLogged.has(page)) return;
  navLogged.add(page);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) console.error(`[invite-accept.nav] ${frame.url()}`);
  });
}

/** Charge la page du gestionnaire d'invitations si on n'y est pas déjà. */
async function ensureInvitationManager(page: Page): Promise<void> {
  logNavigations(page);
  if (page.url().startsWith(INVITATION_MANAGER_URL)) return;
  await page.goto(INVITATION_MANAGER_URL, { waitUntil: "domcontentloaded" });
  assertNotBlocked(page);
  await sleep(1200);
}

/**
 * Attend l'apparition de la première carte plutôt que de dormir un délai fixe:
 * rend la main dès que la liste est rendue, et borne l'attente quand la boîte
 * est vide (auquel cas il n'y a rien à dérouler).
 */
async function waitForFirstCard(page: Page): Promise<number> {
  const deadline = Date.now() + FIRST_CARD_TIMEOUT_MS;
  let count = await countCards(page);
  while (count === 0 && Date.now() < deadline) {
    await sleep(500);
    count = await countCards(page);
  }
  return count;
}

/**
 * Déroule la liste jusqu'à disposer de `targetCount` cartes ou jusqu'à ce que
 * le scroll n'en ramène plus (la liste se charge par lots au scroll, sans
 * bouton de pagination). Le scroll passe par la molette pour rester sur des
 * événements de souris réels, avec un saut en bas de page quand la molette ne
 * suffit plus à déclencher le lot suivant.
 */
async function loadCards(page: Page, targetCount: number): Promise<number> {
  const debug = process.env.SUPERSOCIAL_DEBUG === "true";
  let count = await waitForFirstCard(page);
  if (debug) console.error(`[invite-accept.load] première carte: ${count}`);
  if (count === 0) return 0;
  let plateau = 0;

  for (let round = 0; round < MAX_LOAD_ROUNDS && count < targetCount && plateau < MAX_PLATEAU; round++) {
    await humanScroll(page);
    if (plateau >= 1) await scrollToBottom(page);
    const next = await countCards(page);
    plateau = next > count ? 0 : plateau + 1;
    count = next;
    if (debug) console.error(`[invite-accept.load] round=${round} cartes=${count}/${targetCount} plateau=${plateau}`);
  }

  await scrollToTop(page);
  return count;
}

interface RawInvitationCard {
  invitationUrn: string | null;
  profileHref: string | null;
  name: string;
  headline: string;
  mutual: string;
  note: string;
  ambiguous: boolean;
}

/**
 * Lit les cartes rendues. Les champs sont pris par position dans le lockup
 * plutôt que par reconnaissance de mots: le paragraphe qui porte le lien
 * profil ouvre la carte, le suivant est le poste, celui d'après les relations
 * en commun, le reste la note jointe à l'invitation. Le nom vient du lien
 * profil lui-même (le lien de la photo, sans texte, est ignoré).
 */
async function extractInvitationCards(page: Page): Promise<RawInvitationCard[]> {
  const raw = await page
    .evaluate((c) => {
      const matchesLabel = new Function("return (" + c.matchesSrc + ")")() as
        (aria: string, text: string, spec: unknown) => boolean;
      const findCards = new Function("return (" + c.findCardsSrc + ")")() as
        (m: unknown, l: unknown) => { container: HTMLElement; ambiguous: boolean }[];
      const slugOf = new Function("return (" + c.slugOfSrc + ")")() as (href: string) => string | null;

      const norm = (s: string): string => (s || "").replace(/\s+/g, " ").trim();
      /**
       * Texte d'un élément, hors libellés des boutons qu'il contient ("… voir
       * plus", "Répondre à X"). Les `<br>` deviennent des sauts de ligne, sinon
       * `textContent` colle les paragraphes d'une note bout à bout.
       */
      const cleanText = (el: Element | null): string => {
        if (!el) return "";
        const clone = el.cloneNode(true) as HTMLElement;
        for (const cta of Array.from(clone.querySelectorAll("button, [role='button']"))) cta.remove();
        for (const br of Array.from(clone.querySelectorAll("br"))) br.replaceWith("\n");
        return (clone.textContent ?? "")
          .split("\n")
          .map((line) => norm(line))
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      };

      return findCards(matchesLabel, c.labels).map((card) => {
        const empty = {
          invitationUrn: null,
          profileHref: null,
          name: "",
          headline: "",
          mutual: "",
          note: "",
          ambiguous: true,
        };
        if (card.ambiguous) return empty;
        const container = card.container;
        const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'));

        // Le sujet de la carte est le profil le plus lié dans le lockup (photo
        // plus nom), ce qui écarte un éventuel lien vers une relation en commun.
        const counts = new Map<string, number>();
        const hrefBySlug = new Map<string, string>();
        for (const a of anchors) {
          const slug = slugOf(a.getAttribute("href") ?? a.href ?? "");
          if (!slug) continue;
          counts.set(slug, (counts.get(slug) ?? 0) + 1);
          if (!hrefBySlug.has(slug)) hrefBySlug.set(slug, a.href);
        }
        let subject: string | null = null;
        for (const [slug, n] of counts) {
          if (subject === null || n > (counts.get(subject) ?? 0)) subject = slug;
        }
        if (!subject) return empty;

        // Nom: premier lien du sujet qui porte du texte (celui de la photo n'en a pas).
        let name = "";
        for (const a of anchors) {
          if (slugOf(a.getAttribute("href") ?? a.href ?? "") !== subject) continue;
          const text = norm((a.innerText ?? "").split("\n")[0] ?? "");
          if (text) {
            name = text;
            break;
          }
        }

        // Champs par position à partir du paragraphe qui porte le lien profil.
        const paragraphs = Array.from(container.querySelectorAll<HTMLElement>("p"));
        const head = paragraphs.findIndex((p) => p.querySelector('a[href*="/in/"]'));
        const at = (i: number): string => (i >= 0 && paragraphs[i] ? cleanText(paragraphs[i]!) : "");
        // Note: les paragraphes qui suivent, hors CTA (le "Répondre à X" est
        // rendu comme un lien, la note comme du texte pur).
        const note = paragraphs
          .slice(head + 3)
          .filter((p) => !p.querySelector("a"))
          .map((p) => cleanText(p))
          .filter(Boolean)
          .join(" ");

        // Identifiant stable de l'invitation, porté par la racine de carte.
        const key = container.getAttribute("componentkey") ?? "";

        return {
          invitationUrn: key.startsWith("urn:li:invitation:") ? key : null,
          profileHref: hrefBySlug.get(subject) ?? null,
          name,
          headline: at(head + 1),
          mutual: at(head + 2),
          note,
          ambiguous: false,
        };
      });
    }, ctx())
    .catch(() => [] as RawInvitationCard[]);
  return Array.isArray(raw) ? raw : [];
}

/**
 * Teste la seule présence d'une carte, par URN d'invitation ou par slug de
 * profil. Sert à confirmer une acceptation sans repayer l'extraction complète.
 */
async function isCardPresent(
  page: Page,
  target: { urn: string | null; slug: string },
): Promise<boolean> {
  const present = await page
    .evaluate(
      (c) => {
        const matchesLabel = new Function("return (" + c.matchesSrc + ")")() as
          (aria: string, text: string, spec: unknown) => boolean;
        const findCards = new Function("return (" + c.findCardsSrc + ")")() as
          (m: unknown, l: unknown) => { container: HTMLElement; ambiguous: boolean }[];
        const slugOf = new Function("return (" + c.slugOfSrc + ")")() as (href: string) => string | null;

        return findCards(matchesLabel, c.labels).some((card) => {
          if (card.ambiguous) return false;
          if (c.urn) return card.container.getAttribute("componentkey") === c.urn;
          return Array.from(
            card.container.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'),
          ).some((a) => slugOf(a.getAttribute("href") ?? a.href ?? "") === c.slug);
        });
      },
      { ...ctx(), urn: target.urn, slug: target.slug },
    )
    .catch(() => true);
  return present !== false;
}

function materialize(cards: RawInvitationCard[]): ReceivedInvitation[] {
  const out: ReceivedInvitation[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    if (card.ambiguous || !card.profileHref) continue;
    const slug = extractProfileSlug(card.profileHref);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      name: card.name || slug,
      profileUrl: canonicalProfileUrl(card.profileHref),
      ...(card.invitationUrn ? { invitationUrn: card.invitationUrn } : {}),
      ...(card.headline ? { headline: card.headline } : {}),
      ...(card.mutual ? { mutual: card.mutual } : {}),
      ...(card.note ? { note: card.note } : {}),
    });
  }
  return out;
}

/**
 * Liste les invitations reçues en attente, en déroulant la liste jusqu'à
 * `targetCount` cartes. Retourne une liste vide quand la boîte est vide (cas
 * normal); un dump n'est produit que si des cartes sont rendues sans qu'on
 * sache les rattacher à un profil, signe d'un changement de layout.
 */
export async function readReceivedInvitations(
  page: Page,
  opts: { targetCount?: number } = {},
): Promise<ReceivedInvitation[]> {
  await ensureInvitationManager(page);
  await loadCards(page, opts.targetCount ?? 10);
  const cards = await extractInvitationCards(page);
  const invitations = materialize(cards);
  const unresolved = cards.filter((c) => c.ambiguous || !c.profileHref).length;
  if (process.env.SUPERSOCIAL_DEBUG === "true") {
    await dumpPageState(page, "linkedin-invitation-manager", {
      url: page.url(),
      cards: cards.length,
      unresolved,
      invitations,
    });
  }
  if (unresolved > 0) {
    await dumpPageState(page, "linkedin-invitation-manager-card-unresolved", {
      url: page.url(),
      cards: cards.length,
      unresolved,
    });
  }
  return invitations;
}

/**
 * Clique "Accepter" sur la carte de l'invitation, puis confirme que la carte a
 * disparu de la liste. La carte est ciblée par l'URN d'invitation quand il est
 * connu (identifiant unique porté par la racine de carte), sinon par le slug
 * du profil. La page doit déjà être chargée par `readReceivedInvitations`;
 * elle est rechargée sinon.
 */
export async function acceptReceivedInvitation(
  page: Page,
  invitation: ReceivedInvitation,
): Promise<AcceptInvitationResult> {
  const slug = extractProfileSlug(invitation.profileUrl);
  if (!slug) return { status: "not-found", reason: `URL profil invalide: ${invitation.profileUrl}` };
  const urn = invitation.invitationUrn ?? null;
  const label = urn ?? `/in/${slug}/`;
  await ensureInvitationManager(page);

  // Le bouton est repéré côté DOM puis marqué d'un attribut jetable, pour que
  // le clic lui-même parte de Playwright: souris réelle, événements de
  // confiance, checks d'actionnabilité. Un `element.click()` depuis
  // `page.evaluate` produit un événement synthétique, plus facile à distinguer
  // d'un humain.
  const marked = await page
    .evaluate(
      (c) => {
        const matchesLabel = new Function("return (" + c.matchesSrc + ")")() as
          (aria: string, text: string, spec: unknown) => boolean;
        const findCards = new Function("return (" + c.findCardsSrc + ")")() as
          (m: unknown, l: unknown) => { button: HTMLElement; container: HTMLElement; ambiguous: boolean }[];
        const slugOf = new Function("return (" + c.slugOfSrc + ")")() as (href: string) => string | null;

        for (const stale of Array.from(document.querySelectorAll(`[${c.marker}]`))) {
          stale.removeAttribute(c.marker);
        }

        for (const card of findCards(matchesLabel, c.labels)) {
          if (card.ambiguous) continue;
          const matches = c.urn
            ? card.container.getAttribute("componentkey") === c.urn
            : Array.from(card.container.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')).some(
                (a) => slugOf(a.getAttribute("href") ?? a.href ?? "") === c.slug,
              );
          if (!matches) continue;
          card.button.setAttribute(c.marker, "1");
          return true;
        }
        return false;
      },
      { ...ctx(), slug, urn },
    )
    .catch(() => false);

  if (!marked) {
    return { status: "not-found", reason: `Aucune carte d'invitation pour ${label} sur la page.` };
  }

  const debug = process.env.SUPERSOCIAL_DEBUG === "true";
  const startedAt = Date.now();
  const button = page.locator(`[${ACCEPT_MARKER}]`).first();
  let clicked = false;
  try {
    await button.scrollIntoViewIfNeeded({ timeout: 5000 });
    // Le regard se pose sur la carte avant le clic.
    await sleep(600 + Math.floor(Math.random() * 900));
    await button.click({ timeout: 10_000, delay: 40 + Math.floor(Math.random() * 90) });
    clicked = true;
    if (debug) console.error(`[invite-accept.click] ${label} en ${Date.now() - startedAt}ms`);
  } catch (err) {
    await dumpPageState(page, "linkedin-invitation-accept-click-failed", {
      url: page.url(),
      invitation,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await clearAcceptMarker(page);
  }

  if (!clicked) {
    return {
      status: "not-confirmed",
      reason: "Bouton 'Accepter' repéré mais non cliquable (invisible, recouvert ou détaché).",
    };
  }

  // Confirmation: la carte acceptée disparaît de la liste. Sondage court
  // plutôt qu'une attente fixe, pour rendre la main dès le retrait effectif
  // tout en laissant le temps à l'animation de se terminer.
  const clickedAt = Date.now();
  const deadline = clickedAt + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    if (!(await isCardPresent(page, { urn, slug }))) {
      if (debug) console.error(`[invite-accept.confirm] carte retirée en ${Date.now() - clickedAt}ms`);
      return { status: "accepted" };
    }
  }

  await dumpPageState(page, "linkedin-invitation-accept-not-confirmed", {
    url: page.url(),
    invitation,
  });
  return { status: "not-confirmed", reason: "Bouton cliqué mais la carte est toujours dans la liste." };
}
