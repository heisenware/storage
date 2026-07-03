# Persistent Git-Backed JSON Storage

A lightweight, class-based JSON storage module for Node.js that uses the
filesystem for persisting structured key-value data. Designed for **atomic
writes**, **cross-instance sync**, and **first-class Git version control**, it's
perfect for local persistence, auditable databases, branching test environments,
or lightweight state management.

---

## Features

- **Version Controlled**: native Git snapshotting, branching, and remote syncing.
- **Safe, atomic writes** (temp file + rename strategy).
- **Human-Readable Files**: keys are saved as beautifully transparent `.json` files.
- **Supports nested folders** for scoped persistence.
- **Queue-based concurrency** ensures safe access per file.
- **Multi-instance aware**: storage stays in sync across instances via `chokidar`.

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

## Folder Support

Store and query items within custom subfolders. Path traversal is rigorously
prevented.

```js
await storage.setItem('session-42', { token: 'abc' }, { folder: 'sessions' })
const keys = await storage.keys('sessions') // ['session-42']
```

---

## Internal Design

- Files are directly named `<key>.json` for human-readability and clean Git
  diffs.
- Each entry is stored as a single JSON file: `{ key, value }`.
- Temp files use `.tmp-<timestamp>` suffix and are cleaned if needed.
- `chokidar` watches for external changes and updates all instances. Watchers
  are safely paused during Git branch checkouts.

---

## API

### `new Storage({ dir, log, git })`

Create a storage instance.

- `dir`: absolute path to storage directory
- `log`: optional logger (defaults to `console`)
- `git`: optional config `{ init: boolean, remote: string }`.

### Data Operations

- `setItem(key, value, { folder })`: Persist a key-value pair.
- `getItem(key)`: Retrieve a previously stored value.
- `removeItem(key)`: Delete an entry.
- `keys(folder)`: List all stored keys, optionally scoped to a folder.
- `clear({ folder })`: Clear entries. Protects `.git` files if clearing the root.

### Git Operations

- `getGitStatus()`: Returns an object `{ branch, isClean, added, modified,
  deleted }` mapping directly to your keys.
- `commit(message)`: Commits changes. Auto-generates a smart message if none is
  provided.
- `createBranch(name)` / `checkout(name)`: Swaps Git branches and instantly
  resyncs memory.
- `push()` / `pull()`: Synchronizes with remote Git endpoints.

### Utility

- `Storage.migrateFromV1(dir)`: One-time utility to unpack V1 (MD5 hashed)
  databases into V2 formats.

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

## License

MIT – Built to be used in open-source and commercial projects alike.
