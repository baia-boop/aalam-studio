import 'server-only';

import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

export const ADMIN_SESSION_COOKIE = 'aalam_admin_session';
export const ADMIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

const SCRYPT_KEY_LENGTH = 64;

type AdminAuthConfig = {
  email: string;
  passwordSalt: Buffer;
  passwordHash: Buffer;
  credentialVersion: string;
  sessionSecret: string;
};

export type AdminSession = {
  email: string;
  issuedAt: number;
  expiresAt: number;
};

/**
 * Sign-in throttling deliberately does not live here. An earlier in-module
 * bucket map kept an entry per client address forever, so a caller rotating
 * its address grew it without bound. `RATE_LIMITS.adminLogin` in
 * `src/server/security/rate-limit.ts` does the same job with a bounded memory
 * map and, when Redis is configured, one shared budget across replicas.
 */

function parsePasswordHash(value: string): { salt: Buffer; hash: Buffer } | null {
  const match = /^scrypt\$([\da-f]{32})\$([\da-f]{128})$/i.exec(value);
  if (!match) return null;

  return {
    salt: Buffer.from(match[1], 'hex'),
    hash: Buffer.from(match[2], 'hex'),
  };
}

function getConfig(): AdminAuthConfig | null {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  const sessionSecret = process.env.ADMIN_SESSION_SECRET?.trim();

  if (!email || !passwordHash || !sessionSecret || sessionSecret.length < 32) {
    return null;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const parsedHash = parsePasswordHash(passwordHash);
  if (!parsedHash) return null;

  return {
    email,
    passwordSalt: parsedHash.salt,
    passwordHash: parsedHash.hash,
    credentialVersion: createHash('sha256').update(passwordHash).digest('base64url'),
    sessionSecret,
  };
}

export function isAdminAuthConfigured(): boolean {
  return getConfig() !== null;
}

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_LENGTH, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(key));
    });
  });
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

export async function verifyAdminCredentials(
  email: string,
  password: string
): Promise<boolean> {
  const config = getConfig();
  if (!config) return false;

  const suppliedKey = await derivePasswordKey(password, config.passwordSalt);
  const passwordMatches = timingSafeEqual(suppliedKey, config.passwordHash);
  const emailMatches = timingSafeTextEqual(email.trim().toLowerCase(), config.email);
  return emailMatches && passwordMatches;
}

export function createAdminSessionToken(): string | null {
  const config = getConfig();
  if (!config) return null;

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: config.email,
      cred: config.credentialVersion,
      iat: issuedAt,
      exp: issuedAt + ADMIN_SESSION_MAX_AGE_SECONDS,
      nonce: randomBytes(16).toString('base64url'),
    })
  ).toString('base64url');
  const signature = createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
}

export function verifyAdminSessionToken(token: string | undefined): AdminSession | null {
  const config = getConfig();
  if (!config || !token || token.length > 2048) return null;

  const [payload, suppliedSignature, extra] = token.split('.');
  if (!payload || !suppliedSignature || extra !== undefined) return null;

  const expectedSignature = createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest();
  const signatureBytes = Buffer.from(suppliedSignature, 'base64url');
  if (
    signatureBytes.length !== expectedSignature.length ||
    !timingSafeEqual(signatureBytes, expectedSignature)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      cred?: unknown;
      iat?: unknown;
      exp?: unknown;
      nonce?: unknown;
    };
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = Number(decoded.iat);
    const expiresAt = Number(decoded.exp);

    if (
      decoded.sub !== config.email ||
      decoded.cred !== config.credentialVersion ||
      typeof decoded.nonce !== 'string' ||
      decoded.nonce.length < 16 ||
      !Number.isInteger(issuedAt) ||
      !Number.isInteger(expiresAt) ||
      expiresAt <= issuedAt ||
      issuedAt > now + 60 ||
      expiresAt <= now ||
      expiresAt - issuedAt > ADMIN_SESSION_MAX_AGE_SECONDS
    ) {
      return null;
    }

    return { email: config.email, issuedAt, expiresAt };
  } catch {
    return null;
  }
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const cookieStore = await cookies();
  return verifyAdminSessionToken(cookieStore.get(ADMIN_SESSION_COOKIE)?.value);
}
