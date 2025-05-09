const fs = require('fs/promises')
const path = require('path')
const crypto = require('crypto')
const { emptyDir } = require('fs-extra')
const queue = require('queue')
const fsSync = require('fs')
const chokidar = require('chokidar')

const TMP_MARKER = '.tmp'

class Storage {
  static _instances = new Set()

  /**
   * Constructs a storage instance for a given directory
   *
   * @param {Object} options
   * @param {String} options.dir absolute path to the directory that should be used for storing JSON files
   * @param {Object} [log=console] any custom logging instance
   */
  constructor ({ dir, log = console }) {
    this._dir = dir
    this._log = log
    this._queues = new Map()
    this._files = new Map()
    this._keyMap = new Map()
    this._modifiedByUs = new Set()
    Storage._instances.add(this)

    try {
      fsSync.mkdirSync(this._dir, { recursive: true })
      this._scanDirectorySync(this._dir)
      this._startWatching()
    } catch (err) {
      this._log.error(`Failed initializing storage directory: ${err.message}`)
      throw err
    }
  }

  /**
   * Provides the keys of all items currently available
   *
   * @param {String} [folder=''] If provided only keys stored within this folder are provided
   * @returns Array of all stored item names
   */
  keys (folder = '') {
    const scopedPath = path.join(this._dir, folder)
    return Array.from(this._keyMap.entries())
      .filter(([_, filePath]) => filePath.startsWith(scopedPath))
      .map(([key]) => key)
  }

  /**
   * Asynchronously stores a new item (key-value pair)
   *
   * @param {String} key The key of the item
   * @param {any} value A JSON stringify- and parsable value to store
   * @param {Object} options
   * @param {String} [folder=''] Optional folder for saving the item
   */
  async setItem (key, value, { folder = '' } = {}) {
    const md5Key = Storage._md5(key)
    const dirPath = path.join(this._dir, folder)
    await fs.mkdir(dirPath, { recursive: true })
    const filePath = path.join(dirPath, md5Key)
    const content = { key, value }
    this._modifiedByUs.add(filePath)
    await this._writeFile(filePath, content)
    this._registerUpdateLocally(key, filePath)
  }

  /**
   * Asynchronously retrieves an item from the storage
   *
   * @param {String} key The key of the item
   * @returns the value of the requested item
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
   * Asynchronously removes an item from the storage
   *
   * @param {String} key The key of the item
   */
  async removeItem (key) {
    const filePath = this._keyMap.get(key)
    if (!filePath) {
      this._log.warn(`Could not find item to remove with key: ${key}`)
      return
    }
    this._modifiedByUs.add(filePath)
    await this._deleteFile(filePath)
    this._registerRemovalLocally(key, filePath)
  }

  /**
   * Clears the entire storage
   */
  async clear ({ folder = '' } = {}) {
    const dir = path.join(this._dir, folder)
    await emptyDir(dir)

    for (const instance of Storage._instances) {
      for (const [key, filePath] of instance._keyMap.entries()) {
        if (filePath.startsWith(dir)) {
          instance._keyMap.delete(key)
          instance._files.delete(Storage._md5(key))
        }
      }
    }
  }

  /**
   * Clears all temporary files
   */
  async cleanTemp () {
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

  // Private

  static _md5 (key) {
    return crypto.createHash('md5').update(key).digest('hex')
  }

  _registerUpdateLocally (key, filePath) {
    for (const instance of Storage._instances) {
      instance._keyMap.set(key, filePath)
      instance._files.set(Storage._md5(key), filePath)
    }
  }

  _registerRemovalLocally (key, filePath) {
    for (const instance of Storage._instances) {
      instance._keyMap.delete(key)
      instance._files.delete(Storage._md5(key))
    }
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
        this._registerUpdateLocally(json.key, filePath)
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
        this._registerRemovalLocally(key, filePath)
        break
      }
    }
  }

  async _writeFile (filePath, content) {
    const q = this._getQueue(filePath)
    return new Promise((resolve, reject) => {
      const job = async () => {
        const tmpPath = `${filePath}${TMP_MARKER}-${Date.now()}`
        try {
          await fs.writeFile(tmpPath, JSON.stringify(content), 'utf-8')
          await fs.rename(tmpPath, filePath)
          resolve()
        } catch (err) {
          this._log.error(`Failed writing ${filePath}: ${err.message}`)
          try {
            await fs.unlink(tmpPath)
          } catch {}
          reject(err)
        }
      }
      q.push(job)
    })
  }

  async _readFile (filePath) {
    const q = this._getQueue(filePath)
    return new Promise((resolve, reject) => {
      const job = async () => {
        try {
          const content = await fs.readFile(filePath, 'utf-8')
          resolve(JSON.parse(content))
        } catch (err) {
          this._log.error(`Failed reading ${filePath}: ${err.message}`)
          resolve(null)
        }
      }
      q.push(job)
    })
  }

  async _deleteFile (filePath) {
    const q = this._getQueue(filePath)
    return new Promise((resolve, reject) => {
      const job = async () => {
        try {
          await fs.unlink(filePath)
          resolve()
        } catch (err) {
          this._log.error(`Failed deleting ${filePath}: ${err.message}`)
          resolve()
        }
      }
      q.push(job)
    })
  }

  _getQueue (id) {
    if (!this._queues.has(id)) {
      const q = queue({ concurrency: 1, autostart: true })
      this._queues.set(id, q)
    }
    return this._queues.get(id)
  }
}

module.exports = Storage
