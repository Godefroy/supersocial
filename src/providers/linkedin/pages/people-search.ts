import type { Page } from "playwright";
import type { ConnectionDegree, NetworkFilter, PersonResult } from "../../../core/provider.js";
import { safeEval } from "../../../core/extract.js";
import { dumpPageState } from "../../../core/debug.js";
import { scrollToBottom, scrollToTop } from "../page-ops.js";
import { sleep, LoginRequiredError } from "../../../core/throttle.js";

const PEOPLE_SEARCH_URL = "https://www.linkedin.com/search/results/people/";

/**
 * Construit l'URL de recherche de personnes. Le filtre réseau passe par le
 * paramètre `network`: `["F"]` = relations de 1er degré (First), `["S"]` = 2e
 * (Second). `any` n'ajoute pas de filtre. La pagination passe par `page`.
 */
function buildSearchUrl(query: string, network: NetworkFilter, pageNum: number): string {
  const params = new URLSearchParams({ keywords: query, origin: "FACETED_SEARCH" });
  if (network === "1st") params.set("network", '["F"]');
  else if (network === "2nd") params.set("network", '["S"]');
  if (pageNum > 1) params.set("page", String(pageNum));
  return `${PEOPLE_SEARCH_URL}?${params.toString()}`;
}

function mapDegree(text: string | null): ConnectionDegree | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (t.includes("1er") || t.includes("1ère") || t.includes("1st")) return "1st";
  if (t.includes("2e") || t.includes("2nd")) return "2nd";
  if (t.includes("3e") || t.includes("3rd")) return "3rd";
  return undefined;
}

interface RawPerson {
  slug: string;
  url: string;
  name: string;
  headline: string | null;
  location: string | null;
  degreeText: string | null;
}

/**
 * Extrait les cartes de résultat de la page de recherche de personnes. Le DOM
 * récent de LinkedIn n'utilise plus les classes `.entity-result__*` ni des
 * `<li>`: les résultats sont des `<div role="listitem">` (dans un
 * `<div role="list">`) aux classes obfusquées, le degré est rendu sur une ligne
 * "• 1er" à côté du nom, et le sous-titre n'a pas de classe stable. On scope
 * donc carte par carte sur chaque `[role="listitem"]` contenant un lien profil.
 * L'extraction est structurelle: le nom vient du `span[aria-hidden]` du lien,
 * et headline/lieu se lisent par position dans le sous-arbre du lien profil
 * (qui rend nom, degré, headline, lieu dans l'ordre), les boutons étant exclus
 * via leurs `<button>`. Aucune liste de villes ni mot-clé de section; seul le
 * token de degré (`1er/2e/3e/1st…`) reste lexical, ensemble fermé et stable.
 */
async function extractPeopleOnPage(page: Page): Promise<RawPerson[]> {
  const raw = await safeEval<RawPerson[]>(
    page,
    () => {
      const text = (el: Element | null): string =>
        el ? ((el as HTMLElement).innerText ?? "").trim() : "";

      // Token de degré LinkedIn: petit ensemble fermé et stable (FR + EN), pas
      // une liste de mots-clés ouverte.
      const DEGREE_LINE_RE = /^[·•\s]*(1er|1ère|2e|3e\+?|2nd|3rd)\s*$/i;
      const stripDegree = (s: string): string =>
        s.replace(/\s*[·•]\s*(1er|1ère|2e|3e\+?|2nd|3rd)\b.*$/i, "").trim();
      const degreeFrom = (s: string): string | null => {
        const m = s.match(/(?:^|[·•\s])(1er|1ère|2e|3e\+?|2nd|3rd)(?:\b|$)/i);
        return m?.[1] ?? null;
      };

      // Scope au conteneur de résultats principal pour éviter le bruit (nav
      // latérale, footer, suggestions).
      const root: ParentNode =
        document.querySelector('[role="main"]') ??
        document.querySelector("main") ??
        document.querySelector(".search-results-container") ??
        document;

      // Cartes = les `[role="listitem"]` les plus internes qui contiennent un
      // lien profil. "Plus interne" évite de prendre un conteneur englobant.
      const listitems = Array.from(root.querySelectorAll<HTMLElement>('[role="listitem"]')).filter((el) =>
        el.querySelector('a[href*="/in/"]'),
      );
      let cards = listitems.filter(
        (el) =>
          !Array.from(el.querySelectorAll('[role="listitem"]')).some((inner) =>
            inner.querySelector('a[href*="/in/"]'),
          ),
      );
      // Fallback layout classique: si aucun listitem, retomber sur les <li>.
      if (cards.length === 0) {
        cards = Array.from(root.querySelectorAll<HTMLElement>("li")).filter(
          (li) =>
            li.querySelector('a[href*="/in/"]') &&
            !Array.from(li.querySelectorAll("li")).some((inner) => inner.querySelector('a[href*="/in/"]')),
        );
      }

      const out: RawPerson[] = [];
      const seen = new Set<string>();

      for (const card of cards) {
        const links = Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'));
        const profileLink = links.find((l) => l.getAttribute("href")?.includes("/in/"));
        if (!profileLink) continue;
        const href = profileLink.getAttribute("href") ?? "";
        const m = href.match(/\/in\/([^/?#]+)/);
        if (!m?.[1]) continue;
        const slug = decodeURIComponent(m[1]);
        if (seen.has(slug)) continue;

        // Nom: le lien titre est celui qui porte du texte visible (le lien
        // image est vide). On prend le span aria-hidden pour éviter le doublon
        // visually-hidden, et on retire un éventuel suffixe de degré.
        const titleLink = links.find((l) => text(l).length > 0) ?? profileLink;
        let name =
          text(titleLink.querySelector('span[aria-hidden="true"]')) ||
          (text(titleLink).split("\n")[0] ?? "").trim();
        if (!name) {
          const aria = titleLink.getAttribute("aria-label") ?? "";
          const am = aria.match(/(?:voir le profil de|view .*?profile of)\s+(.+)$/i);
          if (am?.[1]) name = am[1].trim();
        }
        const nameClean = stripDegree(name);
        if (!nameClean) continue;

        // Approche structurelle plutôt que par mots-clés. Le lien profil englobe
        // le lockup d'identité (nom, degré, headline, lieu) rendus dans l'ordre;
        // les boutons (Message, Suivre) et blocs annexes (postes, relations
        // communes) vivent hors du lien. On lit donc les lignes du sous-arbre du
        // lien, et on retire les textes de `<button>` repérés structurellement.
        const lineify = (el: Element | null): string[] =>
          text(el)
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);

        const buttonTexts = new Set(
          Array.from(card.querySelectorAll<HTMLElement>("button"))
            .map((b) => text(b))
            .filter(Boolean),
        );

        const fromLink = lineify(titleLink);
        const identity = fromLink.length >= 3 ? fromLink : lineify(card).filter((l) => !buttonTexts.has(l));

        const degreeText = degreeFrom(identity.slice(0, 3).join(" ")) ?? degreeFrom(name) ?? null;

        // Lignes utiles dans l'ordre, nom et lignes de degré retirés. headline =
        // 1ère, lieu = 2e. Aucune liste de villes ni mot-clé de section.
        const rest: string[] = [];
        const seenLine = new Set<string>([nameClean]);
        for (const l of identity) {
          if (DEGREE_LINE_RE.test(l)) continue;
          const clean = stripDegree(l);
          if (!clean || clean === nameClean || clean === name) continue;
          if (buttonTexts.has(clean)) continue;
          if (seenLine.has(clean)) continue;
          seenLine.add(clean);
          rest.push(clean);
        }
        const headline = rest[0] ?? null;
        const location = rest[1] ?? null;

        seen.add(slug);
        out.push({
          slug,
          url: `https://www.linkedin.com/in/${slug}/`,
          name: nameClean,
          headline,
          location,
          degreeText,
        });
      }

      return out;
    },
    { label: "linkedin-people-search-extract" },
  );
  return raw ?? [];
}

function materialize(r: RawPerson): PersonResult {
  const degree = mapDegree(r.degreeText);
  return {
    name: r.name,
    profileUrl: r.url,
    ...(r.headline ? { headline: r.headline } : {}),
    ...(r.location ? { location: r.location } : {}),
    ...(degree ? { degree } : {}),
  };
}

/** Détecte l'état vide LinkedIn ("Aucun résultat") pour ne pas le confondre avec un échec d'extraction. */
async function hasNoResultsState(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const t = (document.body.innerText ?? "").toLowerCase();
      return t.includes("aucun résultat") || t.includes("no results");
    })
    .catch(() => false);
}

export async function searchPeopleOnPage(
  page: Page,
  query: string,
  opts: { limit?: number; network?: NetworkFilter } = {},
): Promise<PersonResult[]> {
  const debug = process.env.SUPERSOCIAL_DEBUG === "true";
  const limit = opts.limit ?? 20;
  const network = opts.network ?? "1st";
  const maxPages = Math.min(10, Math.ceil(limit / 10) + 2);

  const out: PersonResult[] = [];
  const seen = new Set<string>();

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    await page.goto(buildSearchUrl(query, network, pageNum), { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login") || page.url().includes("/checkpoint/")) {
      throw new LoginRequiredError(`redirigé vers ${page.url()}`, page.url());
    }
    await sleep(3500);
    // Les cartes se chargent en lazy: descendre puis remonter pour forcer le rendu.
    await scrollToBottom(page);
    await sleep(1200);
    await scrollToTop(page);

    const raw = await extractPeopleOnPage(page);
    if (debug) {
      console.error(`[people-search.load] page=${pageNum} got=${raw.length} total=${out.length}`);
      if (pageNum === 1) await dumpPageState(page, "linkedin-people-search-debug", { pageNum, got: raw.length });
    }

    // État vide LinkedIn: arrêt propre, sans dump (ce n'est pas un bug d'extraction).
    if (raw.length === 0 && (await hasNoResultsState(page))) {
      if (debug) console.error(`[people-search.load] page=${pageNum}: LinkedIn affiche "Aucun résultat"`);
      return out.slice(0, limit);
    }

    let added = 0;
    for (const r of raw) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(materialize(r));
      added++;
      if (out.length >= limit) break;
    }

    if (out.length >= limit) break;
    if (added === 0) break; // plus de résultats sur les pages suivantes
  }

  if (out.length === 0) {
    await dumpPageState(page, "linkedin-people-search-zero", { query, network });
  }

  return out.slice(0, limit);
}
