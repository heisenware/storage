// src/Storage.js
const fs = require('fs/promises')
const path = require('path')
const { emptyDir } = require('fs-extra')
const fsSync = require('fs')
const chokidar = require('chokidar')
const lockfile = require('proper-lockfile')
const GitManager = require('./GitManager')
const { TMP_MARKER, OP_LOCK, OWNER_LOCK } = require('./constants')

/** Internal capability token: only Storage.open() may construct instances. */
const CONSTRUCT_KEY = Symbol('Storage.construct')

/**
 * A lightweight, class-based JSON storage module that uses the filesystem for
 * persisting structured key-value data. Designed for atomic writes,
 * cross-instance AND cross-process sync, and Git-backed version control.
 *
 * Instances are obtained via the async factory {@link Storage.open}; direct
 * construction throws. One instance exists per directory per process.
 *
 * Multi-process contract:
 * - Data writes are atomic (temp file + rename); ordering is guaranteed
 *   per process (last caller wins), across processes last-rename-wins.
 * - Reads converge across processes via filesystem watchers.
 * - Git mutations and clear() are serialized across processes through an
 *   advisory lock; other processes pause their watchers while the lock is
 *   held and resync afterwards.
 * - `exclusive: true` claims sole ownership of a directory for the
 *   lifetime of the instance.
 *
 * @class Storage
 */
class Storage {
  /** @type {Map<string, Storage>} Map of directory paths to singleton Storage instances. */
  static _registry = new Map()

  /** @type {Map<string, Promise>} Map of file paths to their pending write Promises for the async queue. */
  static _pendingWrites = new Map()

  /**
   * Opens (or re-opens) the storage for a given directory.
   *
   * This is the ONLY way to obtain an instance. The factory owns three
   * distinct jobs that used to be hidden inside the constructor:
   * 1. CREATE: first call for a directory constructs a fresh, fully
   *    initialized instance (directory created, temp files cleaned,
   *    Git repository initialized - everything awaited).
   * 2. GET: subsequent calls return the existing instance.
   * 3. RESYNC: on reuse, the in-memory key map is rebuilt from disk, so
   *    external changes made outside the storage API become visible.
   *
   * On reuse, `log` and `watch` are re-applied when provided; differing
   * `git` options are NOT re-applied and produce a warning instead.
   *
   * @param {Object} options - Configuration options.
   * @param {string} options.dir - Absolute path to the storage directory.
   * @param {Object} [options.log=console] - Optional logger object.
   * @param {Object} [options.git={}] - Git integration options
   *   (e.g., `{ init: true, remote, branch, ignore: [] }`).
   * @param {boolean} [options.watch=true] - Whether to run a filesystem
   *   watcher keeping the key map in sync with external changes. Set to
   *   `false` for write-only targets (e.g., deployment directories).
   * @param {boolean} [options.exclusive=false] - Claim exclusive,
   *   cross-process ownership of the directory. Throws immediately if
   *   another live process already owns it. Released by dispose() or,
   *   after a crash, reclaimed via lock staleness.
   * @returns {Promise<Storage>} Fully initialized singleton instance.
   */
  static async open (options) {
    const { dir } = options
    let instance = Storage._registry.get(dir)

    if (instance) {
      // Ensure the directory still exists (delete/recreate cycles)
      fsSync.mkdirSync(dir, { recursive: true })

      // Re-apply cheap, per-caller options when explicitly provided
      if (options.log) instance._log = options.log
      if ('watch' in options) await instance._setWatching(options.watch)

      // Git options are bound at creation time - warn on divergence
      const requestedGit = JSON.stringify(options.git || {})
      if (requestedGit !== JSON.stringify(instance._gitOptions)) {
        instance._log.warn(
          `Storage.open(${dir}): differing git options ignored - ` +
            'git configuration is bound at first open. ' +
            'dispose() the instance first to re-configure.'
        )
      }

      // Make external on-disk changes visible
      instance.resync()
    } else {
      instance = new Storage(options, CONSTRUCT_KEY)
      Storage._registry.set(dir, instance)

      // A resolved open() means a fully-ready instance: temp cleanup and
      // Git initialization are awaited here, not fire-and-forgotten.
      await instance._ready
      if (instance._gitManager) await instance._gitManager.initPromise
    }

    if (options.exclusive) await instance._acquireOwnerLock()

    return instance
  }

  /**
   * Do not call directly - use {@link Storage.open}.
   *
   * @param {Object} options - See {@link Storage.open}.
   * @param {symbol} constructKey - Internal capability token.
   * @throws {Error} When constructed without the internal token.
   */
  constructor ({ dir, log = console, git = {}, watch = true } = {}, constructKey) {
    if (constructKey !== CONSTRUCT_KEY) {
      throw new Error(
        'Direct construction is not supported. ' +
          'Use `await Storage.open({ dir, ... })` instead.'
      )
    }

    this._dir = dir
    this._log = log

    /** @type {Object} Git options as bound at creation time (for reuse comparison). */
    this._gitOptions = git || {}

    /** @type {boolean} Whether this instance keeps a filesystem watcher running. */
    this._watch = watch

    /** @type {Map<string, string>} Maps a logical key to its absolute file path on disk. */
    this._keyMap = new Map()

    /** @type {Set<string>} Tracks file paths modified by this instance to prevent chokidar echo loops. */
    this._modifiedByUs = new Set()

    /** @type {boolean} Flag to pause Chokidar processing during rapid disk changes like Git checkouts. */
    this._gitLock = false

    /** @type {boolean} True while THIS process holds the cross-process operation lock. */
    this._weHoldOpLock = false

    /** @type {Function|null} Release function of the exclusive ownership lock, if held. */
    this._ownerRelease = null

    /** @type {Object|null} Chokidar watcher instance, or null when watching is disabled or disposed. */
    this._watcher = null

    /** @type {Promise[]} Close promises of watchers replaced during re-configuration, awaited by dispose(). */
    this._staleWatcherCloses = []

    /** @type {NodeJS.Timeout|null} Poll handle verifying a FOREIGN operation lock's release. */
    this._foreignLockPoll = null

    /** @type {boolean} True once dispose() has run - watcher stragglers must not resurrect state. */
    this._disposed = false

    /** @type {Promise|null} Resolves once the watcher's initial scan completed - closing earlier leaks native handles (chokidar). */
    this._watcherReady = null

    try {
      fsSync.mkdirSync(this._dir, { recursive: true })
      this._scanDirectorySync(this._dir)
      if (this._watch) this._startWatching()

      /** @type {Promise} Startup healing, awaited by open(). */
      this._ready = this._cleanTemp().catch(err =>
        this._log.warn(`Cleanup failed: ${err.message}`)
      )

      // Only instantiate Git integration if options are provided
      this._gitManager =
        git && Object.keys(git).length > 0 ? new GitManager(this, git) : null
    } catch (err) {
      Storage._registry.delete(this._dir)
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
   * Checks whether a key exists in the storage. Resolves the classic
   * key-value ambiguity of getItem() returning null for both "missing"
   * and "stored null".
   *
   * @param {string} key - The key to check.
   * @returns {boolean} True if the key exists.
   */
  has (key) {
    return this._keyMap.has(key)
  }

  /**
   * Persists a key-value pair to the filesystem.
   *
   * Concurrency guarantee: writes to the same key are applied strictly in
   * call order - the last caller wins. This holds because the operation is
   * enqueued synchronously; directory creation and serialization happen
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
   * Safely preserves Git configuration, history, and lock infrastructure
   * when clearing the root. Root clears are serialized across processes
   * via the operation lock, since they are mass mutations in the same
   * spirit as Git checkouts.
   *
   * @param {Object} [options]
   * @param {string} [options.folder=''] - Subfolder to clear.
   * @returns {Promise<void>}
   */
  async clear ({ folder = '' } = {}) {
    const targetDir = path.join(this._dir, Storage._sanitizeFolder(folder))

    const wipe = async () => {
      if (folder === '') {
        // We are clearing the root! DO NOT use emptyDir. We must protect
        // .git, .gitignore and the lock directories - i.e. every dot-entry.
        const entries = await fs.readdir(this._dir, { withFileTypes: true })
        for (const entry of entries) {
          // Protect Git and lock infrastructure
          if (entry.name.startsWith('.')) continue

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

    // Root clears take the cross-process lock; subfolder clears stay cheap
    if (folder === '') return this._withOpLock(wipe)
    return wipe()
  }

  /**
   * Rebuilds the in-memory key map from the current on-disk state.
   * Call this after bulk external modifications made outside the storage
   * API (e.g., unpacking an archive into the directory).
   *
   * @returns {void}
   */
  resync () {
    this._keyMap.clear()
    this._scanDirectorySync(this._dir)
  }

  // =========================================================================
  // --- LIFECYCLE MANAGEMENT ---
  // =========================================================================

  /**
   * Gracefully shuts this instance down and releases all held resources.
   *
   * This is the counterpart to open(): it closes the filesystem watcher,
   * waits for all still-pending write/read/delete operations targeting this
   * directory to settle, releases the exclusive ownership lock (if held),
   * removes the per-file queue entries from the static bookkeeping, and
   * de-registers the instance so it can be garbage-collected.
   *
   * Call this when the underlying directory is being deleted (e.g., an
   * application is removed) or when the storage is no longer needed.
   * A subsequent `Storage.open({ dir })` creates a fresh instance.
   *
   * @returns {Promise<void>}
   */
  async dispose () {
    this._disposed = true
    // Stop any foreign-lock verification poll
    if (this._foreignLockPoll) {
      clearInterval(this._foreignLockPoll)
      this._foreignLockPoll = null
    }
    // 1. Stop observing the filesystem and drop any queued watcher events
    if (this._watcher) {
      if (this._watcherReady) await this._watcherReady
      this._watcher.removeAllListeners()
      await this._watcher.close().catch(() => {})
      this._watcher = null
    }
    // Also wait for watchers that were replaced during re-configurations
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

    // 4. Release exclusive ownership, if we hold it
    if (this._ownerRelease) {
      await this._ownerRelease().catch(() => {})
      this._ownerRelease = null
    }

    // 5. De-register so the instance becomes collectible and a future
    //    open() starts from a clean slate
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
   * Stages all modified storage entries and commits them to the local Git
   * repository. If no message is provided, a smart summary of the changed
   * keys is auto-generated. Serialized across processes.
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
   * Serialized across processes.
   *
   * @param {string} branchName - The name of the new branch.
   * @returns {Promise<void>}
   */
  async createBranch (branchName) {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.createBranch(branchName)
  }

  /**
   * Checks out an existing Git branch, tag, or commit. Safely locks file
   * watchers (in THIS and all other processes), updates the filesystem, and
   * re-syncs the in-memory key map.
   * Smart Checkout: If the target is a tag or commit, this method
   * automatically attaches the current branch to it, preventing a detached
   * HEAD state.
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
   * Creates a Git tag at the current state. Serialized across processes.
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
   * Deletes a Git tag from the underlying repository. Serialized across
   * processes. Only the tag reference is removed; the commit history stays
   * intact.
   *
   * @param {string} tagName - The name of the tag to delete.
   * @returns {Promise<void>}
   */
  async deleteTag (tagName) {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.deleteTag(tagName)
  }

  /**
   * Renames a Git tag. Serialized across processes. The tag's target commit
   * is unchanged; only the reference name is replaced.
   *
   * @param {string} oldTagName - The name of the existing tag.
   * @param {string} newTagName - The new name for the tag.
   * @returns {Promise<void>}
   */
  async renameTag (oldTagName, newTagName) {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.renameTag(oldTagName, newTagName)
  }

  /**
   * Pushes local commits to the configured remote repository (origin).
   * Serialized across processes.
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
   * Serialized across processes.
   *
   * @returns {Promise<void>}
   */
  async pull () {
    if (!this._gitManager) throw new Error('Git integration is not enabled.')
    return this._gitManager.pull()
  }

  // =========================================================================
  // --- CROSS-PROCESS LOCKING ---
  // =========================================================================

  /**
   * Runs a function under the cross-process operation lock. Used to
   * serialize compound Git operations and root clears across processes.
   * The lock is a directory inside the storage root, so watchers of OTHER
   * processes observe its appearance, pause event ingestion, and resync
   * once it disappears.
   *
   * @private
   * @param {Function} fn - Async operation to execute under the lock.
   * @returns {Promise<*>} The return value of fn.
   */
  async _withOpLock (fn) {
    const release = await lockfile.lock(this._dir, {
      lockfilePath: path.join(this._dir, OP_LOCK),
      // Wait for a competing process instead of failing
      retries: { retries: 20, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
      // A crashed holder's lock is reclaimed after this period
      stale: 10000,
      onCompromised: err =>
        this._log.warn(`Operation lock compromised: ${err.message}`)
    })
    this._weHoldOpLock = true
    // Acquiring the lock proves any foreign mutation has ended: stop the
    // poll, resync to its results, and resume ingestion before we start
    this._onForeignLockGone()
    try {
      return await fn()
    } finally {
      this._weHoldOpLock = false
      await release().catch(() => {})
    }
  }

  /**
   * Acquires the exclusive, lifetime ownership lock of the directory.
   * Idempotent for the holding instance.
   *
   * @private
   * @returns {Promise<void>}
   * @throws {Error} When another live process owns the directory.
   */
  async _acquireOwnerLock () {
    if (this._ownerRelease) return // already ours
    try {
      this._ownerRelease = await lockfile.lock(this._dir, {
        lockfilePath: path.join(this._dir, OWNER_LOCK),
        retries: 0,
        stale: 15000,
        onCompromised: err =>
          this._log.warn(`Ownership lock compromised: ${err.message}`)
      })
    } catch (err) {
      throw new Error(
        `Storage directory ${this._dir} is exclusively owned by another ` +
          `process (${err.message}). Dispose the other instance or wait ` +
          'for its lock to become stale.'
      )
    }
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
          // Do not clean inside dot-directories (.git, lock directories)
          if (!entry.name.startsWith('.')) await walk(fullPath)
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
        // Skip .git and lock directories
        if (!entry.name.startsWith('.')) {
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
   * Starts or stops the filesystem watcher according to the desired state.
   * Waits for a running watcher's initial scan before closing it (closing
   * a chokidar watcher before 'ready' can orphan native FSWatcher handles).
   * Replaced watchers are tracked so dispose() can await their closing.
   *
   * @private
   * @param {boolean} desired - Whether watching should be active.
   * @returns {Promise<void>}
   */
  async _setWatching (desired) {
    this._watch = desired
    if (desired && !this._watcher) {
      this._startWatching()
    } else if (!desired && this._watcher) {
      if (this._watcherReady) await this._watcherReady
      this._watcher.removeAllListeners()
      this._staleWatcherCloses.push(this._watcher.close().catch(() => {}))
      this._watcher = null
      this._watcherReady = null
    }
  }

  /**
   * Initializes the Chokidar watcher to keep multiple instances - and
   * multiple PROCESSES - in sync. Not started when `watch: false`.
   *
   * The watcher deliberately does NOT ignore the lock directories: their
   * appearance/disappearance is the cross-process signal that another
   * process is performing a mass mutation (Git checkout, clear).
   *
   * @private
   */
  _startWatching () {
    const watcher = chokidar.watch(this._dir, {
      persistent: true,
      ignoreInitial: true,
      // Ignore dot-entries (like .git and .tmp) in any path segment,
      // EXCEPT the lock directories which act as cross-process signals
      ignored: p =>
        p.split(/[\\/]/).some(
          segment =>
            segment.startsWith('.') &&
            segment !== OP_LOCK &&
            segment !== OWNER_LOCK &&
            segment !== '.'
        ),
      depth: Infinity
    })

    // chokidar's close() is only reliable after the initial scan finished:
    // closing before 'ready' can orphan native FSWatcher handles
    this._watcherReady = new Promise(resolve => watcher.once('ready', resolve))
    watcher.on('add', filePath => this._handleFileChange(filePath))
    watcher.on('change', filePath => this._handleFileChange(filePath))
    watcher.on('unlink', filePath => this._handleFileRemoval(filePath))

    // Cross-process mutation signaling via the operation lock directory
    watcher.on('addDir', dirPath => this._handleLockSignal(dirPath, true))
    watcher.on('unlinkDir', dirPath => this._handleLockSignal(dirPath, false))

    this._watcher = watcher
  }

  /**
   * Reacts to the operation lock of ANOTHER process appearing or
   * disappearing. The unlinkDir event is only a fast path: chokidar can
   * coalesce rapid create/delete sequences on the same path, so release
   * detection is grounded in polling the actual lock state instead.
   *
   * @private
   * @param {string} dirPath - Path of the created/removed directory.
   * @param {boolean} appeared - True on creation, false on removal.
   */
  _handleLockSignal (dirPath, appeared) {
    if (this._disposed || path.basename(dirPath) !== OP_LOCK) return
    if (this._weHoldOpLock) return // our own lock - handled internally

    if (appeared) this._onForeignLockAppeared()
    else this._onForeignLockGone()
  }

  /**
   * A foreign process started a mass mutation: pause event ingestion and
   * begin verifying the lock's release against its on-disk ground truth.
   * The poll only runs while a foreign lock is observed - zero idle cost.
   * Staleness handling means a crashed foreign holder unblocks us too.
   *
   * @private
   */
  _onForeignLockAppeared () {
    if (this._disposed || this._foreignLockPoll) return
    this._gitLock = true

    this._foreignLockPoll = setInterval(() => {
      lockfile
        .check(this._dir, {
          lockfilePath: path.join(this._dir, OP_LOCK),
          stale: 10000
        })
        .then(isLocked => {
          if (!isLocked) this._onForeignLockGone()
        })
        .catch(() => this._onForeignLockGone())
    }, 200)
    this._foreignLockPoll.unref()
  }

  /**
   * The foreign mutation ended: stop polling, rebuild the key map from the
   * final on-disk state, and resume event ingestion. Idempotent.
   *
   * @private
   */
  _onForeignLockGone () {
    if (this._foreignLockPoll) {
      clearInterval(this._foreignLockPoll)
      this._foreignLockPoll = null
    }
    if (!this._gitLock) return
    this.resync()
    this._gitLock = false
  }

  /**
   * Handles inbound file creation/modification events from the watcher.
   *
   * The read is routed through the per-file queue rather than raw
   * fs.readFile: this serializes it against our own writes to the same
   * path AND registers it in the pending-operations map, so dispose()
   * awaits watcher-triggered reads too. Without this, a large external
   * file change could leave an unawaited read holding a file handle
   * beyond disposal (observable as Jest teardown warnings).
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

    const json = await this._readFile(filePath)
    // A disposed instance must not resurrect key map state
    if (this._disposed) return
    if (json?.key) {
      this._keyMap.set(json.key, filePath)
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
    const execute = last.catch(() => {}).then(fn)

    // 3. The queue state: save a promise that will never reject,
    // so the next item in the queue isn't blocked by our failure.
    Storage._pendingWrites.set(
      filePath,
      execute.catch(() => {})
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
   * - Dot-directories (`.git`, lock directories) are skipped defensively.
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
          // Never descend into Git or lock infrastructure
          if (!entry.name.startsWith('.')) await walk(fullPath)
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
