// tests/storage.spec.js
const path = require('path')
const fs = require('fs-extra')
const fixture = require('./fixtures/test-002.json')
const Storage = require('../src/Storage')

/** Silent logger to keep Jest output free of expected warnings. */
const silentLog = { info () {}, warn () {}, error () {} }

/**
 * Polls an async predicate until it returns true or the timeout is reached.
 * Used to await chokidar watcher events without hard-coded sleeps.
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
// CORE STORAGE & FILESYSTEM OPERATIONS
// ===========================================================================
describe('core operations on an initially empty store', () => {
  const dir = path.join(__dirname, 'test-storage-flat')
  let storage

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates an empty directory when nothing exists', async () => {
    expect(() => fs.accessSync(dir)).toThrow()
    storage = await Storage.open({ dir, log: silentLog })
    expect(fs.accessSync(dir)).toBeUndefined()
  })

  it('reports to have no keys', () => {
    expect(storage.keys()).toEqual([])
  })

  it('returns null for a non-existing item', async () => {
    await expect(storage.getItem('not-there')).resolves.toBeNull()
  })

  it('rejects invalid keys (path traversal protection)', async () => {
    await expect(storage.setItem('../evil-key', { hack: true })).rejects.toThrow(
      /Invalid key/
    )
  })

  it('rejects folder options escaping the root (path traversal protection)', async () => {
    await expect(
      storage.setItem('key', { hack: true }, { folder: '../evil' })
    ).rejects.toThrow(/Security Error/)
  })

  it('writes and reads back a single item', async () => {
    await storage.setItem('item1', { just: 'a test of item1' })
    expect(storage.has('item1')).toBe(true)
    await expect(storage.getItem('item1')).resolves.toEqual({
      just: 'a test of item1'
    })
  })

  it('writes and reads back a complex fixture', async () => {
    await storage.setItem('item-fixture', fixture)
    await expect(storage.getItem('item-fixture')).resolves.toEqual(fixture)
  })

  it(
    'stores and retrieves a 50MB item',
    async () => {
      const bigPayload = { data: 'x'.repeat(50 * 1024 * 1024) } // ~50MB string
      await storage.setItem('big-item', bigPayload)
      await expect(storage.getItem('big-item')).resolves.toEqual(bigPayload)
    },
    60000
  )

  it('detects external file changes via the chokidar watcher', async () => {
    const key = 'watched-key'

    // V2 path logic: keys are directly mapped to key.json
    const fileName = Storage._sanitizeKey(key)
    const filePath = path.join(storage._dir, fileName)

    // simulate external creation
    await fs.writeJson(filePath, { key, value: 'first' })
    expect(
      await waitFor(async () => (await storage.getItem(key)) === 'first')
    ).toBe(true)

    // simulate external modification
    await fs.writeJson(filePath, { key, value: 'updated' })
    expect(
      await waitFor(async () => (await storage.getItem(key)) === 'updated')
    ).toBe(true)
  })

  it('serializes concurrent writes on the same key (last write wins)', async () => {
    const writes = Array(100)
      .fill(0)
      .map((_, i) => storage.setItem('item2', { concurrencyTest: i }))

    // A write to a DIFFERENT key must not be blocked by the busy queue above
    const independent = new Promise(resolve =>
      setTimeout(() => storage.setItem('item3', 'survived').then(resolve), 5)
    )

    await Promise.all(writes)
    await independent

    // The per-file queue preserves call order, so the last write wins
    await expect(storage.getItem('item2')).resolves.toEqual({
      concurrencyTest: 99
    })
    await expect(storage.getItem('item3')).resolves.toBe('survived')
  })

  it('gracefully rejects non-serializable objects (circular references)', async () => {
    const obj = {}
    obj.self = obj // create circular reference

    await expect(storage.setItem('circular-item', obj)).rejects.toThrow(
      TypeError
    )

    // Ensure no temp files were left behind
    const files = fs.readdirSync(storage._dir)
    expect(files.some(f => f.includes('.tmp'))).toBe(false)
  })

  it('keeps the queue alive after a failed write on the same key', async () => {
    const obj = {}
    obj.self = obj
    await expect(storage.setItem('item4', obj)).rejects.toThrow(TypeError)

    // The follow-up operation on the very same key must still execute
    await storage.setItem('item4', { healthy: true })
    await expect(storage.getItem('item4')).resolves.toEqual({ healthy: true })
  })

  it('removes items', async () => {
    await storage.removeItem('item2')
    expect(storage.has('item2')).toBe(false)
    await expect(storage.getItem('item2')).resolves.toBeNull()
  })

  it('clears the entire storage', async () => {
    await storage.clear()
    expect(storage.keys()).toEqual([])
  })
})

// ===========================================================================
// MULTI-INSTANCE & FOLDER SUPPORT
// ===========================================================================
describe('folder support and the singleton registry', () => {
  const dir = path.join(__dirname, 'test-storage-nested')
  let storage1, storage2

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns the same instance for the same directory', async () => {
    storage1 = await Storage.open({ dir, log: silentLog })
    storage2 = await Storage.open({ dir, log: silentLog })
    expect(storage1).toBe(storage2)
  })

  it('supports writing items into folder structures', async () => {
    await storage1.setItem('item1', { item1: 'item1' }, { folder: 'test1' })
    await storage2.setItem('item2', { item2: 'item2' })
    await storage1.setItem('item3', { item3: 'item3' }, { folder: 'test2' })
  })

  it('reads items independent of their folder location', async () => {
    await expect(storage2.getItem('item1')).resolves.toEqual({ item1: 'item1' })
    await expect(storage1.getItem('item2')).resolves.toEqual({ item2: 'item2' })
  })

  it('scopes keys() by folder', () => {
    expect(storage1.keys('test1')).toEqual(['item1'])
    expect(storage1.keys('test2')).toEqual(['item3'])
    expect(storage1.keys().sort()).toEqual(['item1', 'item2', 'item3'])
  })

  it('clears scoped subfolders without destroying the root', async () => {
    await storage1.clear({ folder: 'test1' })
    await expect(storage1.getItem('item1')).resolves.toBeNull() // deleted from subfolder
    await expect(storage1.getItem('item2')).resolves.toEqual({ item2: 'item2' }) // root intact
  })
})

// ===========================================================================
// LIFECYCLE: watch OPTION & dispose()
// ===========================================================================
describe('lifecycle management', () => {
  const dir = path.join(__dirname, 'test-storage-lifecycle')

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('does not observe external changes when opened with watch: false', async () => {
    const storage = await Storage.open({ dir, log: silentLog, watch: false })
    expect(storage._watcher).toBeNull()

    // simulate an external write
    const filePath = path.join(dir, Storage._sanitizeKey('external-key'))
    await fs.writeJson(filePath, { key: 'external-key', value: 42 })

    // give a hypothetical watcher ample time, then confirm nothing was picked up
    await new Promise(resolve => setTimeout(resolve, 300))
    await expect(storage.getItem('external-key')).resolves.toBeNull()
  })

  it('picks up on-disk state via the rescan of a re-open', async () => {
    // The reuse path of open() rescans the directory
    const storage = await Storage.open({ dir, log: silentLog, watch: false })
    await expect(storage.getItem('external-key')).resolves.toBe(42)
  })

  it('dispose() de-registers the instance so a fresh one can be created', async () => {
    const before = await Storage.open({ dir, log: silentLog })
    await before.setItem('persistent', { survives: 'disposal' })
    await before.dispose()

    // A new open() must yield a NEW instance (registry was cleaned) ...
    const after = await Storage.open({ dir, log: silentLog })
    expect(after).not.toBe(before)

    // ... while the data on disk is untouched
    await expect(after.getItem('persistent')).resolves.toEqual({
      survives: 'disposal'
    })
  })

  it('static dispose() is a no-op for unknown directories', async () => {
    await expect(Storage.dispose('/tmp/definitely-not-registered')).resolves.toBeUndefined()
  })
})

// ===========================================================================
// V1 -> V2 MIGRATION
// ===========================================================================
describe('migration from v1 (MD5) storage layout', () => {
  const fixtureDir = path.join(__dirname, 'fixtures', 'existing-storage')
  const dir = path.join(__dirname, 'test-storage-migration')

  beforeAll(async () => {
    await fs.copy(fixtureDir, dir)
  })

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('converts legacy MD5 files into key.json files', async () => {
    await Storage.migrateFromV1(dir)
    const storage = await Storage.open({ dir, log: silentLog })

    expect(storage.keys().sort()).toEqual(['test-001', 'test-002'])
    await expect(storage.getItem('test-001')).resolves.toEqual({
      simple: 'json'
    })
    await expect(storage.getItem('test-002')).resolves.toEqual(fixture)
  })

  it('leaves broken and temporary legacy files alone', async () => {
    // The un-parseable fixture files must neither crash the migration
    // nor appear as keys
    const storage = await Storage.open({ dir, log: silentLog })
    expect(storage.has('broken')).toBe(false)
  })

  it('preserves falsy values (0, false, null, empty string) during migration', async () => {
    const falsyDir = path.join(__dirname, 'test-storage-migration-falsy')
    try {
      await fs.mkdirp(falsyDir)
      // V1 files have no file extension
      await fs.writeJson(path.join(falsyDir, 'aaa0'), { key: 'zero', value: 0 })
      await fs.writeJson(path.join(falsyDir, 'aaa1'), {
        key: 'no',
        value: false
      })
      await fs.writeJson(path.join(falsyDir, 'aaa2'), {
        key: 'empty',
        value: ''
      })

      await Storage.migrateFromV1(falsyDir)
      const storage = await Storage.open({ dir: falsyDir, log: silentLog })

      expect(storage.keys().sort()).toEqual(['empty', 'no', 'zero'])
      await expect(storage.getItem('zero')).resolves.toBe(0)
      await expect(storage.getItem('no')).resolves.toBe(false)
      await expect(storage.getItem('empty')).resolves.toBe('')
    } finally {
      await Storage.dispose(falsyDir)
      fs.rmSync(falsyDir, { recursive: true, force: true })
    }
  })
})
