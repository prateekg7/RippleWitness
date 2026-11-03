import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { join } from "node:path";

/** Local HMAC key. Created once with 0600; never logged (AGENTS A3). */
export function loadOrCreateKey(home: string): Buffer {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "key");
  if (existsSync(path)) return readFileSync(path);
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

export function keyPath(home: string): string {
  return join(home, "key");
}

/**
 * ed25519 signing keypair (M-08). Private key PEM at `signing.key` (0600);
 * public key PEM at `signing.pub` (world-readable: it is the CI trust anchor).
 * Anyone with the private key can mint receipts; the public key verifies only.
 */
export function loadOrCreateSignKey(home: string): { privateKeyPem: string; publicKeyPem: string } {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const priv = join(home, "signing.key");
  const pub = join(home, "signing.pub");
  if (existsSync(priv) && existsSync(pub)) {
    return { privateKeyPem: readFileSync(priv, "utf8"), publicKeyPem: readFileSync(pub, "utf8") };
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  writeFileSync(priv, privateKeyPem, { mode: 0o600 });
  writeFileSync(pub, publicKeyPem);
  return { privateKeyPem, publicKeyPem };
}

export function signKeyPath(home: string): string {
  return join(home, "signing.key");
}

export function signPubPath(home: string): string {
  return join(home, "signing.pub");
}
