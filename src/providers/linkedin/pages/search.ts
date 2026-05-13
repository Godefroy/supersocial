import type { Page } from "playwright";
import type { Post } from "../../../core/provider.js";
import { loadAndExtractPosts } from "../page-ops.js";
import { LoginRequiredError } from "../../../core/throttle.js";

const CONTENT_SEARCH_URL = "https://www.linkedin.com/search/results/content/";

function buildSearchUrl(query: string, dateRange?: "past-24h" | "past-week" | "past-month"): string {
  const params = new URLSearchParams({ keywords: query });
  if (dateRange === "past-24h") params.set("datePosted", '"past-24h"');
  if (dateRange === "past-week") params.set("datePosted", '"past-week"');
  if (dateRange === "past-month") params.set("datePosted", '"past-month"');
  return `${CONTENT_SEARCH_URL}?${params.toString()}`;
}

export async function searchPostsOnPage(
  page: Page,
  query: string,
  opts: { limit?: number; dateRange?: "past-24h" | "past-week" | "past-month" } = {},
): Promise<Post[]> {
  const limit = opts.limit ?? 20;
  await page.goto(buildSearchUrl(query, opts.dateRange), { waitUntil: "domcontentloaded" });

  if (page.url().includes("/login") || page.url().includes("/checkpoint/")) {
    throw new LoginRequiredError(`redirigé vers ${page.url()}`, page.url());
  }

  const posts = await loadAndExtractPosts(page, {
    targetCount: limit + 2,
    label: "search",
    initialWaitMs: 6000,
  });
  return posts.slice(0, limit);
}
