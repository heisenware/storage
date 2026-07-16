# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [3.0.0] - 16 Jul 2026

### Breaking Changes

- **`pull()` divergence handling:** `pull()` no longer runs a bare `git pull`
  (which could leave conflict markers inside `.json` files). When the local
  branch is merely behind, it fast-forwards; when local and remote history
  have **diverged**, the configured strategy decides — `'local-wins'` (new
  default: merges both sides via `merge -X ours`, conflicting keys resolve
  in favor of local content, never produces conflict markers),
  `'remote-wins'` (`reset --hard` to the remote state), or `'fail'` (throws
  a typed `GitSyncError` with `code: 'GIT_DIVERGED'`, local state untouched).
  A fresh storage without versioned data joining an established remote
  adopts the remote history outright, regardless of strategy.
- **`checkout()` accepts existing branches only:** the v2 "smart checkout"
  of tags/commits (including the `targetBranch` parameter) is removed. A
  branch rewind cannot survive remote synchronization — a rewound branch is
  indistinguishable from an out-of-date node and gets synced right back.
  Use the new `restore()` to re-establish a previous version and
  `getItem(key, { version })` to inspect one.

### Added

- **`git.auth` option — simple token authentication:** `auth: { token,
  username? }` authenticates HTTPS remotes (GitHub/GitLab PATs, deploy
  tokens). The token is injected via the child-process environment only —
  never written to `.git/config`, process arguments, or any file on disk.
  Default username `oauth2`; SSH remotes keep using the ambient agent.
  Requires git >= 2.31.
- **`pull({ strategy })` & `git.strategy`:** per-call divergence strategy and
  a configurable default (see Breaking Changes).
- **`git.autoSync` option:** opt-in background synchronization running
  commit -> pull -> push on an interval (default 30s, minimum 1s). Cycles
  never overlap, skip while another process performs a mass mutation, never
  keep the process alive (unref'd timer), stop on `dispose()`, and log
  errors with repeat-throttling.
- **`restore(tagOrCommit, [message])`:** one-call version rollback that
  rolls the state _forward_ to the tagged content as a new commit — no
  history rewrite, so it works identically for local storages and
  auto-synced fleets. Uncommitted changes are snapshotted first; every
  in-between version stays in the history and can itself be restored.
- **`getItem(key, { version })`:** time-travel reads — retrieve a value as
  it existed at any tag or commit without touching the current state.
- **`createBranch(name, { at })`:** branch off a previous version (tag or
  commit) — the sync-safe replacement for the removed
  `checkout(tag, targetBranch)`; the current branch is never rewound.
- **Auto-sync branch pinning:** auto-sync only runs on its sync branch (the
  `branch` option, or the branch present on first cycle); cycles pause on
  other branches and resume on switching back.
- **`Storage.GitSyncError`:** typed error for remote sync failures with a
  stable `code` (`'GIT_DIVERGED'`, `'GIT_NO_REMOTE'`).

### Fixed

- **`setItem` relocates on folder change:** writing an existing key with a
  different `folder` now removes the superseded file. Previously the key
  existed twice on disk and the next rescan (`resync()`/reopen) picked a
  winner by directory scan order — silently.
- `push()` and `pull()` without a configured `origin` now fail with a clear
  `GIT_NO_REMOTE` error instead of a cryptic git message.
- A failed Git initialization (previously only logged) is now recorded and
  re-thrown by remote operations, instead of causing confusing downstream
  git errors while `open()` appeared successful.

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
