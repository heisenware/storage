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
    it('should report no have no keys', () => {
      assert.deepEqual(storage.keys(), [])
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
        assert.deepEqual(storage.keys(), [])
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
      it('should allow to instantiate two storage instances', () => {
        assert.throws(() => fs.accessSync(dir))
        storage1 = new Storage({ dir })
        storage2 = new Storage({ dir })
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
        assert.deepEqual(storage2.keys(), [])
      })
    }
  )

  context('construction on non-empty store', () => {
    let storage
    it('should not overwrite information when already existing', () => {
      const dir = path.join(__dirname, 'fixtures')
      assert.equal(fs.accessSync(dir), undefined)
      storage = new Storage({ dir })
    })
    it('should report to have three keys', () => {
      assert.deepEqual(storage.keys(), ['broken', 'test-001', 'test-002.json'])
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
