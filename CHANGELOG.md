# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

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
