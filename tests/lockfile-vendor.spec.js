// tests/lockfile-vendor.spec.js
//
// Regression tests for the vendored proper-lockfile patch: the keepalive
// timer must survive a lock release racing its in-flight fs callbacks, and
// two locks on the same file with different lockfilePath options must not
// clobber each other's registry entries.
const path = require('path')
const fs = require('fs-extra')
const gracefulFs = require('graceful-fs')
const lockfile = require('../src/vendor/proper-lockfile')
const Storage = require('../src/Storage')
const { OWNER_LOCK } = require('../src/constants')

/** Silent logger to keep Jest output free of expected warnings. */
const silentLog = { info () {}, warn () {}, error () {} }

/**
 * Polls an async predicate until it returns true or the timeout is reached.
 */
async function waitFor (predicate, timeout = 3000, interval = 50) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  return false
}

describe('vendored proper-lockfile keepalive', () => {
  const dir = path.join(__dirname, 'test-lockfile-vendor')
  const uncaught = []
  const onUncaught = err => uncaught.push(err)

  beforeAll(() => {
    fs.mkdirpSync(dir)
    process.on('uncaughtException', onUncaught)
  })

  afterAll(async () => {
    process.removeListener('uncaughtException', onUncaught)
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  afterEach(() => {
    // Every test must leave the process free of async time bombs
    expect(uncaught).toEqual([])
  })

  it('ignores a keepalive stat that lands after the lock was released', async () => {
    // Deterministic race: an injected fs delays EXECUTION of stat calls
    // while `hold` is set, so the keepalive's stat provably runs after
    // release() removed the lockfile - the exact production race.
    let hold = null
    let statHeld
    const heldPromise = new Promise(resolve => { statHeld = resolve })
    const slowFs = {
      ...gracefulFs,
      stat (p, cb) {
        const run = () => gracefulFs.stat(p, cb)
        if (hold) {
          statHeld()
          hold.then(run)
        } else {
          run()
        }
      }
    }

    const onCompromised = jest.fn()
    const lockfilePath = path.join(dir, '.race-lock')
    const release = await lockfile.lock(dir, {
      lockfilePath,
      stale: 2000, // -> keepalive update interval: 1000ms
      fs: slowFs,
      onCompromised
    })

    // Arm the trap AFTER acquisition (the probe during acquire also stats)
    let releaseHold
    hold = new Promise(resolve => { releaseHold = resolve })

    // Wait for the keepalive to fire its stat ...
    await heldPromise
    // ... release the lock while that stat is pending ...
    await release()
    expect(fs.existsSync(lockfilePath)).toBe(false)
    // ... then let the stat run: it hits ENOENT on the removed lockfile
    releaseHold()
    await new Promise(resolve => setTimeout(resolve, 200))

    // A released lock's missing lockfile is not a compromise
    expect(onCompromised).not.toHaveBeenCalled()
  })

  it('keeps two locks with distinct lockfilePaths independent (op/owner collision)', async () => {
    const ownerPath = path.join(dir, '.collision-owner')
    const opPath = path.join(dir, '.collision-op')
    const ownerCompromised = jest.fn()

    // Same locked file, two lockfile paths - mirrors Storage's OWNER_LOCK
    // held for the lifetime while OP_LOCKs come and go
    const releaseOwner = await lockfile.lock(dir, {
      lockfilePath: ownerPath,
      stale: 2000,
      onCompromised: ownerCompromised
    })
    const releaseOp = await lockfile.lock(dir, {
      lockfilePath: opPath,
      stale: 2000,
      onCompromised: () => {}
    })
    await releaseOp()

    // Unpatched, releasing the op lock deleted the shared registry entry:
    // the owner keepalive then crashed (uncaught TypeError) and the owner
    // lockfile went stale. Patched, it must keep refreshing.
    const mtimeBefore = fs.statSync(ownerPath).mtime.getTime()
    const refreshed = await waitFor(
      () => fs.statSync(ownerPath).mtime.getTime() > mtimeBefore,
      4000,
      200
    )

    expect(refreshed).toBe(true) // exclusivity survives op-lock cycles
    expect(ownerCompromised).not.toHaveBeenCalled()

    await releaseOwner()
  })

  it('still reports a genuinely compromised lock', async () => {
    const lockfilePath = path.join(dir, '.doomed-lock')
    const onCompromised = jest.fn()

    await lockfile.lock(dir, {
      lockfilePath,
      stale: 2000,
      onCompromised
    })

    // Destroy the lockfile while the lock is HELD (not released)
    fs.rmSync(lockfilePath, { recursive: true, force: true })

    // The next keepalive cycle must flag the compromise
    const flagged = await waitFor(() => onCompromised.mock.calls.length > 0, 4000)
    expect(flagged).toBe(true)
    expect(onCompromised).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ECOMPROMISED' })
    )
  })

  it('dispose() removes the ownership lockfile after op-lock cycles', async () => {
    // Storage-level regression: unpatched, the registry collision made the
    // owner release fail with ENOTACQUIRED (swallowed), leaving a stale
    // OWNER_LOCK directory on disk
    const storage = await Storage.open({ dir, log: silentLog, exclusive: true })
    await storage.clear() // takes and releases an OP_LOCK on the same dir
    await storage.dispose()

    expect(fs.existsSync(path.join(dir, OWNER_LOCK))).toBe(false)
  })
})
