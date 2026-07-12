import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '\\.e2e-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '@libs/common/(.*)': '<rootDir>/libs/common/src/$1',
    '@libs/prisma/(.*)': '<rootDir>/libs/prisma/src/$1',
    '@libs/redis/(.*)': '<rootDir>/libs/redis/src/$1',
    '@libs/ledger/(.*)': '<rootDir>/libs/ledger/src/$1',
    '@libs/idempotency/(.*)': '<rootDir>/libs/idempotency/src/$1',
    '@libs/webhooks/(.*)': '<rootDir>/libs/webhooks/src/$1',
    '@libs/common': '<rootDir>/libs/common/src/index.ts',
    '@libs/prisma': '<rootDir>/libs/prisma/src/index.ts',
    '@libs/redis': '<rootDir>/libs/redis/src/index.ts',
    '@libs/ledger': '<rootDir>/libs/ledger/src/index.ts',
    '@libs/idempotency': '<rootDir>/libs/idempotency/src/index.ts',
    '@libs/webhooks': '<rootDir>/libs/webhooks/src/index.ts',
  },
  testTimeout: 60000,
};

export default config;
