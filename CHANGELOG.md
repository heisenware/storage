# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [2.0.0] - 15 Jul 2026

### Breaking Changes

- **Removed MD5 Hashing:** Files are no longer obfuscated with MD5 hashes. Keys
  are now strictly sanitized and saved as readable `<key>.json` files.
- **Removed `copy()`:** Duplicating the database via raw filesystem copies is an
  architectural anti-pattern with the introduction of Git. Use `git` remotes or
  branches for backups and environment duplication.
- **Requires Git:** To utilize version control features, `git` must be installed
  on the host system.
- **Commit staging widened:** `commit()` now stages **all** changes (`git add.`)
  instead of root-level `*.json` files only. Items stored in subfolders are
  finally versioned; exclusions belong in `.gitignore`.
- **Construction via `Storage.open()`:** Direct `new Storage(...)` now throws.
  The async factory `await Storage.open({ dir, ... })` owns the three previously
  hidden constructor jobs (create, get-existing, resync) and resolves only when
  the instance is fully initialized including Git setup. Differing `git` options
  on reuse produce a warning instead of being silently ignored.

### Added

- **Native Git Integration:** First-class support for version control. Storage
  can now act as a versioned database.
- **New API Methods:**
  - `commit(message)`: Safely commit disk changes with smart auto-generated
    commit messages.
  - `getGitStatus()`: Retrieve current working tree status (clean, added,
    modified, deleted) mapped directly to your storage keys.
  - `createBranch(name)` & `checkout(nameOrTag, [targetBranch])`: Safely swap
    environments. Watchers are automatically locked and memory maps re-synced to
    prevent race conditions. Smart checkout attaches the current (or an
    explicitly provided) branch when targeting tags or commits, preventing
    detached HEAD states.
  - `createTag(name, [message])`, `listTags()`, `renameTag(oldName, newName)`
    & `deleteTag(name)`: Tag-based snapshotting and version histories as plain
    string arrays.
  - `push()` & `pull()`: Synchronize state across distributed systems.
  - `dispose()` & static `Storage.dispose(dir)`: Graceful instance shutdown —
    closes watchers, awaits in-flight writes, and de-registers from the
    singleton registry. Enables leak-free operation in tests and long-running
    processes with app churn.
- **`watch` constructor option:** Set `watch: false` to skip the filesystem
  watcher for write-only directories (e.g., deployment targets), saving watcher
  resources and OS file handles.
- **`git.ignore` option:** Consumers can extend the repository's `.gitignore`
  (e.g., `{ ignore: ['state/'] }`) to keep runtime data out of version control.
  The `.gitignore` is synced idempotently on every startup, so pattern changes
  also reach previously initialized repositories.
- **Migration Utility:** Added `Storage.migrateFromV1(dir)` to easily upgrade
  existing MD5-based storage directories to the new readable V2 format.
  - **Multi-process safety:** Git mutations and root `clear()` are serialized
    across processes via an advisory lock (`proper-lockfile`) with staleness
    recovery and wait-instead-of-fail semantics. Watchers of other processes
    observe the lock, pause event ingestion during foreign mass mutations
    (checkouts, clears), and resync automatically afterwards.
- **`exclusive` open option:** `Storage.open({ dir, exclusive: true })` claims
  sole cross-process ownership of a directory for the instance lifetime;
  conflicts fail fast with a descriptive error. Released by `dispose()` or
  reclaimed via lock staleness after a crash.
- **`has(key)`:** Synchronous existence check, resolving the `getItem()`
  ambiguity between "missing" and "stored null".
- **`resync()`:** Public rebuild of the in-memory key map after bulk external
  modifications (e.g., archive extraction).
- **`git.branch` option:** Configurable default branch name for fresh
  repositories (defaults to `master`).
- **TypeScript declarations:** Hand-maintained `types/index.d.ts` covering the
  full public API.
- **Dual module support:** ESM consumers get a native `import` entry via an
  `exports` map; the CJS source remains canonical.

### Changed

- **Deterministic write ordering:** `setItem()` now enqueues synchronously
  (directory creation happens inside the queued task), guaranteeing that
  concurrent writes to the same key apply strictly in call order — the last
  caller wins.
- **Tooling modernized:** mocha/assert test suite migrated to Jest with enforced
  coverage thresholds; linting moved from standard-js to neostandard (ESLint 9
  flat config) with husky/lint-staged pre-commit enforcement.

### Security

- **Path Traversal Protection:** Added rigorous sanitization (`_sanitizeKey` and
  `_sanitizeFolder`) to prevent malicious keys or folders from escaping the root
  storage directory (e.g., preventing `../../../etc/passwd` exploits).

### Fixed

- **Circular JSON Crash:** Fixed a critical bug in the concurrency queue
  (`_enqueue`) where `TypeError` exceptions from circular object references were
  silently swallowed, leaving pending Promises unresolved.
- **Protected `clear()`:** Calling `storage.clear()` at the root level now
  gracefully deletes data while strictly preserving `.git` and `.gitignore`
  files.
- **Falsy values in migration:** `Storage.migrateFromV1()` no longer drops items
  whose stored value is falsy (`0`, `false`, `''`, `null`); it now checks for
  property existence instead of truthiness and defensively skips `.git`
  directories.
- **First commit on empty store:** `commit()` no longer fails with a pathspec
  error when the repository contains no JSON files yet.
- **Watcher handle leak:** Watchers replaced during idempotent re-construction
  are now tracked and awaited by `dispose()`, so no filesystem handles outlive
  the instance.
