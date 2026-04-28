import { join } from "node:path";
import { renameSync, existsSync } from "node:fs";
import { providerDir, slugify, writeMarkdown, readMarkdown, writeJson, readJson } from "../../core/storage.js";
import type { Post, Comment, Message, Conversation } from "../../core/provider.js";

const LINKEDIN = "linkedin" as const;

const base = () => providerDir(LINKEDIN);

export const linkedinPaths = {
  searches: () => join(base(), "searches"),
  searchFile: (query: string, date: string) =>
    join(base(), "searches", `${slugify(query)}-${date}.md`),

  myPostsDir: () => join(base(), "posts", "mine"),
  myPostFile: (postId: string, date: string) =>
    join(base(), "posts", "mine", `${date}-${slugify(postId)}.md`),
  myPostsIndex: () => join(base(), "posts", "mine", "index.json"),

  conversationsDir: () => join(base(), "conversations"),
  conversationFile: (slug: string) =>
    join(base(), "conversations", `${slug}.md`),
  conversationsIndex: () => join(base(), "conversations", "index.json"),

  outboxDir: () => join(base(), "outbox"),
  outboxPendingDir: () => join(base(), "outbox", "pending"),
  outboxSentDir: () => join(base(), "outbox", "sent"),
  outboxFailedDir: () => join(base(), "outbox", "failed"),

  commentsDir: () => join(base(), "comments"),
  commentsFile: (postId: string) => join(base(), "comments", `${slugify(postId)}.md`),
};

function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function writeSearchResults(query: string, posts: Post[]): string {
  const date = isoDate();
  const path = linkedinPaths.searchFile(query, date);
  const body = posts
    .map(
      (p) =>
        `## ${p.author.name}${p.publishedAt ? ` — ${p.publishedAt}` : ""}\n\n` +
        `${p.body}\n\n` +
        `[Voir le post](${p.url}) | réactions: ${p.reactions ?? "?"} | commentaires: ${p.commentCount ?? "?"}\n`,
    )
    .join("\n---\n\n");

  writeMarkdown(path, {
    frontmatter: {
      provider: LINKEDIN,
      kind: "search",
      query,
      fetched_at: new Date().toISOString(),
      result_count: posts.length,
    },
    body: body || "_Aucun résultat._\n",
  });

  return path;
}

interface MyPostIndexEntry {
  id: string;
  url: string;
  publishedAt?: string;
  file: string;
  reactions?: number;
  commentCount?: number;
}

/** Retourne les IDs connus dans l'index, utile pour la synchro incrémentale. */
export function readMyPostsKnownIds(): Set<string> {
  const index = readJson<MyPostIndexEntry[]>(linkedinPaths.myPostsIndex()) ?? [];
  return new Set(index.map((e) => e.id));
}

export function writeMyPost(post: Post): string {
  const isoDateRe = /^\d{4}-\d{2}-\d{2}/;
  const publishedDate = post.publishedAt && isoDateRe.test(post.publishedAt) ? post.publishedAt.slice(0, 10) : null;
  const date = publishedDate ?? post.fetchedAt.slice(0, 10);
  const path = linkedinPaths.myPostFile(post.id, date);

  writeMarkdown(path, {
    frontmatter: {
      provider: LINKEDIN,
      kind: "post",
      id: post.id,
      url: post.url,
      author: post.author.name,
      published_at: post.publishedAt ?? null,
      published_at_approx: post.publishedAtApprox ?? false,
      published_label: post.publishedLabel ?? null,
      fetched_at: post.fetchedAt,
      reactions: post.reactions ?? null,
      comment_count: post.commentCount ?? null,
      repost_count: post.repostCount ?? null,
      media: post.media ?? [],
    },
    body: post.body + "\n",
  });

  const indexPath = linkedinPaths.myPostsIndex();
  const index = readJson<MyPostIndexEntry[]>(indexPath) ?? [];
  const next: MyPostIndexEntry = {
    id: post.id,
    url: post.url,
    file: path,
    ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
    ...(post.reactions != null ? { reactions: post.reactions } : {}),
    ...(post.commentCount != null ? { commentCount: post.commentCount } : {}),
  };
  const filtered = index.filter((e) => e.id !== post.id);
  filtered.push(next);
  filtered.sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
  writeJson(indexPath, filtered);

  return path;
}

export function writeComments(postId: string, comments: Comment[]): string {
  const path = linkedinPaths.commentsFile(postId);
  const body = comments
    .map((c) => {
      const heading = c.author.profileUrl
        ? `[${c.author.name}](${c.author.profileUrl})`
        : c.author.name;
      const when = c.publishedAt ? ` — ${c.publishedAt}` : "";
      const level = "#".repeat(Math.min(6, 2 + c.depth));
      return `${level} ${heading}${when}\n\n${c.body}\n\n_réactions: ${c.reactions ?? 0}_\n`;
    })
    .join("\n---\n\n");
  writeMarkdown(path, {
    frontmatter: {
      provider: LINKEDIN,
      kind: "comments",
      post_id: postId,
      fetched_at: new Date().toISOString(),
      comment_count: comments.length,
    },
    body: body || "_Aucun commentaire._\n",
  });
  return path;
}

interface ConversationIndexEntry {
  threadId: string;
  slug: string;
  file: string;
  participants: string[];
  lastSyncedAt: string;
  lastMessageAt?: string;
  messageCount: number;
}

function slugFromNames(names: string[]): string | null {
  const slugs = names.map(slugify).filter(Boolean);
  if (slugs.length === 0) return null;
  const joined = slugs.slice(0, 3).join("+");
  const suffix = slugs.length > 3 ? `+${slugs.length - 3}-more` : "";
  const result = (joined + suffix).slice(0, 120);
  return result || null;
}

function conversationSlug(conv: Conversation): string {
  return slugFromNames(conv.participants.map((p) => p.name)) ?? slugify(conv.id);
}

function resolveConversationPath(conv: Conversation): { path: string; slug: string } {
  const indexPath = linkedinPaths.conversationsIndex();
  const index = readJson<ConversationIndexEntry[]>(indexPath) ?? [];
  const existingByThread = index.find((e) => e.threadId === conv.id);
  if (existingByThread) return { path: existingByThread.file, slug: existingByThread.slug };

  let slug = conversationSlug(conv);
  const collision = index.find((e) => e.slug === slug);
  if (collision) {
    const shortId = slugify(conv.id).slice(0, 10) || "thread";
    slug = `${slug}-${shortId}`;
  }
  return { path: linkedinPaths.conversationFile(slug), slug };
}

export function writeConversation(conv: Conversation, messages: Message[]): string {
  const { path, slug } = resolveConversationPath(conv);

  const existing = readMarkdown<Record<string, unknown>>(path);
  const seen = new Set<string>();
  if (existing) {
    const m = existing.body.match(/<!-- msg-id:([^ ]+) -->/g) ?? [];
    for (const tag of m) seen.add(tag.replace(/^<!-- msg-id:| -->$/g, ""));
  }

  const newMessages = messages.filter((msg) => !seen.has(msg.id));
  const newLines = newMessages
    .map(
      (msg) =>
        `<!-- msg-id:${msg.id} -->\n## ${msg.sentAt || "—"} — ${msg.outgoing ? "Moi" : msg.from.name}\n\n${msg.body}\n`,
    )
    .join("\n");

  const body = (existing?.body ?? "") + (newLines ? (existing?.body ? "\n" : "") + newLines : "");
  const totalCount = (existing?.body.match(/<!-- msg-id:/g)?.length ?? 0) + newMessages.length;

  writeMarkdown(path, {
    frontmatter: {
      provider: LINKEDIN,
      kind: "conversation",
      conversation_id: conv.id,
      conversation_url: conv.url,
      participants: conv.participants.map((p) => p.name),
      participant_urls: conv.participants.map((p) => p.profileUrl ?? null),
      last_synced_at: new Date().toISOString(),
      last_message_at: conv.lastMessageAt ?? null,
      message_count: totalCount,
    },
    body,
  });

  // Index
  const indexPath = linkedinPaths.conversationsIndex();
  const index = readJson<ConversationIndexEntry[]>(indexPath) ?? [];
  const next: ConversationIndexEntry = {
    threadId: conv.id,
    slug,
    file: path,
    participants: conv.participants.map((p) => p.name),
    lastSyncedAt: new Date().toISOString(),
    ...(conv.lastMessageAt ? { lastMessageAt: conv.lastMessageAt } : {}),
    messageCount: totalCount,
  };
  const filtered = index.filter((e) => e.threadId !== conv.id);
  filtered.push(next);
  filtered.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  writeJson(indexPath, filtered);

  return path;
}

export function findConversationFileByThreadId(threadId: string): string | null {
  const index = readJson<ConversationIndexEntry[]>(linkedinPaths.conversationsIndex()) ?? [];
  return index.find((e) => e.threadId === threadId)?.file ?? null;
}

/**
 * Retourne le corps du dernier message sortant (envoyé par nous) dans ce thread,
 * en relisant le fichier markdown. Utilisé pour détecter les envois en doublon.
 */
export function readLastOutgoingBody(threadId: string): string | null {
  const file = findConversationFileByThreadId(threadId);
  if (!file) return null;
  const doc = readMarkdown<Record<string, unknown>>(file);
  if (!doc) return null;
  const blocks = doc.body.split(/<!-- msg-id:[^>]*-->/).filter((s) => s.trim().length > 0);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    // Format: "\n## <sentAt> — <from>\n\n<body>\n"
    const headerMatch = block.match(/^\s*##\s+[^\n]*—\s*(.+?)\s*\n\s*\n([\s\S]+?)\s*$/);
    if (!headerMatch) continue;
    const from = headerMatch[1]!.trim();
    const body = headerMatch[2]!.trim();
    if (from === "Moi") return body;
  }
  return null;
}

/**
 * Met a jour les participants en frontmatter d'un fichier de conversation existant.
 * Utilise pour reparer les conversations creees via compose qui ont `participants: []`
 * en s'appuyant sur des donnees externes (ex: outbox sent items). No-op si le fichier
 * a deja des participants ou si introuvable.
 */
export function enrichConversationParticipants(
  threadId: string,
  participants: Array<{ name: string; profileUrl?: string | null }>,
): boolean {
  const file = findConversationFileByThreadId(threadId);
  if (!file) return false;
  const doc = readMarkdown<Record<string, unknown>>(file);
  if (!doc) return false;
  const existing = doc.frontmatter?.participants;
  if (Array.isArray(existing) && existing.length > 0) return false;
  if (participants.length === 0) return false;

  const updated = {
    ...doc.frontmatter,
    participants: participants.map((p) => p.name),
    participant_urls: participants.map((p) => p.profileUrl ?? null),
  };
  writeMarkdown(file, { frontmatter: updated, body: doc.body });
  return true;
}

export interface ConversationRename {
  threadId: string;
  oldSlug: string;
  newSlug: string;
  oldFile: string;
  newFile: string;
}

/**
 * Renomme les fichiers de conversation dont le slug retombait sur l'ID du thread
 * (cas ou les participants etaient inconnus au moment du write, ex: thread tout
 * neuf via compose). Recalcule le slug a partir des participants en frontmatter
 * et deplace le fichier + met a jour l'index.
 */
export function renameConversationFiles(): { renamed: ConversationRename[]; skipped: Array<{ threadId: string; reason: string }> } {
  const indexPath = linkedinPaths.conversationsIndex();
  const index = readJson<ConversationIndexEntry[]>(indexPath) ?? [];
  const renamed: ConversationRename[] = [];
  const skipped: Array<{ threadId: string; reason: string }> = [];

  for (const entry of index) {
    const fallbackSlug = slugify(entry.threadId);
    if (entry.slug !== fallbackSlug) continue; // slug non degenere, on laisse

    const doc = readMarkdown<Record<string, unknown>>(entry.file);
    const fmParticipants = (doc?.frontmatter?.participants ?? []) as unknown;
    const names = Array.isArray(fmParticipants)
      ? fmParticipants.filter((n): n is string => typeof n === "string" && n.length > 0)
      : [];
    if (names.length === 0) {
      skipped.push({ threadId: entry.threadId, reason: "participants vides, faire `linkedin thread <url>` d'abord" });
      continue;
    }

    let newSlug = slugFromNames(names);
    if (!newSlug) {
      skipped.push({ threadId: entry.threadId, reason: "impossible de deriver un slug depuis les noms" });
      continue;
    }

    // Collision avec un autre thread (slug deja pris): on suffixe avec un short ID.
    const collision = index.find((e) => e.threadId !== entry.threadId && e.slug === newSlug);
    if (collision) {
      const shortId = slugify(entry.threadId).slice(0, 10) || "thread";
      newSlug = `${newSlug}-${shortId}`;
    }

    const newFile = linkedinPaths.conversationFile(newSlug);
    if (existsSync(newFile)) {
      skipped.push({ threadId: entry.threadId, reason: `fichier cible existe deja: ${newFile}` });
      continue;
    }

    renameSync(entry.file, newFile);
    renamed.push({ threadId: entry.threadId, oldSlug: entry.slug, newSlug, oldFile: entry.file, newFile });
    entry.slug = newSlug;
    entry.file = newFile;
  }

  if (renamed.length > 0) {
    writeJson(indexPath, index);
  }
  return { renamed, skipped };
}
