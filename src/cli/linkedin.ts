import type { Command } from "commander";
import { LinkedInProvider } from "../providers/linkedin/index.js";
import {
  writeSearchResults,
  writeMyPost,
  writeComments,
  writeConversation,
  readMyPostsKnownIds,
} from "../providers/linkedin/storage.js";
import { extractPostIdFromUrl } from "../providers/linkedin/pages/comments.js";
import { getTodayCount, getDailyLimits, type CountedAction } from "../core/throttle-state.js";
import type { SearchOptions } from "../core/provider.js";

async function withProvider<T>(fn: (p: LinkedInProvider) => Promise<T>): Promise<T> {
  const provider = new LinkedInProvider();
  try {
    return await fn(provider);
  } finally {
    await provider.dispose();
  }
}

export function registerLinkedInCommands(program: Command): void {
  const linkedin = program.command("linkedin").alias("li").description("Commandes LinkedIn");

  linkedin
    .command("throttle:status")
    .description("Afficher les compteurs d'actions journaliers et leurs limites")
    .action(() => {
      const limits = getDailyLimits();
      console.log("Action             Aujourd'hui / Limite");
      console.log("----------------   --------------------");
      for (const [action, limit] of Object.entries(limits)) {
        const count = getTodayCount(action as CountedAction);
        const marker = count >= limit ? " (LIMITE ATTEINTE)" : "";
        console.log(`${action.padEnd(18)} ${count}/${limit}${marker}`);
      }
    });

  linkedin
    .command("login")
    .description("Ouvre Chrome pour se connecter à LinkedIn, persiste la session dans .chrome-profile/")
    .action(async () => {
      await withProvider((p) => p.login());
      console.log("Login OK.");
    });

  linkedin
    .command("search <query>")
    .description("Chercher des posts LinkedIn et stocker le résultat en markdown")
    .option("-n, --limit <n>", "nombre max de posts", (v) => parseInt(v, 10), 20)
    .option("--since <range>", "past-24h | past-week | past-month")
    .action(async (query: string, opts: { limit: number; since?: string }) => {
      const searchOpts: SearchOptions = { limit: opts.limit };
      if (opts.since === "past-24h" || opts.since === "past-week" || opts.since === "past-month") {
        searchOpts.dateRange = opts.since;
      }
      const posts = await withProvider((p) => p.searchPosts(query, searchOpts));
      const file = writeSearchResults(query, posts);
      console.log(`${posts.length} post(s) trouvé(s). Stocké dans ${file}`);
    });

  linkedin
    .command("posts:sync")
    .description("Synchroniser l'inventaire de tes propres posts (full: tous les posts)")
    .option("-n, --limit <n>", "nombre max de posts", (v) => parseInt(v, 10), 50)
    .option("--all", "pas de limite (récupère tout, peut prendre 10+ min)")
    .action(async (opts: { limit: number; all?: boolean }) => {
      const limit = opts.all ? 10_000 : opts.limit;
      const posts = await withProvider((p) => p.listMyPosts({ limit }));
      posts.forEach(writeMyPost);
      console.log(`${posts.length} post(s) sauvegardé(s) dans data/linkedin/posts/mine/`);
    });

  linkedin
    .command("posts:sync:latest")
    .description("Synchro incrémentale: s'arrête dès qu'on rencontre les posts déjà connus")
    .option("-n, --limit <n>", "cap de sécurité (défaut 200)", (v) => parseInt(v, 10), 200)
    .action(async (opts: { limit: number }) => {
      const knownIds = readMyPostsKnownIds();
      const posts = await withProvider((p) => p.listMyPosts({ limit: opts.limit, knownIds }));
      const newPosts = posts.filter((p) => !knownIds.has(p.id));
      newPosts.forEach(writeMyPost);
      posts.filter((p) => knownIds.has(p.id)).forEach(writeMyPost); // met à jour stats des existants aussi
      console.log(
        `${newPosts.length} nouveau(x) post(s), ${posts.length - newPosts.length} post(s) déjà connus mis à jour. Total index: ${readMyPostsKnownIds().size}`,
      );
    });

  linkedin
    .command("inbox:list")
    .description("Lister les conversations privées (aperçu)")
    .option("-n, --limit <n>", "nombre max de conversations", (v) => parseInt(v, 10), 30)
    .action(async (opts: { limit: number }) => {
      const convs = await withProvider((p) => p.listConversations({ limit: opts.limit }));
      for (const c of convs) {
        console.log(
          `- ${c.participants.map((p) => p.name).join(", ")} | ${c.lastMessageAt ?? "?"} | unread=${c.unread}`,
        );
      }
    });

  linkedin
    .command("inbox:read <conversationId>")
    .description("Lire une conversation et la sauvegarder en markdown")
    .action(async (conversationId: string) => {
      const { messages, conversation } = await withProvider(async (p) => {
        const messages = await p.readConversation(conversationId);
        const convs = await p.listConversations({ limit: 50 });
        const conversation = convs.find((c) => c.id === conversationId);
        if (!conversation) throw new Error(`Conversation introuvable: ${conversationId}`);
        return { messages, conversation };
      });
      const file = writeConversation(conversation, messages);
      console.log(`${messages.length} message(s) synchronisé(s). Stocké dans ${file}`);
    });

  linkedin
    .command("dm <conversationId> <body>")
    .description("Envoyer un DM dans une conversation existante")
    .action(async (conversationId: string, body: string) => {
      const msg = await withProvider((p) => p.sendMessage(conversationId, body));
      console.log(`Message envoyé: ${msg.id}`);
    });

  linkedin
    .command("comments <postIdOrUrl>")
    .description("Récupérer les commentaires d'un post et les sauvegarder (accepte un activity ID ou une URL)")
    .action(async (postIdOrUrl: string) => {
      const comments = await withProvider((p) => p.listComments(postIdOrUrl));
      const postId = extractPostIdFromUrl(postIdOrUrl) ?? postIdOrUrl;
      const file = writeComments(postId, comments);
      console.log(`${comments.length} commentaire(s). Stocké dans ${file}`);
    });

  linkedin
    .command("comment <postId> <body>")
    .description("Publier un commentaire sur un post")
    .action(async (postId: string, body: string) => {
      const c = await withProvider((p) => p.sendComment(postId, body));
      console.log(`Commentaire publié: ${c.id}`);
    });

  linkedin
    .command("publish <body>")
    .description("Publier un post")
    .option("--visibility <v>", "public | connections", "public")
    .action(async (body: string, opts: { visibility: string }) => {
      const visibility = opts.visibility === "connections" ? "connections" : "public";
      const post = await withProvider((p) => p.publishPost({ body, visibility }));
      console.log(`Post publié: ${post.url}`);
    });
}
