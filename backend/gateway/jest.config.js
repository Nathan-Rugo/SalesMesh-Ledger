/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Tests run under TZ=Africa/Nairobi so any local-time leak (EAT, UTC+3) shows up.
  globalSetup: '<rootDir>/tests/setup/global-setup.js',
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
};
