const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { emptyDir } = require('fs-extra')
const fsSync = require('fs')
const chokidar = require('chokidar')

const TMP_MARKER = '.tmp'

class Storage {
  // dir -> instance
  static _registry = new Map()
  // filePath -> Promise
  static _pendingWrites = new Map()

  /**
   * Constructs a Storage instance for a given directory.
   * This constructor is idempotent: multiple calls with the same `dir` return the same instance.
   *
   * @param {Object} options
   * @param {string} options.dir - Absolute path to the storage directory.
   * @param {Object} [options.log=console] - Optional logger object.
   * @returns {Storage} Singleton instance for the given directory.
   */
  constructor ({ dir, log = console }) {
    if (Storage._registry.has(dir)) {
      // make sure the directory still exists
      fsSync.mkdirSync(dir, { recursive: true })
      const instance = Storage._registry.get(dir)
      instance._keyMap = new Map()
      instance._files = new Map()
      instance._log = log
      instance._modifiedByUs = new Set()
      instance._scanDirectorySync(dir)
      return instance
    }

    this._dir = dir
    this._log = log

    // key -> md5
    this._keyMap = new Map()
    // md5 -> filePath
    this._files = new Map()
    // filePath
    this._modifiedByUs = new Set()
    // instance registry
    Storage._registry.set(dir, this)

    try {
      fsSync.mkdirSync(this._dir, { recursive: true })
      this._scanDirectorySync(this._dir)
      this._startWatching()
      this._cleanTemp().catch(err =>
        this._log.warn(
          `Failed cleaning temporary files, because: ${err.message}`
        )
      )
    } catch (err) {
      this._log.error(`Failed initializing storage directory: ${err.message}`)
      throw err
    }
  }

  /**
   * Lists all keys currently stored, optionally filtered by a folder.
   *
   * @param {string} [folder=''] - Optional subfolder to scope the key list.
   * @returns {string[]} Array of keys.
   */
  keys (folder = '') {
    const scopedPath = path.join(this._dir, folder)
    return Array.from(this._keyMap.entries())
      .filter(([_, filePath]) => filePath.startsWith(scopedPath))
      .map(([key]) => key)
  }

  /**
   * Persists a key-value pair.
   *
   * @param {string} key - The identifier to store.
   * @param {*} value - JSON-serializable value to store.
   * @param {Object} [options]
   * @param {string} [options.folder=''] - Optional folder for scoped storage.
   */
  async setItem (key, value, { folder = '' } = {}) {
    const md5Key = Storage._md5(key)
    const dirPath = path.join(this._dir, folder)
    await fs.mkdir(dirPath, { recursive: true })
    const filePath = path.join(dirPath, md5Key)
    const content = { key, value }
    this._modifiedByUs.add(filePath)
    await this._writeFile(filePath, content)
    this._keyMap.set(key, filePath)
    this._files.set(Storage._md5(key), filePath)
  }

  /**
   * Retrieves a stored item.
   *
   * @param {string} key - The key to retrieve.
   * @returns {Promise<*>} The stored value or null if not found.
   */
  async getItem (key) {
    const filePath = this._keyMap.get(key)
    if (!filePath) {
      this._log.warn(`Could not find item with key: ${key}`)
      return null
    }
    const item = await this._readFile(filePath)
    return item?.value ?? null
  }

  /**
   * Removes a stored item.
   *
   * @param {string} key - The key to remove.
   */
  async removeItem (key) {
    const filePath = this._keyMap.get(key)
    if (!filePath) {
      this._log.warn(`Could not find item to remove with key: ${key}`)
      return
    }
    this._modifiedByUs.add(filePath)
    await this._deleteFile(filePath)
    this._keyMap.delete(key)
    this._files.delete(Storage._md5(key))
  }

  /**
   * Clears all stored data, optionally within a subfolder.
   *
   * @param {Object} [options]
   * @param {string} [options.folder=''] - Subfolder to clear.
   */
  async clear ({ folder = '' } = {}) {
    const dir = path.join(this._dir, folder)
    await emptyDir(dir)

    for (const [key, filePath] of this._keyMap.entries()) {
      if (filePath.startsWith(dir)) {
        this._keyMap.delete(key)
        this._files.delete(Storage._md5(key))
      }
    }
  }

  /**
   * Copies the contents of the store to another directory.
   *
   * @param {string} destinationDir - The directory to copy to.
   * @param {Object} [options]
   * @param {string} [options.folder=''] - Optional subfolder to copy from.
   * @returns {Promise<void>}
   */
  async copy (destinationDir, { folder = '' } = {}) {
    const dir = path.join(this._dir, folder)
    return fs.cp(dir, destinationDir, { recursive: true })
  }

  // Private

  /**
   * Removes leftover temporary files from previous failed writes.
   *
   * @returns {Promise<void>}
   */
  async _cleanTemp () {
    const walk = async dir => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(fullPath)
        else if (entry.name.includes(TMP_MARKER)) await fs.unlink(fullPath)
      }
    }
    await walk(this._dir)
  }

  static _md5 (key) {
    return crypto.createHash('md5').update(key).digest('hex')
  }

  _scanDirectorySync (dir) {
    const entries = fsSync.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        this._scanDirectorySync(fullPath)
      } else if (!entry.name.includes(TMP_MARKER)) {
        try {
          const content = fsSync.readFileSync(fullPath, 'utf-8')
          const json = JSON.parse(content)
          if (json?.key) {
            this._keyMap.set(json.key, fullPath)
            this._files.set(Storage._md5(json.key), fullPath)
          }
        } catch (err) {
          this._log.warn(`Could not parse ${fullPath}: ${err.message}`)
        }
      }
    }
  }

  _startWatching () {
    const watcher = chokidar.watch(this._dir, {
      persistent: true,
      ignoreInitial: true,
      depth: Infinity
    })

    watcher.on('add', filePath => this._handleFileChange(filePath))
    watcher.on('change', filePath => this._handleFileChange(filePath))
    watcher.on('unlink', filePath => this._handleFileRemoval(filePath))

    this._watcher = watcher
  }

  async _handleFileChange (filePath) {
    if (this._modifiedByUs.has(filePath)) {
      this._modifiedByUs.delete(filePath)
      return
    }
    if (filePath.includes(TMP_MARKER)) return
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const json = JSON.parse(content)
      if (json?.key) {
        this._keyMap.set(json.key, filePath)
        this._files.set(Storage._md5(json.key), filePath)
      }
    } catch (err) {
      this._log.warn(`Watcher failed to process ${filePath}: ${err.message}`)
    }
  }

  _handleFileRemoval (filePath) {
    if (this._modifiedByUs.has(filePath)) {
      this._modifiedByUs.delete(filePath)
    }
    for (const [key, path] of this._keyMap.entries()) {
      if (path === filePath) {
        this._keyMap.delete(key)
        this._files.delete(Storage._md5(key))
        break
      }
    }
  }

  async _writeFile (filePath, content) {
    return Storage._enqueue(filePath, async () => {
      const tmpPath = `${filePath}${TMP_MARKER}-${Date.now()}`
      try {
        await fs.writeFile(tmpPath, JSON.stringify(content), 'utf-8')
        await fs.rename(tmpPath, filePath)
      } catch (err) {
        this._log.error(`Failed writing ${filePath}: ${err.message}`)
        try {
          await fs.unlink(tmpPath)
        } catch {}
        throw err
      }
    })
  }

  async _readFile (filePath) {
    return Storage._enqueue(filePath, async () => {
      try {
        const content = await fs.readFile(filePath, 'utf-8')
        return JSON.parse(content)
      } catch (err) {
        this._log.error(`Failed reading ${filePath}: ${err.message}`)
        return null
      }
    })
  }

  async _deleteFile (filePath) {
    return Storage._enqueue(filePath, async () => {
      try {
        await fs.unlink(filePath)
      } catch (err) {
        this._log.error(`Failed deleting ${filePath}: ${err.message}`)
      }
    })
  }

  static async _enqueue (filePath, fn) {
    const last = Storage._pendingWrites.get(filePath) || Promise.resolve()
    const next = last.then(fn).catch(() => {})
    Storage._pendingWrites.set(filePath, next)
    return next
  }
}

module.exports = Storage
