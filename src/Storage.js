// src/Storage.js
const fs = require('fs/promises')
const path = require('path')
const { emptyDir } = require('fs-extra')
const fsSync = require('fs')
const chokidar = require('chokidar')
const GitManager = require('./GitManager')

const TMP_MARKER = '.tmp'

/**
 * A lightweight, class-based JSON storage module that uses the filesystem for
 * persisting structured key-value data. Designed for atomic writes, cross-instance
 * sync, and Git-backed version control.
 * * @class Storage
 */
class Storage {
  /** @type {Map<string, Storage>} Map of directory paths to singleton Storage instances. */
  static _registry = new Map()

  /** @type {Map<string, Promise>} Map of file paths to their pending write Promises for the async queue. */
  static _pendingWrites = new Map()

  /**
   * Constructs a Storage instance for a given directory.
   * This constructor is idempotent: multiple calls with the same `dir` return the same instance.
   *
   * @param {Object} options - Configuration options.
   * @param {string} options.dir - Absolute path to the storage directory.
   * @param {Object} [options.log=console] - Optional logger object.
   * @param {Object} [options.git={}] - Git integration options (e.g., init, remote, ignore).
   * @param {boolean} [options.watch=true] - Whether to start a file watcher that keeps
   *   the in-memory key map in sync with external filesystem changes. Set to `false`
   *   for write-only targets (e.g., production deployment directories) where no
   *   external modifications are expected, to avoid needless watcher resources.
   * @returns {Storage} Singleton instance for the given directory.
   */
  constructor ({ dir, log = console, git = {}, watch = true }) {
    if (Storage._registry.has(dir)) {
      // Ensure the directory still exists
      fsSync.mkdirSync(dir, { recursive: true })
      const instance = Storage._registry.get(dir)

      // If a watcher exists, detach listeners immediately to ignore
      // any pending/stale events (like race-condition 'unlinks')
      if (instance._watcher) {
        instance._watcher.removeAllListeners()
        // Track the async close so dispose() can await stale watchers too
        instance._staleWatcherCloses.push(
          instance._watcher.close().catch(() => {})
        )
        instance._watcher = null
      }

      instance._keyMap = new Map()
      instance._log = log
      instance._modifiedByUs = new Set()
      instance._gitLock = false
      instance._watch = watch

      instance._scanDirectorySync(dir)
      // Start a fresh watcher for the new state (respecting the current call's flag)
      if (watch) instance._startWatching()
      return instance
    }

    this._dir = dir
    this._log = log

    /** @type {boolean} Whether this instance keeps a filesystem watcher running. */
    this._watch = watch

    /** @type {Map<string, string>} Maps a logical key to its absolute file path on disk. */
    this._keyMap = new Map()

    /** @type {Set<string>} Tracks file paths modified by this instance to prevent chokidar echo loops. */
    this._modifiedByUs = new Set()

    /** @type {boolean} Flag to pause Chokidar processing during rapid disk changes like Git checkouts. */
    this._gitLock = false

    /** @type {Object|null} Chokidar watcher instance, or null when watching is disabled or disposed. */
    this._watcher = null

    /** @type {Promise[]} Close promises of watchers replaced during re-construction, awaited by dispose(). */
    this._staleWatcherCloses = []

    Storage._registry.set(dir, this)

    try {
      fsSync.mkdirSync(this._dir, { recursive: true })
      this._scanDirectorySync(this._dir)
      if (this._watch) this._startWatching()
      this._cleanTemp().catch(err =>
        this._log.warn(`Cleanup failed: ${err.message}`)
      )
      // Ensure we use _gitManager and only instantiate if options are provided
      this._gitManager =
        git && Object.keys(git).length > 0 ? new GitManager(this, git) : null
    } catch (err) {
      this._log.error(`Failed initializing storage directory: ${err.message}`)
      throw err
    }
  }

  /**
   * Sanitizes a key to prevent path traversal and enforce safe filenames.
   *
   * @param {string} key - The raw key.
   * @returns {string} The sanitized filename appended with .json.
   * @throws {Error} If the key contains invalid characters.
   */
  static _sanitizeKey (key) {
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new Error(
        `Invalid key "${key}". Keys must only contain letters, numbers, underscores, and dashes.`
      )
    }
    return `${key}.json`
  }

  /**
   * Sanitizes a folder path to prevent directory traversal attacks.
   *
   * @param {string} folder - The relative folder path.
   * @returns {string} The normalized, safe folder path.
   * @throws {Error} If the path attempts to escape the root directory.
   */
  static _sanitizeFolder (folder) {
    if (!folder) return ''
    const normalized = path.normalize(folder)
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      throw new Error(
        `Security Error: Invalid folder path "${folder}". Cannot escape storage directory.`
      )
    }
    return normalized
  }

  /**
   * Lists all keys currently stored, optionally filtered by a subfolder.
   * This is a synchronous operation served entirely from the in-memory key map.
   *
   * @param {string} [folder=''] - Optional subfolder to scope the key list.
   * @returns {string[]} Array of string keys.
   */
  keys (folder = '') {
    const scopedPath = path.join(this._dir, Storage._sanitizeFolder(folder))
    return Array.from(this._keyMap.entries())
      .filter(([_, filePath]) => filePath.startsWith(scopedPath))
      .map(([key]) => key)
  }

  /**
   * Persists a key-value pair to the filesystem.
   *
   * Concurrency guarantee: writes to the same key are applied strictly in
   * call order (the last caller wins). This holds because the operation is
   * enqueued synchronously - directory creation and serialization happen
   * inside the queued task.
   *
   * @param {string} key - The identifier to store. Must be alphanumeric (plus _ and -).
   * @param {*} value - JSON-serializable value to store.
   * @param {Object} [options]
   * @param {string} [options.folder=''] - Optional folder for scoped storage.
   * @returns {Promise<void>}
   */
  async setItem (key, value, { folder = '' } = {}) {
    const fileName = Storage._sanitizeKey(key)
    const dirPath = path.join(this._dir, Storage._sanitizeFolder(folder))
    const filePath = path.join(dirPath, fileName)
    const content = { key, value }

    this._modifiedByUs.add(filePath)
    await this._writeFile(filePath, content, dirPath)
    this._keyMap.set(key, filePath)
  }

  /**
   * Retrieves a stored item from the filesystem.
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
   * Removes a stored item from the filesystem and memory.
   *
   * @param {string} key - The key to remove.
   * @returns {Promise<void>}
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
  }

  /**
   * Clears all stored data, optionally within a specific subfolder.
   * Safely preserves Git configuration and history if clearing the root.
   *
   * @param {Object} [options]
   * @param {string} [options.folder=''] - Subfolder to clear.
   * @returns {Promise<void>}
   */
  async clear ({ folder = '' } = {}) {
    const targetDir = path.join(this._dir, Storage._sanitizeFolder(folder))

    if (folder === '') {
      // We are clearing the root! DO NOT use emptyDir. We must protect .git.
      const entries = await fs.readdir(this._dir, { withFileTypes: true })
      for (const entry of entries) {
        // Protect Git infrastructure
        if (entry.name === '.git' || entry.name === '.gitignore') continue

        const fullPath = path.join(this._dir, entry.name)
        if (entry.isDirectory()) {
          await fs.rm(fullPath, { recursive: true, force: true })
        } else {
          await fs.unlink(fullPath)
        }
      }
    } else {
      // Clearing a subfolder is safe, as .git only lives at the root
      await emptyDir(targetDir)
    }

    // Clean up the memory map
    for (const [key, filePath] of this._keyMap.entries()) {
      if (filePath.startsWith(targetDir)) {
        this._keyMap.delete(key)
      }
    }
  }

  // =========================================================================
  // --- LIFECYCLE MANAGEMENT ---
  // =========================================================================

  /**
   * Gracefully shuts this instance down and releases all held resources.
   *
   * This is the counterpart to the constructor: it closes the filesystem
   * watcher, waits for all still-pending write/read/delete operations
   * targeting this directory to settle, removes the per-file queue entries
   * from the static bookkeeping, and de-registers the instance from the
   * singleton registry so it can be garbage-collected.
   *
   * Call this when the underlying directory is being deleted (e.g., an
   * application is removed) or when the storage is no longer needed.
   * A subsequent `new Storage({ dir })` for the same directory will create
   * a fresh instance.
   *
   * @returns {Promise<void>}
   */
  async dispose () {
    // 1. Stop observing the filesystem and drop any queued watcher events
    if (this._watcher) {
      this._watcher.removeAllListeners()
      await this._watcher.close().catch(() => {})
      this._watcher = null
    }
    // Also wait for watchers that were replaced during re-constructions
    await Promise.allSettled(this._staleWatcherCloses)
    this._staleWatcherCloses = []

    // 2. Wait for in-flight operations on this directory to settle so that
    //    disposal is a clean shutdown, not a hard cut-off
    const pending = []
    for (const [filePath, promise] of Storage._pendingWrites.entries()) {
      if (filePath.startsWith(this._dir)) pending.push(promise)
    }
    await Promise.allSettled(pending)

    // 3. Remove the (now settled) queue entries to keep the static map bounded
    for (const filePath of Storage._pendingWrites.keys()) {
      if (filePath.startsWith(this._dir)) {
        Storage._pendingWrites.delete(filePath)
      }
    }

    // 4. De-register so the instance becomes collectible and a future
    //    constructor call starts from a clean slate
    Storage._registry.delete(this._dir)
    this._keyMap.clear()
  }

  /**
   * Disposes the Storage instance registered for the given directory, if any.
   * Convenience wrapper around the instance-level {@link Storage#dispose}.
   *
   * @static
   * @param {string} dir - The storage directory whose instance should be disposed.
   * @returns {Promise<void>}
   */
  static async dispose (dir) {
    const instance = Storage._registry.get(dir)
    if (instance) await instance.dispose()
  }

  // =========================================================================
  // --- PUBLIC GIT API (Version Control & Synchronization) ---
  // =========================================================================

  /**
   * Stages all modified storage entries and commits them to the local Git repository.
   * If no message is provided, a smart summary of the changed keys is auto-generated.
   *
   * @param {string} [message] - Optional explicit commit message.
   * @returns {Promise<string|null>} The commit hash, or null if there were no changes to commit.
   */
  async commit (message) {
    if (!this._gitManager) {
      throw new Error(
        'Git integration is not enabled for this Storage instance.'
      )
    }
    return this._gitManager.commit(message)
  }

  /**
   * Retrieves the current version control status of the storage instance.
   * Useful for building UIs that need to highlight modified, added, or deleted keys.
   *
   * @returns {Promise<{ branch: string, isClean: boolean, added: string[], modified: string[], deleted: string[] }>}
   */
  async getGitStatus () {
    if (!this._gitManager) {
      throw new Error(
        'Git integration is not enabled for this Storage instance.'
      )
    }
    return this._gitManager.getStatus()
  }

  /**
   * Creates a new Git branch from the current state and switches to it.
   * * @param {string} branchName - The name of the new branch.
   * @returns {Promise<void>}
   */
  async createBranch (branchName) {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.createBranch(branchName)
  }

  /**
   * Checks out an existing Git branch, tag, or commit. Safely locks file watchers,
   * updates the filesystem, and re-syncs the in-memory key map.
   * Smart Checkout: If the target is a tag or commit, this method automatically
   * attaches the current branch to it, preventing a detached HEAD state.
   *
   * @param {string} branchOrTagName - The target branch, tag, or commit hash.
   * @param {string} [targetBranch] - Optional. Explicitly provide a different branch name to attach to the target.
   * @returns {Promise<void>}
   */
  async checkout (branchOrTagName, targetBranch) {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.checkout(branchOrTagName, targetBranch)
  }

  /**
   * Creates a Git tag at the current state.
   * Useful for snapshotting specific milestones (e.g., 'v1.0.0' or 'backup-2026').
   *
   * @param {string} tagName - The name of the tag to create.
   * @param {string} [message] - Optional message to create an annotated tag.
   * @returns {Promise<void>}
   */
  async createTag (tagName, message) {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.createTag(tagName, message)
  }

  /**
   * Lists all Git tags of the underlying repository.
   * The primary building block for tag-based version histories.
   *
   * @returns {Promise<string[]>} Array of tag names (empty if no tags exist).
   */
  async listTags () {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.listTags()
  }

  /**
   * Deletes a Git tag from the underlying repository.
   * Only the tag reference is removed; the commit history stays intact.
   *
   * @param {string} tagName - The name of the tag to delete.
   * @returns {Promise<void>}
   */
  async deleteTag (tagName) {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.deleteTag(tagName)
  }

  /**
   * Pushes local commits to the configured remote repository (origin).
   *
   * @returns {Promise<void>}
   */
  async push () {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.push()
  }

  /**
   * Pulls remote changes from the configured upstream repository.
   * Safely updates the underlying filesystem and synchronizes memory maps.
   *
   * @returns {Promise<void>}
   */
  async pull () {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.pull()
  }

  // --- Private File & Sync Methods ---

  /**
   * Removes leftover temporary files from previous failed or interrupted writes.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _cleanTemp () {
    const walk = async dir => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          // Do not clean temp files inside the .git directory
          if (entry.name !== '.git') await walk(fullPath)
        } else if (entry.name.includes(TMP_MARKER)) await fs.unlink(fullPath)
      }
    }
    await walk(this._dir)
  }

  /**
   * Synchronously scans a directory and builds the initial memory map of keys to file paths.
   *
   * @private
   * @param {string} dir - The directory to scan.
   */
  _scanDirectorySync (dir) {
    const entries = fsSync.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '.git') {
          this._scanDirectorySync(fullPath)
        }
      } else if (
        !entry.name.includes(TMP_MARKER) &&
        entry.name.endsWith('.json')
      ) {
        try {
          const content = fsSync.readFileSync(fullPath, 'utf-8')
          const json = JSON.parse(content)
          if (json?.key) {
            this._keyMap.set(json.key, fullPath)
          }
        } catch (err) {
          this._log.warn(`Could not parse ${fullPath}: ${err.message}`)
        }
      }
    }
  }

  /**
   * Initializes the Chokidar watcher to keep multiple instances in sync.
   * Not called when the instance was constructed with `watch: false`.
   *
   * @private
   */
  _startWatching () {
    const watcher = chokidar.watch(this._dir, {
      persistent: true,
      ignoreInitial: true,
      ignored: [/(^|[/\\])\../], // Ignores .dotfiles (like .git and .tmp)
      depth: Infinity
    })

    watcher.on('add', filePath => this._handleFileChange(filePath))
    watcher.on('change', filePath => this._handleFileChange(filePath))
    watcher.on('unlink', filePath => this._handleFileRemoval(filePath))

    this._watcher = watcher
  }

  /**
   * Handles inbound file creation/modification events from the watcher.
   *
   * @private
   * @param {string} filePath - Path of the changed file.
   */
  async _handleFileChange (filePath) {
    if (this._gitLock) return // Ignore events during mass file changes (Git checkouts)

    if (this._modifiedByUs.has(filePath)) {
      this._modifiedByUs.delete(filePath)
      return
    }
    if (filePath.includes(TMP_MARKER) || !filePath.endsWith('.json')) return

    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const json = JSON.parse(content)
      if (json?.key) {
        this._keyMap.set(json.key, filePath)
      }
    } catch (err) {
      this._log.warn(`Watcher failed to process ${filePath}: ${err.message}`)
    }
  }

  /**
   * Handles inbound file deletion events from the watcher.
   *
   * @private
   * @param {string} filePath - Path of the removed file.
   */
  _handleFileRemoval (filePath) {
    if (this._gitLock) return // Ignore events during mass file changes (Git checkouts)

    if (this._modifiedByUs.has(filePath)) {
      this._modifiedByUs.delete(filePath)
    }
    for (const [key, path] of this._keyMap.entries()) {
      if (path === filePath) {
        this._keyMap.delete(key)
        break
      }
    }
  }

 /**
   * Queues an atomic write to the filesystem using a temporary marker.
   * The target directory is created inside the queued task so that callers
   * can enqueue synchronously (preserving call order).
   *
   * @private
   * @param {string} filePath - Destination path.
   * @param {Object} content - Payload to stringify.
   * @param {string} [dirPath] - Directory to ensure before writing.
   * @returns {Promise<void>}
   */
  async _writeFile (filePath, content, dirPath) {
    return Storage._enqueue(filePath, async () => {
      if (dirPath) await fs.mkdir(dirPath, { recursive: true })
      const tmpPath = `${filePath}${TMP_MARKER}-${Date.now()}`
      try {
        await fs.writeFile(tmpPath, JSON.stringify(content, null, 2), 'utf-8')
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

  /**
   * Queues a read from the filesystem.
   *
   * @private
   * @param {string} filePath - Path to read.
   * @returns {Promise<Object|null>}
   */
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

  /**
   * Queues a deletion from the filesystem.
   *
   * @private
   * @param {string} filePath - Path to delete.
   * @returns {Promise<void>}
   */
  async _deleteFile (filePath) {
    return Storage._enqueue(filePath, async () => {
      try {
        await fs.unlink(filePath)
      } catch (err) {
        this._log.error(`Failed deleting ${filePath}: ${err.message}`)
      }
    })
  }

  /**
   * Implements a per-file async queue to prevent race conditions when reading/writing.
   *
   * @private
   * @param {string} filePath - Path acting as the concurrency lock.
   * @param {Function} fn - Async operation to execute.
   * @returns {Promise<*>}
   */
  static _enqueue (filePath, fn) {
    // 1. Get the last promise in the queue
    const last = Storage._pendingWrites.get(filePath) || Promise.resolve()

    // 2. The execution promise: chain off the last promise.
    // If the previous queue item failed, we STILL want to execute this one,
    // so we safely catch the previous error before running our function.
    const execute = last.catch(() => { }).then(fn)

    // 3. The queue state: save a promise that will never reject,
    // so the next item in the queue isn't blocked by our failure.
    Storage._pendingWrites.set(
      filePath,
      execute.catch(() => { })
    )

    // 4. Return the raw execution promise to the caller so they get the error!
    return execute
  }

  // --- Utilities ---

  /**
   * Migrates a v1 (MD5) storage directory to v2 (Plain JSON).
   * Usage: `await Storage.migrateFromV1('/tmp/my-store')`
   *
   * Notes on robustness:
   * - Items are identified by the presence of the `value` property, not its
   *   truthiness, so stored values like `0`, `false`, `''`, or `null` survive
   *   the migration.
   * - `.git` directories are skipped defensively, in case a v2 repository
   *   already coexists next to legacy data.
   *
   * @static
   * @param {string} storageDir - The root directory of the storage to migrate.
   * @returns {Promise<void>}
   */
  static async migrateFromV1 (storageDir) {
    const walk = async dir => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          // Never descend into Git infrastructure
          if (entry.name !== '.git') await walk(fullPath)
        } else if (!entry.name.includes('.')) {
          // V1 files lack extensions
          try {
            const content = await fs.readFile(fullPath, 'utf-8')
            const json = JSON.parse(content)
            // Check for property EXISTENCE (not truthiness) so falsy values
            // such as 0, false, '' and null are migrated correctly
            if (json && json.key !== undefined && 'value' in json) {
              const sanitizedKey = Storage._sanitizeKey(json.key)
              const newPath = path.join(dir, sanitizedKey)

              await fs.writeFile(
                newPath,
                JSON.stringify(json, null, 2),
                'utf-8'
              )
              await fs.unlink(fullPath)
            }
          } catch (err) {
            // Ignore un-parseable files
          }
        }
      }
    }
    await walk(storageDir)
  }
}

module.exports = Storage
