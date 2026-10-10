/**
 * @file keys-generate.ts
 * @description Dev helper: generate an RS256 key pair with a key id for the access-token key ring.
 *
 *   cd backend/gateway && npm run build && npm run keys:generate -- --kid dev-1 [--out keys] [--bits 3072]
 *
 * Writes <out>/jwt-<kid>.key.pem (private, mode 600) and <out>/jwt-<kid>.pub.pem, relative to the
 * current directory (backend/gateway), and prints the .env lines. Without --kid a dated random kid
 * is used. The keys/ directory is git-ignored. Production keys belong in a secret store.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { MIN_RSA_BITS } from '../config/jwt';

export function generateKeyPair(
  bits: number,
  now = new Date(),
  kidOverride?: string
): { kid: string; privatePem: string; publicPem: string } {
  if (!Number.isInteger(bits) || bits < MIN_RSA_BITS) throw new Error(`--bits must be at least ${MIN_RSA_BITS}`);
  if (kidOverride !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(kidOverride)) {
    throw new Error('--kid must be 1-64 of A-Z a-z 0-9 . _ -');
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const kid = kidOverride ?? `k${now.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  return {
    kid,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  let out = 'keys';
  let bits = 3072;
  let kidArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i] ?? out;
    else if (argv[i] === '--bits') bits = parseInt(argv[++i] ?? '', 10);
    else if (argv[i] === '--kid') kidArg = argv[++i] ?? '';
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const { kid, privatePem, publicPem } = generateKeyPair(bits, new Date(), kidArg);
  if (fs.existsSync(path.join(out, `jwt-${kid}.key.pem`))) throw new Error(`keys for kid ${kid} already exist in ${out}`);
  fs.mkdirSync(out, { recursive: true });
  const keyFile = path.join(out, `jwt-${kid}.key.pem`);
  const pubFile = path.join(out, `jwt-${kid}.pub.pem`);
  fs.writeFileSync(keyFile, privatePem, { mode: 0o600 });
  fs.writeFileSync(pubFile, publicPem);
  console.log(`Generated a ${bits}-bit RS256 key pair, kid ${kid}.`);
  console.log('Add to .env:');
  console.log(`  JWT_PRIVATE_KEY_FILE=${keyFile.replace(/\\/g, '/')}`);
  console.log(`  JWT_KEY_ID=${kid}`);
  console.log('When rotating, move the old public key to JWT_PREVIOUS_PUBLIC_KEY_FILE / JWT_PREVIOUS_KEY_ID.');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`keys:generate: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
