import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { ensureStateDir } from "./storage.js";

export interface DumpResult {
  dir: string;
  html: string;
  screenshot: string;
  meta: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function dumpPageState(
  page: Page,
  label: string,
  extraMeta: Record<string, unknown> = {},
): Promise<DumpResult> {
  const root = join(ensureStateDir(), "debug");
  const dir = join(root, `${timestamp()}-${label}`);
  mkdirSync(dir, { recursive: true });

  const html = join(dir, "page.html");
  const screenshot = join(dir, "page.png");
  const meta = join(dir, "meta.json");

  const url = page.url();
  let innerText = "";
  try {
    innerText = await page.evaluate(() => document.body.innerText ?? "");
  } catch { /* ignore */ }

  let htmlCaptured = false;
  for (let attempt = 0; attempt < 4 && !htmlCaptured; attempt++) {
    try {
      const content = await page.content();
      writeFileSync(html, content, "utf8");
      htmlCaptured = true;
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (!htmlCaptured) {
    try {
      const outer = await page.evaluate(
        () => document.documentElement?.outerHTML ?? document.body?.outerHTML ?? "",
      );
      writeFileSync(html, outer || "<!-- empty -->", "utf8");
    } catch (err) {
      writeFileSync(html, `<!-- dump failed: ${err instanceof Error ? err.message : String(err)} -->`, "utf8");
    }
  }

  try {
    await page.screenshot({ path: screenshot, fullPage: true });
  } catch { /* ignore */ }

  writeFileSync(
    meta,
    JSON.stringify(
      {
        label,
        url,
        dumpedAt: new Date().toISOString(),
        innerTextSample: innerText.slice(0, 1500),
        ...extraMeta,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.error(`[debug-dump] ${dir}`);
  return { dir, html, screenshot, meta };
}
