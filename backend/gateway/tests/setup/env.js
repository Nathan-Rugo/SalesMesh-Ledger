// Per-worker environment shared by every test file (runs before the test framework).
process.env.TZ = 'Africa/Nairobi';
process.env.NODE_ENV = 'test';
process.env.PII_HMAC_KEY = process.env.PII_HMAC_KEY || 'test-pii-hmac-key-0123456789abcdef0123456789';
