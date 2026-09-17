import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
export const hashToken = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
export const randomId = () => crypto.randomUUID();

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 256) throw new Error('Password must contain 10–256 characters');
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if(typeof password!=='string'||password.length>256)return false;
  const [method, saltHex, hashHex] = String(stored).split(':');
  if (method !== 'scrypt' || !saltHex || !hashHex) return false;
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const keyFrom = master => /^[a-fA-F0-9]{64}$/.test(master)
  ? Buffer.from(master, 'hex') : crypto.createHash('sha256').update(master).digest();

export function encryptJson(value, master, context = '') {
  if(typeof master==='object'){
    const id=master.active, key=master.keys[id];
    if(!key)throw new Error('Active encryption key unavailable');
    const encrypted=encryptJson(value,key,`key:${id}:${context}`);
    return `v3.${id}.${encrypted.split('.').slice(1).join('.')}`;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(master), iv);
  if(context)cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `${context?'v2':'v1'}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptJson(value, master, context = '') {
  if(String(value).startsWith('v3.')){
    const [,id,...parts]=String(value).split('.');
    const key=typeof master==='object'&&master.keys[id];
    if(!key)throw new Error('Encryption key version unavailable');
    return decryptJson('v2.'+parts.join('.'),key,`key:${id}:${context}`);
  }
  if(typeof master==='object')master=master.legacy;
  if(!master)throw new Error('Legacy encryption key unavailable');
  const [version, iv, tag, ciphertext] = String(value).split('.');
  if (!['v1','v2'].includes(version)) throw new Error('Unsupported encrypted credential format');
  if(context&&version==='v1')throw new Error('Legacy credentials must be re-entered to bind them to the account');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(master), Buffer.from(iv, 'base64url'));
  if(version==='v2')decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

export function encryptionKeys(legacy,active='k1',previous='{}'){
  let keys;
  try{keys=JSON.parse(previous);}catch{throw new Error('Invalid ENCRYPTION_PREVIOUS_KEYS');}
  if(!/^[a-zA-Z0-9_-]{1,32}$/.test(active)||!keys||typeof keys!=='object'||Array.isArray(keys))throw new Error('Invalid encryption keyring');
  for(const [id,key] of Object.entries(keys))if(!/^[a-zA-Z0-9_-]{1,32}$/.test(id)||typeof key!=='string'||!/^[a-fA-F0-9]{64}$/.test(key))throw new Error('Invalid previous encryption key');
  if(Object.hasOwn(keys,active)&&keys[active]!==legacy)throw new Error('Active encryption key ID was reused');
  return {active,keys:{...keys,[active]:legacy},legacy};
}
