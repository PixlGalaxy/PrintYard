import argon2 from 'argon2';
import { z } from 'zod';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`);

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/** Burns the same time as a real verify, so unknown usernames cannot be told apart by latency. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('printyard-timing-equaliser');
  await verifyPassword(await dummyHash, password);
}
