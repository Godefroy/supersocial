import { mkdirSync, readdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { slugify, writeMarkdown, readMarkdown } from "../../core/storage.js";
import { linkedinPaths } from "./storage.js";

export type OutboxStatus = "pending" | "sent" | "failed";

export interface OutboxItem {
  id: string;
  recipient: string; // URL profil, URL thread ou thread ID (tel que saisi)
  recipientLabel: string; // libellé lisible
  body: string;
  createdAt: string;
  sentAt?: string;
  threadId?: string;
  error?: string;
  note?: string;
  status: OutboxStatus;
  file: string;
}

interface OutboxFrontmatter extends Record<string, unknown> {
  provider: "linkedin";
  kind: "outbox_item";
  id: string;
  recipient: string;
  recipient_label: string;
  status: OutboxStatus;
  created_at: string;
  sent_at?: string | null;
  thread_id?: string | null;
  error?: string | null;
  note?: string | null;
}

function ensureDirs(): void {
  mkdirSync(linkedinPaths.outboxPendingDir(), { recursive: true });
  mkdirSync(linkedinPaths.outboxSentDir(), { recursive: true });
  mkdirSync(linkedinPaths.outboxFailedDir(), { recursive: true });
}

function dirForStatus(status: OutboxStatus): string {
  if (status === "pending") return linkedinPaths.outboxPendingDir();
  if (status === "sent") return linkedinPaths.outboxSentDir();
  return linkedinPaths.outboxFailedDir();
}

function isoTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function deriveLabelFromRecipient(recipient: string): string {
  const profile = recipient.match(/\/in\/([^/?#]+)/);
  if (profile?.[1]) return profile[1];
  const thread = recipient.match(/messaging\/thread\/([^/?#]+)/);
  if (thread?.[1]) return `thread-${thread[1].slice(0, 10)}`;
  return recipient.slice(0, 30);
}

function filenameFor(item: {
  id: string;
  recipient: string;
  createdAt: string;
}): string {
  const label = slugify(deriveLabelFromRecipient(item.recipient)) || "item";
  const ts = item.createdAt.replace(/[:.]/g, "-").slice(0, 19);
  return `${ts}-${label}-${item.id}.md`;
}

export function addOutboxItem(params: {
  recipient: string;
  body: string;
  label?: string;
}): OutboxItem {
  ensureDirs();
  const createdAt = new Date().toISOString();
  const id = Math.random().toString(36).slice(2, 10);
  const recipientLabel = params.label ?? deriveLabelFromRecipient(params.recipient);
  const filename = filenameFor({ id, recipient: params.recipient, createdAt });
  const filepath = join(linkedinPaths.outboxPendingDir(), filename);

  const frontmatter: OutboxFrontmatter = {
    provider: "linkedin",
    kind: "outbox_item",
    id,
    recipient: params.recipient,
    recipient_label: recipientLabel,
    status: "pending",
    created_at: createdAt,
  };

  writeMarkdown(filepath, { frontmatter, body: params.body + (params.body.endsWith("\n") ? "" : "\n") });

  return {
    id,
    recipient: params.recipient,
    recipientLabel,
    body: params.body,
    createdAt,
    status: "pending",
    file: filepath,
  };
}

function parseItem(file: string, status: OutboxStatus): OutboxItem | null {
  const doc = readMarkdown<OutboxFrontmatter>(file);
  if (!doc) return null;
  const fm = doc.frontmatter;
  if (fm.kind !== "outbox_item") return null;
  const item: OutboxItem = {
    id: String(fm.id),
    recipient: String(fm.recipient),
    recipientLabel: String(fm.recipient_label ?? deriveLabelFromRecipient(String(fm.recipient))),
    body: doc.body.trimEnd(),
    createdAt: String(fm.created_at),
    status,
    file,
  };
  if (fm.sent_at) item.sentAt = String(fm.sent_at);
  if (fm.thread_id) item.threadId = String(fm.thread_id);
  if (fm.error) item.error = String(fm.error);
  if (fm.note) item.note = String(fm.note);
  return item;
}

export function listOutboxItems(statuses: OutboxStatus[] = ["pending"]): OutboxItem[] {
  ensureDirs();
  const out: OutboxItem[] = [];
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

export function findOutboxItemById(id: string): OutboxItem | null {
  for (const status of ["pending", "sent", "failed"] as OutboxStatus[]) {
    const items = listOutboxItems([status]);
    const hit = items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}

function moveItem(item: OutboxItem, next: OutboxStatus, updates: Partial<OutboxFrontmatter>): string {
  ensureDirs();
  const doc = readMarkdown<OutboxFrontmatter>(item.file);
  if (!doc) throw new Error(`Fichier outbox introuvable: ${item.file}`);
  const nextFm: OutboxFrontmatter = {
    ...doc.frontmatter,
    provider: "linkedin",
    kind: "outbox_item",
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

export function markOutboxSent(item: OutboxItem, threadId: string, note?: string): string {
  return moveItem(item, "sent", {
    sent_at: new Date().toISOString(),
    thread_id: threadId,
    error: null,
    ...(note ? { note } : {}),
  });
}

export function markOutboxFailed(item: OutboxItem, error: string): string {
  return moveItem(item, "failed", {
    error,
    sent_at: null,
  });
}

export function retryOutboxItem(item: OutboxItem): string {
  if (item.status !== "failed") {
    throw new Error(`L'item ${item.id} n'est pas en échec (status: ${item.status}).`);
  }
  return moveItem(item, "pending", { error: null, sent_at: null });
}

export function cancelOutboxItem(id: string): OutboxItem | null {
  const item = findOutboxItemById(id);
  if (!item) return null;
  if (item.status !== "pending") {
    throw new Error(`L'item ${id} n'est pas en attente (status: ${item.status}). Supprime manuellement si besoin.`);
  }
  unlinkSync(item.file);
  return item;
}
