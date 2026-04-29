import { mkdirSync, readdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { slugify, writeMarkdown, readMarkdown } from "../../core/storage.js";
import { linkedinPaths } from "./storage.js";

export type InvitationStatus = "pending" | "sent" | "accepted" | "failed";

export interface Invitation {
  id: string;
  /** URL profil canonique (`https://www.linkedin.com/in/<slug>/`). */
  recipient: string;
  /** Libellé lisible (nom). */
  recipientLabel: string;
  /** URN profil interne quand connu, utile pour la dédup et les checks ultérieurs. */
  recipientUrn?: string;
  /** Note jointe à l'invitation, vide pour une invitation simple. */
  note?: string;
  status: InvitationStatus;
  createdAt: string;
  sentAt?: string;
  acceptedAt?: string;
  error?: string;
  file: string;
}

interface InvitationFrontmatter extends Record<string, unknown> {
  provider: "linkedin";
  kind: "invitation";
  id: string;
  recipient: string;
  recipient_label: string;
  recipient_urn?: string | null;
  status: InvitationStatus;
  created_at: string;
  sent_at?: string | null;
  accepted_at?: string | null;
  error?: string | null;
}

function ensureDirs(): void {
  mkdirSync(linkedinPaths.invitationsPendingDir(), { recursive: true });
  mkdirSync(linkedinPaths.invitationsSentDir(), { recursive: true });
  mkdirSync(linkedinPaths.invitationsAcceptedDir(), { recursive: true });
  mkdirSync(linkedinPaths.invitationsFailedDir(), { recursive: true });
}

function dirForStatus(status: InvitationStatus): string {
  if (status === "pending") return linkedinPaths.invitationsPendingDir();
  if (status === "sent") return linkedinPaths.invitationsSentDir();
  if (status === "accepted") return linkedinPaths.invitationsAcceptedDir();
  return linkedinPaths.invitationsFailedDir();
}

function deriveLabelFromRecipient(recipient: string): string {
  const profile = recipient.match(/\/in\/([^/?#]+)/);
  if (profile?.[1]) return profile[1];
  return recipient.slice(0, 30);
}

function filenameFor(item: { id: string; recipient: string; createdAt: string }): string {
  const label = slugify(deriveLabelFromRecipient(item.recipient)) || "invite";
  const ts = item.createdAt.replace(/[:.]/g, "-").slice(0, 19);
  return `${ts}-${label}-${item.id}.md`;
}

export function addInvitation(params: {
  recipient: string;
  note?: string;
  label?: string;
  recipientUrn?: string;
}): Invitation {
  ensureDirs();
  const createdAt = new Date().toISOString();
  const id = Math.random().toString(36).slice(2, 10);
  const recipientLabel = params.label ?? deriveLabelFromRecipient(params.recipient);
  const filename = filenameFor({ id, recipient: params.recipient, createdAt });
  const filepath = join(linkedinPaths.invitationsPendingDir(), filename);

  const frontmatter: InvitationFrontmatter = {
    provider: "linkedin",
    kind: "invitation",
    id,
    recipient: params.recipient,
    recipient_label: recipientLabel,
    status: "pending",
    created_at: createdAt,
    ...(params.recipientUrn ? { recipient_urn: params.recipientUrn } : {}),
  };

  writeMarkdown(filepath, {
    frontmatter,
    body: (params.note ?? "") + (params.note?.endsWith("\n") || !params.note ? "" : "\n"),
  });

  const inv: Invitation = {
    id,
    recipient: params.recipient,
    recipientLabel,
    status: "pending",
    createdAt,
    file: filepath,
  };
  if (params.note) inv.note = params.note;
  if (params.recipientUrn) inv.recipientUrn = params.recipientUrn;
  return inv;
}

function parseItem(file: string, status: InvitationStatus): Invitation | null {
  const doc = readMarkdown<InvitationFrontmatter>(file);
  if (!doc) return null;
  const fm = doc.frontmatter;
  if (fm.kind !== "invitation") return null;
  const note = doc.body.trimEnd();
  const item: Invitation = {
    id: String(fm.id),
    recipient: String(fm.recipient),
    recipientLabel: String(fm.recipient_label ?? deriveLabelFromRecipient(String(fm.recipient))),
    status,
    createdAt: String(fm.created_at),
    file,
  };
  if (note) item.note = note;
  if (fm.recipient_urn) item.recipientUrn = String(fm.recipient_urn);
  if (fm.sent_at) item.sentAt = String(fm.sent_at);
  if (fm.accepted_at) item.acceptedAt = String(fm.accepted_at);
  if (fm.error) item.error = String(fm.error);
  return item;
}

export function listInvitations(statuses: InvitationStatus[] = ["pending"]): Invitation[] {
  ensureDirs();
  const out: Invitation[] = [];
  for (const status of statuses) {
    const dir = dirForStatus(status);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const item = parseItem(join(dir, f), status);
      if (item) out.push(item);
    }
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export function findInvitationById(id: string): Invitation | null {
  for (const status of ["pending", "sent", "accepted", "failed"] as InvitationStatus[]) {
    const items = listInvitations([status]);
    const hit = items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Trouve une invitation existante pour un URN profil (toutes statuts confondus).
 * Sert à éviter les doublons quand un `connect` direct s'exécute pour une cible
 * déjà tracée. Compare sur l'URN car c'est la clé stable (le slug peut changer).
 */
export function findInvitationByUrn(urn: string): Invitation | null {
  for (const status of ["pending", "sent", "accepted", "failed"] as InvitationStatus[]) {
    const items = listInvitations([status]);
    const hit = items.find((i) => i.recipientUrn === urn);
    if (hit) return hit;
  }
  return null;
}

function moveItem(item: Invitation, next: InvitationStatus, updates: Partial<InvitationFrontmatter>): string {
  ensureDirs();
  const doc = readMarkdown<InvitationFrontmatter>(item.file);
  if (!doc) throw new Error(`Fichier invitation introuvable: ${item.file}`);
  const nextFm: InvitationFrontmatter = {
    ...doc.frontmatter,
    provider: "linkedin",
    kind: "invitation",
    id: String(doc.frontmatter.id),
    recipient: String(doc.frontmatter.recipient),
    recipient_label: String(doc.frontmatter.recipient_label ?? deriveLabelFromRecipient(String(doc.frontmatter.recipient))),
    created_at: String(doc.frontmatter.created_at),
    status: next,
    ...updates,
  };
  const targetDir = dirForStatus(next);
  const targetFile = join(targetDir, basename(item.file));
  writeMarkdown(item.file, { frontmatter: nextFm, body: doc.body });
  if (targetFile !== item.file) {
    renameSync(item.file, targetFile);
  }
  return targetFile;
}

export function markInvitationSent(item: Invitation, opts: { sentAt?: string; recipientUrn?: string } = {}): string {
  return moveItem(item, "sent", {
    sent_at: opts.sentAt ?? new Date().toISOString(),
    error: null,
    ...(opts.recipientUrn ? { recipient_urn: opts.recipientUrn } : {}),
  });
}

export function markInvitationAccepted(item: Invitation): string {
  return moveItem(item, "accepted", {
    accepted_at: new Date().toISOString(),
    error: null,
  });
}

export function markInvitationFailed(item: Invitation, error: string): string {
  return moveItem(item, "failed", {
    error,
    sent_at: null,
  });
}

export function retryInvitation(item: Invitation): string {
  if (item.status !== "failed") {
    throw new Error(`L'invitation ${item.id} n'est pas en échec (status: ${item.status}).`);
  }
  return moveItem(item, "pending", { error: null, sent_at: null });
}

export function cancelInvitation(id: string): Invitation | null {
  const item = findInvitationById(id);
  if (!item) return null;
  if (item.status !== "pending") {
    throw new Error(`L'invitation ${id} n'est pas en attente (status: ${item.status}). Supprime manuellement si besoin.`);
  }
  unlinkSync(item.file);
  return item;
}

/**
 * Crée un fichier `sent/` directement (sans passer par `pending/`). Utilisé
 * par le `connect <url>` direct pour tracer une invitation envoyée hors batch.
 * Si une invitation existe déjà pour ce URN (toutes statuts), no-op et
 * retourne l'existante: la source de vérité est l'état LinkedIn live, pas une
 * invitation locale dupliquée.
 */
export function recordDirectInvitation(params: {
  recipient: string;
  recipientLabel?: string;
  recipientUrn: string;
  note?: string;
  status?: "sent" | "accepted";
}): Invitation {
  ensureDirs();
  const existing = findInvitationByUrn(params.recipientUrn);
  if (existing) return existing;

  const createdAt = new Date().toISOString();
  const id = Math.random().toString(36).slice(2, 10);
  const recipientLabel = params.recipientLabel ?? deriveLabelFromRecipient(params.recipient);
  const filename = filenameFor({ id, recipient: params.recipient, createdAt });
  const status: InvitationStatus = params.status ?? "sent";
  const filepath = join(dirForStatus(status), filename);

  const frontmatter: InvitationFrontmatter = {
    provider: "linkedin",
    kind: "invitation",
    id,
    recipient: params.recipient,
    recipient_label: recipientLabel,
    recipient_urn: params.recipientUrn,
    status,
    created_at: createdAt,
    sent_at: createdAt,
    ...(status === "accepted" ? { accepted_at: createdAt } : {}),
  };

  writeMarkdown(filepath, {
    frontmatter,
    body: (params.note ?? "") + (params.note?.endsWith("\n") || !params.note ? "" : "\n"),
  });

  const inv: Invitation = {
    id,
    recipient: params.recipient,
    recipientLabel,
    recipientUrn: params.recipientUrn,
    status,
    createdAt,
    sentAt: createdAt,
    file: filepath,
  };
  if (params.note) inv.note = params.note;
  if (status === "accepted") inv.acceptedAt = createdAt;
  return inv;
}
