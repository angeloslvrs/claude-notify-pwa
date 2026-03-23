import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import webpush from "web-push";

const DATA_DIR = "./data";
const DB_PATH = `${DATA_DIR}/claude-notif.db`;
const VAPID_PATH = `${DATA_DIR}/vapid.json`;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// --- DB Init ---

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

let _db: Database;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec("PRAGMA journal_mode=WAL");
    _db.exec("PRAGMA foreign_keys=ON");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        api_key TEXT UNIQUE NOT NULL,
        role TEXT DEFAULT 'user',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT UNIQUE NOT NULL,
        keys_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        machine TEXT NOT NULL,
        project TEXT,
        summary TEXT,
        event TEXT NOT NULL,
        count INTEGER DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invite_codes (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        max_uses INTEGER,
        use_count INTEGER DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
  return _db;
}

export async function initStorage() {
  await ensureDataDir();
  getDb();
}

// --- VAPID Keys (still JSON file, shared across users) ---

export async function loadVapidKeys(subject: string): Promise<VapidKeys> {
  await ensureDataDir();
  if (existsSync(VAPID_PATH)) {
    return JSON.parse(await Bun.file(VAPID_PATH).text());
  }
  const keys = webpush.generateVAPIDKeys();
  const vapid: VapidKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  await Bun.write(VAPID_PATH, JSON.stringify(vapid, null, 2));
  return vapid;
}

// --- Users ---

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  api_key: string;
  created_at: string;
}

export interface UserRow extends User {
  password_hash: string;
  role: string;
}

export function createUser(id: string, username: string, passwordHash: string, apiKey: string): User {
  const now = new Date().toISOString();
  getDb().run(
    "INSERT INTO users (id, username, password_hash, display_name, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, username, passwordHash, username, apiKey, now]
  );
  return { id, username, display_name: username, api_key: apiKey, created_at: now };
}

export function getUserByUsername(username: string): UserRow | null {
  return getDb().query("SELECT * FROM users WHERE username = ?").get(username) as UserRow | null;
}

export function getUserByApiKey(apiKey: string): User | null {
  return getDb().query("SELECT id, username, display_name, api_key, created_at FROM users WHERE api_key = ?").get(apiKey) as User | null;
}

export function getUserById(id: string): User | null {
  return getDb().query("SELECT id, username, display_name, api_key, created_at FROM users WHERE id = ?").get(id) as User | null;
}

export function listUsers(): Omit<User, "api_key">[] {
  return getDb().query("SELECT id, username, display_name, created_at FROM users ORDER BY created_at DESC").all() as Omit<User, "api_key">[];
}

export function deleteUser(id: string) {
  getDb().run("DELETE FROM users WHERE id = ?", [id]);
}

// --- Subscriptions (user-scoped) ---

export function addSubscription(userId: string, endpoint: string, keysJson: string) {
  const now = new Date().toISOString();
  getDb().run(
    "INSERT OR IGNORE INTO subscriptions (user_id, endpoint, keys_json, created_at) VALUES (?, ?, ?, ?)",
    [userId, endpoint, keysJson, now]
  );
}

export function removeSubscription(userId: string, endpoint: string) {
  getDb().run("DELETE FROM subscriptions WHERE user_id = ? AND endpoint = ?", [userId, endpoint]);
}

export function getSubscriptionsForUser(userId: string): { endpoint: string; keys: any }[] {
  const rows = getDb().query("SELECT endpoint, keys_json FROM subscriptions WHERE user_id = ?").all(userId) as { endpoint: string; keys_json: string }[];
  return rows.map((r) => ({ endpoint: r.endpoint, keys: JSON.parse(r.keys_json) }));
}

export function removeExpiredSubscriptions(endpoints: string[]) {
  if (endpoints.length === 0) return;
  const placeholders = endpoints.map(() => "?").join(",");
  getDb().run(`DELETE FROM subscriptions WHERE endpoint IN (${placeholders})`, endpoints);
}

// --- History (user-scoped) ---

export interface HistoryEntry {
  id: string;
  timestamp: string;
  machine: string;
  project: string;
  summary: string;
  event: string;
  count: number;
}

export function addHistoryEntry(userId: string, entry: { id: string; machine: string; project: string; summary: string; event: string; count: number }) {
  const now = new Date().toISOString();
  getDb().run(
    "INSERT INTO history (id, user_id, machine, project, summary, event, count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [entry.id, userId, entry.machine, entry.project || "", entry.summary, entry.event, entry.count, now]
  );
  // Cap at 50 per user
  getDb().run(
    "DELETE FROM history WHERE user_id = ? AND id NOT IN (SELECT id FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50)",
    [userId, userId]
  );
}

export function getHistory(userId: string): HistoryEntry[] {
  const rows = getDb().query(
    "SELECT id, created_at, machine, project, summary, event, count FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
  ).all(userId) as { id: string; created_at: string; machine: string; project: string; summary: string; event: string; count: number }[];
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.created_at,
    machine: r.machine,
    project: r.project,
    summary: r.summary,
    event: r.event,
    count: r.count,
  }));
}

export function clearHistory(userId: string) {
  getDb().run("DELETE FROM history WHERE user_id = ?", [userId]);
}

// --- Invite Codes ---

export interface InviteCode {
  id: string;
  code: string;
  max_uses: number | null;
  use_count: number;
  created_at: string;
}

export function createInviteCode(id: string, code: string, maxUses: number | null, createdBy: string): InviteCode {
  const now = new Date().toISOString();
  getDb().run(
    "INSERT INTO invite_codes (id, code, max_uses, use_count, created_by, created_at) VALUES (?, ?, ?, 0, ?, ?)",
    [id, code, maxUses, createdBy, now]
  );
  return { id, code, max_uses: maxUses, use_count: 0, created_at: now };
}

export function getInviteByCode(code: string): InviteCode | null {
  return getDb().query("SELECT id, code, max_uses, use_count, created_at FROM invite_codes WHERE code = ?").get(code) as InviteCode | null;
}

export function incrementInviteUse(id: string) {
  getDb().run("UPDATE invite_codes SET use_count = use_count + 1 WHERE id = ?", [id]);
}

export function listInviteCodes(): InviteCode[] {
  return getDb().query("SELECT id, code, max_uses, use_count, created_at FROM invite_codes ORDER BY created_at DESC").all() as InviteCode[];
}

export function deleteInviteCode(id: string) {
  getDb().run("DELETE FROM invite_codes WHERE id = ?", [id]);
}
