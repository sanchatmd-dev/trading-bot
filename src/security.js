import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const hashToken = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const randomId = () => crypto.randomUUID();

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) throw new Error('Password must contain at least 10 characters');
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [method, saltHex, hashHex] = String(stored).split(':');
  if (method !== 'scrypt' || !saltHex || !hashHex) return false;
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const keyFrom = master => /^[a-fA-F0-9]{64}$/.test(master)
  ? Buffer.from(master, 'hex') : crypto.createHash('sha256').update(master).digest();

export function encryptJson(value, master) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(master), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptJson(value, master) {
  const [version, iv, tag, ciphertext] = String(value).split('.');
  if (version !== 'v1') throw new Error('Unsupported encrypted credential format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(master), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}
