// tests/locking.spec.js
const path = require('path')
const fs = require('fs-extra')
const { spawnSync } = require('child_process')
const lockfile = require('../src/vendor/proper-lockfile')
const Storage = require('../src/Storage')
const { OP_LOCK } = require('../src/constants')

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

// ===========================================================================
// CONSTRUCTION STORY
// ===========================================================================
describe('construction via Storage.open()', () => {
  const dir = path.join(__dirname, 'test-storage-open')

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('throws on direct construction and points at open()', () => {
    expect(() => new Storage({ dir })).toThrow(/Storage\.open/)
  })

  it('returns the same, resynced instance on repeated open()', async () => {
    const a = await Storage.open({ dir, log: silentLog })
    const b = await Storage.open({ dir, log: silentLog })
    expect(a).toBe(b)
  })

  it('resolves only when the instance is fully ready (git initialized)', async () => {
    await Storage.dispose(dir)
    const storage = await Storage.open({
      dir,
      log: silentLog,
      git: { init: true }
    })
    // No "wait for init" dance needed: the repository already exists
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true)
    expect(storage.has('anything')).toBe(false)
  })

  it('warns on differing git options during reuse instead of applying them', async () => {
    const warnings = []
    const collectingLog = { ...silentLog, warn: msg => warnings.push(msg) }

    await Storage.open({
      dir,
      log: collectingLog,
      git: { init: true, ignore: ['other/'] }
    })

    expect(warnings.some(w => /differing git options/.test(w))).toBe(true)
  })
})

// ===========================================================================
// CROSS-PROCESS OPERATION LOCK
// ===========================================================================
describe('cross-process operation lock', () => {
  const dir = path.join(__dirname, 'test-storage-oplock')
  let storage

  beforeAll(async () => {
    storage = await Storage.open({ dir, log: silentLog, git: { init: true } })
  })

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('lists the lock directories in .gitignore', () => {
    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.storage.lock/')
    expect(gitignore).toContain('.storage-owner.lock/')
  })

  it('makes commit() wait for a competing lock holder instead of failing', async () => {
    // Simulate another process holding the operation lock
    const release = await lockfile.lock(dir, {
      lockfilePath: path.join(dir, OP_LOCK)
    })

    await storage.setItem('contended', { v: 1 })

    const started = Date.now()
    const commitPromise = storage.commit('feat: contended commit')

    // Release the foreign lock after 300ms - commit must wait, then succeed
    setTimeout(() => release(), 300)

    const hash = await commitPromise
    expect(hash).toBeTruthy()
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  it('pauses the watcher while a FOREIGN lock exists and resyncs afterwards', async () => {
    // A foreign process (simulated) takes the lock ...
    const release = await lockfile.lock(dir, {
      lockfilePath: path.join(dir, OP_LOCK)
    })

    // ... our watcher notices and raises the internal git lock
    expect(await waitFor(() => storage._gitLock === true)).toBe(true)

    // The foreign process mutates the working tree outside our API
    const filePath = path.join(dir, Storage._sanitizeKey('foreign-item'))
    await fs.writeJson(filePath, { key: 'foreign-item', value: 'from-afar' })

    // Lock disappears -> watcher resyncs and lifts the pause
    await release()
    expect(await waitFor(() => storage._gitLock === false)).toBe(true)
    expect(await waitFor(() => storage.has('foreign-item'))).toBe(true)
    await expect(storage.getItem('foreign-item')).resolves.toBe('from-afar')
  })
})

// ===========================================================================
// EXCLUSIVE OWNERSHIP
// ===========================================================================
describe('exclusive cross-process ownership', () => {
  const dir = path.join(__dirname, 'test-storage-exclusive')

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a second PROCESS while we hold exclusive ownership', async () => {
    const storage = await Storage.open({
      dir,
      log: silentLog,
      exclusive: true
    })
    expect(storage._ownerRelease).toBeTruthy()

    // A real second process tries to claim the same directory
    const script = `
      const Storage = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'Storage.js'))})
      Storage.open({ dir: ${JSON.stringify(dir)}, watch: false, exclusive: true })
        .then(() => { console.log('ACQUIRED'); process.exit(0) })
        .catch(() => { console.log('REJECTED'); process.exit(3) })
    `
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf-8',
      timeout: 15000
    })

    expect(result.stdout).toContain('REJECTED')
    expect(result.status).toBe(3)
  })

  it('is idempotent for the holding instance', async () => {
    // Re-opening exclusively from the same process is a no-op, not an error
    const again = await Storage.open({ dir, log: silentLog, exclusive: true })
    expect(again._ownerRelease).toBeTruthy()
  })

  it('releases ownership on dispose() so others can claim it', async () => {
    await Storage.dispose(dir)

    const script = `
      const Storage = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'Storage.js'))})
      Storage.open({ dir: ${JSON.stringify(dir)}, watch: false, exclusive: true })
        .then(s => s.dispose())
        .then(() => { console.log('ACQUIRED'); process.exit(0) })
        .catch(() => { console.log('REJECTED'); process.exit(3) })
    `
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf-8',
      timeout: 15000
    })

    expect(result.stdout).toContain('ACQUIRED')
    expect(result.status).toBe(0)
  })
})

// ===========================================================================
// has() & resync()
// ===========================================================================
describe('has() and resync()', () => {
  const dir = path.join(__dirname, 'test-storage-has-resync')
  let storage

  beforeAll(async () => {
    storage = await Storage.open({ dir, log: silentLog, watch: false })
  })

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('distinguishes a stored null from a missing key', async () => {
    await storage.setItem('null-item', null)

    // getItem cannot tell the two apart ...
    await expect(storage.getItem('null-item')).resolves.toBeNull()
    await expect(storage.getItem('missing-item')).resolves.toBeNull()

    // ... has() can
    expect(storage.has('null-item')).toBe(true)
    expect(storage.has('missing-item')).toBe(false)
  })

  it('reflects removals', async () => {
    await storage.removeItem('null-item')
    expect(storage.has('null-item')).toBe(false)
  })

  it('resync() picks up bulk external modifications', async () => {
    // Simulate an archive being unpacked outside the storage API
    const filePath = path.join(dir, Storage._sanitizeKey('unpacked'))
    await fs.writeJson(filePath, { key: 'unpacked', value: { from: 'tar' } })

    expect(storage.has('unpacked')).toBe(false) // watch is off - invisible
    storage.resync()
    expect(storage.has('unpacked')).toBe(true)
    await expect(storage.getItem('unpacked')).resolves.toEqual({ from: 'tar' })
  })
})
