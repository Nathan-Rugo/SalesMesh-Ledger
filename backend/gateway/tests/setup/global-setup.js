module.exports = async () => {
  process.env.TZ = 'Africa/Nairobi';
  // One throwaway RS256 key for the whole run (workers inherit the env): generating a 2048-bit
  // key per test file costs CPU that starves the timing-sensitive integration suites.
  if (!process.env.JWT_PRIVATE_KEY) {
    const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
    process.env.JWT_KEY_ID = 'test-k1';
  }
};
