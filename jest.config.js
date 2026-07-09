// jest.config.js
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.spec.js'],

  // Git operations and the big-payload test need headroom
  testTimeout: 30000,

  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',

  // Ratchet these upwards as coverage grows - CI fails below the thresholds
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 85,
      lines: 85,
      statements: 85
    }
  }
}
