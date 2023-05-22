const {
  mkdirSync,
  renameSync,
  unlinkSync,
  lstatSync,
  readdirSync
} = require('fs')
const { writeFile, readFile, unlink, cp } = require('fs/promises')
const { emptyDir } = require('fs-extra')
const path = require('path')
const queue = require('queue')
const crypto = require('crypto')

const TMP_MARKER = 'T'

class Storage {
  static queues = {}
  static files = {}

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
    mkdirSync(dir, { recursive: true })
    Storage.files[dir] = Storage._getDirectoryInfo(dir)[1]
  }

  /**
   * Provides the keys of all items currently available
   *
   * @returns Array of all stored item names
   */
  async keys () {
    const keys = await Promise.all(
      Object.values(Storage.files[this._dir]).map(
        filePath =>
          new Promise(async resolve => {
            try {
              const item = await this._readFile(filePath)
              if (item?.key) resolve(item.key)
              resolve(null)
            } catch (err) {
              resolve(null)
            }
          })
      )
    )
    return keys.filter(x => x !== null)
  }

  info () {
    return Storage._getDirectoryInfo(this._dir)[0]
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
    if (folder !== '') {
      mkdirSync(dirPath, { recursive: true })
    }
    const filePath = path.join(dirPath, md5Key)
    await this._writeFile(filePath, { key, value })
    Storage.files[this._dir][md5Key] = filePath
  }

  /**
   * Asynchronously retrieves an item from the storage
   *
   * @param {String} key The key of the item
   * @returns the value of the requested item
   */
  async getItem (key) {
    const md5Key = Storage._md5(key)
    const filePath = Storage.files[this._dir][md5Key]
    if (!filePath) {
      this._log.warn(`Could not find item with key: ${key}`)
      return null
    }
    const item = await this._readFile(filePath)
    return item?.value ? item.value : null
  }

  /**
   * Asynchronously removes an item from the storage
   *
   * @param {String} key The key of the item
   */
  async removeItem (key) {
    const md5Key = Storage._md5(key)
    const filePath = Storage.files[this._dir][md5Key]
    if (!filePath) {
      this._log.warn(`Could not find item to remove with key: ${key}`)
      return
    }
    await this._deleteFile(filePath)
    delete Storage.files[this._dir][md5Key]
  }

  /**
   * Clears the entire storage
   */
  async clear ({ folder = '' } = {}) {
    const dir = path.join(this._dir, folder)
    await emptyDir(dir, { recursive: true, force: true })
    Storage.files[dir] = Storage._getDirectoryInfo(this._dir)[1]
  }

  async copy (destinationDir, { folder = '' } = {}) {
    const dir = path.join(this._dir, folder)
    return cp(dir, destinationDir, { recursive: true, force: true })
  }

  // private:

  static _md5 (key) {
    return crypto.createHash('md5').update(key).digest('hex')
  }

  static _getDirectoryInfo (filename, files = {}) {
    const stats = lstatSync(filename)
    const tree = {
      id: `${stats.ino}`,
      path: filename,
      name: path.basename(filename),
      modDate: stats.mtime,
      size: stats.size
    }
    if (stats.isDirectory()) {
      tree.isDir = true
      const children = readdirSync(filename)
      tree.childrenCount = children.length
      tree.children = children.map(
        child => Storage._getDirectoryInfo(filename + '/' + child, files)[0]
      )
    } else {
      tree.isDir = false
      tree.isFile = stats.isFile()
      tree.isSymlink = stats.isSymbolicLink()
      if (!tree.name.includes(TMP_MARKER)) {
        files[tree.name] = filename
      } else {
        // TODO think about delete those folks...
      }
    }
    return [tree, files]
  }

  async _writeFile (path, content) {
    const job = async () => {
      try {
        const pathTmp = `${path}${TMP_MARKER}${(Math.random() + 1)
          .toString(36)
          .substring(7)}`
        await writeFile(pathTmp, JSON.stringify(content), { encoding: 'utf-8' })
        renameSync(pathTmp, path)
      } catch (err) {
        this._log.error(`Failed writing file ${path}, because: ${err.message}`)
        unlinkSync(pathTmp)
      }
    }
    return Storage._runQueue(path, job)
  }

  async _readFile (path) {
    const job = async () => {
      try {
        const buffer = await readFile(path, { encoding: 'utf-8' })
        return JSON.parse(buffer)
      } catch (err) {
        this._log.error(`Failed reading file ${path}, because: ${err.message}`)
        return null
      }
    }
    return Storage._runQueue(path, job)
  }

  async _deleteFile (path) {
    const job = async () => {
      try {
        return unlink(path)
      } catch (err) {
        this._log.error(`Failed deleting file ${path}, because: ${err.message}`)
      }
    }
    return Storage._runQueue(path, job)
  }

  static async _runQueue (id, job) {
    let q
    if (Storage.queues[id]) {
      // this._log.info(`Encountered concurrency on path: ${id}`)
      q = Storage.queues[id]
    } else {
      q = queue({ concurrency: 1, autostart: true })
      q.on('end', () => {
        q.removeAllListeners()
        delete Storage.queues[id]
      })
      Storage.queues[id] = q
    }
    const ret = new Promise((resolve, reject) => {
      q.on('success', (result, jobDone) => {
        if (job === jobDone) resolve(result)
      })
      q.on('error', (error, jobDone) => {
        if (job === jobDone) reject(error, jobDone)
      })
    })
    q.push(job)
    return ret
  }
}

module.exports = Storage
