# Persistent Git-Backed JSON Storage

[![neostandard](https://img.shields.io/badge/code_style-neostandard-brightgreen?style=flat)](https://github.com/neostandard/neostandard)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/heisenware/storage/actions/workflows/ci.yml/badge.svg)](https://github.com/heisenware/storage/actions/workflows/ci.yml)

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

Tags turn the storage into a versioned database with painless version
management. Look into the past with a versioned read, go back with
`restore()`:

```js
// Snapshot a milestone
await storage.commit('feat: stable state')
await storage.createTag('v1.0.0', 'Stable baseline')

// Keep working ...
await storage.setItem('user-456', { name: 'Bob' })
await storage.commit('feat: add bob')

// Peek into the past - a pure read, nothing changes
const old = await storage.getItem('user-456', { version: 'v1.0.0' }) // null

// Re-establish the old version. restore() rolls the state FORWARD to the
// tagged content as a new commit - no history rewrite, so it works with
// remotes and auto-sync, and every in-between version stays in the
// history (and can itself be restored again).
await storage.restore('v1.0.0')
await storage.getItem('user-456') // null - state equals v1.0.0 again

// Work with an old version on the side, without touching the main line
await storage.createBranch('hotfix-v1', { at: 'v1.0.0' })
await storage.checkout('master') // back to the present

// Inspect and clean up the version history
const tags = await storage.listTags() // ['v1.0.0', ...]
await storage.renameTag('v1.0.0', 'v1.0.0-legacy') // same commit, new name
await storage.deleteTag('v1.0.0-legacy') // removes the tag, keeps the history
```

Note that `checkout()` deliberately switches between _branches_ only —
re-establishing a version is always `restore()`, inspecting one is always a
versioned `getItem()`. This keeps rollbacks safe in every topology, from a
single local storage to an auto-synced fleet.

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

## Remote Sync & Authentication

Connect the storage to a remote repository and keep it in sync — manually via
`push()`/`pull()`, or fully automatic:

```js
const storage = await Storage.open({
  dir: '/var/lib/my-app-store',
  git: {
    init: true,
    remote: 'https://github.com/acme/app-state.git',
    auth: { token: process.env.GIT_TOKEN },
    strategy: 'local-wins', // the default
    autoSync: { interval: 30000 } // commit -> pull -> push every 30s
  }
})
```

### Authentication

- The token is injected into git **via the child-process environment only** —
  it is never written to `.git/config`, never appears in process arguments,
  and never touches any file on disk.
- The default username `oauth2` works for GitHub and GitLab personal access
  tokens as well as GitLab OAuth tokens. Override it via
  `auth: { token, username }` — use `x-access-token` for GitHub App
  installation tokens and `x-token-auth` for Bitbucket.
- SSH remotes are unaffected: leave `auth` out and the ambient SSH agent or
  credential helper of the host is used.
- Token authentication requires **git >= 2.31** (March 2021). On older
  versions remote operations fail with a clean authentication error instead
  of hanging.

### Pull Strategies

When the local branch is merely behind the remote, `pull()` fast-forwards —
always. A fresh storage (no versioned data yet) connecting to an established
remote **adopts the remote history outright**, so new nodes join a shared
remote without any manual bootstrap — regardless of strategy. Otherwise a
_strategy_ decides what happens when local and remote history **diverged**
(both sides committed since the last sync):

- `'local-wins'` (default): a real merge (`merge -X ours`) — additions and
  edits from both sides survive; only keys changed on _both_ sides resolve
  in favor of local content. A subsequent `push()` succeeds without force.
- `'remote-wins'`: makes local exactly match the remote (`reset --hard`).
  **Discards diverged local commits AND uncommitted local changes.**
- `'fail'`: throws a `Storage.GitSyncError` with `code: 'GIT_DIVERGED'` and
  leaves local state untouched — for consumers that want to detect divergence
  and decide themselves.

```js
try {
  await storage.pull({ strategy: 'fail' })
} catch (err) {
  if (err.code === 'GIT_DIVERGED') {
    await storage.pull({ strategy: 'remote-wins' })
  }
}
```

The default strategy can be set once via `git: { strategy }`. Calling `push()`
or `pull()` without a configured remote throws a `GitSyncError` with
`code: 'GIT_NO_REMOTE'`.

### Auto-Sync

`git: { autoSync: { interval, strategy } }` runs a commit → pull → push cycle
on an interval (default 30s, minimum 1s). Cycles never overlap, pause
automatically while another process performs a mass mutation, never keep the
Node.js process alive, and stop on `dispose()`. Errors are logged through the
configured logger (throttled — each distinct failure is logged once), so a
temporarily unreachable remote does not spam the log.

Auto-sync is **pinned to its sync branch** (the `branch` option, or the
branch present when the first cycle ran): while any other branch is checked
out, cycles pause — so branch experiments are never synced accidentally —
and resume automatically when you switch back.

### Restoring Versions in a Synced Storage

`restore(tag)` is sync-safe by construction: it re-establishes the old
content as a _new forward commit_, which pushes without force and reaches
every other node through normal synchronization. Branch rewinds, by
contrast, cannot survive synchronization — a rewound branch is
indistinguishable from an out-of-date node and gets synced right back —
which is why `checkout()` accepts existing branches only.

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

### `await Storage.open({ dir, log, git, watch, exclusive })`

Opens (or re-opens) the storage for a directory — the only way to obtain an
instance; direct construction throws. The first call creates a fully
initialized instance (a resolved `open()` includes Git setup); subsequent
calls return the existing instance with a rescanned key map.

- `dir`: absolute path to storage directory
- `log`: optional logger (defaults to `console`)
- `git`: optional config `{ init: boolean, remote: string, branch: string, ignore: string[], auth: { token, username }, strategy: 'local-wins' | 'remote-wins' | 'fail', autoSync: { interval, strategy } }`
- `watch`: optional boolean (default `true`); `false` skips the filesystem watcher
- `exclusive`: optional boolean (default `false`); claims sole cross-process ownership

### Data Operations

- `setItem(key, value, { folder })`: Persist a key-value pair. Writes to the
  same key are applied strictly in call order.
- `getItem(key, { version })`: Retrieve a previously stored value. With the
  optional `version` (tag or commit) the value is read as it existed at that
  version — without changing any state.
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
- `createBranch(name, { at })` / `checkout(branchName)`: Creates branches and
  swaps between them, instantly resyncing memory. With `at` (a tag or
  commit) the new branch starts at that version instead of the current
  state. Tags and commits are not valid checkout targets — use `restore()`
  instead.
- `restore(tagOrCommit, [message])`: Re-establishes the data state of a
  previous version as a new forward commit — no history rewrite, safe with
  remotes and auto-sync. Uncommitted changes are snapshotted first; returns
  the commit hash, or `null` when the state already matches.
- `createTag(name, [message])`: Tags the current state (annotated when a
  message is given).
- `listTags()`: Returns all tag names as a plain string array.
- `deleteTag(name)`: Removes a tag while keeping the commit history.
- `renameTag(oldName, newName)`: Renames a tag; the target commit is
  unchanged.
- `push()`: Pushes local commits to `origin`, setting the upstream on first
  push. Throws `GitSyncError` (`GIT_NO_REMOTE`) without a configured remote.
- `pull({ strategy })`: Fetches and integrates remote changes, then resyncs
  memory. Fast-forwards when merely behind; on diverged histories the
  strategy decides: `'local-wins'` (default), `'remote-wins'`, or `'fail'`
  (throws `GitSyncError` with `code: 'GIT_DIVERGED'`). See
  [Remote Sync & Authentication](#remote-sync--authentication).

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

### Multi-Process Contract

Multiple processes may share the same storage directory. The library
guarantees:

- **Reads converge** across processes via filesystem watchers.
- **Writes are atomic** (temp file + rename); ordering is guaranteed per
  process (last caller wins) — across processes, last-rename-wins.
- **Git operations and root `clear()` are mutually exclusive** across
  processes through an advisory lock with automatic staleness recovery.
  While one process performs a mass mutation (checkout, clear), the
  watchers of all other processes pause and resync afterwards.
- **Exclusive ownership** is available on demand:

```js
// Throws immediately if another live process owns the directory
const storage = await Storage.open({ dir: '/shared/data/app1', exclusive: true })
```

Supported topology: processes on the same host (including Docker volumes on
Linux). Network filesystems (NFS) make both `inotify` and lock staleness
unreliable and are not supported.

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
