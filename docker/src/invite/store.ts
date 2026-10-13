import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { dataFile } from "../paths.js";

export type InviteStatus = "active" | "paused" | "expired" | "exhausted";
export type InviteAssignmentStrategy = "manual" | "round_robin";

export interface InviteEntry {
  id: string;
  code: string;
  url: string;
  label: string;
  category: string;
  tags: string[];
  source: string;
  campaignId: string;
  status: InviteStatus;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface InviteAssignment {
  id: string;
  inviteId: string;
  accountId: string;
  strategy: InviteAssignmentStrategy;
  result: string;
  assignedAt: string;
  consumedAt: string | null;
}

export interface InviteSettings {
  defaultStrategy: InviteAssignmentStrategy;
}

export interface InviteStoreDoc {
  version: 1;
  invites: InviteEntry[];
  assignments: InviteAssignment[];
  settings: InviteSettings;
}

export interface CreateInviteInput {
  code: string;
  url?: string;
  label?: string;
  category?: string;
  tags?: string[];
  source?: string;
  campaignId?: string;
  status?: InviteStatus;
  maxUses?: number | null;
  usedCount?: number;
  expiresAt?: string | null;
  note?: string;
}

export type UpdateInviteInput = Partial<Omit<CreateInviteInput, "code" | "usedCount">> & {
  code?: string;
  usedCount?: number;
};

export interface ListInvitesOptions {
  page?: number;
  pageSize?: number;
  query?: string;
  status?: InviteStatus | InviteStatus[];
  category?: string;
  campaignId?: string;
  tag?: string;
}

export interface InvitePage {
  items: InviteEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface InviteStats {
  total: number;
  active: number;
  paused: number;
  expired: number;
  exhausted: number;
  assigned: number;
  consumed: number;
  available: number;
  byCategory: Record<string, number>;
  byCampaign: Record<string, number>;
}

export interface AssignInviteOptions {
  strategy?: InviteAssignmentStrategy;
  inviteId?: string;
  result?: string;
}

export interface AssignInviteResult {
  assignment: InviteAssignment;
  invite: InviteEntry;
}

const ENV_SECRET = "ZCODE_KNIGHT_CREDENTIAL_SECRET";
const ENV_SECRET_LEGACY = "ZCODE_PROXY_CREDENTIAL_SECRET";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

interface StoreFile {
  encrypted: string;
}

function filePath(): string {
  return dataFile("invites.json");
}

function encryptionKey(): Uint8Array {
  const seed = process.env[ENV_SECRET]?.trim() || process.env[ENV_SECRET_LEGACY]?.trim()
    || `${homedir()}-${process.platform}-${process.arch}`;
  return new Uint8Array(createHash("sha256").update(seed, "utf-8").digest());
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  const buffer = new ArrayBuffer(raw.byteLength);
  new Uint8Array(buffer).set(raw);
  return crypto.subtle.importKey("raw", buffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(plaintext: string): Promise<string> {
  const key = await importAesKey(encryptionKey());
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString("base64");
}

async function decrypt(ciphertext: string): Promise<string> {
  const key = await importAesKey(encryptionKey());
  const combined = Buffer.from(ciphertext, "base64");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.slice(0, 12) },
    key,
    combined.slice(12),
  );
  return new TextDecoder().decode(plaintext);
}

function atomicWrite(contents: string): void {
  const target = filePath();
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, target);
}

function emptyDoc(): InviteStoreDoc {
  return {
    version: 1,
    invites: [],
    assignments: [],
    settings: { defaultStrategy: "round_robin" },
  };
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim()).filter(Boolean))];
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nullableLimit(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("maxUses must be a non-negative integer or null");
  }
  return value;
}

function normaliseStatus(value: unknown): InviteStatus {
  return value === "paused" || value === "expired" || value === "exhausted" ? value : "active";
}

/**
 * An ISO-8601 expiry, or null for "never".
 *
 * Validated HERE rather than only in the route: `Date.parse("soon")` is NaN, and
 * `NaN <= now` is false, so an unparseable value silently reads as "never
 * expires" — the invite would stay assignable forever with no error anywhere.
 * Every write path (create, patch) funnels through this, so the check cannot be
 * bypassed by a new caller that forgets to validate.
 *
 * `strict` is false while LOADING a stored document: a value already on disk
 * (hand-edited, or written by an older build) must degrade to "no expiry"
 * rather than throwing — a throw here fails the whole registry load and takes
 * every other invite down with it.
 */
function expiry(value: unknown, strict = true): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = text(value);
  if (!raw) return null;
  if (Number.isNaN(Date.parse(raw))) {
    if (strict) throw new Error(`expiresAt is not a valid date: ${raw}`);
    return null;
  }
  return raw;
}

function normaliseStrategy(value: unknown): InviteAssignmentStrategy {
  return value === "manual" ? "manual" : "round_robin";
}

function normaliseDoc(raw: unknown): InviteStoreDoc {
  if (!raw || typeof raw !== "object") return emptyDoc();
  const input = raw as Partial<InviteStoreDoc>;
  const inviteList = Array.isArray(input.invites) ? input.invites : [];
  const assignmentList = Array.isArray(input.assignments) ? input.assignments : [];
  const invites: InviteEntry[] = [];
  for (const rawInvite of inviteList) {
    if (!rawInvite || typeof rawInvite !== "object") continue;
    const value = rawInvite as Partial<InviteEntry>;
    const code = text(value.code);
    if (!code) continue;
    const maxUses = value.maxUses === null ? null : nonNegativeInteger(value.maxUses, 0);
    invites.push({
      id: text(value.id, randomUUID()),
      code,
      url: text(value.url),
      label: text(value.label, code),
      category: text(value.category, "general"),
      tags: tags(value.tags),
      source: text(value.source, "manual"),
      campaignId: text(value.campaignId),
      status: normaliseStatus(value.status),
      maxUses,
      usedCount: nonNegativeInteger(value.usedCount, 0),
      // strict=false: loading must tolerate a bad value already on disk.
      expiresAt: expiry(value.expiresAt, false),
      note: text(value.note),
      createdAt: text(value.createdAt, new Date(0).toISOString()),
      updatedAt: text(value.updatedAt, text(value.createdAt, new Date(0).toISOString())),
    });
  }
  const inviteIds = new Set(invites.map((invite) => invite.id));
  const assignments: InviteAssignment[] = [];
  for (const rawAssignment of assignmentList) {
    if (!rawAssignment || typeof rawAssignment !== "object") continue;
    const value = rawAssignment as Partial<InviteAssignment>;
    const inviteId = text(value.inviteId);
    const accountId = text(value.accountId);
    if (!inviteId || !accountId || !inviteIds.has(inviteId)) continue;
    assignments.push({
      id: text(value.id, randomUUID()),
      inviteId,
      accountId,
      strategy: normaliseStrategy(value.strategy),
      result: text(value.result, "assigned"),
      assignedAt: text(value.assignedAt, new Date(0).toISOString()),
      consumedAt: value.consumedAt === null ? null : text(value.consumedAt),
    });
  }
  return {
    version: 1,
    invites,
    assignments,
    settings: { defaultStrategy: normaliseStrategy(input.settings?.defaultStrategy) },
  };
}

let cache: InviteStoreDoc | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

async function loadUncached(): Promise<InviteStoreDoc> {
  const path = filePath();
  if (!existsSync(path)) return emptyDoc();
  try {
    const envelope = JSON.parse(readFileSync(path, "utf-8")) as StoreFile;
    if (!envelope?.encrypted) return emptyDoc();
    return normaliseDoc(JSON.parse(await decrypt(envelope.encrypted)));
  } catch {
    return emptyDoc();
  }
}

async function loadCached(): Promise<InviteStoreDoc> {
  if (cache) return cache;
  const task = writeChain.then(async () => {
    if (!cache) cache = await loadUncached();
    return cache;
  });
  // Same rule as mutate(): never park a rejection on the shared chain.
  writeChain = task.then(() => {}, () => {});
  return task as Promise<InviteStoreDoc>;
}

async function persist(doc: InviteStoreDoc): Promise<void> {
  mkdirSync(dirname(filePath()), { recursive: true });
  atomicWrite(JSON.stringify({ encrypted: await encrypt(JSON.stringify(doc)) } satisfies StoreFile));
}

async function mutate<T>(fn: (doc: InviteStoreDoc) => T): Promise<T> {
  const task = writeChain.then(async () => {
    if (!cache) cache = await loadUncached();
    const result = fn(cache);
    await persist(cache);
    return result;
  });
  // The CHAIN must not carry the rejection.
  //
  // A validator that throws (duplicate code, capacity exceeded, "release it
  // before deleting") rejects this task. Assigning that rejected promise to
  // writeChain poisoned every LATER write: the next `writeChain.then(...)` never
  // ran, so one rejected request silently broke the whole registry until the
  // process restarted. The caller still gets the rejection through the returned
  // task; the chain itself keeps a resolved tail so the next mutation proceeds.
  writeChain = task.then(() => {}, () => {});
  return task as Promise<T>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isExpired(invite: InviteEntry, now = Date.now()): boolean {
  return Boolean(invite.expiresAt && Date.parse(invite.expiresAt) <= now);
}

function effectiveStatus(invite: InviteEntry, now = Date.now()): InviteStatus {
  if (invite.status === "paused") return "paused";
  if (isExpired(invite, now)) return "expired";
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return "exhausted";
  return "active";
}

function isAvailable(invite: InviteEntry, now = Date.now()): boolean {
  return effectiveStatus(invite, now) === "active";
}

function makeInvite(input: CreateInviteInput, now: string): InviteEntry {
  const code = text(input.code);
  if (!code) throw new Error("invite code is required");
  const maxUses = nullableLimit(input.maxUses);
  const usedCount = nonNegativeInteger(input.usedCount, 0);
  if (maxUses !== null && usedCount > maxUses) throw new Error("usedCount cannot exceed maxUses");
  return {
    id: randomUUID(),
    code,
    url: text(input.url),
    label: text(input.label, code),
    category: text(input.category, "general"),
    tags: tags(input.tags),
    source: text(input.source, "manual"),
    campaignId: text(input.campaignId),
    status: normaliseStatus(input.status),
    maxUses,
    usedCount,
    expiresAt: expiry(input.expiresAt),
    note: text(input.note),
    createdAt: now,
    updatedAt: now,
  };
}

export function inviteStoreFile(): string {
  return filePath();
}

export async function loadInvites(): Promise<InviteStoreDoc> {
  return clone(await loadCached());
}

export async function createInvite(input: CreateInviteInput): Promise<InviteEntry> {
  return mutate((doc) => {
    if (doc.invites.some((invite) => invite.code === text(input.code))) {
      throw new Error(`invite code already exists: ${text(input.code)}`);
    }
    const invite = makeInvite(input, new Date().toISOString());
    doc.invites.push(invite);
    return clone(invite);
  });
}

export async function updateInvite(id: string, patch: UpdateInviteInput): Promise<InviteEntry | null> {
  return mutate((doc) => {
    const invite = doc.invites.find((entry) => entry.id === id);
    if (!invite) return null;
    if (patch.code !== undefined) {
      const code = text(patch.code);
      if (!code) throw new Error("invite code is required");
      if (doc.invites.some((other) => other.id !== id && other.code === code)) {
        throw new Error(`invite code already exists: ${code}`);
      }
      invite.code = code;
    }
    if (patch.url !== undefined) invite.url = text(patch.url);
    if (patch.label !== undefined) invite.label = text(patch.label);
    if (patch.category !== undefined) invite.category = text(patch.category);
    if (patch.tags !== undefined) invite.tags = tags(patch.tags);
    if (patch.source !== undefined) invite.source = text(patch.source);
    if (patch.campaignId !== undefined) invite.campaignId = text(patch.campaignId);
    if (patch.status !== undefined) invite.status = normaliseStatus(patch.status);
    if (patch.maxUses !== undefined) invite.maxUses = nullableLimit(patch.maxUses);
    if (patch.usedCount !== undefined) invite.usedCount = nonNegativeInteger(patch.usedCount, invite.usedCount);
    if (invite.maxUses !== null && invite.usedCount > invite.maxUses) {
      throw new Error("usedCount cannot exceed maxUses");
    }
    if (patch.expiresAt !== undefined) invite.expiresAt = expiry(patch.expiresAt);
    if (patch.note !== undefined) invite.note = text(patch.note);
    invite.updatedAt = new Date().toISOString();
    return clone(invite);
  });
}

/**
 * Remove a registry entry.
 *
 * Refuses while a live (unconsumed) assignment points at it: the code is
 * reserved for an account, and deleting the entry would leave that account's
 * card showing a reservation whose invite no longer exists. Release first, then
 * delete. Historical (consumed) assignments are kept — they are the audit trail
 * of what was handed out, and the panel shows them on the By-account tab.
 *
 * @returns true when removed, false when the id is unknown.
 */
export async function deleteInvite(id: string): Promise<boolean> {
  return mutate((doc) => {
    const at = doc.invites.findIndex((entry) => entry.id === id);
    if (at < 0) return false;
    const live = doc.assignments.some((a) => a.inviteId === id && !a.consumedAt);
    if (live) throw new Error("invite has a live reservation — release it before deleting");
    doc.invites.splice(at, 1);
    return true;
  });
}

export async function listInvites(options: ListInvitesOptions = {}): Promise<InvitePage> {
  const doc = await loadCached();
  const query = text(options.query).toLowerCase();
  const statuses = new Set<InviteStatus>(Array.isArray(options.status) ? options.status : options.status ? [options.status] : []);
  const filtered = doc.invites.filter((invite) => {
    const haystack = [invite.code, invite.url, invite.label, invite.category, invite.source, invite.campaignId, invite.note, ...invite.tags].join(" ").toLowerCase();
    return (!query || haystack.includes(query))
      && (!statuses.size || statuses.has(effectiveStatus(invite)))
      && (!options.category || invite.category === options.category)
      && (!options.campaignId || invite.campaignId === options.campaignId)
      && (!options.tag || invite.tags.includes(options.tag));
  });
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  return {
    items: clone(filtered.slice((safePage - 1) * pageSize, safePage * pageSize)),
    page: safePage,
    pageSize,
    total: filtered.length,
    totalPages,
  };
}

export async function inviteStats(): Promise<InviteStats> {
  const doc = await loadCached();
  const stats: InviteStats = {
    total: doc.invites.length,
    active: 0,
    paused: 0,
    expired: 0,
    exhausted: 0,
    assigned: doc.assignments.length,
    consumed: doc.assignments.filter((assignment) => Boolean(assignment.consumedAt)).length,
    available: 0,
    byCategory: {},
    byCampaign: {},
  };
  for (const invite of doc.invites) {
    const status = effectiveStatus(invite);
    stats[status]++;
    if (status === "active") stats.available++;
    stats.byCategory[invite.category] = (stats.byCategory[invite.category] ?? 0) + 1;
    if (invite.campaignId) stats.byCampaign[invite.campaignId] = (stats.byCampaign[invite.campaignId] ?? 0) + 1;
  }
  return stats;
}

export async function getInviteSettings(): Promise<InviteSettings> {
  return clone((await loadCached()).settings);
}

export async function updateInviteSettings(patch: Partial<InviteSettings>): Promise<InviteSettings> {
  return mutate((doc) => {
    if (patch.defaultStrategy !== undefined) doc.settings.defaultStrategy = normaliseStrategy(patch.defaultStrategy);
    return clone(doc.settings);
  });
}

export async function assignInvite(accountId: string, options: AssignInviteOptions = {}): Promise<AssignInviteResult | null> {
  const account = text(accountId);
  if (!account) throw new Error("accountId is required");
  return mutate((doc) => {
    const strategy = options.strategy ?? doc.settings.defaultStrategy;
    let invite: InviteEntry | undefined;
    if (strategy === "manual") {
      if (!options.inviteId) throw new Error("inviteId is required for manual assignment");
      invite = doc.invites.find((entry) => entry.id === options.inviteId);
    } else {
      const candidates = doc.invites.filter((entry) => isAvailable(entry));
      invite = candidates.sort((a, b) => {
        const aAssigned = doc.assignments.filter((assignment) => assignment.inviteId === a.id).length;
        const bAssigned = doc.assignments.filter((assignment) => assignment.inviteId === b.id).length;
        return aAssigned - bAssigned || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      })[0];
    }
    if (!invite || !isAvailable(invite)) return null;
    const now = new Date().toISOString();
    const assignment: InviteAssignment = {
      id: randomUUID(),
      inviteId: invite.id,
      accountId: account,
      strategy,
      result: text(options.result, "assigned"),
      assignedAt: now,
      consumedAt: null,
    };
    doc.assignments.push(assignment);
    invite.usedCount++;
    invite.updatedAt = now;
    return { assignment: clone(assignment), invite: clone(invite) };
  });
}

export async function releaseInvite(assignmentId: string, result = "released"): Promise<InviteAssignment | null> {
  return mutate((doc) => {
    const assignment = doc.assignments.find((entry) => entry.id === assignmentId);
    if (!assignment || assignment.consumedAt) return null;
    const invite = doc.invites.find((entry) => entry.id === assignment.inviteId);
    if (!invite) return null;
    const now = new Date().toISOString();
    assignment.result = text(result, "released");
    assignment.consumedAt = now;
    invite.usedCount = Math.max(0, invite.usedCount - 1);
    invite.updatedAt = now;
    return clone(assignment);
  });
}

export async function consumeInvite(assignmentId: string, result = "consumed"): Promise<InviteAssignment | null> {
  return mutate((doc) => {
    const assignment = doc.assignments.find((entry) => entry.id === assignmentId);
    if (!assignment || assignment.consumedAt) return null;
    assignment.result = text(result, "consumed");
    assignment.consumedAt = new Date().toISOString();
    return clone(assignment);
  });
}

/**
 * Release a reservation without marking it as consumed. This preserves the
 * assignment audit row while returning the invite's capacity to the pool.
 */
export async function releaseInviteReservation(assignmentId: string, result = "released"): Promise<InviteAssignment | null> {
  return mutate((doc) => {
    const assignment = doc.assignments.find((entry) => entry.id === assignmentId);
    if (!assignment || assignment.consumedAt) return null;
    const invite = doc.invites.find((entry) => entry.id === assignment.inviteId);
    if (!invite) return null;
    const now = new Date().toISOString();
    assignment.result = text(result, "released");
    assignment.consumedAt = now;
    invite.usedCount = Math.max(0, invite.usedCount - 1);
    invite.updatedAt = now;
    return clone(assignment);
  });
}

export function resetInviteStoreForTest(): void {
  cache = null;
  writeChain = Promise.resolve();
}
