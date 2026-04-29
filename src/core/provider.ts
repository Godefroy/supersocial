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

export type ConnectionDegree = "1st" | "2nd" | "3rd" | "out-of-network" | "unknown";

export interface ProfileStatus {
  /** URL canonique `/in/<slug>/`. */
  url: string;
  name?: string;
  /** URN profil interne (`urn:li:fsd_profile:<id>`) quand extrait. */
  profileUrn?: string;
  degree: ConnectionDegree;
  /** True si une invitation est déjà en attente (bouton "En attente" visible). */
  invitationPending: boolean;
  /**
   * True si LinkedIn rend l'inbox messaging directement (1ère relation ou
   * thread préexistant). False quand la cible est non-connectée et que l'envoi
   * libre est refusé (l'upsell Premium s'affichera alors au compose).
   */
  canMessage: boolean;
}

export interface InviteResult {
  /**
   * sent: invitation envoyée avec succès dans cette commande.
   * already-pending: une invitation était déjà en attente, no-op.
   * already-connected: la cible est en 1ère relation, pas besoin d'inviter.
   * no-button: aucun bouton d'invitation trouvé (visible ni dans Plus). Peut
   * être un profil hors réseau, restreint, ou un changement de DOM LinkedIn.
   * blocked: LinkedIn a refusé l'envoi (modal d'erreur, exigence email, etc).
   */
  status: "sent" | "already-pending" | "already-connected" | "no-button" | "blocked";
  reason?: string;
  /** True si le clic du bouton "Se connecter" passait par le menu "Plus" plutôt que par un bouton visible directement. */
  viaMoreMenu?: boolean;
  /** True si une note personnalisée a été jointe à l'invitation. */
  withNote?: boolean;
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
  /** Lit le degré de relation, les états du bouton Connect/Message, l'URN. URL profil obligatoire. */
  getProfileStatus(url: string): Promise<ProfileStatus>;
  /** Envoie une demande de connexion, optionnellement avec une note personnalisée. */
  sendConnectionInvite(url: string, opts?: { note?: string }): Promise<InviteResult>;
  listComments(postId: string): Promise<Comment[]>;
  sendComment(postId: string, body: string): Promise<Comment>;
  publishPost(opts: PublishOptions): Promise<Post>;

  dispose(): Promise<void>;
}
