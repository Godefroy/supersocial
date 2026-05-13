import type { BrowserContext, Page } from "playwright";
import type {
  SocialProvider,
  SearchOptions,
  PublishOptions,
  Post,
  Comment,
  Conversation,
  Message,
  ThreadSnapshot,
  ProfileStatus,
  InviteResult,
} from "../../core/provider.js";
import type { ProviderId } from "../../core/storage.js";
import { launchPersistentChrome, closeContext } from "../../core/browser.js";
import {
  attachKillSwitch,
  assertKillSwitchOk,
  checkPageForRedFlags,
  LoginRequiredError,
  type KillSwitchState,
} from "../../core/throttle.js";
import { checkAndRecord } from "../../core/throttle-state.js";
import { hasLinkedInSession } from "../../core/session.js";
import { searchPostsOnPage } from "./pages/search.js";
import { listMyPostsOnPage } from "./pages/my-posts.js";
import { listCommentsOnPage } from "./pages/comments.js";
import { runLinkedInLogin } from "./pages/login.js";
import {
  resolveThreadFromInput,
  resolveTarget,
  openAndLoadThread,
  extractThreadState,
  sendMessageInOpenThread,
  sendFromComposeUrl,
} from "./pages/messaging.js";
import { readProfileStatus, sendInvite } from "./pages/profile.js";

export class LinkedInProvider implements SocialProvider {
  readonly id: ProviderId = "linkedin";
  private context: BrowserContext | null = null;
  private killSwitch: KillSwitchState | null = null;
  /** Cache input → cible résolue, pour éviter de relancer la résolution entre read/send au sein d'une même session. */
  private targetCache = new Map<
    string,
    Awaited<ReturnType<typeof resolveTarget>>
  >();
  /** URL thread actuellement chargée, pour skip `openAndLoadThread` si déjà sur place. */
  private loadedThreadUrl: string | null = null;

  async ensureContext(opts: { headless?: boolean } = {}): Promise<BrowserContext> {
    if (!this.context) this.context = await launchPersistentChrome(opts);
    return this.context;
  }

  private async ensurePage(): Promise<Page> {
    const context = await this.ensureContext();
    if (!(await hasLinkedInSession(context))) {
      throw new LoginRequiredError("aucun cookie li_at dans le profil Chrome");
    }
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    if (!this.killSwitch) this.killSwitch = attachKillSwitch(page);
    return page;
  }

  async login(): Promise<void> {
    const context = await this.ensureContext({ headless: false });
    await runLinkedInLogin(context);
  }

  async searchPosts(query: string, opts: SearchOptions = {}): Promise<Post[]> {
    checkAndRecord("search");
    const page = await this.ensurePage();
    const posts = await searchPostsOnPage(page, query, {
      ...(opts.limit != null ? { limit: opts.limit } : {}),
      ...(opts.dateRange ? { dateRange: opts.dateRange } : {}),
    });
    if (this.killSwitch) assertKillSwitchOk(this.killSwitch);
    await checkPageForRedFlags(page);
    return posts;
  }

  async listMyPosts(opts: { limit?: number; knownIds?: Set<string> } = {}): Promise<Post[]> {
    checkAndRecord("profile_view");
    const page = await this.ensurePage();
    const posts = await listMyPostsOnPage(page, opts);
    if (this.killSwitch) assertKillSwitchOk(this.killSwitch);
    await checkPageForRedFlags(page);
    return posts;
  }
  async listConversations(_opts?: { limit?: number }): Promise<Conversation[]> {
    throw new Error("listConversations: pas encore implémenté");
  }

  private async getOrResolveTarget(
    page: Page,
    input: string,
  ): Promise<Awaited<ReturnType<typeof resolveTarget>>> {
    const cached = this.targetCache.get(input);
    if (cached) return cached;
    const target = await resolveTarget(page, input);
    this.targetCache.set(input, target);
    return target;
  }

  private async ensureThreadLoaded(page: Page, threadUrl: string): Promise<void> {
    if (this.loadedThreadUrl === threadUrl) return;
    await openAndLoadThread(page, threadUrl);
    this.loadedThreadUrl = threadUrl;
  }

  /**
   * Expose la cible résolue (cache provider). Charge le profil si pas encore
   * en cache. Utilisé par les pre-flights CLI qui veulent connaître le degré
   * de relation avant de tenter un envoi, sans payer un second profile load
   * (car `readConversation` et `sendMessage` réutilisent la même cache).
   */
  async resolveTargetForInput(input: string): Promise<Awaited<ReturnType<typeof resolveTarget>>> {
    const page = await this.ensurePage();
    return this.getOrResolveTarget(page, input);
  }

  async resolveThread(input: string): Promise<{ threadId: string; threadUrl: string }> {
    checkAndRecord("read");
    const page = await this.ensurePage();
    const target = await this.getOrResolveTarget(page, input);
    if (!target.threadId || !target.threadUrl) {
      throw new Error(
        `Pas de thread résolu depuis "${input}". Donne l'URL du thread pour lire l'historique.`,
      );
    }
    if (this.killSwitch) assertKillSwitchOk(this.killSwitch);
    return { threadId: target.threadId, threadUrl: target.threadUrl };
  }

  async readConversation(input: string): Promise<ThreadSnapshot> {
    checkAndRecord("read");
    const page = await this.ensurePage();
    const target = await this.getOrResolveTarget(page, input);
    if (!target.threadId || !target.threadUrl) {
      throw new Error(
        `Pas de thread résolu depuis "${input}". Donne l'URL du thread pour lire l'historique. Une URL profil n'est acceptée que pour \`dm\` quand un thread existe déjà.`,
      );
    }
    await this.ensureThreadLoaded(page, target.threadUrl);
    const state = await extractThreadState(page, target.threadId, target.threadUrl);
    if (this.killSwitch) assertKillSwitchOk(this.killSwitch);
    await checkPageForRedFlags(page);
    const conversation: Conversation = {
      id: state.threadId,
      url: state.threadUrl,
      participants: state.participants,
      unread: false,
      ...(state.messages.at(-1)?.sentAt ? { lastMessageAt: state.messages.at(-1)!.sentAt } : {}),
    };
    return { conversation, messages: state.messages };
  }

  async sendMessage(input: string, body: string): Promise<ThreadSnapshot> {
    checkAndRecord("dm");
    const page = await this.ensurePage();
    const target = await this.getOrResolveTarget(page, input);

    let threadId: string;
    let threadUrl: string;

    if (target.threadId && target.threadUrl) {
      threadId = target.threadId;
      threadUrl = target.threadUrl;
      await this.ensureThreadLoaded(page, threadUrl);
      await sendMessageInOpenThread(page, body);
    } else if (target.composeUrl) {
      const res = await sendFromComposeUrl(page, target.composeUrl, body);
      threadId = res.threadId;
      threadUrl = res.threadUrl;
      // Le compose a redirigé vers /messaging/thread/<id>/; on met à jour le cache
      // et on considère le thread "chargé" puisque le DOM contient déjà le message
      // envoyé (thread neuf = pas d'historique à dérouler).
      this.targetCache.set(input, { threadId, threadUrl });
      this.loadedThreadUrl = threadUrl;
    } else {
      throw new Error(`Cible non résolue: ni thread existant ni compose URL disponible pour "${input}".`);
    }

    const state = await extractThreadState(page, threadId, threadUrl);
    if (this.killSwitch) assertKillSwitchOk(this.killSwitch);
    await checkPageForRedFlags(page);

    // Thread tout neuf via compose: aucun en-tete de groupe "cote destinataire" puisqu'il
    // n'y a que le message qu'on vient d'envoyer. extractParticipants retourne []. On
    // injecte ce qu'on sait deja du destinataire (resolu depuis la page profil).
    let participants = state.participants;
    if (participants.length === 0 && target.recipientDisplayName) {
      const fallback = {
        name: target.recipientDisplayName,
        ...(target.recipientProfileUrl ? { profileUrl: target.recipientProfileUrl } : {}),
        ...(target.recipientProfileUrn ? { profileUrn: target.recipientProfileUrn } : {}),
      };
      participants = [fallback];
    }

    const conversation: Conversation = {
      id: state.threadId,
      url: state.threadUrl,
      participants,
      unread: false,
      ...(state.messages.at(-1)?.sentAt ? { lastMessageAt: state.messages.at(-1)!.sentAt } : {}),
    };
    return { conversation, messages: state.messages };
  }
  async getProfileStatus(url: string): Promise<ProfileStatus> {
    checkAndRecord("profile_view");
    const page = await this.ensurePage();
    const status = await readProfileStatus(page, url);
    if (this.killSwitch) assertKillSwitchOk(this.killSwitch);
    await checkPageForRedFlags(page);
    return status;
  }

  async sendConnectionInvite(url: string, opts: { note?: string } = {}): Promise<InviteResult> {
    // Throttle: une invitation consomme un slot `invite` (limite 15/jour).
    // L'éventuel court-circuit (already-pending / already-connected) ne consomme
    // pas le slot car aucune action n'est tentée auprès de LinkedIn dans ce cas.
    const page = await this.ensurePage();
    // On lit le profil d'abord pour court-circuiter sans payer le throttle si déjà
    // connecté ou invitation pendante.
    checkAndRecord("profile_view");
    const status = await readProfileStatus(page, url);
    if (status.invitationPending) return { status: "already-pending" };
    if (status.degree === "1st") return { status: "already-connected" };
    checkAndRecord("invite");
    const opt: { note?: string } = {};
    if (opts.note) opt.note = opts.note;
    const result = await sendInvite(page, url, opt);
    if (this.killSwitch) assertKillSwitchOk(this.killSwitch);
    await checkPageForRedFlags(page);
    return result;
  }

  async listComments(postIdOrUrl: string): Promise<Comment[]> {
    checkAndRecord("read");
    const page = await this.ensurePage();
    const { comments } = await listCommentsOnPage(page, postIdOrUrl);
    if (this.killSwitch) assertKillSwitchOk(this.killSwitch);
    await checkPageForRedFlags(page);
    return comments;
  }
  async sendComment(_postId: string, _body: string): Promise<Comment> {
    throw new Error("sendComment: pas encore implémenté");
  }
  async publishPost(_opts: PublishOptions): Promise<Post> {
    throw new Error("publishPost: pas encore implémenté");
  }

  async dispose(): Promise<void> {
    if (this.context) {
      await closeContext(this.context);
      this.context = null;
    }
  }
}
