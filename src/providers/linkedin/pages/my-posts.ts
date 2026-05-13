import type { Page } from "playwright";
import type { Post } from "../../../core/provider.js";
import { loadAndExtractPosts } from "../page-ops.js";
import { LoginRequiredError } from "../../../core/throttle.js";

export interface ListMyPostsOptions {
  limit?: number;
  profileSlug?: string;
  /** IDs déjà connus (depuis l'index existant). La synchro s'arrête dès qu'un batch ne contient que ces IDs. */
  knownIds?: Set<string>;
}

export async function listMyPostsOnPage(
  page: Page,
  opts: ListMyPostsOptions = {},
): Promise<Post[]> {
  const limit = opts.limit ?? 50;
  const slug = opts.profileSlug ?? "me";
  const url = `https://www.linkedin.com/in/${slug}/recent-activity/all/`;

  await page.goto(url, { waitUntil: "domcontentloaded" });

  if (page.url().includes("/login") || page.url().includes("/checkpoint/")) {
    throw new LoginRequiredError(`redirigé vers ${page.url()}`, page.url());
  }

  // Sur recent-activity, chaque post a ~2 boutons aria-label "post de X", donc on
  // cible le double en boutons pour obtenir suffisamment de posts après dédup.
  const posts = await loadAndExtractPosts(page, {
    targetCount: limit * 2 + 2,
    label: "my-posts",
    initialWaitMs: 5000,
    loadTimeoutMs: 15 * 60_000,
    maxPlateau: 5,
    ...(opts.knownIds ? { stopWhenAllKnown: opts.knownIds } : {}),
  });
  return posts.slice(0, limit);
}
