// src/GitManager.js
const { simpleGit } = require('simple-git')
const fs = require('fs/promises')
const path = require('path')
const { OP_LOCK, OWNER_LOCK } = require('./constants')

/** Valid divergence strategies for pull(). */
const PULL_STRATEGIES = ['local-wins', 'remote-wins', 'fail']

/**
 * Environment keys simple-git's vulnerability check flags when an explicit
 * child env is set. They are stripped from the inherited environment when
 * token auth is enabled: none of them is needed for HTTPS push/pull, and
 * the injected credential helper replaces the askpass/ssh mechanisms.
 */
const UNSAFE_ENV_KEYS = [
  'EDITOR',
  'PAGER',
  'PREFIX',
  'GIT_ASKPASS',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_PROXY_COMMAND',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
  'SSH_ASKPASS'
]

/**
 * Error thrown by remote synchronization operations. Carries a stable
 * `code` so consumers can react programmatically:
 * - 'GIT_DIVERGED': local and remote history diverged and the active pull
 *   strategy is 'fail'.
 * - 'GIT_NO_REMOTE': push/pull was called without a configured 'origin'.
 *
 * @class GitSyncError
 */
class GitSyncError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'GitSyncError'
    this.code = code
  }
}

/**
 * Encapsulates all Git operations for a Storage instance: repository
 * initialization, staging and committing, branching, tagging, checkouts,
 * and remote synchronization.
 *
 * Every mutating operation runs under the storage's cross-process
 * operation lock, so compound sequences (add -> status -> commit,
 * checkout -> rescan, ...) never interleave between processes.
 *
 * An instance is created by Storage when Git options are provided and is
 * never used standalone.
 *
 * @class GitManager
 */
class GitManager {
  /**
   * @param {import('./Storage')} storageInstance - The owning Storage instance.
   * @param {Object} [options={}] - Git integration options.
   * @param {boolean} [options.init] - Initialize a repository if none exists yet.
   * @param {string} [options.remote] - Optional remote URL to register as 'origin'.
   * @param {string} [options.branch='master'] - Default branch name used when
   *   initializing a fresh repository.
   * @param {string[]} [options.ignore=[]] - Additional .gitignore patterns supplied
   *   by the consumer (e.g., ['state/'] to keep runtime state out of version
   *   control). These are merged with the built-in patterns and synced to the
   *   repository's .gitignore on every startup.
   * @param {Object} [options.auth] - HTTP(S) authentication. The token is
   *   injected via the child-process environment only - it never reaches
   *   .git/config, the command line, or any file on disk. Requires git >= 2.31.
   * @param {string} options.auth.token - Access token (PAT / OAuth).
   * @param {string} [options.auth.username='oauth2'] - HTTP username sent with
   *   the token.
   * @param {string} [options.strategy='local-wins'] - Default divergence
   *   strategy for pull(): 'local-wins', 'remote-wins', or 'fail'.
   * @param {Object} [options.autoSync] - Enables the periodic
   *   commit -> pull -> push loop.
   * @param {number} [options.autoSync.interval=30000] - Milliseconds between
   *   cycles (minimum 1000).
   * @param {string} [options.autoSync.strategy] - Pull strategy used by
   *   auto-sync cycles; defaults to `options.strategy`.
   */
  constructor (storageInstance, options = {}) {
    this.storage = storageInstance
    // simple-git vets env-injected configuration: the two enabled categories
    // cover exactly the library-controlled credential helper below - nothing
    // consumer-supplied passes through them
    this.git = options.auth?.token
      ? simpleGit(this.storage._dir, {
        unsafe: {
          allowUnsafeConfigEnvCount: true,
          allowUnsafeCredentialHelper: true
        }
      })
      : simpleGit(this.storage._dir)
    this.options = options

    /** @type {Error|null} Recorded init failure - re-thrown by remote operations. */
    this._initError = null

    /** @type {NodeJS.Timeout|null} Auto-sync interval handle. */
    this._autoSyncTimer = null

    /** @type {boolean} True while an auto-sync cycle runs (prevents overlap). */
    this._autoSyncBusy = false

    /** @type {Promise|null} Most recent auto-sync cycle, drained by dispose(). */
    this._autoSyncPromise = null

    /** @type {string|null} Last logged auto-sync error (repeat-throttling). */
    this._lastAutoSyncError = null

    /** @type {string|null} Branch auto-sync is pinned to (configured, or first seen). */
    this._syncBranch = options.branch || null

    /** @type {string|null} Branch a pause was already logged for (log once). */
    this._autoSyncPausedOn = null

    if (options.auth?.token) {
      // simple-git's env() REPLACES the child environment, so process.env
      // must be spread in to keep PATH, HOME, and locale variables alive.
      // Keys simple-git flags as unsafe are stripped (see UNSAFE_ENV_KEYS).
      const inherited = { ...process.env }
      for (const key of Object.keys(inherited)) {
        if (UNSAFE_ENV_KEYS.includes(key.toUpperCase())) delete inherited[key]
      }
      this.git.env({
        ...inherited,
        ...GitManager._buildAuthEnv(options.auth)
      })
    }

    // Store the initialization promise so other methods can wait for it
    this.initPromise = options.init ? this._initRepo() : Promise.resolve()

    if (options.autoSync) {
      this.initPromise.then(() => this._startAutoSync())
    }
  }

  /**
   * Builds the environment fragment that makes git resolve HTTP(S)
   * credentials at runtime. The configuration travels via GIT_CONFIG_*
   * variables (git >= 2.31), so it exists only in the environment of the
   * spawned git process: the token never appears in .git/config, in process
   * arguments, or in any file on disk. The inline credential helper reads
   * the secret from dedicated environment variables, keeping it out of the
   * helper string as well. SSH remotes are unaffected - credential helpers
   * only fire for http(s) transports.
   *
   * @param {Object} auth - Authentication options.
   * @param {string} auth.token - Access token used as password.
   * @param {string} [auth.username='oauth2'] - HTTP username. The default
   *   works for GitHub and GitLab tokens; override with 'x-access-token'
   *   for GitHub App tokens or 'x-token-auth' for Bitbucket.
   * @returns {Object} Environment variables to merge into the child env.
   */
  static _buildAuthEnv ({ token, username = 'oauth2' }) {
    const helper =
      '!f() { if [ "$1" = get ]; then echo "username=$STORAGE_GIT_AUTH_USER";' +
      ' echo "password=$STORAGE_GIT_AUTH_TOKEN"; fi; }; f'
    return {
      STORAGE_GIT_AUTH_USER: username,
      STORAGE_GIT_AUTH_TOKEN: token,
      // Fail fast on rejected credentials instead of prompting
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2',
      // The empty first entry resets git's helper list, so global/system
      // credential helpers cannot shadow the configured token
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: helper
    }
  }

  /**
   * Initializes the local repository if required and synchronizes the
   * .gitignore file with the configured patterns. Runs under the
   * cross-process lock so two processes racing on a fresh directory
   * cannot double-initialize.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _initRepo () {
    try {
      await this.storage._withOpLock(async () => {
        // DO NOT use checkIsRepo() as it detects parent repositories up the tree.
        // Explicitly check if a .git folder exists in this specific directory.
        const gitDir = path.join(this.storage._dir, '.git')
        const isLocalRepo = await fs
          .access(gitDir)
          .then(() => true)
          .catch(() => false)

        if (!isLocalRepo) {
          const branch = this.options.branch || 'master'
          await this.git.init(['-b', branch])

          // Ensure CI and local test environments don't crash if global git user is missing
          await this.git.addConfig('user.name', 'Storage Bot')
          await this.git.addConfig('user.email', 'bot@heisenware.local')

          await this._syncGitignore()

          await this.git.add('.gitignore')
          await this.git.commit('chore: initialize storage repository')
        } else {
          // Existing repository: keep the .gitignore in sync with the currently
          // configured patterns. This is idempotent and ensures that patterns
          // added in newer versions (or via options.ignore) also reach
          // repositories that were initialized before the change.
          await this._syncGitignore()
        }

        if (this.options.remote) {
          const remotes = await this.git.getRemotes()
          if (!remotes.find(r => r.name === 'origin')) {
            await this.git.addRemote('origin', this.options.remote)
          }
        }
      })
    } catch (err) {
      // Keep initPromise resolved so local-only usage and open() semantics
      // are unaffected; remote operations surface the failure via
      // _ensureReady() instead of failing with confusing git errors later.
      this._initError = err
      this.storage._log.error(`Git initialization failed: ${err.message}`)
    }
  }

  /**
   * Awaits initialization and re-throws a recorded init failure. Remote
   * operations call this instead of awaiting initPromise directly.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _ensureReady () {
    await this.initPromise
    if (this._initError) {
      throw new Error(
        `Git initialization failed earlier: ${this._initError.message}`
      )
    }
  }

  /**
   * Throws when no 'origin' remote is configured.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _ensureOrigin () {
    const remotes = await this.git.getRemotes()
    if (!remotes.find(r => r.name === 'origin')) {
      throw new GitSyncError(
        'GIT_NO_REMOTE',
        "No 'origin' remote configured. Provide git.remote when opening the storage."
      )
    }
  }

  /**
   * Fetches 'origin' and computes how far HEAD and the remote counterpart
   * of the current branch have drifted apart. Read-only with respect to
   * the working tree; must run inside the operation lock.
   *
   * @private
   * @returns {Promise<{branch: string, hasRemoteBranch: boolean, ahead: number, behind: number}>}
   */
  async _fetchDivergence () {
    await this._ensureOrigin()
    await this.git.fetch('origin')

    const branch = (await this.git.status()).current
    // NOTE: with --quiet, a missing ref resolves with EMPTY output through
    // simple-git instead of rejecting - hence the emptiness check
    const hasRemoteBranch = await this.git
      .raw(['rev-parse', '--verify', '--quiet', `origin/${branch}`])
      .then(out => out.trim().length > 0)
      .catch(() => false)
    if (!hasRemoteBranch) {
      return { branch, hasRemoteBranch, ahead: 0, behind: 0 }
    }

    const counts = await this.git.raw([
      'rev-list',
      '--left-right',
      '--count',
      `HEAD...origin/${branch}`
    ])
    const [ahead, behind] = counts.trim().split(/\s+/).map(Number)
    return { branch, hasRemoteBranch, ahead, behind }
  }

  /**
   * True when HEAD and the remote branch share no common ancestor - the
   * signature of two independently initialized repositories.
   *
   * @private
   * @param {string} branch - The current branch name.
   * @returns {Promise<boolean>}
   */
  async _isUnrelated (branch) {
    return this.git
      .raw(['merge-base', 'HEAD', `origin/${branch}`])
      .then(out => out.trim().length === 0)
      .catch(() => true)
  }

  /**
   * True when the repository versions no data yet (no .json files in the
   * index) and the working tree is clean - i.e., adopting the remote state
   * outright cannot lose any stored item.
   *
   * @private
   * @returns {Promise<boolean>}
   */
  async _isBlankSlate () {
    const status = await this.git.status()
    if (!status.isClean()) return false
    const files = await this.git.raw(['ls-files', '--', '*.json'])
    return files.trim().length === 0
  }

  /**
   * Writes the .gitignore file, combining the built-in patterns (temp files
   * of the atomic write queue, the cross-process lock directories) with any
   * consumer-provided patterns from `options.ignore`.
   *
   * The operation is idempotent: repeated calls always produce the same file
   * content, so it is safe to run on every startup.
   *
   * @private
   * @returns {Promise<void>}
   */
  async _syncGitignore () {
    // Built-ins: temp files of the write queue and the lock directories
    const patterns = [
      '*.tmp-*',
      `${OP_LOCK}/`,
      `${OWNER_LOCK}/`,
      ...(this.options.ignore || [])
    ]
    const content = patterns.join('\n') + '\n'
    const gitignorePath = path.join(this.storage._dir, '.gitignore')

    // Only touch the file when the content actually differs, to avoid
    // producing needless diffs and watcher events
    const current = await fs.readFile(gitignorePath, 'utf-8').catch(() => null)
    if (current === content) return

    await fs.writeFile(gitignorePath, content)
  }

  /**
   * Generates a human-readable commit message summarizing the staged changes.
   *
   * @private
   * @param {Object} status - A simple-git status result.
   * @returns {Promise<string>} The generated commit message.
   */
  async _generateAutoMessage (status) {
    const changes = [
      ...status.created,
      ...status.modified,
      ...status.deleted
    ].filter(f => f.endsWith('.json'))

    if (changes.length === 0) return 'chore: storage synchronization'

    if (changes.length === 1) {
      const file = changes[0]
      const keyName = path.basename(file, '.json')
      if (status.created.includes(file)) { return `add: stored new item '${keyName}'` }
      if (status.deleted.includes(file)) { return `delete: removed item '${keyName}'` }
      return `update: modified item '${keyName}'`
    }

    if (changes.length <= 3) {
      const names = changes.map(f => path.basename(f, '.json')).join(', ')
      return `update: modified items (${names})`
    }

    return `update: bulk modification of ${changes.length} items`
  }

  /**
   * Retrieves the current version control status, reduced to the logical
   * storage keys that were added, modified, or deleted. Read-only, hence
   * not serialized.
   *
   * @returns {Promise<{ branch: string, isClean: boolean, added: string[], modified: string[], deleted: string[] }>}
   */
  async getStatus () {
    await this.initPromise // Wait for init to finish!

    const status = await this.git.status()
    const extractKey = filePath => path.basename(filePath, '.json')
    const filterJson = files =>
      files.filter(f => f.endsWith('.json')).map(extractKey)

    return {
      branch: status.current,
      isClean: status.isClean(),
      added: filterJson([...status.created, ...status.not_added]),
      modified: filterJson(status.modified),
      deleted: filterJson(status.deleted)
    }
  }

  /**
   * Stages all changes and commits them to the local repository, serialized
   * across processes. If no message is provided, a smart summary is
   * auto-generated.
   *
   * Staging uses `git add .` (instead of a `*.json` glob) so that items
   * living in subfolders are versioned as well, and so that a repository
   * without any JSON files yet does not fail with a pathspec error on its
   * first commit. Unwanted files are excluded via .gitignore, not via the
   * staging pattern.
   *
   * @param {string} [message=null] - Optional explicit commit message.
   * @returns {Promise<string|null>} The commit hash, or null if there were no changes.
   */
  async commit (message = null) {
    await this.initPromise // Wait for init to finish!

    return this.storage._withOpLock(async () => {
      await this.git.add('.')

      const status = await this.git.status()
      if (status.isClean()) {
        this.storage._log.warn('Git commit skipped: No changes detected.')
        return null
      }

      const commitMsg = message || (await this._generateAutoMessage(status))
      const result = await this.git.commit(commitMsg)
      return result.commit
    })
  }

  /**
   * Creates a new local branch and switches to it. By default the branch
   * starts at the current state; with `at` it starts at a previous version
   * (tag or commit) - the sync-safe way to work with an old version on the
   * side, since the current branch is never rewound. When branching off a
   * version, pending changes are snapshotted to the current branch first
   * so they stay where they belong. Serialized across processes.
   *
   * @param {string} branchName - The name of the new branch.
   * @param {Object} [options]
   * @param {string} [options.at] - Optional tag or commit the branch starts at.
   * @returns {Promise<void>}
   */
  async createBranch (branchName, { at } = {}) {
    await this.initPromise // Wait for init to finish!
    return this.storage._withOpLock(async () => {
      if (!at) {
        await this.git.checkoutLocalBranch(branchName)
        return
      }

      // Validate the target up front (NOTE: with --quiet a missing ref
      // resolves with empty output through simple-git, it does not reject)
      const target = await this.git
        .raw(['rev-parse', '--verify', '--quiet', `${at}^{commit}`])
        .then(out => out.trim())
        .catch(() => '')
      if (!target) {
        throw new Error(`Unknown tag or commit: '${at}'`)
      }

      // Keep pending changes on the branch they were made on
      await this.git.add('.')
      const pending = await this.git.status()
      if (!pending.isClean()) {
        await this.git.commit(`chore: snapshot before branching off '${at}'`)
      }

      this.storage._gitLock = true
      try {
        await this.git.checkout(['-b', branchName, target])
        this.storage.resync()
      } finally {
        this.storage._gitLock = false
      }
    })
  }

  /**
   * Creates a Git tag at the current state. Serialized across processes.
   *
   * @param {string} tagName - The name of the tag.
   * @param {string} [message=null] - Optional message to create an annotated tag.
   * @returns {Promise<void>}
   */
  async createTag (tagName, message = null) {
    await this.initPromise // Wait for init to finish!

    return this.storage._withOpLock(async () => {
      if (message) {
        await this.git.addAnnotatedTag(tagName, message)
      } else {
        await this.git.addTag(tagName)
      }
    })
  }

  /**
   * Lists all tags of the repository. Read-only, hence not serialized.
   *
   * Note: simple-git's `tags()` resolves to a TagResult object; this method
   * unwraps it and returns the plain array of tag names, which is what
   * consumers building version histories actually need.
   *
   * @returns {Promise<string[]>} Array of tag names (empty if no tags exist).
   */
  async listTags () {
    await this.initPromise
    const result = await this.git.tags()
    return result.all
  }

  /**
   * Deletes a tag from the repository, serialized across processes. Only
   * the tag reference is removed; the underlying commits remain untouched.
   *
   * @param {string} tagName - The name of the tag to delete.
   * @returns {Promise<void>}
   */
  async deleteTag (tagName) {
    await this.initPromise
    return this.storage._withOpLock(async () => {
      await this.git.tag(['-d', tagName])
    })
  }

  /**
   * Renames a tag, serialized across processes. The tag's target commit is
   * unchanged; only the reference name is replaced.
   *
   * @param {string} oldName - The name of the existing tag.
   * @param {string} newName - The new name for the tag.
   * @returns {Promise<void>}
   */
  async renameTag (oldName, newName) {
    await this.initPromise
    return this.storage._withOpLock(async () => {
      // Git has no native rename: re-point the new name at the old tag's
      // target (annotated tag objects stay dereferenceable), then drop the
      // old reference. Creation fails first on invalid input, so the old
      // tag is never deleted without its replacement existing.
      await this.git.tag([newName, oldName])
      await this.git.tag(['-d', oldName])
    })
  }

  /**
   * Checks whether the given name refers to an existing local branch.
   *
   * @private
   * @param {string} name - Candidate branch name.
   * @returns {Promise<boolean>}
   */
  async _isLocalBranch (name) {
    const branches = await this.git.branchLocal()
    return branches.all.includes(name)
  }

  /**
   * Switches to an EXISTING local branch while keeping every observing
   * Storage instance consistent: the operation runs under the cross-process
   * lock (whose presence pauses the watchers of OTHER processes), this
   * process's watcher is paused via the git lock, and the in-memory key map
   * is rebuilt from the new working tree afterwards. Other processes resync
   * automatically when the lock disappears.
   *
   * Tags and commits are deliberately NOT valid checkout targets: a branch
   * rewind cannot survive remote synchronization (a rewound branch is
   * indistinguishable from an out-of-date node and gets synced right back).
   * Use restore() to re-establish a previous version, or read it directly
   * via readItemAt() without changing any state.
   *
   * @param {string} branchName - The branch to switch to.
   * @returns {Promise<void>}
   */
  async checkout (branchName) {
    await this.initPromise

    return this.storage._withOpLock(async () => {
      if (!(await this._isLocalBranch(branchName))) {
        throw new Error(
          `Unknown branch '${branchName}'. checkout() switches between ` +
            'existing branches only - use restore(tagOrCommit) to ' +
            're-establish a previous version, or createBranch() to start ' +
            'a new branch.'
        )
      }

      this.storage._gitLock = true
      try {
        await this.git.checkout(branchName)
        this.storage.resync()
      } finally {
        this.storage._gitLock = false
      }
    })
  }

  /**
   * Re-establishes the data state of a previous version (tag or commit) as
   * a NEW forward commit - the sync-safe counterpart to a branch rewind.
   * Pending (uncommitted) changes are snapshotted first, so nothing is
   * ever lost; the restored state then propagates through push/pull and
   * auto-sync like any ordinary change, and the in-between versions remain
   * in the history. Serialized across processes.
   *
   * @param {string} tagOrCommit - The version to restore (tag name or commit hash).
   * @param {string} [message=null] - Optional message for the restore commit.
   * @returns {Promise<string|null>} The restore commit hash, or null when
   *   the current state already equals the requested version.
   */
  async restore (tagOrCommit, message = null) {
    await this.initPromise

    return this.storage._withOpLock(async () => {
      // Validate the target up front (NOTE: with --quiet a missing ref
      // resolves with empty output through simple-git, it does not reject)
      const target = await this.git
        .raw(['rev-parse', '--verify', '--quiet', `${tagOrCommit}^{commit}`])
        .then(out => out.trim())
        .catch(() => '')
      if (!target) {
        throw new Error(`Unknown tag or commit: '${tagOrCommit}'`)
      }

      // Snapshot pending changes first - restoring must never destroy data
      await this.git.add('.')
      const pending = await this.git.status()
      if (!pending.isClean()) {
        await this.git.commit(`chore: snapshot before restoring '${tagOrCommit}'`)
      }

      // No-op when the current tree already matches the target version
      const headTree = await this.git.raw(['rev-parse', 'HEAD^{tree}'])
      const targetTree = await this.git.raw(['rev-parse', `${target}^{tree}`])
      if (headTree.trim() === targetTree.trim()) return null

      this.storage._gitLock = true
      try {
        // Make the index AND working tree exactly match the target version
        // (including deletions of keys added after it)
        await this.git.raw(['read-tree', '-u', '--reset', target])
        const result = await this.git.commit(
          message || `restore: state of '${tagOrCommit}'`
        )
        this.storage.resync()
        return result.commit
      } finally {
        this.storage._gitLock = false
      }
    })
  }

  /**
   * Reads a single item as it existed at a given version (tag or commit)
   * WITHOUT touching the working tree, HEAD, or any other observer -
   * time-travel reads are completely synchronization-safe. Read-only,
   * hence not serialized.
   *
   * @param {string} version - Tag name or commit hash to read from.
   * @param {string} key - The logical storage key.
   * @returns {Promise<Object|null>} The stored { key, value } content, or
   *   null when the key did not exist at that version.
   */
  async readItemAt (version, key) {
    await this.initPromise

    const files = await this.git.raw(['ls-tree', '-r', '--name-only', version])
    const fileName = `${key}.json`
    const match = files
      .split('\n')
      .find(f => f === fileName || f.endsWith(`/${fileName}`))
    if (!match) return null

    const content = await this.git.show([`${version}:${match}`])
    return JSON.parse(content)
  }

  /**
   * Pushes local commits of the current branch to the 'origin' remote,
   * setting the upstream on first push. Serialized across processes.
   *
   * @throws {GitSyncError} With code 'GIT_NO_REMOTE' when no 'origin' is configured.
   * @returns {Promise<void>}
   */
  async push () {
    await this._ensureReady()
    return this.storage._withOpLock(async () => {
      await this._ensureOrigin()
      const status = await this.git.status()
      await this.git.push('origin', status.current, { '--set-upstream': null })
    })
  }

  /**
   * Fetches remote changes and synchronizes the local state according to
   * the given strategy, then re-synchronizes the in-memory key map of the
   * owning Storage instance. Serialized across processes; watcher events
   * are suppressed while the working tree changes.
   *
   * When the local branch is merely behind, a plain fast-forward is
   * performed regardless of strategy. A fresh storage (no versioned data,
   * clean tree) joining an established remote with an unrelated history
   * adopts the remote outright - also regardless of strategy. Otherwise
   * the strategy decides what happens when local and remote DIVERGED:
   * - 'local-wins' (default): merges the remote changes; non-conflicting
   *   additions and edits from both sides survive, conflicting keys resolve
   *   in favor of local content (merge -X ours). A subsequent push()
   *   succeeds without force.
   * - 'remote-wins': makes local exactly match the remote (reset --hard),
   *   discarding diverged local commits AND uncommitted changes.
   * - 'fail': throws a GitSyncError with code 'GIT_DIVERGED', leaving the
   *   local state untouched.
   *
   * @param {Object} [options]
   * @param {'local-wins'|'remote-wins'|'fail'} [options.strategy] - Divergence
   *   strategy; defaults to the `git.strategy` option, then 'local-wins'.
   * @throws {GitSyncError} With code 'GIT_DIVERGED' or 'GIT_NO_REMOTE'.
   * @returns {Promise<void>}
   */
  async pull ({ strategy } = {}) {
    strategy = strategy || this.options.strategy || 'local-wins'
    if (!PULL_STRATEGIES.includes(strategy)) {
      throw new Error(
        `Unknown pull strategy "${strategy}". ` +
          `Valid strategies: ${PULL_STRATEGIES.join(', ')}.`
      )
    }
    await this._ensureReady()

    return this.storage._withOpLock(async () => {
      const { branch, hasRemoteBranch, ahead, behind } =
        await this._fetchDivergence()

      // First pull against an empty remote, or nothing new on the remote
      if (!hasRemoteBranch || behind === 0) return

      const remoteRef = `origin/${branch}`
      const diverged = ahead > 0
      let unrelated = false
      let adopt = false

      if (diverged) {
        unrelated = await this._isUnrelated(branch)
        // Bootstrap: a data-less repository joining an established remote
        // adopts its history outright - independent of strategy, so even
        // 'fail' fleets can add fresh nodes without manual intervention
        adopt = unrelated && (await this._isBlankSlate())

        if (!adopt && strategy === 'fail') {
          throw new GitSyncError(
            'GIT_DIVERGED',
            `Local and remote '${branch}' have ` +
              (unrelated
                ? 'unrelated histories. '
                : `diverged (${ahead} ahead / ${behind} behind). `) +
              "Pull with { strategy: 'local-wins' } or " +
              "{ strategy: 'remote-wins' } to resolve."
          )
        }
      }

      this.storage._gitLock = true
      try {
        if (!diverged) {
          await this.git.merge(['--ff-only', remoteRef])
        } else if (adopt || strategy === 'remote-wins') {
          await this.git.reset(['--hard', remoteRef])
        } else {
          // local-wins: real merge - both sides' non-conflicting changes
          // survive, conflicting keys resolve in favor of local content
          const mergeArgs = ['-X', 'ours', '--no-edit']
          if (unrelated) mergeArgs.push('--allow-unrelated-histories')
          try {
            await this.git.merge([...mergeArgs, remoteRef])
          } catch (err) {
            // Never leave a half-done merge behind (e.g. a modify/delete
            // conflict that -X ours cannot auto-resolve)
            await this.git.merge(['--abort']).catch(() => {})
            throw new GitSyncError(
              'GIT_DIVERGED',
              `Merging remote '${branch}' failed: ${err.message}`
            )
          }
        }
        this.storage.resync()
      } finally {
        this.storage._gitLock = false
      }
    })
  }

  /**
   * Starts the periodic auto-sync loop (commit -> pull -> push). The timer
   * is unref'd so it never keeps the process alive; cycles never overlap
   * and errors are logged (throttled) instead of thrown.
   *
   * @private
   * @returns {void}
   */
  _startAutoSync () {
    if (this.storage._disposed || this._autoSyncTimer) return
    const interval = Math.max(1000, this.options.autoSync.interval || 30000)
    this._autoSyncTimer = setInterval(() => {
      this._autoSyncPromise = this._autoSyncCycle()
    }, interval)
    this._autoSyncTimer.unref()
  }

  /**
   * One auto-sync cycle: commit local changes (auto message), pull with
   * the configured strategy, push. Skipped while a previous cycle is
   * still running, a mass mutation is in progress (git lock), the
   * repository failed to initialize, or a branch other than the sync
   * branch is checked out (auto-sync is pinned to one branch so branch
   * experiments are never synced accidentally).
   *
   * @private
   * @returns {Promise<void>}
   */
  async _autoSyncCycle () {
    if (this._autoSyncBusy) return
    if (this.storage._gitLock || this.storage._disposed || this._initError) {
      return
    }
    this._autoSyncBusy = true
    try {
      const status = await this.git.status()

      // Pin auto-sync to its branch: configured via options.branch, or the
      // branch present when the first cycle ran
      if (!this._syncBranch) this._syncBranch = status.current
      if (status.current !== this._syncBranch) {
        if (this._autoSyncPausedOn !== status.current) {
          this._autoSyncPausedOn = status.current
          this.storage._log.info(
            `Git auto-sync paused: branch '${status.current}' is not the ` +
              `sync branch '${this._syncBranch}'.`
          )
        }
        return
      }
      this._autoSyncPausedOn = null

      if (!status.isClean()) await this.commit()
      await this.pull({ strategy: this.options.autoSync.strategy })
      await this.push()
      this._lastAutoSyncError = null
    } catch (err) {
      // Log each distinct failure once, not on every cycle
      if (err.message !== this._lastAutoSyncError) {
        this._lastAutoSyncError = err.message
        this.storage._log.error(`Git auto-sync failed: ${err.message}`)
      }
    } finally {
      this._autoSyncBusy = false
    }
  }

  /**
   * Stops the auto-sync loop and waits for an in-flight cycle to drain.
   * Called by Storage#dispose().
   *
   * @returns {Promise<void>}
   */
  async dispose () {
    if (this._autoSyncTimer) {
      clearInterval(this._autoSyncTimer)
      this._autoSyncTimer = null
    }
    if (this._autoSyncPromise) await this._autoSyncPromise.catch(() => {})
  }
}

GitManager.GitSyncError = GitSyncError

module.exports = GitManager
