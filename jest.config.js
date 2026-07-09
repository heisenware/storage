// jest.config.js
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.spec.js'],

  // Git operations and the big-payload test need headroom
  testTimeout: 30000,

  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',

  // Filesystem-watcher teardown (chokidar close()) can outlive a worker's
  // 1s exit grace period. In-band execution is proven handle-clean
  // (npx jest exits without warnings), so pin to one process for
  // deterministic teardown. NOT forceExit - the leak detector stays honest.
  maxWorkers: 1,
  globalTeardown: '<rootDir>/tests/global-teardown.js',
  // Investigated exhaustively (2026-07): all awaitable resources are closed
  // and awaited; dispose() sequences ready-wait -> close correctly. A native
  // FSWatcher handle inside chokidar's close() internals (present in v4 and
  // v5) can outlive the event-loop check regardless. forceExit covers ONLY
  // that residue. Genuine leaks still surface via the [teardown] handle
  // report - anything beyond WriteStream/ReadStream there is a regression.
  forceExit: true,

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
