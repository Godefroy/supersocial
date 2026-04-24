import { join } from "node:path";
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
  conversationFile: (participantSlug: string) =>
    join(base(), "conversations", `${participantSlug}.md`),
  conversationsIndex: () => join(base(), "conversations", "index.json"),

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

export function writeConversation(conv: Conversation, messages: Message[]): string {
  const participantName = conv.participants[0]?.name ?? conv.id;
  const path = linkedinPaths.conversationFile(slugify(participantName));

  const existing = readMarkdown<Record<string, unknown>>(path);
  const seen = new Set<string>();
  if (existing) {
    const m = existing.body.match(/<!-- msg-id:([^ ]+) -->/g) ?? [];
    for (const tag of m) seen.add(tag.replace(/^<!-- msg-id:| -->$/g, ""));
  }

  const newLines = messages
    .filter((msg) => !seen.has(msg.id))
    .map(
      (msg) =>
        `<!-- msg-id:${msg.id} -->\n## ${msg.sentAt} — ${msg.outgoing ? "Moi" : msg.from.name}\n\n${msg.body}\n`,
    )
    .join("\n");

  const body = (existing?.body ?? "") + (newLines ? "\n" + newLines : "");

  writeMarkdown(path, {
    frontmatter: {
      provider: LINKEDIN,
      kind: "conversation",
      conversation_id: conv.id,
      conversation_url: conv.url,
      participants: conv.participants.map((p) => p.name),
      last_synced_at: new Date().toISOString(),
      last_message_at: conv.lastMessageAt ?? null,
      message_count: (existing?.body.match(/<!-- msg-id:/g)?.length ?? 0) +
        messages.filter((m) => !seen.has(m.id)).length,
    },
    body,
  });

  return path;
}
