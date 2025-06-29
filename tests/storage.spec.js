const path = require('path')
const fs = require('fs-extra')
const assert = require('assert/strict')
const fixture = require('./fixtures/test-002.json')
const Storage = require('../src/Storage')

describe('storage', () => {
  // construction
  context('using flat files on initially empty store', () => {
    const dir = path.join(__dirname, 'test-storage')
    after(() => {
      fs.rmSync(dir, { recursive: true })
    })
    let storage
    it('should correctly create an empty directory, when nothing exists', () => {
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
        const filePath = path.join(storage._dir, Storage._md5(key))

        // simulate external creation
        await fs.writeJson(filePath, value1)
        await new Promise(resolve => setTimeout(resolve, 50)) // let watcher pick it up
        let fetched = await storage.getItem(key)
        assert.deepEqual(fetched, 'first')

        // simulate external modification
        await fs.writeJson(filePath, value2)
        await new Promise(resolve => setTimeout(resolve, 50))
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
      it('should not complain when an non-existent item is removed', async () => {
        await storage.removeItem('item2')
      })
      it('should clear the entire storage', async () => {
        await storage.clear()
        const keys = storage.keys()
        assert.deepEqual(keys, [])
      })
    })
  })

  context(
    'using nested files on initially empty store with multiple instances',
    () => {
      const dir = path.join(__dirname, 'test-storage')
      after(() => {
        fs.rmSync(dir, { recursive: true })
      })
      let storage1
      let storage2
      it('should return the same instance for the same directory', () => {
        const dir = path.join(__dirname, 'test-storage')
        storage1 = new Storage({ dir })
        storage2 = new Storage({ dir })
        assert.strictEqual(storage1, storage2)
        assert.equal(fs.accessSync(dir), undefined)
      })
      it('should support writing items in folder structures', async () => {
        await storage1.setItem('item1', { item1: 'item1' }, { folder: 'test1' })
        await storage2.setItem('item2', { item2: 'item2' })
        await storage1.setItem('item3', { item3: 'item3' }, { folder: 'test2' })
        await storage2.setItem(
          'item4',
          { item4: 'item4' },
          { folder: 'test1/test2' }
        )
      })
      it('should properly read items in folder structures', async () => {
        const item1 = await storage2.getItem('item1')
        assert.deepEqual(item1, { item1: 'item1' })
        const item2 = await storage1.getItem('item2')
        assert.deepEqual(item2, { item2: 'item2' })
        const item3 = await storage2.getItem('item3')
        assert.deepEqual(item3, { item3: 'item3' })
        const item4 = await storage1.getItem('item4')
        assert.deepEqual(item4, { item4: 'item4' })
      })
      it('should properly remove items', async () => {
        await storage1.removeItem('item3')
        const item = await storage2.getItem('item3')
        assert.equal(item, null)
      })
      it('should clear the entire storage', async () => {
        await storage1.clear()
        const keys = storage2.keys()
        assert.deepEqual(keys, [])
      })
    }
  )

  context('construction on non-empty store', () => {
    let storage
    it('should not overwrite information when already existing', () => {
      const dir = path.join(__dirname, 'fixtures/existing-storage')
      assert.equal(fs.accessSync(dir), undefined)
      storage = new Storage({ dir })
    })
    it('should report to have two keys', () => {
      const keys = storage.keys()
      assert.deepEqual(keys, ['test-002', 'test-001'])
    })
    it('should not fail on broken items', async () => {
      const item = await storage.getItem('broken')
      assert.equal(item, null)
    })
    it('should properly read intact item', async () => {
      const item = await storage.getItem('test-001')
      assert.deepEqual(item, { simple: 'json' })
    })
  })
})
