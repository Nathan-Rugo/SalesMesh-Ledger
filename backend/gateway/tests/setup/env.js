// Per-worker environment shared by every test file (runs before the test framework).
process.env.TZ = 'Africa/Nairobi';
process.env.NODE_ENV = 'test';
process.env.PII_HMAC_KEY = process.env.PII_HMAC_KEY || 'test-pii-hmac-key-0123456789abcdef0123456789';

// RS256 access-token key ring (spec gh-5): normally set once by global-setup.js; fallback here.
if (!process.env.JWT_PRIVATE_KEY) {
  const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.JWT_KEY_ID = 'test-k1';
}
// Cheap scrypt (allowed only under NODE_ENV=test) and no failed-login latency floor, for speed.
process.env.AUTH_SCRYPT_LOG_N = process.env.AUTH_SCRYPT_LOG_N || '10';
process.env.AUTH_FAILURE_MIN_MS = process.env.AUTH_FAILURE_MIN_MS || '0';
// The production hot-path budget is 150 ms. Under a fully loaded parallel jest run a starved
// worker can exceed it and turn an expected 200 into a 503, so tests use a generous deadline;
// the one test that exercises the deadline itself delays Postgres past this value.
process.env.HOT_PATH_DEADLINE_MS = process.env.HOT_PATH_DEADLINE_MS || '1500';
