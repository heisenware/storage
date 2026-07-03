// tests/storage.spec.js
const path = require('path')
const fs = require('fs-extra')
const assert = require('assert/strict')
const fixture = require('./fixtures/test-002.json')
const Storage = require('../src/Storage')

describe('Storage v2', () => {
  // =========================================================================
  // CORE STORAGE & FILESYSTEM OPERATIONS
  // =========================================================================
  context('using flat files on initially empty store', () => {
    const dir = path.join(__dirname, 'test-storage-flat')
    after(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    let storage

    it('should correctly create an empty directory when nothing exists', () => {
      assert.throws(() => fs.accessSync(dir))
      storage = new Storage({ dir })
      assert.equal(fs.accessSync(dir), undefined)
    })

    it('should report to have no keys', () => {
      const keys = storage.keys()
      assert.deepEqual(keys, [])
    })

    context('read / write items', () => {
      it('should not read a non-existing item', async () => {
        const item = await storage.getItem('not-there')
        assert.equal(item, null)
      })

      it('should reject invalid keys (path traversal protection)', async () => {
        await assert.rejects(
          async () => await storage.setItem('../evil-key', { hack: true }),
          /Invalid key/
        )
      })

      it('should properly write a single item', async () => {
        await storage.setItem('item1', { just: 'a test of item1' })
      })

      it('should read the just created item', async () => {
        const item = await storage.getItem('item1')
        assert.deepEqual(item, { just: 'a test of item1' })
      })

      it('should store and retrieve a 50MB item', async () => {
        const bigPayload = { data: 'x'.repeat(50 * 1024 * 1024) } // ~50MB string
        await storage.setItem('big-item', bigPayload)
        const readBack = await storage.getItem('big-item')
        assert.deepEqual(readBack, bigPayload)
      })

      it('should detect external file changes via chokidar watcher', async () => {
        const key = 'watched-key'
        const value1 = { key, value: 'first' }
        const value2 = { key, value: 'updated' }

        // V2 Path logic: keys are directly mapped to key.json
        const fileName = Storage._sanitizeKey(key)
        const filePath = path.join(storage._dir, fileName)

        // simulate external creation
        await fs.writeJson(filePath, value1)
        await new Promise(resolve => setTimeout(resolve, 100)) // let watcher pick it up
        let fetched = await storage.getItem(key)
        assert.deepEqual(fetched, 'first')

        // simulate external modification
        await fs.writeJson(filePath, value2)
        await new Promise(resolve => setTimeout(resolve, 100))
        fetched = await storage.getItem(key)
        assert.deepEqual(fetched, 'updated')
      })

      it('should properly handle concurrent reads and writes', async () => {
        const contents = Array(100)
          .fill(0)
          .map((x, i) => {
            const copy = JSON.parse(JSON.stringify(fixture))
            copy[0].concurrencyTest = i
            return copy
          })
        const p1 = Promise.all(contents.map(x => storage.setItem('item2', x)))
        const p2 = new Promise(resolve =>
          setTimeout(
            () => storage.setItem('item3', 'survived').then(resolve),
            5
          )
        )
        await Promise.all(
          contents.map(x => async () => {
            const item = await storage.getItem('item2')
            assert(
              item[0].concurrencyTest >= 0 && item[0].concurrencyTest < 100
            )
          })
        )
        await p2
        await p1
        const item3 = await storage.getItem('item3')
        assert.equal(item3, 'survived')
      })

      it('should properly remove items', async () => {
        await storage.removeItem('item2')
        const item = await storage.getItem('item2')
        assert.equal(item, null)
      })

      it('should clear the entire storage', async () => {
        await storage.clear()
        const keys = storage.keys()
        assert.deepEqual(keys, [])
      })

      it('should gracefully reject non-serializable objects (circular references)', async () => {
        const obj = {}
        obj.self = obj // Create circular reference

        await assert.rejects(
          async () => await storage.setItem('circular-item', obj),
          TypeError // Should throw native JSON stringify TypeError
        )

        // Ensure no temp files were left behind
        const files = fs.readdirSync(storage._dir)
        assert.equal(
          files.some(f => f.includes('.tmp')),
          false
        )
      })
    })
  })

  // =========================================================================
  // MULTI-INSTANCE & FOLDER SUPPORT
  // =========================================================================
  context('using nested files with multiple instances', () => {
    const dir = path.join(__dirname, 'test-storage-nested')
    after(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    let storage1, storage2

    it('should return the same instance for the same directory', () => {
      storage1 = new Storage({ dir })
      storage2 = new Storage({ dir })
      assert.strictEqual(storage1, storage2)
    })

    it('should support writing items in folder structures', async () => {
      await storage1.setItem('item1', { item1: 'item1' }, { folder: 'test1' })
      await storage2.setItem('item2', { item2: 'item2' })
      await storage1.setItem('item3', { item3: 'item3' }, { folder: 'test2' })
    })

    it('should properly read items in folder structures', async () => {
      const item1 = await storage2.getItem('item1')
      assert.deepEqual(item1, { item1: 'item1' })

      const item2 = await storage1.getItem('item2')
      assert.deepEqual(item2, { item2: 'item2' })
    })

    it('should clear scoped subfolders without destroying root', async () => {
      await storage1.clear({ folder: 'test1' })
      const item1 = await storage1.getItem('item1')
      const item2 = await storage1.getItem('item2')

      assert.equal(item1, null) // Deleted from subfolder
      assert.deepEqual(item2, { item2: 'item2' }) // Root intact
    })
  })

  // =========================================================================
  // GIT INTEGRATION SUITE
  // =========================================================================
  context('Git version control and branching', () => {
    const dir = path.join(__dirname, 'test-storage-git')
    let storage

    after(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it('should initialize a git repository and respect .gitignore', async () => {
      storage = new Storage({ dir, git: { init: true } })

      // Trigger a status check. This will safely wait until _initRepo resolves!
      await storage.getGitStatus()

      const gitDirExists = fs.existsSync(path.join(dir, '.git'))
      const gitignoreExists = fs.existsSync(path.join(dir, '.gitignore'))

      assert.equal(gitDirExists, true, '.git folder should exist')
      assert.equal(gitignoreExists, true, '.gitignore should exist')
    })

    it('should accurately report git status for new files', async () => {
      await storage.setItem('user-alice', { role: 'admin' })

      const status = await storage.getGitStatus()
      assert.equal(status.isClean, false)
      assert.ok(status.added.includes('user-alice'))
    })

    it('should commit changes and generate auto-messages', async () => {
      const hash = await storage.commit()
      assert.ok(hash, 'Should return a commit hash')

      const status = await storage.getGitStatus()
      assert.equal(status.isClean, true)
    })

    it('should safely switch branches and re-sync memory map', async () => {
      // 1. Create a branch and switch
      await storage.createBranch('feature-branch')
      await storage.checkout('feature-branch')

      // 2. Make a destructive change on the branch
      await storage.setItem('user-bob', { role: 'user' })
      await storage.removeItem('user-alice')
      await storage.commit('chore: swap users')

      // 3. Verify memory state on feature branch
      assert.equal(await storage.getItem('user-alice'), null)
      assert.deepEqual(await storage.getItem('user-bob'), { role: 'user' })

      // 4. Switch back to the enforced default branch
      await storage.checkout('master')

      // 5. Verify memory state reverted correctly
      assert.deepEqual(await storage.getItem('user-alice'), { role: 'admin' })
      assert.equal(await storage.getItem('user-bob'), null)
    })
  })

  context('Git API Guardrails', () => {
    const dir = path.join(__dirname, 'test-storage-no-git')
    after(() => fs.rmSync(dir, { recursive: true, force: true }))

    it('should throw errors if Git API is called when disabled', async () => {
      const plainStorage = new Storage({ dir }) // No git options

      await assert.rejects(
        () => plainStorage.commit(),
        /Git integration is not enabled/
      )
      await assert.rejects(
        () => plainStorage.getGitStatus(),
        /Git integration is not enabled/
      )
      await assert.rejects(
        () => plainStorage.createBranch('test'),
        /Git integration is not enabled/
      )
    })
  })
})
