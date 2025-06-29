# Persistent JSON Storage

A lightweight, class-based JSON storage module for Node.js that uses the filesystem for persisting structured key-value data. Designed for **atomic writes**, **cross-instance sync**, and **watch-based reactivity**, it's perfect for local persistence, caching, or lightweight state management.

---

## 🚀 Features

- **Safe, atomic writes** (temp file + rename strategy)
- **Supports nested folders** for scoped persistence
- **Queue-based concurrency** ensures safe access per file
- **Multi-instance aware**: storage stays in sync across instances
- **Real-time sync** using filesystem watchers (`chokidar`)
- **Automatic cleanup** of temp files
- **Efficient key indexing** via MD5-hashed filenames

---

## 📦 Installation

```bash
npm install @heisenware/storage
```

---

## ✨ Usage

```js
const Storage = require('@heisenware/storage')

const storage = new Storage({ dir: '/tmp/my-app-store' })

await storage.setItem('user123', { name: 'Alice', active: true })
const user = await storage.getItem('user123')
console.log(user) // { name: 'Alice', active: true }

await storage.removeItem('user123')
await storage.clear() // clears all stored entries
```

---

## 📁 Folder Support

Store and query items within custom subfolders:

```js
await storage.setItem('session42', { token: 'abc' }, { folder: 'sessions' })
const keys = await storage.keys('sessions') // ['session42']
```

---

## 🧠 Internal Design

- Files are named using `MD5(key)` to avoid path issues.
- Each entry is stored as a single JSON file: `{ key, value }`.
- Temp files use `.tmp-<timestamp>` suffix and are cleaned if needed.
- `chokidar` watches for external changes and updates all instances.

---

## 🛠 API

### `new Storage({ dir, log })`

Create a storage instance.

- `dir`: absolute path to storage directory
- `log`: optional logger (defaults to `console`)

### `setItem(key, value, { folder })`

Persist a key-value pair.

### `getItem(key)`

Retrieve a previously stored value.

### `removeItem(key)`

Delete an entry.

### `keys(folder)`

List all stored keys, optionally scoped to a folder.

### `clear({ folder })`

Clear all entries (optionally in a subfolder).

---

## 🔒 Atomicity & Concurrency

Each file operation uses a per-file async queue, ensuring that overlapping reads/writes don't corrupt files.
This package is race-protected against concurrent file access withing the scope of a single-process.

---

## ✅ Tests

Includes a full integration test suite for reading, writing, concurrency, and multi-instance interaction.

To run:

```bash
npm test
```

---

⚠️ Known Limitation: OS-native bulk-clear and File Watchers

Due to limitations in file system watchers like chokidar, bulk operations such
as for example `fs-extra`’s `emptyDir` do not trigger file removal events.

When these operations are executed externally, the `storage` instance may loose
synchronization. In that case, it is advisable to re-create the instance which
leads to a re-synchronization.

---

## 📜 License

MIT – Built to be used in open-source and commercial projects alike.

---

## 💡 Contributing

Contributions, bug reports, and PRs are welcome. Let’s make local storage a breeze for Node.js!
