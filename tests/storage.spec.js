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

      await storage.getGitStatus() // Wait for init to complete

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
      await storage.createBranch('feature-branch')
      await storage.checkout('feature-branch')

      await storage.setItem('user-bob', { role: 'user' })
      await storage.removeItem('user-alice')
      await storage.commit('chore: swap users')

      assert.equal(await storage.getItem('user-alice'), null)
      assert.deepEqual(await storage.getItem('user-bob'), { role: 'user' })

      await storage.checkout('master')

      assert.deepEqual(await storage.getItem('user-alice'), { role: 'admin' })
      assert.equal(await storage.getItem('user-bob'), null)
    })

    it('should create tags and gracefully rollback without detached HEAD', async () => {
      // 1. We are on 'master'. Create a baseline tag.
      await storage.createTag('v1.0.0', 'Stable baseline')

      // 2. Add some new data and commit it to master
      await storage.setItem('user-charlie', { role: 'guest' })
      await storage.commit('feat: add charlie')

      assert.deepEqual(await storage.getItem('user-charlie'), { role: 'guest' })

      // 3. Rollback to the tag!
      // Because we don't provide a branch, it should smartly move 'master' back to this tag.
      await storage.checkout('v1.0.0')

      // 4. Verify memory state rewound
      assert.equal(
        await storage.getItem('user-charlie'),
        null,
        'Charlie should be gone'
      )

      // 5. Verify we are NOT in detached HEAD, but safely still on master
      const status = await storage.getGitStatus()
      assert.equal(
        status.branch,
        'master',
        'Should safely remain on master branch'
      )
    })

    it('should checkout a tag to an explicitly provided new branch', async () => {
      // 1. Create a new tag where we currently are
      await storage.createTag('v1.0.1')

      // 2. Move forward on master
      await storage.setItem('user-dave', { role: 'admin' })
      await storage.commit('feat: add dave')

      // 3. Checkout the older tag and explicitly attach it to a 'hotfix' branch
      await storage.checkout('v1.0.1', 'hotfix-v1')

      // 4. Verify we are on the new branch
      const status = await storage.getGitStatus()
      assert.equal(
        status.branch,
        'hotfix-v1',
        'Should be on the new explicitly requested branch'
      )

      // 5. Verify memory state reflects the tag, not the future master commit
      assert.equal(
        await storage.getItem('user-dave'),
        null,
        'Dave should not exist in this older tag'
      )
    })

    it('should preserve .git during clear() operations', async () => {
      await storage.clear()

      const gitDirExists = fs.existsSync(path.join(dir, '.git'))
      assert.equal(gitDirExists, true, '.git must survive clear()')

      const keys = storage.keys()
      assert.deepEqual(keys, [])
    })
  })
})
