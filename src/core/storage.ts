import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import { config } from "./config.js";

export type ProviderId = "linkedin" | "x";

export function providerDir(provider: ProviderId): string {
  return resolve(config.dataDir, provider);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export interface MarkdownDoc<T extends Record<string, unknown>> {
  frontmatter: T;
  body: string;
}

export function readMarkdown<T extends Record<string, unknown>>(
  path: string,
): MarkdownDoc<T> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = matter(raw);
  return { frontmatter: parsed.data as T, body: parsed.content };
}

export function writeMarkdown<T extends Record<string, unknown>>(
  path: string,
  doc: MarkdownDoc<T>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const content = matter.stringify(doc.body, doc.frontmatter);
  writeFileSync(path, content, "utf8");
}

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson<T>(path: string, value: T): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function listFilesByExt(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(ext))
    .map((f) => join(dir, f))
    .sort();
}

export function ensureStateDir(): string {
  mkdirSync(config.stateDir, { recursive: true });
  return config.stateDir;
}
