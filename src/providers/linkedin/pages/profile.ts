import type { Page } from "playwright";
import type { ConnectionDegree, ProfilePosition, ProfileStatus, InviteResult } from "../../../core/provider.js";
import { sleep, LoginRequiredError } from "../../../core/throttle.js";
import { dumpPageState } from "../../../core/debug.js";

/**
 * Les sections "Infos" et "Expérience" se rendent en lazy quand elles entrent
 * dans le viewport. On descend la page par paliers pour déclencher leur rendu,
 * puis on remonte en haut avant l'extraction (le Topcard reste en DOM).
 */
async function loadProfileSections(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const height = document.scrollingElement?.scrollHeight ?? document.body.scrollHeight;
      for (let y = 0; y < Math.min(height, 6000); y += 600) {
        window.scrollTo(0, y);
        await wait(150);
      }
      window.scrollTo(0, 0);
    })
    .catch(() => undefined);
  await sleep(1200);
}

const PROFILE_URL_RE = /https?:\/\/(?:www\.)?linkedin\.com\/in\/([^/?#]+)/i;

export function extractProfileSlug(input: string): string | null {
  const m = input.match(PROFILE_URL_RE);
  return m?.[1] ?? null;
}

export function canonicalProfileUrl(input: string): string {
  const slug = extractProfileSlug(input);
  if (!slug) throw new Error(`URL profil invalide: ${input}. Format attendu: https://www.linkedin.com/in/<slug>/`);
  return `https://www.linkedin.com/in/${slug}/`;
}

/**
 * Charge la page profil et lit le degré de relation, l'état d'invitation, le
 * URN et le nom. Le degré se déduit de plusieurs signaux DOM en cascade
 * pour rester robuste aux variations de layout LinkedIn:
 * 1. Le badge `.dist-value` ou `[class*="distance-badge"]` rend "1ère", "2e", "3e" ou "3e+"
 * 2. Le `aria-label` du bouton Plus/Connect contient parfois "relation au Xe degré"
 * 3. La présence d'un bouton "Message" sans bouton "Se connecter" suggère 1ère relation
 * 4. L'absence des deux suggère "out-of-network"
 */
export async function readProfileStatus(page: Page, url: string): Promise<ProfileStatus> {
  const targetUrl = canonicalProfileUrl(url);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  assertNotBlocked(page);
  await sleep(2500);
  await loadProfileSections(page);

  const raw = await page
    .evaluate(() => {
      const innerText = (el: Element | null): string =>
        el ? ((el as HTMLElement).innerText ?? "").trim() : "";

      // Nom (h1 du top card, fallback title)
      const h1 = document.querySelector<HTMLHeadingElement>("h1");
      const nameFromH1 = innerText(h1).split("\n")[0]?.trim() ?? "";
      const titleMatch = (document.title ?? "").match(/^(?:\(\d+\)\s*)?([^|]+?)(?:\s*\|.*)?$/);
      const name = nameFromH1 || titleMatch?.[1]?.trim() || null;

      // URN profil dérivé des liens compose (le plus fréquent = la cible)
      const counts = new Map<string, number>();
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/messaging/compose/"]'))) {
        const href = a.getAttribute("href") ?? "";
        const m = href.match(/profileUrn=urn%3Ali%3Afsd_profile%3A([A-Za-z0-9_-]+)/);
        if (m?.[1]) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
      let profileUrn: string | null = null;
      let bestCount = 0;
      for (const [k, v] of counts) {
        if (v > bestCount) { profileUrn = k; bestCount = v; }
      }

      // Topcard: dans la nouvelle UI server-driven, le top card est un div
      // avec componentkey="com.linkedin.sdui.profile.card.ref<URN>Topcard".
      // Toutes les actions principales (Message, Suivre, Inviter, Plus) sont
      // dedans. Les suggestions sidebar (PYMK, browsemap) sont OUTSIDE et
      // contiennent aussi des "Inviter X" qu'il ne faut JAMAIS cliquer ici.
      const topcardEl: HTMLElement | null = (() => {
        const all = Array.from(document.querySelectorAll<HTMLElement>('[componentkey]'));
        return (
          all.find((el) =>
            (el.getAttribute("componentkey") ?? "").startsWith("com.linkedin.sdui.profile.card.ref") &&
            (el.getAttribute("componentkey") ?? "").endsWith("Topcard"),
          ) ?? null
        );
      })();
      const scope: HTMLElement | Document = topcardEl ?? document;

      // Degré: signal le plus rapide à charger c'est le `<p>· 2e</p>` (ou
      // "· 1er", "· 3e+") rendu directement dans le Topcard juste avant le
      // headline. LinkedIn rend en HTML brut TOUTES les variantes (1er, 2e,
      // 3e+) côte à côte et n'en affiche qu'une via CSS, donc on filtre
      // sur la visibilité réelle. Les fallbacks (aria-label des entity-
      // lockups, .dist-value, .visually-hidden) restent pour les cas où
      // le Topcard n'expose pas ce pattern (vieux layout, A/B test).
      const degreeText = (() => {
        const isVisible = (el: HTMLElement): boolean => {
          const cv = (el as unknown as { checkVisibility?: () => boolean }).checkVisibility;
          if (typeof cv === "function") return cv.call(el);
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        if (topcardEl) {
          const ps = Array.from(topcardEl.querySelectorAll<HTMLElement>("p, span"));
          for (const p of ps) {
            if (!isVisible(p)) continue;
            const t = (p.innerText ?? "").trim();
            const m = t.match(/^[·•]\s*(1er|1ère|2e|3e\+?|2nd|3rd)$/i);
            if (m?.[1]) return m[1].toLowerCase();
          }
        }
        const nameTrim = (name ?? "").trim();
        if (nameTrim) {
          const ariaElements = Array.from(document.querySelectorAll<HTMLElement>("[aria-label]"));
          for (const el of ariaElements) {
            const aria = (el.getAttribute("aria-label") ?? "").trim();
            if (!aria.startsWith(nameTrim)) continue;
            const m = aria.match(/(?:^|\s)(1er|1ère|2e|3e\+?|2nd|3rd)\s*$/i);
            if (m?.[1]) return m[1].toLowerCase();
          }
        }
        // Fallback ancien layout: badge .dist-value
        const oldBadges = Array.from(
          document.querySelectorAll<HTMLElement>(
            '.dist-value, [class*="distance-badge"] span, [data-test-distance-value]',
          ),
        );
        for (const el of oldBadges) {
          const t = innerText(el).toLowerCase();
          if (t) return t;
        }
        // Fallback "relation au Ne degré" dans visually-hidden
        const hidden = Array.from(document.querySelectorAll<HTMLElement>(".visually-hidden, .a11y-text"));
        for (const el of hidden) {
          const t = innerText(el).toLowerCase();
          const m = t.match(/relation au (\d+)(?:er|e|ère) degr/);
          if (m?.[1]) return `${m[1]}e`;
        }
        return "";
      })();

      // Headline (poste et entreprise): le `.text-body-medium` du Topcard rend
      // la ligne de titre juste sous le nom. Fallback: première ligne de texte
      // du Topcard, après le nom, qui n'est ni le degré ni le nom lui-même.
      const headline = (() => {
        const scopeEl: HTMLElement | Document = topcardEl ?? document;
        const direct = scopeEl.querySelector<HTMLElement>(".text-body-medium.break-words, .text-body-medium");
        const dt = innerText(direct).split("\n")[0]?.trim() ?? "";
        if (dt && dt !== (name ?? "")) return dt;
        if (topcardEl) {
          const nameTrim = (name ?? "").trim();
          const lines = (topcardEl.innerText ?? "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          const idx = nameTrim ? lines.findIndex((l) => l === nameTrim) : -1;
          for (const l of lines.slice(idx + 1)) {
            if (l === nameTrim) continue;
            if (/^[·•]?\s*(1er|1ère|2e|3e\+?|2nd|3rd)$/i.test(l)) continue;
            if (/relation au \d/i.test(l)) continue;
            if (l.length < 4) continue;
            return l;
          }
        }
        return null;
      })();

      // Boutons d'action: tous scopés au Topcard pour éviter les collisions
      // avec les suggestions sidebar (Moussa DIAKITE en attente, Inviter
      // Logan R., etc.).
      const buttonsInScope = Array.from(scope.querySelectorAll<HTMLElement>("button, a"));

      const hasMessageButton = buttonsInScope.some((el) => {
        const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
        const text = innerText(el).toLowerCase();
        return aria.startsWith("envoyer un message à") || aria === "message" || text === "message";
      });

      const hasConnectButtonVisible = buttonsInScope.some((el) => {
        const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
        return aria.startsWith("inviter ") || aria === "se connecter";
      });

      // Pour invitationPending, on cherche STRICTEMENT dans le Topcard.
      // Sinon le "En attente" d'un Moussa DIAKITE en sidebar nous polluerait.
      const invitationPending = buttonsInScope.some((el) => {
        const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
        const text = innerText(el).toLowerCase();
        return aria.includes("en attente") || text === "en attente" || aria.includes("pending") || text === "pending";
      });

      // Bouton "Plus" dans le Topcard (cache Se connecter pour 3e degré ou
      // certains 2e selon le layout).
      const hasMoreMenu = buttonsInScope.some((el) => {
        const aria = (el.getAttribute("aria-label") ?? "").trim();
        return aria === "Plus" || aria.toLowerCase().startsWith("plus d'actions") || aria.toLowerCase().startsWith("more actions");
      });

      // Sections "Infos" et "Expérience". Le profil récent est server-driven:
      // chaque carte porte un `componentkey` stable et indépendant de la langue
      // (même schéma que le Topcard: `com.linkedin.sdui.profile.card.ref<URN><Section>`).
      // On localise les cartes par ce suffixe, avec un fallback ancre/`<h2>` pour
      // l'ancien layout. On lit ensuite par forme des lignes, sans classes CSS
      // obfusquées ni mots-clés de langue.
      const findCard = (suffix: string, headers: string[]): HTMLElement | null => {
        const byKey = Array.from(document.querySelectorAll<HTMLElement>("[componentkey]")).find((el) => {
          const k = el.getAttribute("componentkey") ?? "";
          return k.startsWith("com.linkedin.sdui.profile.card.ref") && k.endsWith(suffix);
        });
        if (byKey) return byKey;
        const anchor = document.getElementById(suffix.toLowerCase());
        const viaAnchor = anchor?.closest("section");
        if (viaAnchor) return viaAnchor as HTMLElement;
        for (const s of Array.from(document.querySelectorAll<HTMLElement>("section"))) {
          const h = s.querySelector("h2");
          const t = (h ? innerText(h) : "").toLowerCase();
          if (t && headers.some((n) => t.includes(n))) return s;
        }
        return null;
      };

      const cardLines = (el: HTMLElement | null): string[] =>
        el
          ? innerText(el)
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
          : [];

      // Infos: 1ère ligne = en-tête localisé (ignoré). Le corps est la suite de
      // lignes "prose" (longues ou ponctuées comme une phrase) jusqu'à une ligne
      // courte de sous-section (compétences, sélection). Détection par forme, pas
      // par mot-clé.
      const about = (() => {
        const lines = cardLines(findCard("About", ["à propos", "infos", "about"]));
        if (lines.length < 2) return null;
        const body: string[] = [];
        for (const l of lines.slice(1)) {
          const prose = l.length >= 40 || /[.!?…]$/.test(l);
          if (!prose) break;
          body.push(l);
        }
        return body.join("\n") || null;
      })();

      // Expérience: chaque poste est une séquence de lignes ancrée par sa ligne
      // de période (une année + un séparateur de plage ou une durée). Avant la
      // date: titre puis entreprise; après: localisation puis description. On
      // ignore le bruit "Article N" (média mis en avant) et les libellés de
      // bouton repérés via `<button>`.
      const positions = (() => {
        const expCard = findCard("ExperienceTopLevelSection", ["expérience", "experience"]);
        const lines = cardLines(expCard);
        if (lines.length < 2) return [] as Array<{
          title: string;
          company: string | null;
          dateRange: string | null;
          description: string | null;
          current: boolean;
        }>;
        const buttonTexts = new Set(
          expCard
            ? Array.from(expCard.querySelectorAll<HTMLElement>("button"))
                .map((b) => innerText(b).trim())
                .filter(Boolean)
            : [],
        );
        const body = lines.slice(1).filter((l) => !buttonTexts.has(l));
        const isNoise = (l: string): boolean => /^article\s+\d+$/i.test(l);
        const isDateLine = (l: string): boolean => /(19|20)\d{2}/.test(l) && /[-–—·]/.test(l);
        const PRESENT = /(aujourd['’]?hui|présent|present|à ce jour|en poste|\bnow\b)/i;

        const dateIdx: number[] = [];
        body.forEach((l, i) => {
          if (isDateLine(l)) dateIdx.push(i);
        });

        const out = [];
        for (let n = 0; n < dateIdx.length; n++) {
          const di = dateIdx[n]!;
          const dateRange = body[di]!;
          const before = body.slice(Math.max(0, di - 3), di).filter((x) => !isNoise(x));
          const title = (before[before.length - 2] ?? before[before.length - 1] ?? "").trim();
          if (!title) continue;
          let company: string | null = (before[before.length - 1] ?? "").trim() || null;
          if (company === title || (company && isNoise(company))) company = null;
          if (company) company = (company.split("·")[0] ?? "").trim() || null;
          // Description: lignes après la localisation (di+1) jusqu'au poste suivant.
          const end = n + 1 < dateIdx.length ? dateIdx[n + 1]! - 2 : body.length;
          const after = body.slice(di + 2, Math.max(di + 2, end));
          const description = after.join("\n").trim() || null;
          const current = PRESENT.test(dateRange);
          out.push({ title, company, dateRange, description, current });
        }
        return out;
      })();

      return {
        name,
        headline,
        about,
        positions,
        profileUrn,
        degreeText,
        topcardFound: Boolean(topcardEl),
        hasMessageButton,
        hasConnectButtonVisible,
        invitationPending,
        hasMoreMenu,
      };
    })
    .catch(() => null);

  if (!raw) {
    await dumpPageState(page, "linkedin-profile-status-extract-failed", { url: targetUrl });
    throw new Error(`Extraction profil échouée pour ${targetUrl}.`);
  }

  if (process.env.SUPERSOCIAL_DEBUG === "true" && !raw.degreeText) {
    await dumpPageState(page, "linkedin-profile-degree-not-found", { url: targetUrl, name: raw.name });
  }
  if (process.env.SUPERSOCIAL_DEBUG === "true") {
    await dumpPageState(page, "linkedin-profile-debug", {
      url: targetUrl,
      name: raw.name,
      aboutLen: (raw.about ?? "").length,
      positions: raw.positions?.length ?? 0,
    });
  }

  const degree: ConnectionDegree = (() => {
    const t = raw.degreeText;
    if (t === "1er" || t === "1ère" || t === "1st") return "1st";
    if (t === "2e" || t === "2nd") return "2nd";
    if (t === "3e" || t === "3e+" || t === "3rd") return "3rd";
    // Heuristique: pas de degré explicite + pas de connect + pas de Plus = hors réseau
    if (!raw.hasConnectButtonVisible && !raw.hasMoreMenu) {
      return "out-of-network";
    }
    return "unknown";
  })();

  // canMessage = uniquement 1ère relation. Le bouton Message visible sur le
  // profil ne garantit rien pour les 2e/3e: le clic redirige vers compose
  // qui affichera l'upsell Premium.
  const canMessage = degree === "1st";

  const status: ProfileStatus = {
    url: targetUrl,
    degree,
    invitationPending: raw.invitationPending,
    canMessage,
  };
  if (raw.name) status.name = raw.name;
  if (raw.headline) status.headline = raw.headline;
  if (raw.about) status.about = raw.about;

  // Postes actuels: on garde ceux détectés "en cours". Si la détection échoue
  // (période sans marqueur reconnu), on retombe sur le poste le plus récent.
  const allPositions = Array.isArray(raw.positions) ? raw.positions : [];
  const currentPositions = allPositions.filter((p) => p.current);
  const kept = currentPositions.length > 0 ? currentPositions : allPositions.slice(0, 1);
  if (kept.length > 0) {
    status.positions = kept.map((p): ProfilePosition => ({
      title: p.title,
      ...(p.company ? { company: p.company } : {}),
      ...(p.dateRange ? { dateRange: p.dateRange } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.current ? { current: true } : {}),
    }));
  }

  if (raw.profileUrn) status.profileUrn = `urn:li:fsd_profile:${raw.profileUrn}`;
  return status;
}

/**
 * Envoie une demande de connexion depuis la page profil. Le bouton "Se
 * connecter" peut être visible directement (souvent en 2e relation) ou caché
 * dans le menu "Plus" (souvent en 3e relation). On essaye le bouton visible
 * d'abord, puis on retombe sur le menu si nécessaire.
 *
 * Si `note` est fournie, clique sur "Ajouter une note", remplit le textarea,
 * puis "Envoyer". Sinon, clique "Envoyer sans note" (ou "Envoyer" pour les
 * variantes sans option note).
 *
 * Suppose que le caller a déjà vérifié le degré (pas 1ère relation) et la
 * non-existence d'invitation pendante via `readProfileStatus`. Si appelé sur
 * une 1ère relation, retourne `already-connected`.
 */
export async function sendInvite(
  page: Page,
  url: string,
  opts: { note?: string } = {},
): Promise<InviteResult> {
  const targetUrl = canonicalProfileUrl(url);
  if (page.url() !== targetUrl) {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    assertNotBlocked(page);
    await sleep(2500);
  }

  // Court-circuits via lecture rapide de l'état avant de tenter le clic.
  // Le pre-check et tous les clics de "Se connecter" / "Plus" sont scopés au
  // Topcard du profil (composant SUI `com.linkedin.sdui.profile.card.ref<URN>Topcard`).
  // Sinon les "Inviter X" et "En attente" des suggestions sidebar (Logan R.,
  // Moussa DIAKITE, etc.) collisionnent et un clic peut envoyer une
  // invitation à la mauvaise personne.
  const findTopcard = `() => {
    const all = Array.from(document.querySelectorAll('[componentkey]'));
    return all.find((el) =>
      (el.getAttribute('componentkey') || '').startsWith('com.linkedin.sdui.profile.card.ref') &&
      (el.getAttribute('componentkey') || '').endsWith('Topcard')
    ) || null;
  }`;

  const preCheck = await page
    .evaluate((findTopcardSrc) => {
      const findTopcard = new Function("return (" + findTopcardSrc + ")()") as () => HTMLElement | null;
      const topcard = findTopcard();
      if (!topcard) return { pending: false, connected: false, topcardFound: false };
      const text = (el: Element | null): string =>
        el ? ((el as HTMLElement).innerText ?? "").toLowerCase().trim() : "";
      const buttons = Array.from(topcard.querySelectorAll<HTMLElement>("button, a"));
      const has = (pred: (aria: string, t: string) => boolean): boolean =>
        buttons.some((b) => pred((b.getAttribute("aria-label") ?? "").toLowerCase(), text(b)));
      return {
        pending: has((aria, t) => aria.includes("en attente") || t === "en attente" || aria.includes("pending")),
        connected: has((aria, _) => aria.startsWith("envoyer un message à")) &&
          !has((aria, t) => aria.startsWith("inviter ") || aria.includes("se connecter") || t === "se connecter"),
        topcardFound: true,
      };
    }, findTopcard)
    .catch(() => ({ pending: false, connected: false, topcardFound: false }));

  if (!preCheck.topcardFound) {
    await dumpPageState(page, "linkedin-invite-topcard-not-found", { url: targetUrl });
    return { status: "no-button", reason: "Top card du profil introuvable (componentkey 'com.linkedin.sdui.profile.card.ref...Topcard'). Layout LinkedIn possiblement changé." };
  }
  if (preCheck.pending) return { status: "already-pending" };
  if (preCheck.connected) return { status: "already-connected" };

  const debug = process.env.SUPERSOCIAL_DEBUG === "true";
  let viaMoreMenu = false;

  // Tentative 1: bouton/lien "Inviter X à rejoindre votre réseau" (ou
  // variantes legacy) visible directement DANS LE TOPCARD UNIQUEMENT.
  // Le CTA peut être rendu comme `<a>` ou `<button>` selon le degré et le
  // layout, on scan les deux + tout `[role='button']`.
  const directClicked = await page
    .evaluate((findTopcardSrc) => {
      const findTopcard = new Function("return (" + findTopcardSrc + ")()") as () => HTMLElement | null;
      const topcard = findTopcard();
      if (!topcard) return false;
      const elements = Array.from(
        topcard.querySelectorAll<HTMLElement>("button, a, [role='button']"),
      );
      for (const el of elements) {
        if ((el as HTMLButtonElement).disabled) continue;
        const aria = el.getAttribute("aria-label") ?? "";
        const ariaLow = aria.toLowerCase();
        const text = (el.innerText ?? "").toLowerCase().trim();
        if (
          ariaLow.startsWith("inviter ") ||
          ariaLow === "se connecter" ||
          text === "se connecter"
        ) {
          el.click();
          return true;
        }
      }
      return false;
    }, findTopcard)
    .catch(() => false);

  if (!directClicked) {
    // Tentative 2: ouvrir le menu "Plus" du Topcard, puis cliquer
    // "Inviter / Se connecter" dans le dropdown qui apparaît (sibling, pas
    // dans le Topcard).
    const moreOpened = await page
      .evaluate((findTopcardSrc) => {
        const findTopcard = new Function("return (" + findTopcardSrc + ")()") as () => HTMLElement | null;
        const topcard = findTopcard();
        if (!topcard) return false;
        const buttons = Array.from(topcard.querySelectorAll<HTMLButtonElement>("button"));
        for (const b of buttons) {
          if (b.disabled) continue;
          const aria = (b.getAttribute("aria-label") ?? "").trim();
          if (
            aria === "Plus" ||
            aria.toLowerCase().startsWith("plus d'actions") ||
            aria.toLowerCase().startsWith("more actions")
          ) {
            b.click();
            return true;
          }
        }
        return false;
      }, findTopcard)
      .catch(() => false);

    if (!moreOpened) {
      await dumpPageState(page, "linkedin-invite-no-button", { url: targetUrl });
      return { status: "no-button", reason: "Bouton 'Se connecter' introuvable, ni en visible ni via le menu Plus." };
    }

    // Le menu se déploie via une transition CSS, laisser le temps de rendre
    await sleep(800);

    const menuClicked = await page
      .evaluate(() => {
        const items = Array.from(
          document.querySelectorAll<HTMLElement>(
            "[role='menu'] [role='menuitem'], [role='menu'] button, [role='menu'] [role='button'], .artdeco-dropdown__content button, .artdeco-dropdown__content [role='button']",
          ),
        );
        for (const el of items) {
          const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
          const text = (el.innerText ?? "").toLowerCase().trim();
          if (
            aria.startsWith("inviter ") ||
            text.startsWith("inviter ") ||
            aria.includes("se connecter") ||
            text.includes("se connecter")
          ) {
            (el as HTMLElement).click();
            return true;
          }
        }
        return false;
      })
      .catch(() => false);

    if (!menuClicked) {
      await dumpPageState(page, "linkedin-invite-menu-no-connect", { url: targetUrl });
      return { status: "no-button", reason: "Menu 'Plus' ouvert mais aucune option 'Se connecter' à l'intérieur." };
    }
    viaMoreMenu = true;
    if (debug) console.error(`[invite] connect cliqué via menu Plus`);
  }

  // La modale d'invitation est rendue dans un Shadow DOM monté sur
  // `#interop-outlet[data-testid="interop-shadowdom"]`. Le DOM principal
  // contient juste le div outlet vide; tout le markup (titre, boutons,
  // textarea) vit dans le shadow root et n'est pas visible via
  // `document.querySelector(...)`. Toutes les évaluations doivent piercer le
  // shadow root.
  const inviteUiReady = await page
    .waitForFunction(
      () => {
        const outlet = document.getElementById("interop-outlet");
        const root = outlet?.shadowRoot;
        if (!root) return false;
        const els = Array.from(root.querySelectorAll<HTMLElement>("button, a, [role='button']"));
        return els.some((el) => {
          const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
          const text = (el.innerText ?? "").toLowerCase().trim();
          return (
            aria.includes("envoyer") ||
            text.includes("envoyer") ||
            aria.includes("ajouter une note") ||
            text.includes("ajouter une note")
          );
        });
      },
      null,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!inviteUiReady) {
    await dumpPageState(page, "linkedin-invite-modal-not-opened", { url: targetUrl, viaMoreMenu, currentUrl: page.url() });
    return { status: "blocked", reason: "Modale d'invitation (shadow root #interop-outlet) absente 10s après le clic." };
  }
  if (debug) console.error(`[invite] shadow root invite UI ready`);
  await sleep(500);

  if (opts.note && opts.note.trim().length > 0) {
    // Cliquer "Ajouter une note" pour révéler le textarea (la modale ouvre
    // par défaut sur le choix "Ajouter une note" / "Envoyer sans note").
    await page
      .evaluate(() => {
        const root = document.getElementById("interop-outlet")?.shadowRoot;
        if (!root) return false;
        const els = Array.from(root.querySelectorAll<HTMLElement>("button, a, [role='button']"));
        for (const el of els) {
          if ((el as HTMLButtonElement).disabled) continue;
          const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
          const text = (el.innerText ?? "").toLowerCase().trim();
          if (aria.includes("ajouter une note") || text.includes("ajouter une note") || text.includes("add a note")) {
            el.click();
            return true;
          }
        }
        return false;
      })
      .catch(() => false);
    await sleep(800);

    const noteFilled = await page
      .evaluate(
        (note) => {
          const root = document.getElementById("interop-outlet")?.shadowRoot;
          if (!root) return false;
          const ta = root.querySelector<HTMLTextAreaElement>(
            "textarea#custom-message, textarea[name='message'], textarea",
          );
          if (!ta) return false;
          ta.focus();
          ta.value = note;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        opts.note,
      )
      .catch(() => false);
    if (!noteFilled) {
      await dumpPageState(page, "linkedin-invite-textarea-missing", { url: targetUrl });
      return { status: "blocked", reason: "Textarea de note introuvable dans le shadow root d'invitation." };
    }
    await sleep(400);
  }

  // Envoyer: cherche dans le shadow root, scan button/a/[role=button].
  const sendClicked = await page
    .evaluate(() => {
      const root = document.getElementById("interop-outlet")?.shadowRoot;
      if (!root) return false;
      const els = Array.from(root.querySelectorAll<HTMLElement>("button, a, [role='button']"));
      const primary = els.find((el) => {
        if ((el as HTMLButtonElement).disabled) return false;
        const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
        const text = (el.innerText ?? "").toLowerCase().trim();
        const cls = el.className.toLowerCase();
        return (
          (cls.includes("primary") || cls.includes("--primary")) &&
          (aria.includes("envoyer") || text.includes("envoyer") || text.includes("send"))
        );
      });
      if (primary) { primary.click(); return true; }
      const generic = els.find((el) => {
        if ((el as HTMLButtonElement).disabled) return false;
        const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
        const text = (el.innerText ?? "").toLowerCase().trim();
        return (
          aria === "envoyer" ||
          aria.includes("envoyer maintenant") ||
          aria.includes("envoyer sans note") ||
          text === "envoyer" ||
          text.includes("envoyer maintenant") ||
          text.includes("envoyer sans note") ||
          text === "send" ||
          text.includes("send now") ||
          text.includes("send without")
        );
      });
      if (generic) { generic.click(); return true; }
      return false;
    })
    .catch(() => false);

  if (!sendClicked) {
    const shadowDump = await page
      .evaluate(() => {
        const root = document.getElementById("interop-outlet")?.shadowRoot;
        if (!root) return [];
        const els = Array.from(root.querySelectorAll<HTMLElement>("button, a, [role='button']"));
        return els.slice(0, 30).map((el) => ({
          tag: el.tagName.toLowerCase(),
          aria: el.getAttribute("aria-label") ?? "",
          text: ((el.innerText ?? "") as string).slice(0, 80).trim(),
          role: el.getAttribute("role") ?? "",
        }));
      })
      .catch(() => []);
    if (debug) console.error(`[invite] shadow candidates: ${JSON.stringify(shadowDump, null, 2)}`);
    await dumpPageState(page, "linkedin-invite-send-button-missing", { url: targetUrl, shadowDump });
    return { status: "blocked", reason: "Bouton 'Envoyer' introuvable ou inactif dans le shadow root d'invitation." };
  }

  // Confirmer: le shadow root se vide (plus de textarea/boutons d'envoi).
  const sentConfirmed = await page
    .waitForFunction(
      () => {
        const root = document.getElementById("interop-outlet")?.shadowRoot;
        if (!root) return true;
        const els = Array.from(root.querySelectorAll<HTMLElement>("button, a, [role='button']"));
        return !els.some((el) => {
          const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
          const text = (el.innerText ?? "").toLowerCase().trim();
          return aria.includes("envoyer") || text.includes("envoyer") || aria.includes("ajouter une note");
        });
      },
      null,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);

  if (!sentConfirmed) {
    await dumpPageState(page, "linkedin-invite-not-confirmed", { url: targetUrl, currentUrl: page.url() });
    return { status: "blocked", reason: "Envoi non confirmé: l'iframe d'invitation est resté ouvert 10s après clic 'Envoyer'." };
  }

  await sleep(800);
  const result: InviteResult = { status: "sent", viaMoreMenu, withNote: Boolean(opts.note?.trim()) };
  return result;
}

function assertNotBlocked(page: Page): void {
  const u = page.url();
  if (u.includes("/login") || u.includes("/checkpoint/")) {
    throw new LoginRequiredError(`redirigé vers ${u}`, u);
  }
}

