# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [2.0.0] - unreleased

### Breaking Changes

- **Removed MD5 Hashing:** Files are no longer obfuscated with MD5 hashes. Keys are now strictly sanitized and saved as readable `<key>.json` files.
- **Removed `copy()`:** Duplicating the database via raw filesystem copies is an architectural anti-pattern with the introduction of Git. Use `git` remotes or branches for backups and environment duplication.
- **Requires Git:** To utilize version control features, `git` must be installed on the host system.

### Added

- **Native Git Integration:** First-class support for version control. Storage can now act as a versioned database.
- **New API Methods:** - `commit(message)`: Safely commit disk changes with smart auto-generated commit messages.
  - `getGitStatus()`: Retrieve current working tree status (clean, added, modified, deleted) mapped directly to your storage keys.
  - `createBranch(name)` & `checkout(name)`: Safely swap environments. Watchers are automatically locked and memory maps re-synced to prevent race conditions.
  - `push()` & `pull()`: Synchronize state across distributed systems.
- **Migration Utility:** Added `Storage.migrateFromV1(dir)` to easily upgrade existing MD5-based storage directories to the new readable V2 format.

### Security

- **Path Traversal Protection:** Added rigorous sanitization (`_sanitizeKey` and `_sanitizeFolder`) to prevent malicious keys or folders from escaping the root storage directory (e.g., preventing `../../../etc/passwd` exploits).

### Fixed

- **Circular JSON Crash:** Fixed a critical bug in the concurrency queue (`_enqueue`) where `TypeError` exceptions from circular object references were silently swallowed, leaving pending Promises unresolved.
- **Protected `clear()`:** Calling `storage.clear()` at the root level now gracefully deletes data while strictly preserving `.git` and `.gitignore` files.

## [1.2.3]

### Fixed

- A potential race, when watched directly gets externally deleted and
  immediately after re-created with a fresh `Storage` instance

## [1.2.2]

### Changed

- Removed queue dependency and implemented a static promise map
- Possibly existing .tmp files will be cleaned during construction

### Added

- Some more tests, verifying external file manipulation synchronization and large writes

## [1.2.1] - 21 May 2025

### Fixed

- Unclean data structures when creating another storage instance with identical directory

## [1.2.0] - 10 May 2025

### Changed

- Constructor is now **idempotent** — calling `new Storage({ dir })` with the same path returns the same instance

## [1.1.1] - 9 May 2025

### Fixed

- Wrong cross-notification between Storage instances that are not using the same `dir`

## [1.1.0] - 9 May 2025

### Added

- JsDoc based documentation to all public functions

### Fixed

- Removed `async` keyword from synchronous function `keys()`
- Removed non-needed vrpc dependency from project

## [1.0.0] - 8 May 2025

### Added

- Live file system syncing using [`chokidar`](https://github.com/paulmillr/chokidar)
- Multi-instance awareness: all instances are automatically kept in sync
- Support for watching nested directories
- Automatic updates to in-memory state on external changes
- New `cleanTemp()` method for removing orphaned temporary files
- Folder support for all core operations (`setItem`, `keys`, `clear`, `copy`)
- Cross-instance update propagation for `setItem`, `removeItem`, and `clear`

### Changed

- File system operations are now fully asynchronous
- Key tracking is now done in memory using internal maps (`_keyMap`, `_files`)
- `keys()` is now folder-aware via `keys(folder)`
- Improved error logging across all file operations
- Construction now performs eager scan and setup synchronously

## [0.2.0] - 22 May 2023

- Now using MD5 hashed filenames.
- Each file stores `{ key, value }` for reverse lookups.

## [0.1.0] - 22 May 2023

- First initial release
