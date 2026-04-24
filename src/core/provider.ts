import type { ProviderId } from "./storage.js";

export interface Author {
  name: string;
  handle?: string;
  /** URL publique du profil (format `https://www.linkedin.com/in/slug/`), query params nettoyés. */
  profileUrl?: string;
  /** URN interne LinkedIn (ex: `urn:li:fsd_profile:ACoAAA...`), identifiant stable. */
  profileUrn?: string;
}

export interface PostMedia {
  type: "image" | "video";
  /** URL directe pour les images, URL du poster (thumbnail) pour les vidéos. */
  url: string;
  /** Pour les vidéos, le src vidéo réel est un blob MSE non téléchargeable; on ne capture que le poster. */
}

export interface Post {
  id: string;
  provider: ProviderId;
  url: string;
  author: Author;
  /** Date de publication en ISO 8601, quand on peut la décoder (ex: depuis l'URN snowflake). */
  publishedAt?: string;
  /** True si publishedAt est dérivé du label relatif ("1 mois") donc approximatif. */
  publishedAtApprox?: boolean;
  /** Label relatif affiché par l'UI ("1 mois", "3 h", etc.), conservé même si publishedAt est présent. */
  publishedLabel?: string;
  body: string;
  reactions?: number;
  commentCount?: number;
  repostCount?: number;
  media?: PostMedia[];
  fetchedAt: string;
}

export interface Comment {
  id: string;
  postId: string;
  /** Niveau d'imbrication: 0 = top-level, 1 = réponse, 2 = réponse à une réponse, etc. */
  depth: number;
  author: Author;
  publishedAt?: string;
  body: string;
  reactions?: number;
}

export interface Conversation {
  id: string;
  participants: Author[];
  lastMessageAt?: string;
  unread: boolean;
  url: string;
}

export interface Message {
  id: string;
  conversationId: string;
  sentAt: string;
  from: Author;
  body: string;
  outgoing: boolean;
}

export interface SearchOptions {
  limit?: number;
  since?: string;
  dateRange?: "past-24h" | "past-week" | "past-month";
}

export interface PublishOptions {
  body: string;
  visibility?: "public" | "connections";
}

export interface ThreadSnapshot {
  conversation: Conversation;
  messages: Message[];
}

export interface SocialProvider {
  readonly id: ProviderId;

  searchPosts(query: string, opts?: SearchOptions): Promise<Post[]>;
  listMyPosts(opts?: { limit?: number }): Promise<Post[]>;
  listConversations(opts?: { limit?: number }): Promise<Conversation[]>;
  /** Accepte une URL profil, URL thread ou thread ID. Retourne le snapshot complet. */
  readConversation(input: string): Promise<ThreadSnapshot>;
  /** Envoie et retourne le snapshot mis à jour (le message envoyé est dans messages). */
  sendMessage(input: string, body: string): Promise<ThreadSnapshot>;
  listComments(postId: string): Promise<Comment[]>;
  sendComment(postId: string, body: string): Promise<Comment>;
  publishPost(opts: PublishOptions): Promise<Post>;

  dispose(): Promise<void>;
}
