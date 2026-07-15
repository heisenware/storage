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

  /** Retrieves a stored value, or null if the key does not exist. */
  getItem (key: string): Promise<any>

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

  /** Creates a new branch from the current state and switches to it. */
  createBranch (branchName: string): Promise<void>

  /**
   * Checks out a branch, tag, or commit and resyncs memory. Tags/commits
   * are attached to the current (or provided) branch - no detached HEAD.
   */
  checkout (branchOrTagName: string, targetBranch?: string): Promise<void>

  /** Tags the current state (annotated when a message is given). */
  createTag (tagName: string, message?: string): Promise<void>

  /** Returns all tag names as a plain string array. */
  listTags (): Promise<string[]>

  /** Removes a tag while keeping the commit history. */
  deleteTag (tagName: string): Promise<void>

  /** Renames a tag while keeping its target commit. */
  renameTag (oldTagName: string, newTagName: string): Promise<void>

  /** Pushes local commits to 'origin', setting the upstream on first push. */
  push (): Promise<void>

  /** Pulls remote changes and resyncs the in-memory key map. */
  pull (): Promise<void>
}

declare namespace Storage {
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
}

export = Storage
