// types/index.d.ts

/**
 * A lightweight, class-based JSON storage module that uses the filesystem
 * for persisting structured key-value data, with atomic writes,
 * cross-instance and cross-process sync, and Git-backed version control.
 *
 * Obtain instances via the async factory Storage.open(); direct
 * construction throws.
 */
declare class Storage {
  /**
   * Opens (or re-opens) the storage for a given directory. First call
   * creates a fully initialized instance; subsequent calls return the
   * existing instance with a rescanned key map.
   */
  static open (options: Storage.StorageOptions): Promise<Storage>

  /** Disposes the instance registered for the given directory, if any. */
  static dispose (dir: string): Promise<void>

  /** One-time utility migrating V1 (MD5 hashed) directories to V2 format. */
  static migrateFromV1 (storageDir: string): Promise<void>

  /** @deprecated Direct construction throws - use Storage.open(). */
  constructor (options: Storage.StorageOptions)

  // --- Data operations ---

  /**
   * Persists a key-value pair. Writes to the same key apply strictly in
   * call order - the last caller wins.
   */
  setItem (
    key: string,
    value: any,
    options?: Storage.FolderOptions
  ): Promise<void>

  /**
   * Retrieves a stored value, or null if the key does not exist. With
   * { version } the value is read as it existed at a tag or commit,
   * without changing any state (requires Git integration).
   */
  getItem (key: string, options?: Storage.VersionOptions): Promise<any>

  /** Checks whether a key exists (distinguishes "missing" from stored null). */
  has (key: string): boolean

  /** Deletes an entry. */
  removeItem (key: string): Promise<void>

  /** Lists all stored keys, optionally scoped to a folder. Synchronous. */
  keys (folder?: string): string[]

  /**
   * Clears entries. Root clears preserve Git and lock infrastructure and
   * are serialized across processes.
   */
  clear (options?: Storage.FolderOptions): Promise<void>

  /**
   * Rebuilds the in-memory key map from disk. Call after bulk external
   * modifications made outside the storage API.
   */
  resync (): void

  // --- Lifecycle ---

  /**
   * Gracefully shuts the instance down: closes the watcher, awaits
   * in-flight writes, releases the exclusive lock, and de-registers the
   * instance. A subsequent open() creates a fresh instance.
   */
  dispose (): Promise<void>

  // --- Git operations (require git options at open) ---

  /** Working tree status mapped to storage keys. */
  getGitStatus (): Promise<Storage.GitStatus>

  /**
   * Stages all changes (including subfolders) and commits, serialized
   * across processes. Returns the commit hash, or null when clean.
   */
  commit (message?: string): Promise<string | null>

  /**
   * Creates a new branch and switches to it. With { at } the branch starts
   * at a previous version (tag or commit) instead of the current state.
   */
  createBranch (
    branchName: string,
    options?: Storage.CreateBranchOptions
  ): Promise<void>

  /**
   * Switches to an existing branch and resyncs memory. Tags/commits are
   * not valid targets - use restore() to re-establish a previous version.
   */
  checkout (branchName: string): Promise<void>

  /**
   * Re-establishes the data state of a tag or commit as a new forward
   * commit (no history rewrite - safe with remotes and auto-sync).
   * Returns the commit hash, or null when the state already matches.
   */
  restore (tagOrCommit: string, message?: string): Promise<string | null>

  /** Tags the current state (annotated when a message is given). */
  createTag (tagName: string, message?: string): Promise<void>

  /** Returns all tag names as a plain string array. */
  listTags (): Promise<string[]>

  /** Removes a tag while keeping the commit history. */
  deleteTag (tagName: string): Promise<void>

  /** Renames a tag while keeping its target commit. */
  renameTag (oldTagName: string, newTagName: string): Promise<void>

  /**
   * Pushes local commits to 'origin', setting the upstream on first push.
   * Throws GitSyncError ('GIT_NO_REMOTE') when no origin is configured.
   */
  push (): Promise<void>

  /**
   * Pulls remote changes and resyncs the in-memory key map. On diverged
   * histories the strategy decides: 'local-wins' (default) merges both
   * sides and resolves conflicting keys in favor of local content,
   * 'remote-wins' resets to the remote state, 'fail' throws GitSyncError
   * ('GIT_DIVERGED') without touching local state. A fresh storage without
   * versioned data adopts an established remote outright.
   */
  pull (options?: Storage.PullOptions): Promise<void>
}

declare namespace Storage {
  /**
   * Typed error thrown by remote sync operations (push/pull). The stable
   * `code` allows programmatic handling.
   */
  class GitSyncError extends Error {
    code: 'GIT_DIVERGED' | 'GIT_NO_REMOTE'
  }

  /** Divergence strategy applied by pull() when local and remote history diverged. */
  type PullStrategy = 'local-wins' | 'remote-wins' | 'fail'

  /** HTTP(S) authentication for remote operations. Requires git >= 2.31. */
  interface GitAuthOptions {
    /**
     * Access token (PAT / OAuth). Injected per command via the child-process
     * environment - never written to .git/config, argv, or any file.
     */
    token: string
    /**
     * HTTP username sent with the token. Default: 'oauth2' (works for GitHub
     * and GitLab tokens); use 'x-access-token' for GitHub App tokens or
     * 'x-token-auth' for Bitbucket.
     */
    username?: string
  }

  /** Configuration of the periodic commit -> pull -> push loop. */
  interface AutoSyncOptions {
    /** Milliseconds between cycles. Default: 30000, minimum: 1000. */
    interval?: number
    /** Pull strategy for auto-sync cycles. Defaults to git.strategy, then 'local-wins'. */
    strategy?: PullStrategy
  }

  /** Options accepted by pull(). */
  interface PullOptions {
    /** Divergence strategy; defaults to git.strategy, then 'local-wins'. */
    strategy?: PullStrategy
  }

  /** Git integration options, bound at first open() of a directory. */
  interface GitOptions {
    /** Initialize a repository if none exists yet. */
    init?: boolean
    /** Optional remote URL to register as 'origin'. */
    remote?: string
    /** Default branch name for freshly initialized repositories. Default: 'master'. */
    branch?: string
    /** Additional .gitignore patterns, synced idempotently on every startup. */
    ignore?: string[]
    /** HTTP(S) authentication for push/pull against the remote. */
    auth?: GitAuthOptions
    /** Default divergence strategy for pull(). Default: 'local-wins'. */
    strategy?: PullStrategy
    /** Enables periodic automatic commit -> pull -> push synchronization. */
    autoSync?: AutoSyncOptions
  }

  /** Minimal logger contract accepted by the library. */
  interface Logger {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }

  /** Options accepted by Storage.open(). */
  interface StorageOptions {
    /** Absolute path to the storage directory. */
    dir: string
    /** Optional logger (defaults to console). */
    log?: Logger
    /** Git integration options. */
    git?: GitOptions
    /**
     * Whether to run a filesystem watcher keeping the key map in sync with
     * external changes. Default: true. Set to false for write-only targets.
     */
    watch?: boolean
    /**
     * Claim exclusive, cross-process ownership of the directory. Throws if
     * another live process already owns it. Default: false.
     */
    exclusive?: boolean
  }

  /** Version control status mapped to logical storage keys. */
  interface GitStatus {
    branch: string
    isClean: boolean
    added: string[]
    modified: string[]
    deleted: string[]
  }

  /** Options for folder-scoped data operations. */
  interface FolderOptions {
    folder?: string
  }

  /** Options for version-scoped reads. */
  interface VersionOptions {
    /** Tag name or commit hash to read from. */
    version?: string
  }

  /** Options for createBranch(). */
  interface CreateBranchOptions {
    /** Tag or commit the new branch starts at. Default: the current state. */
    at?: string
  }
}

export = Storage
