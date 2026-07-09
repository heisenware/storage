// src/constants.js

/**
 * Shared internal constants for the storage library.
 */
module.exports = {
  /** Suffix marker for temporary files of the atomic write queue. */
  TMP_MARKER: '.tmp',

  /**
   * Directory name of the cross-process operation lock. Guards Git
   * mutations and clear() against interleaving from other processes.
   * Lives INSIDE the storage directory so that watchers of other
   * processes can observe it (see checkout signaling).
   */
  OP_LOCK: '.storage.lock',

  /**
   * Directory name of the exclusive ownership lock, acquired for the
   * lifetime of an instance opened with `exclusive: true`.
   */
  OWNER_LOCK: '.storage-owner.lock'
}
