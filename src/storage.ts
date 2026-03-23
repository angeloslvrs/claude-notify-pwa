import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import webpush from "web-push";

const DATA_DIR = "./data";
const SUBS_PATH = `${DATA_DIR}/subscriptions.json`;
const VAPID_PATH = `${DATA_DIR}/vapid.json`;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export type PushSubscription = webpush.PushSubscription;

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

export async function loadVapidKeys(subject: string): Promise<VapidKeys> {
  await ensureDataDir();
  if (existsSync(VAPID_PATH)) {
    return JSON.parse(await Bun.file(VAPID_PATH).text());
  }
  const keys = webpush.generateVAPIDKeys();
  const vapid: VapidKeys = {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  await Bun.write(VAPID_PATH, JSON.stringify(vapid, null, 2));
  return vapid;
}

export async function loadSubscriptions(): Promise<PushSubscription[]> {
  await ensureDataDir();
  if (!existsSync(SUBS_PATH)) return [];
  try {
    return JSON.parse(await Bun.file(SUBS_PATH).text());
  } catch {
    return [];
  }
}

export async function saveSubscriptions(subs: PushSubscription[]) {
  await ensureDataDir();
  await Bun.write(SUBS_PATH, JSON.stringify(subs, null, 2));
}

export async function addSubscription(sub: PushSubscription) {
  const subs = await loadSubscriptions();
  if (subs.some((s) => s.endpoint === sub.endpoint)) return;
  subs.push(sub);
  await saveSubscriptions(subs);
}

export async function removeSubscription(endpoint: string) {
  const subs = await loadSubscriptions();
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  await saveSubscriptions(filtered);
}
