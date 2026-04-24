import type { BrowserContext, Page } from "playwright";
import type {
  SocialProvider,
  SearchOptions,
  PublishOptions,
  Post,
  Comment,
  Conversation,
  Message,
} from "../../core/provider.js";
import type { ProviderId } from "../../core/storage.js";
import { launchPersistentChrome, closeContext } from "../../core/browser.js";
import {
  attachKillSwitch,
  assertKillSwitchOk,
  checkPageForRedFlags,
  type KillSwitchState,
} from "../../core/throttle.js";
import { checkAndRecord } from "../../core/throttle-state.js";
import { hasLinkedInSession } from "../../core/session.js";
import { searchPostsOnPage } from "./pages/search.js";
import { listMyPostsOnPage } from "./pages/my-posts.js";
import { listCommentsOnPage } from "./pages/comments.js";
import { runLinkedInLogin } from "./pages/login.js";

export class LinkedInProvider implements SocialProvider {
  readonly id: ProviderId = "linkedin";
  private context: BrowserContext | null = null;
  private killSwitch: KillSwitchState | null = null;

  async ensureContext(): Promise<BrowserContext> {
    if (!this.context) this.context = await launchPersistentChrome();
    return this.context;
  }

  private async ensurePage(): Promise<Page> {
    const context = await this.ensureContext();
    if (!(await hasLinkedInSession(context))) {
      throw new Error(
        "Pas de session LinkedIn dans le profil Chrome. Lance d'abord: npm run dev -- linkedin login",
      );
    }
    const pages = context.pages();
    const page = pages[0] ?? (await context.newPage());
    if (!this.killSwitch) this.killSwitch = attachKillSwitch(page);
    return page;
  }

  async login(): Promise<void> {
    const context = await this.ensureContext();
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
  async readConversation(_conversationId: string): Promise<Message[]> {
    throw new Error("readConversation: pas encore implémenté");
  }
  async sendMessage(_conversationId: string, _body: string): Promise<Message> {
    throw new Error("sendMessage: pas encore implémenté");
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
