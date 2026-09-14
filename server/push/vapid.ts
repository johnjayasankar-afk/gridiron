/**
 * The server's VAPID key pair and contact subject for Web Push.
 *
 * - Keys come from GRIDIRON_VAPID_PUBLIC_KEY and GRIDIRON_VAPID_PRIVATE_KEY when both are set. Otherwise they are
 *   read from vapid.json in the cache directory, or generated once and written there, readable by its owner only.
 * - A key file that exists but does not validate is an error, never a reason to generate new keys: new keys would
 *   quietly stop every existing subscription.
 * - GRIDIRON_VAPID_SUBJECT tells push services how to reach whoever runs the server: an https: URL or a mailto:
 *   address.
 * - Errors name the setting or the file, never a key, and never a path on this machine.
 */
import { createECDH, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isRecord } from '../../shared/util.js';
import { generateVapidKeys, vapidHeaders, type VapidKeys } from './webpush.js';

export interface LoadedVapid {
  keys: VapidKeys;
  subject: string;
  source: 'env' | 'file' | 'generated';
}

export interface VapidOptions {
  env: Record<string, string | undefined>;
  cacheDir: string | null;
}

export const VAPID_FILE = 'vapid.json';
export const DEFAULT_VAPID_SUBJECT = 'https://labs.johnjayasankar.com/';

const FILE_VERSION = 1;
/** The rule vapidHeaders applies to a subject. */
const SUBJECT = /^mailto:[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

function decode(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  const text = value.trim().replace(/=+$/, '');
  return /^[A-Za-z0-9_-]+$/.test(text) ? Buffer.from(text, 'base64url') : null;
}

/** The pair in canonical base64url, or the problem with it: the forms, then whether the public key belongs to the private key. */
function checkPair(publicKey: unknown, privateKey: unknown, names: { publicKey: string; privateKey: string }): { keys: VapidKeys } | { error: string } {
  const pub = decode(publicKey);
  if (!pub || pub.length !== 65 || pub[0] !== 0x04) return { error: `${names.publicKey} must be a 65-byte uncompressed P-256 public key in base64url` };
  const priv = decode(privateKey);
  if (!priv || priv.length !== 32) return { error: `${names.privateKey} must be a 32-byte P-256 private key in base64url` };
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    if (!ecdh.getPublicKey().equals(pub)) return { error: `${names.publicKey} does not belong to ${names.privateKey}` };
  } catch {
    return { error: `${names.privateKey} is not a valid P-256 private key` };
  }
  return { keys: { publicKey: pub.toString('base64url'), privateKey: priv.toString('base64url') } };
}

const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? 'error';

function readKeyFile(file: string): { keys: VapidKeys } | { error: string } | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return code(e) === 'ENOENT' ? null : { error: `${VAPID_FILE} in the cache directory could not be read (${code(e)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed) || parsed.version !== FILE_VERSION) {
    return { error: `${VAPID_FILE} in the cache directory is not a version ${FILE_VERSION} key file. Fix or remove it; new keys stop existing subscriptions` };
  }
  const pair = checkPair(parsed.publicKey, parsed.privateKey, { publicKey: `publicKey in ${VAPID_FILE}`, privateKey: `privateKey in ${VAPID_FILE}` });
  return 'error' in pair ? { error: `${pair.error}. Fix or remove the file; new keys stop existing subscriptions` } : pair;
}

/**
 * Publishes a complete key file atomically: written and synced under a temporary name, then hard-linked to the
 * real name, which fails if another process got there first. Returns 'exists' in that case.
 */
function writeKeyFile(file: string, keys: VapidKeys): 'written' | 'exists' {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const body = `${JSON.stringify({ version: FILE_VERSION, publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: new Date().toISOString() }, null, 2)}\n`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temp, file);
    return 'written';
  } catch (e) {
    if (code(e) === 'EEXIST') return 'exists';
    throw e;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Keys and subject the sender will accept, or the first problem found. */
export function loadVapid(options: VapidOptions): LoadedVapid | { error: string } {
  const { env, cacheDir } = options;
  const subject = env.GRIDIRON_VAPID_SUBJECT?.trim() || DEFAULT_VAPID_SUBJECT;
  if (!SUBJECT.test(subject) && !(/^https:\/\/\S+$/.test(subject) && URL.canParse(subject))) {
    return { error: 'GRIDIRON_VAPID_SUBJECT must be an https: URL or a mailto: address' };
  }
  const finish = (keys: VapidKeys, source: LoadedVapid['source']): LoadedVapid | { error: string } => {
    try {
      // Everything a push request will need, checked once now rather than on the first alert.
      vapidHeaders('https://fcm.googleapis.com/', keys, subject);
    } catch (e) {
      return { error: (e as Error).message };
    }
    return { keys, subject, source };
  };

  const envPublic = env.GRIDIRON_VAPID_PUBLIC_KEY?.trim();
  const envPrivate = env.GRIDIRON_VAPID_PRIVATE_KEY?.trim();
  if (envPublic || envPrivate) {
    if (!envPublic || !envPrivate) return { error: 'Set both GRIDIRON_VAPID_PUBLIC_KEY and GRIDIRON_VAPID_PRIVATE_KEY, or neither' };
    const pair = checkPair(envPublic, envPrivate, { publicKey: 'GRIDIRON_VAPID_PUBLIC_KEY', privateKey: 'GRIDIRON_VAPID_PRIVATE_KEY' });
    return 'error' in pair ? pair : finish(pair.keys, 'env');
  }

  if (!cacheDir) {
    return { error: 'Push alerts need VAPID keys: set GRIDIRON_VAPID_PUBLIC_KEY and GRIDIRON_VAPID_PRIVATE_KEY, or keep the cache directory on so keys can be generated' };
  }
  const file = join(cacheDir, VAPID_FILE);
  const saved = readKeyFile(file);
  if (saved) return 'error' in saved ? saved : finish(saved.keys, 'file');

  const generated = generateVapidKeys();
  try {
    if (writeKeyFile(file, generated) === 'written') return finish(generated, 'generated');
  } catch (e) {
    return { error: `Generated VAPID keys could not be saved in the cache directory (${code(e)})` };
  }
  // Another process wrote the file first: use its keys, so every process signs with the same pair.
  const raced = readKeyFile(file);
  if (!raced) return { error: `${VAPID_FILE} in the cache directory disappeared while it was being created` };
  return 'error' in raced ? raced : finish(raced.keys, 'file');
}
