import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import { ValueTransformer } from 'typeorm';

const PREFIX = 'enc:v1:';

function getEncryptionKey() {
  const raw =
    process.env.TOKEN_ENCRYPTION_KEY ||
    process.env.OAUTH_ENCRYPTION_KEY ||
    process.env.CLIENT_SECRET ||
    '';

  if (!raw) return null;
  return createHash('sha256').update(raw).digest();
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

export const encryptedJsonTransformer: ValueTransformer = {
  to(value: unknown) {
    if (value === null || value === undefined) return value as any;

    const key = getEncryptionKey();
    const plain = JSON.stringify(value);
    if (!key) return plain;

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plain, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return `${PREFIX}${iv.toString('base64')}:${tag.toString(
      'base64',
    )}:${encrypted.toString('base64')}`;
  },

  from(value: unknown) {
    if (value === null || value === undefined) return value as any;
    if (typeof value !== 'string') return value as any;

    if (!value.startsWith(PREFIX)) {
      return parseMaybeJson(value) as any;
    }

    const key = getEncryptionKey();
    if (!key) {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY or CLIENT_SECRET is required to decrypt oauth data',
      );
    }

    const payload = value.slice(PREFIX.length);
    const [ivRaw, tagRaw, encryptedRaw] = payload.split(':');
    if (!ivRaw || !tagRaw || !encryptedRaw) {
      throw new Error('Invalid encrypted oauth payload');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivRaw, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    return JSON.parse(decrypted) as any;
  },
};
