import type { Command } from "commander";
import * as readline from "node:readline";
import { LinkedInProvider } from "../providers/linkedin/index.js";
import {
  writeSearchResults,
  writeMyPost,
  writeComments,
  writeConversation,
  readMyPostsKnownIds,
  readLastOutgoingBody,
  renameConversationFiles,
  enrichConversationParticipants,
} from "../providers/linkedin/storage.js";
import { extractPostIdFromUrl } from "../providers/linkedin/pages/comments.js";
import {
  addOutboxItem,
  listOutboxItems,
  findOutboxItemById,
  markOutboxSent,
  markOutboxFailed,
  cancelOutboxItem,
  retryOutboxItem,
  type OutboxItem,
  type OutboxStatus,
} from "../providers/linkedin/outbox.js";
import {
  addInvitation,
  listInvitations,
  findInvitationById,
  markInvitationSent,
  markInvitationFailed,
  markInvitationAccepted,
  cancelInvitation,
  retryInvitation,
  recordDirectInvitation,
  type Invitation,
  type InvitationStatus,
} from "../providers/linkedin/invitations.js";
import { getTodayCount, getDailyLimits, type CountedAction } from "../core/throttle-state.js";
import { humanPause, RateLimitHitError, LinkedInDmRestrictedError } from "../core/throttle.js";
import type { SearchOptions } from "../core/provider.js";

async function withProvider<T>(fn: (p: LinkedInProvider) => Promise<T>): Promise<T> {
  const provider = new LinkedInProvider();
  try {
    return await fn(provider);
  } finally {
    await provider.dispose();
  }
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Confirmation requise mais stdin n'est pas un TTY. Ajoute --yes pour sauter la confirmation.`,
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^(y|yes|o|oui)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function formatMessagePreview(body: string, maxLen = 120): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + "…" : oneLine;
}

/**
 * Compare deux bodies de message en tolérant les variations de présentation
 * que LinkedIn peut introduire à l'affichage: NBSP vs espace, retours ligne
 * différents, ponctuation Unicode (quotes courbes), variantes de
 * normalisation (NFC vs NFD), majuscules/minuscules. On garde uniquement
 * les lettres et chiffres pour comparer.
 */
function messageBodiesMatch(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return norm(a) === norm(b);
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
      posts.filter((p) => knownIds.has(p.id)).forEach(writeMyPost);
      console.log(
        `${newPosts.length} nouveau(x) post(s), ${posts.length - newPosts.length} post(s) déjà connus mis à jour. Total index: ${readMyPostsKnownIds().size}`,
      );
    });

  linkedin
    .command("conversations:rename")
    .description("Renommer les fichiers de conversation dont le slug est resté sur le thread ID. Tente d'abord d'enrichir les participants vides depuis la boîte d'envoi `sent/`.")
    .action(() => {
      // Pre-enrichissement: pour les conversations creees via compose dont
      // `participants:` est reste vide, on retrouve nom + URL profil dans les
      // items de la boite d'envoi qui ont ete envoyes (thread_id matche).
      const sentItems = listOutboxItems(["sent"]).filter((it): it is OutboxItem & { threadId: string } => Boolean(it.threadId));
      let enriched = 0;
      for (const item of sentItems) {
        const ok = enrichConversationParticipants(item.threadId, [
          { name: item.recipientLabel, profileUrl: item.recipient },
        ]);
        if (ok) enriched++;
      }
      if (enriched > 0) console.log(`Enrichi ${enriched} conversation(s) depuis la boîte d'envoi.`);

      const { renamed, skipped } = renameConversationFiles();
      if (renamed.length === 0 && skipped.length === 0) {
        console.log("Rien à renommer: aucune conversation avec un slug dégénéré.");
        return;
      }
      for (const r of renamed) {
        console.log(`✓ ${r.oldSlug} → ${r.newSlug}`);
      }
      for (const s of skipped) {
        console.log(`- ${s.threadId}: ${s.reason}`);
      }
      console.log(`\n${renamed.length} renommé(s), ${skipped.length} sauté(s).`);
    });

  linkedin
    .command("thread <url>")
    .description("Synchroniser une conversation. url = URL profil (/in/slug/), URL thread (/messaging/thread/id/) ou thread ID")
    .action(async (url: string) => {
      const { conversation, messages } = await withProvider((p) => p.readConversation(url));
      const file = writeConversation(conversation, messages);
      console.log(
        `Thread ${conversation.id} avec ${conversation.participants.map((p) => p.name).join(", ") || "?"}: ${messages.length} message(s). Stocké dans ${file}`,
      );
    });

  linkedin
    .command("dm <url> <body>")
    .description("Envoyer un DM. Essaie de charger l'historique (URL profil ou URL thread). Si thread existant: dédup + confirmation. Si nouveau: envoi via compose.")
    .option("-y, --yes", "sauter la confirmation interactive")
    .option("--dry-run", "ne pas envoyer, juste afficher ce qui serait envoyé")
    .option("--force", "autoriser l'envoi même si le dernier message sortant est identique")
    .option("--queue", "ajouter à la boîte d'envoi au lieu d'envoyer maintenant")
    .action(async (url: string, body: string, opts: { yes?: boolean; dryRun?: boolean; force?: boolean; queue?: boolean }) => {
      if (opts.queue) {
        const item = addOutboxItem({ recipient: url, body });
        console.log(`Ajouté à la boîte d'envoi: ${item.id} (${item.recipientLabel}). Lance \`linkedin outbox:send\` pour traiter.`);
        return;
      }

      // Un seul provider pour read + send: évite deux lancements de Chrome et
      // deux résolutions de thread (cache interne côté provider).
      await withProvider(async (p) => {
        let conversation: Awaited<ReturnType<LinkedInProvider["readConversation"]>>["conversation"] | null = null;
        let messages: Awaited<ReturnType<LinkedInProvider["readConversation"]>>["messages"] = [];
        try {
          const snap = await p.readConversation(url);
          conversation = snap.conversation;
          messages = snap.messages;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`\n[pas d'historique chargé: ${msg}]`);
        }

        if (conversation) {
          console.error(`\nThread ${conversation.id}`);
          console.error(`Participants: ${conversation.participants.map((p) => p.name).join(", ") || "?"}`);
          console.error(`${messages.length} message(s) dans l'historique.`);
          const last = messages.slice(-3);
          if (last.length > 0) {
            console.error(`\nDerniers messages:`);
            for (const m of last) {
              const who = m.outgoing ? "Moi" : m.from.name;
              console.error(`  [${m.sentAt || "?"}] ${who}: ${formatMessagePreview(m.body, 80)}`);
            }
          }

          const lastOutgoing =
            [...messages].reverse().find((m) => m.outgoing)?.body ??
            readLastOutgoingBody(conversation.id);
          if (!opts.force && lastOutgoing && messageBodiesMatch(lastOutgoing, body)) {
            throw new Error(
              `Doublon détecté: le dernier message sortant a déjà le même body (comparaison alphanumérique). Ajoute --force pour renvoyer quand même.`,
            );
          }
        } else {
          console.error(`\nCible: ${url} (nouveau thread, pas d'historique)`);
        }

        console.error(`\nMessage à envoyer:\n---\n${body}\n---`);

        if (opts.dryRun) {
          console.error(`\n[dry-run] Pas d'envoi.${conversation ? " Thread sauvegardé dans data/linkedin/conversations/." : ""}`);
          if (conversation) writeConversation(conversation, messages);
          return;
        }

        if (!opts.yes) {
          const ok = await askYesNo("Envoyer ce message ? [y/N] ");
          if (!ok) {
            console.error("Annulé.");
            if (conversation) writeConversation(conversation, messages);
            return;
          }
        }

        const sent = await p.sendMessage(url, body);
        const file = writeConversation(sent.conversation, sent.messages);
        const newMsg = sent.messages.at(-1);
        console.log(`Envoyé. Thread sauvegardé: ${file} (${sent.messages.length} messages, dernier id: ${newMsg?.id ?? "?"})`);
      });
    });

  linkedin
    .command("outbox:add <url> <body>")
    .description("Ajouter un message à la boîte d'envoi (traité ensuite par outbox:send)")
    .option("--label <label>", "libellé lisible pour cet item")
    .action((url: string, body: string, opts: { label?: string }) => {
      const itemParams: { recipient: string; body: string; label?: string } = { recipient: url, body };
      if (opts.label) itemParams.label = opts.label;
      const item = addOutboxItem(itemParams);
      console.log(`Ajouté: ${item.id} | ${item.recipientLabel} | ${formatMessagePreview(body, 60)}`);
      console.log(`Fichier: ${item.file}`);
    });

  linkedin
    .command("outbox:list")
    .description("Lister les items de la boîte d'envoi")
    .option("--status <s>", "pending | sent | failed | all", "pending")
    .action((opts: { status: string }) => {
      const statuses: OutboxStatus[] =
        opts.status === "all"
          ? ["pending", "sent", "failed"]
          : ([opts.status] as OutboxStatus[]);
      const items = listOutboxItems(statuses);
      if (items.length === 0) {
        console.log("Aucun item.");
        return;
      }
      console.log(`ID        Status   Destinataire                          Message`);
      console.log(`--------  -------  ------------------------------------  -------`);
      for (const it of items) {
        console.log(
          `${it.id.padEnd(8)}  ${it.status.padEnd(7)}  ${it.recipientLabel.slice(0, 36).padEnd(36)}  ${formatMessagePreview(it.body, 60)}`,
        );
      }
    });

  linkedin
    .command("outbox:retry [ids...]")
    .description("Repasser des items `failed` en `pending`. Sans argument, requiert --all. Filtrage optionnel par motif d'erreur.")
    .option("--all", "rejouer tous les items en échec")
    .option("--match <pattern>", "ne rejouer que les items dont l'erreur contient ce motif (insensible à la casse)")
    .action((ids: string[], opts: { all?: boolean; match?: string }) => {
      const failed = listOutboxItems(["failed"]);
      if (failed.length === 0) {
        console.log("Aucun item en échec.");
        return;
      }
      let targets: OutboxItem[];
      if (ids.length > 0) {
        const requested = new Set(ids);
        targets = failed.filter((it) => requested.has(it.id));
        const missing = ids.filter((id) => !targets.some((t) => t.id === id));
        if (missing.length > 0) {
          console.error(`Item(s) en échec introuvable(s): ${missing.join(", ")}`);
          process.exit(1);
        }
      } else if (opts.all) {
        targets = failed;
      } else {
        console.error("Précise des IDs ou ajoute --all.");
        process.exit(1);
        return;
      }
      if (opts.match) {
        const re = new RegExp(opts.match, "i");
        targets = targets.filter((it) => re.test(it.error ?? ""));
      }
      if (targets.length === 0) {
        console.log("Aucun item ne correspond au filtre.");
        return;
      }
      for (const it of targets) {
        retryOutboxItem(it);
        console.log(`✓ ${it.id} (${it.recipientLabel}) → pending`);
      }
      console.log(`\n${targets.length} item(s) replacé(s) en attente.`);
    });

  linkedin
    .command("outbox:cancel <id>")
    .description("Annuler (supprimer) un item en attente")
    .action((id: string) => {
      const item = cancelOutboxItem(id);
      if (!item) {
        console.error(`Item introuvable: ${id}`);
        process.exit(1);
      }
      console.log(`Annulé: ${item.id} (${item.recipientLabel})`);
    });

  linkedin
    .command("outbox:send")
    .description("Traiter les items en attente (respecte la limite journalière dm et fait des pauses humaines entre les envois)")
    .option("-n, --count <n>", "nombre max d'items à envoyer cette session", (v) => parseInt(v, 10))
    .option("--dry-run", "ne pas envoyer, juste afficher le plan")
    .action(async (opts: { count?: number; dryRun?: boolean }) => {
      const pending = listOutboxItems(["pending"]);
      if (pending.length === 0) {
        console.log("Aucun item en attente.");
        return;
      }
      const limits = getDailyLimits();
      const todayCount = getTodayCount("dm");
      const remainingToday = Math.max(0, limits.dm - todayCount);
      const targetCount = Math.min(opts.count ?? Infinity, remainingToday, pending.length);

      console.log(`Pending: ${pending.length} | DM aujourd'hui: ${todayCount}/${limits.dm} | Capacité restante: ${remainingToday} | Cette session: ${targetCount}`);
      if (targetCount === 0) {
        console.log("Rien à traiter (limite atteinte ou count=0).");
        return;
      }

      if (opts.dryRun) {
        console.log("\n[dry-run] Items qui seraient envoyés:");
        for (const it of pending.slice(0, targetCount)) {
          console.log(`  ${it.id} | ${it.recipientLabel} | ${formatMessagePreview(it.body, 60)}`);
        }
        return;
      }

      let sent = 0;
      let failed = 0;
      let skipped = 0;
      let waitingNotConnected = 0;
      // Un seul browser pour toute la boucle: évite N lancements de Chrome.
      await withProvider(async (p) => {
        for (const item of pending.slice(0, targetCount)) {
          console.log(`\n[${sent + failed + skipped + waitingNotConnected + 1}/${targetCount}] ${item.id} → ${item.recipientLabel}`);
          console.log(`  ${formatMessagePreview(item.body, 100)}`);
          try {
            // Pre-flight: ne JAMAIS DM si la cible n'est pas en 1ère relation.
            // LinkedIn refusera et affichera l'upsell Premium. La résolution
            // charge le profil une seule fois (cache provider), donc le coût
            // est partagé avec le `readConversation` qui suit.
            const target = await p.resolveTargetForInput(item.recipient);
            if (target.recipientDegree && target.recipientDegree !== "1st") {
              console.log(
                `  ⏸ skip (waiting): pas en 1ère relation (degré=${target.recipientDegree}). Item reste en pending; envoie une demande de connexion via \`linkedin connect ${item.recipient}\` ou attends qu'elle soit acceptée.`,
              );
              waitingNotConnected++;
              continue;
            }

            // Dédup avant envoi: si le thread existe déjà et que le dernier
            // message sortant est identique, considérer l'envoi comme déjà
            // réalisé. Sécurise contre les retries après un faux négatif
            // (ex: compose-no-redirect où le message part mais on lève
            // l'exception, ou contre une queue créée sans `--force`).
            // Pas de consommation de quota dm dans ce cas.
            let dedupHit: { threadId: string; lastBody: string } | null = null;
            try {
              const snap = await p.readConversation(item.recipient);
              const lastOutgoing = [...snap.messages].reverse().find((m) => m.outgoing);
              if (lastOutgoing && messageBodiesMatch(lastOutgoing.body, item.body)) {
                dedupHit = { threadId: snap.conversation.id, lastBody: lastOutgoing.body };
              }
            } catch {
              // Pas de thread préalable: rien à dédup, on envoie normalement.
            }

            if (dedupHit) {
              markOutboxSent(item, dedupHit.threadId, "déjà envoyé (dedup match)");
              console.log(`  ↺ skip: dernier sortant identique sur thread ${dedupHit.threadId}`);
              skipped++;
              continue;
            }

            const snap = await p.sendMessage(item.recipient, item.body);
            writeConversation(snap.conversation, snap.messages);
            markOutboxSent(item, snap.conversation.id);
            console.log(`  ✓ envoyé (thread ${snap.conversation.id})`);
            sent++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            markOutboxFailed(item, msg);
            console.error(`  ✗ échec: ${msg}`);
            failed++;
            if (err instanceof RateLimitHitError) {
              console.error(`RateLimitHitError détecté. Arrêt immédiat de la boîte d'envoi.`);
              break;
            }
            if (err instanceof LinkedInDmRestrictedError) {
              console.error(
                `LinkedIn refuse les DM gratuits (upsell Premium affiché). Arrêt du batch: les autres items non-1ère relation auront le même sort. Envoie d'abord une demande de connexion via \`linkedin connect <url>\` ou attends 24-48h que la restriction s'estompe.`,
              );
              break;
            }
          }
          // humanPause uniquement quand on a effectivement déclenché une
          // action DM (envoyé, dedup-skipped, ou échec). Le `continue` sur
          // waiting saute cette section, donc pas de pause sur ces items.
          if (sent + failed + skipped + waitingNotConnected < targetCount) {
            await humanPause("dm");
          }
        }
      });

      console.log(`\nBilan: ${sent} envoyé(s), ${skipped} skip(s) dedup, ${waitingNotConnected} waiting (non-1ère relation), ${failed} échec(s), ${pending.length - sent - failed - skipped - waitingNotConnected} restant(s) en attente.`);
    });

  linkedin
    .command("profile:status <url>")
    .description("Lire le degré de relation, l'URN profil et l'état d'invitation/messagerie")
    .action(async (url: string) => {
      const status = await withProvider((p) => p.getProfileStatus(url));
      console.log(`URL: ${status.url}`);
      console.log(`Nom: ${status.name ?? "?"}`);
      console.log(`URN: ${status.profileUrn ?? "?"}`);
      console.log(`Degré: ${status.degree}`);
      console.log(`Bouton Message visible: ${status.canMessage ? "oui" : "non"}`);
      console.log(`Invitation déjà envoyée: ${status.invitationPending ? "oui" : "non"}`);
    });

  linkedin
    .command("connect <url>")
    .description("Envoyer une demande de connexion. Si --note, joint une note personnalisée. Court-circuite si déjà connecté ou invitation pendante.")
    .option("--note <body>", "note personnalisée jointe à l'invitation (max ~300 caractères côté LinkedIn)")
    .option("-y, --yes", "sauter la confirmation interactive")
    .option("--dry-run", "ne pas envoyer, juste afficher l'état du profil et le plan")
    .action(async (url: string, opts: { note?: string; yes?: boolean; dryRun?: boolean }) => {
      await withProvider(async (p) => {
        const status = await p.getProfileStatus(url);
        console.error(`Cible: ${status.name ?? "?"} (${status.degree})`);
        console.error(`URL: ${status.url}`);
        if (status.profileUrn) console.error(`URN: ${status.profileUrn}`);

        // Court-circuits via état lu, mais on continue pour TRACER dans
        // `data/linkedin/invitations/` (le provider applique les mêmes courts-
        // circuits côté envoi sans coût quota; ici on veut juste persister).
        if (status.invitationPending) {
          console.log(`Invitation déjà en attente côté LinkedIn (pas d'envoi, juste traçage local).`);
        } else if (status.degree === "1st") {
          console.log(`Déjà en 1ère relation (pas d'envoi, juste traçage local en accepted/).`);
        } else if (status.degree === "out-of-network") {
          console.error(`Profil hors réseau: l'invitation libre est probablement refusée. Tente quand même ?`);
        }

        if (opts.note) {
          console.error(`Note (${opts.note.length} car):\n---\n${opts.note}\n---`);
        } else {
          console.error(`Pas de note (invitation simple).`);
        }
        if (opts.dryRun) {
          console.error(`[dry-run] Pas d'envoi.`);
          return;
        }
        if (!opts.yes && !status.invitationPending && status.degree !== "1st") {
          const ok = await askYesNo("Envoyer la demande de connexion ? [y/N] ");
          if (!ok) {
            console.error("Annulé.");
            return;
          }
        }
        const inviteOpts: { note?: string } = {};
        if (opts.note) inviteOpts.note = opts.note;
        const result = await p.sendConnectionInvite(url, inviteOpts);
        if (result.status === "sent") {
          console.log(`✓ Invitation envoyée${result.viaMoreMenu ? " (via menu Plus)" : ""}${result.withNote ? " avec note" : " sans note"}.`);
          // Tracer dans data/linkedin/invitations/sent/ pour suivi local.
          if (status.profileUrn) {
            const recordParams: Parameters<typeof recordDirectInvitation>[0] = {
              recipient: status.url,
              recipientUrn: status.profileUrn,
              status: "sent",
            };
            if (status.name) recordParams.recipientLabel = status.name;
            if (opts.note) recordParams.note = opts.note;
            const inv = recordDirectInvitation(recordParams);
            console.log(`  Trace: ${inv.file}`);
          }
        } else if (result.status === "already-pending") {
          console.log(`Invitation déjà en attente.`);
          if (status.profileUrn) {
            const recordParams: Parameters<typeof recordDirectInvitation>[0] = {
              recipient: status.url,
              recipientUrn: status.profileUrn,
              status: "sent",
            };
            if (status.name) recordParams.recipientLabel = status.name;
            recordDirectInvitation(recordParams);
          }
        } else if (result.status === "already-connected") {
          console.log(`Déjà en 1ère relation.`);
          if (status.profileUrn) {
            const recordParams: Parameters<typeof recordDirectInvitation>[0] = {
              recipient: status.url,
              recipientUrn: status.profileUrn,
              status: "accepted",
            };
            if (status.name) recordParams.recipientLabel = status.name;
            recordDirectInvitation(recordParams);
          }
        } else if (result.status === "no-button") {
          console.error(`✗ Aucun bouton de connexion trouvé: ${result.reason ?? ""}`);
          process.exit(1);
        } else {
          console.error(`✗ Bloqué: ${result.reason ?? "raison inconnue"}`);
          process.exit(1);
        }
      });
    });

  linkedin
    .command("invite:add <url>")
    .description("Ajouter une invitation à la file d'attente. Avec --then-dm, queue aussi un DM qui partira automatiquement après acceptation de l'invitation (outbox:send skip les non-1ère relation, donc le DM attend tout seul que la cible passe en 1ère relation).")
    .option("--note <body>", "note personnalisée jointe à l'invitation")
    .option("--label <label>", "libellé lisible pour cet item")
    .option("--then-dm <body>", "queue aussi un DM dans l'outbox qui partira après acceptation")
    .action((url: string, opts: { note?: string; label?: string; thenDm?: string }) => {
      const params: Parameters<typeof addInvitation>[0] = { recipient: url };
      if (opts.note) params.note = opts.note;
      if (opts.label) params.label = opts.label;
      const inv = addInvitation(params);
      console.log(`Invitation ajoutée: ${inv.id} | ${inv.recipientLabel}${opts.note ? ` | note (${opts.note.length} car)` : " | sans note"}`);
      console.log(`  ${inv.file}`);

      if (opts.thenDm) {
        const dmParams: Parameters<typeof addOutboxItem>[0] = { recipient: url, body: opts.thenDm };
        if (opts.label) dmParams.label = opts.label;
        const dm = addOutboxItem(dmParams);
        console.log(`DM chaîné ajouté: ${dm.id} | ${dm.recipientLabel} | ${formatMessagePreview(opts.thenDm, 60)}`);
        console.log(`  ${dm.file}`);
        console.log(`Le DM partira automatiquement quand outbox:send détectera la cible en 1ère relation (après acceptation).`);
      }
    });

  linkedin
    .command("invite:list")
    .description("Lister les invitations")
    .option("--status <s>", "pending | sent | accepted | failed | all", "pending")
    .action((opts: { status: string }) => {
      const statuses: InvitationStatus[] =
        opts.status === "all"
          ? ["pending", "sent", "accepted", "failed"]
          : ([opts.status] as InvitationStatus[]);
      const items = listInvitations(statuses);
      if (items.length === 0) {
        console.log("Aucune invitation.");
        return;
      }
      console.log(`ID        Status    Destinataire                          Note`);
      console.log(`--------  --------  ------------------------------------  ----`);
      for (const inv of items) {
        const notePreview = inv.note ? formatMessagePreview(inv.note, 40) : "(simple)";
        console.log(
          `${inv.id.padEnd(8)}  ${inv.status.padEnd(8)}  ${inv.recipientLabel.slice(0, 36).padEnd(36)}  ${notePreview}`,
        );
      }
    });

  linkedin
    .command("invite:cancel <id>")
    .description("Annuler une invitation en attente")
    .action((id: string) => {
      const inv = cancelInvitation(id);
      if (!inv) {
        console.error(`Invitation introuvable: ${id}`);
        process.exit(1);
      }
      console.log(`Annulée: ${inv.id} (${inv.recipientLabel})`);
    });

  linkedin
    .command("invite:retry [ids...]")
    .description("Repasser des invitations `failed` en `pending`. Sans argument, requiert --all.")
    .option("--all", "rejouer toutes les invitations en échec")
    .option("--match <pattern>", "ne rejouer que celles dont l'erreur contient ce motif (insensible à la casse)")
    .action((ids: string[], opts: { all?: boolean; match?: string }) => {
      const failed = listInvitations(["failed"]);
      if (failed.length === 0) {
        console.log("Aucune invitation en échec.");
        return;
      }
      let targets: Invitation[];
      if (ids.length > 0) {
        const requested = new Set(ids);
        targets = failed.filter((it) => requested.has(it.id));
        const missing = ids.filter((id) => !targets.some((t) => t.id === id));
        if (missing.length > 0) {
          console.error(`Invitation(s) en échec introuvable(s): ${missing.join(", ")}`);
          process.exit(1);
        }
      } else if (opts.all) {
        targets = failed;
      } else {
        console.error("Précise des IDs ou ajoute --all.");
        process.exit(1);
        return;
      }
      if (opts.match) {
        const re = new RegExp(opts.match, "i");
        targets = targets.filter((it) => re.test(it.error ?? ""));
      }
      if (targets.length === 0) {
        console.log("Aucune invitation ne correspond au filtre.");
        return;
      }
      for (const it of targets) {
        retryInvitation(it);
        console.log(`✓ ${it.id} (${it.recipientLabel}) → pending`);
      }
      console.log(`\n${targets.length} invitation(s) replacée(s) en attente.`);
    });

  linkedin
    .command("invite:send")
    .description("Traiter les invitations en attente (respecte la limite invite journalière et fait des pauses humaines)")
    .option("-n, --count <n>", "nombre max d'invitations à envoyer cette session", (v) => parseInt(v, 10))
    .option("--dry-run", "ne pas envoyer, juste afficher le plan")
    .action(async (opts: { count?: number; dryRun?: boolean }) => {
      const pending = listInvitations(["pending"]);
      if (pending.length === 0) {
        console.log("Aucune invitation en attente.");
        return;
      }
      const limits = getDailyLimits();
      const todayCount = getTodayCount("invite");
      const remainingToday = Math.max(0, limits.invite - todayCount);
      const targetCount = Math.min(opts.count ?? Infinity, remainingToday, pending.length);

      console.log(`Pending: ${pending.length} | Invite aujourd'hui: ${todayCount}/${limits.invite} | Capacité restante: ${remainingToday} | Cette session: ${targetCount}`);
      if (targetCount === 0) {
        console.log("Rien à traiter (limite atteinte ou count=0).");
        return;
      }
      if (opts.dryRun) {
        console.log("\n[dry-run] Invitations qui seraient envoyées:");
        for (const inv of pending.slice(0, targetCount)) {
          console.log(`  ${inv.id} | ${inv.recipientLabel} | ${inv.note ? formatMessagePreview(inv.note, 60) : "sans note"}`);
        }
        return;
      }

      let sent = 0;
      let alreadyConnected = 0;
      let alreadyPending = 0;
      let failed = 0;

      await withProvider(async (p) => {
        for (const inv of pending.slice(0, targetCount)) {
          console.log(`\n[${sent + alreadyConnected + alreadyPending + failed + 1}/${targetCount}] ${inv.id} → ${inv.recipientLabel}`);
          if (inv.note) console.log(`  Note: ${formatMessagePreview(inv.note, 80)}`);
          try {
            const inviteOpts: { note?: string } = {};
            if (inv.note) inviteOpts.note = inv.note;
            const result = await p.sendConnectionInvite(inv.recipient, inviteOpts);
            if (result.status === "sent") {
              const status = await p.getProfileStatus(inv.recipient);
              const sentOpts: Parameters<typeof markInvitationSent>[1] = {};
              if (status.profileUrn) sentOpts.recipientUrn = status.profileUrn;
              markInvitationSent(inv, sentOpts);
              console.log(`  ✓ envoyée${result.viaMoreMenu ? " (via menu Plus)" : ""}${result.withNote ? " avec note" : " sans note"}`);
              sent++;
            } else if (result.status === "already-pending") {
              markInvitationSent(inv);
              console.log(`  ↺ déjà en attente côté LinkedIn, marquée sent`);
              alreadyPending++;
            } else if (result.status === "already-connected") {
              markInvitationAccepted(inv);
              console.log(`  ↺ déjà en 1ère relation, marquée accepted`);
              alreadyConnected++;
            } else {
              markInvitationFailed(inv, result.reason ?? `status=${result.status}`);
              console.error(`  ✗ échec: ${result.reason ?? result.status}`);
              failed++;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            markInvitationFailed(inv, msg);
            console.error(`  ✗ échec: ${msg}`);
            failed++;
            if (err instanceof RateLimitHitError) {
              console.error(`RateLimitHitError détecté. Arrêt immédiat.`);
              break;
            }
          }
          if (sent + alreadyConnected + alreadyPending + failed < targetCount) {
            await humanPause("invite");
          }
        }
      });

      console.log(`\nBilan: ${sent} envoyée(s), ${alreadyPending} déjà en attente, ${alreadyConnected} déjà connectée(s), ${failed} échec(s).`);
    });

  linkedin
    .command("invite:check")
    .description("Re-vérifier l'état des invitations en `sent`. Si la cible est passée 1ère relation, l'invitation passe en `accepted`. Pause humaine entre chaque profil.")
    .option("-n, --count <n>", "nombre max d'invitations à vérifier cette session", (v) => parseInt(v, 10))
    .action(async (opts: { count?: number }) => {
      const sent = listInvitations(["sent"]);
      if (sent.length === 0) {
        console.log("Aucune invitation en attente de réponse.");
        return;
      }
      const targetCount = Math.min(opts.count ?? Infinity, sent.length);
      console.log(`En attente: ${sent.length} | Cette session: ${targetCount}`);

      let accepted = 0;
      let stillPending = 0;
      let errors = 0;

      await withProvider(async (p) => {
        for (const inv of sent.slice(0, targetCount)) {
          console.log(`\n[${accepted + stillPending + errors + 1}/${targetCount}] ${inv.id} → ${inv.recipientLabel}`);
          try {
            const status = await p.getProfileStatus(inv.recipient);
            if (status.degree === "1st") {
              markInvitationAccepted(inv);
              console.log(`  ✓ acceptée (1ère relation)`);
              accepted++;
            } else {
              console.log(`  · toujours ${status.degree}${status.invitationPending ? " (invitation toujours en attente)" : " (pas de pending visible)"}`);
              stillPending++;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`  ✗ erreur: ${msg}`);
            errors++;
          }
          if (accepted + stillPending + errors < targetCount) {
            await humanPause("profile_view");
          }
        }
      });

      console.log(`\nBilan: ${accepted} acceptée(s), ${stillPending} toujours en attente, ${errors} erreur(s).`);
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
