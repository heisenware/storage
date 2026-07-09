# Persistent Git-Backed JSON Storage

[![neostandard](https://img.shields.io/badge/code_style-neostandard-brightgreen?style=flat)](https://github.com/neostandard/neostandard)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A lightweight, class-based JSON storage module for Node.js that uses the
filesystem for persisting structured key-value data. Designed for **atomic
writes**, **cross-instance sync**, and **first-class Git version control**, it's
perfect for local persistence, auditable databases, branching test environments,
or lightweight state management.

---

## Features

- **Version Controlled**: native Git snapshotting, branching, tagging, and
  remote syncing.
- **Safe, atomic writes** (temp file + rename strategy) with a strict
  concurrency guarantee: writes to the same key apply in call order — the last
  caller wins.
- **Human-Readable Files**: keys are saved as beautifully transparent `.json`
  files, producing clean Git diffs.
- **Supports nested folders** for scoped persistence.
- **Queue-based concurrency** ensures safe access per file.
- **Multi-instance aware**: storage stays in sync across instances via
  `chokidar` (optional per instance).
- **Clean lifecycle**: instances can be fully disposed, releasing watchers and
  queues — no leaked handles in tests or long-running processes.

---

## Installation

```bash
npm install @heisenware/storage simple-git
```

_(Note: Requires the native `git` binary installed on your host OS or Docker image)._

---

## Usage

```js
const Storage = require('@heisenware/storage')

const storage = new Storage({
  dir: '/tmp/my-app-store',
  git: { init: true } // Automatically sets up a Git repository
})

await storage.setItem('user-123', { name: 'Alice', active: true })
const user = await storage.getItem('user-123')
console.log(user) // { name: 'Alice', active: true }

// Snapshot the state
await storage.commit('chore: update alice')

// Create a test environment, make changes, and discard them
await storage.createBranch('destructive-tests')
await storage.checkout('destructive-tests')
await storage.clear()
await storage.checkout('master') // Memory map instantly resyncs to safe data!
```

---

## Tag-Based Versioning

Tags turn the storage into a versioned database with painless rollbacks:

```js
// Snapshot a milestone
await storage.commit('feat: stable state')
await storage.createTag('v1.0.0', 'Stable baseline')

// Keep working ...
await storage.setItem('user-456', { name: 'Bob' })
await storage.commit('feat: add bob')

// Roll back! Smart checkout attaches the CURRENT branch to the tag,
// so you never end up in a detached HEAD state.
await storage.checkout('v1.0.0')

// Or check the tag out onto a dedicated branch instead:
await storage.checkout('v1.0.0', 'hotfix-v1')

// Inspect and clean up the version history
const tags = await storage.listTags() // ['v1.0.0', ...]
await storage.deleteTag('v1.0.0') // removes the tag, keeps the history
```

---

## Folder Support

Store and query items within custom subfolders. Path traversal is rigorously
prevented.

```js
await storage.setItem('session-42', { token: 'abc' }, { folder: 'sessions' })
const keys = storage.keys('sessions') // ['session-42'] (synchronous!)
```

---

## Keeping Runtime Data Out of Version Control

Consumers can extend the repository's `.gitignore` via the `ignore` option —
useful for separating tracked configuration from untracked runtime state:

```js
const storage = new Storage({
  dir: '/tmp/my-app-store',
  git: { init: true, ignore: ['state/'] }
})

// Fully readable through the storage API ...
await storage.setItem('live-cache', { hits: 42 }, { folder: 'state' })

// ... but invisible to version control
await storage.commit() // null - nothing to commit
```

The `.gitignore` is re-synced idempotently on every startup, so pattern changes
also reach repositories that were initialized earlier.

---

## Internal Design

- Files are directly named `<key>.json` for human-readability and clean Git
  diffs.
- Each entry is stored as a single JSON file: `{ key, value }`.
- Temp files use `.tmp-<timestamp>` suffix and are cleaned if needed.
- Write operations are enqueued synchronously per file, which guarantees that
  concurrent writes to the same key apply in call order.
- `chokidar` watches for external changes and updates all instances. Watchers
  are safely paused during Git branch checkouts and can be disabled entirely
  via `watch: false` for write-only targets.

---

## API

### `new Storage({ dir, log, git, watch })`

Create a storage instance. The constructor is idempotent: calling it again
with the same `dir` returns the same (re-synced) instance.

- `dir`: absolute path to storage directory
- `log`: optional logger (defaults to `console`)
- `git`: optional config `{ init: boolean, remote: string, ignore: string[] }`
- `watch`: optional boolean (defaults to `true`); set to `false` to skip the
  filesystem watcher for directories that receive no external modifications

### Data Operations

- `setItem(key, value, { folder })`: Persist a key-value pair. Writes to the
  same key are applied strictly in call order.
- `getItem(key)`: Retrieve a previously stored value.
- `removeItem(key)`: Delete an entry.
- `keys(folder)`: List all stored keys, optionally scoped to a folder.
  Synchronous — served from the in-memory key map.
- `clear({ folder })`: Clear entries. Protects `.git` files if clearing the root.

### Git Operations

- `getGitStatus()`: Returns an object `{ branch, isClean, added, modified,
  deleted }` mapping directly to your keys.
- `commit(message)`: Stages **all** changes (including subfolders) and commits.
  Auto-generates a smart message if none is provided. Returns the commit hash,
  or `null` when there is nothing to commit.
- `createBranch(name)` / `checkout(nameOrTag, [targetBranch])`: Swaps branches
  or rolls back to tags and instantly resyncs memory. Checking out a tag
  attaches the current (or explicitly provided) branch to it — no detached
  HEAD.
- `createTag(name, [message])`: Tags the current state (annotated when a
  message is given).
- `listTags()`: Returns all tag names as a plain string array.
- `deleteTag(name)`: Removes a tag while keeping the commit history.
- `push()` / `pull()`: Synchronizes with remote Git endpoints.

### Lifecycle

- `dispose()`: Gracefully shuts the instance down — closes the watcher, awaits
  in-flight writes, and de-registers the instance so it can be
  garbage-collected. Call this before deleting the underlying directory.
- `Storage.dispose(dir)`: Static convenience — disposes whatever instance is
  registered for `dir` (no-op if none).

### Utility

- `Storage.migrateFromV1(dir)`: One-time utility to unpack V1 (MD5 hashed)
  databases into V2 formats. Preserves falsy values (`0`, `false`, `''`,
  `null`) and skips un-parseable files.

---

## Architecture & Multi-Process Guidelines

### Multi-Process Isolation

If multiple independent Node.js processes need to use the storage library
simultaneously, **do not point them at the same root directory**. Point them at
dedicated subdirectories:

```js
// CORRECT (Complete isolation)
const procA = new Storage({ dir: '/shared/data/procA' })
const procB = new Storage({ dir: '/shared/data/procB' })
```

### Docker Volumes

When running on **Linux**, Docker bind-mounts natively propagate `inotify`
events, so the `chokidar` watcher runs with near-zero overhead. If you run this
on macOS/Windows Docker Desktop, you may need to enable `usePolling` in Chokidar
for real-time sync.

---

## Development

```bash
npm run lint          # neostandard via ESLint 9
npm run lint:fix      # auto-fix style issues
npm test              # Jest test suites
npm run test:coverage # coverage report with enforced thresholds
```

Code style is [neostandard](https://github.com/neostandard/neostandard); a
husky pre-commit hook auto-fixes staged files. Pull requests must pass linting
and the coverage thresholds.

---

## License

MIT – Built to be used in open-source and commercial projects alike.
