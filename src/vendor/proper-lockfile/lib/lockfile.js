'use strict';

// Vendored from proper-lockfile@4.1.2 (MIT, (c) Made With MOXY Lda
// <hello@moxy.studio>, see ../LICENSE). Patched by @heisenware/storage to
// fix an uncaught async crash in the keepalive timer:
//
// 1. `updateLock()` guards against the lock having been released/removed
//    while an `fs.stat`/`fs.utimes` callback was in flight (previously the
//    retry path re-entered with `locks[...] === undefined` -> TypeError,
//    and the stat error path called onCompromised after release).
// 2. The internal registry is keyed by the LOCKFILE path instead of the
//    locked file path, so two locks on the same file with different
//    `lockfilePath` options (as used for the operation and ownership locks
//    of a storage directory) no longer clobber each other's entries.
//
// All patched lines are marked with `PATCH:` comments.

const path = require('path');
const fs = require('graceful-fs');
const retry = require('retry');
const onExit = require('signal-exit');
const mtimePrecision = require('./mtime-precision');

const locks = {};

function getLockFile(file, options) {
    return options.lockfilePath || `${file}.lock`;
}

function resolveCanonicalPath(file, options, callback) {
    if (!options.realpath) {
        return callback(null, path.resolve(file));
    }

    // Use realpath to resolve symlinks
    // It also resolves relative paths
    options.fs.realpath(file, callback);
}

function acquireLock(file, options, callback) {
    const lockfilePath = getLockFile(file, options);

    // Use mkdir to create the lockfile (atomic operation)
    options.fs.mkdir(lockfilePath, (err) => {
        if (!err) {
            // At this point, we acquired the lock!
            // Probe the mtime precision
            return mtimePrecision.probe(lockfilePath, options.fs, (err, mtime, mtimePrecision) => {
                // If it failed, try to remove the lock..
                /* istanbul ignore if */
                if (err) {
                    options.fs.rmdir(lockfilePath, () => {});

                    return callback(err);
                }

                callback(null, mtime, mtimePrecision);
            });
        }

        // If error is not EEXIST then some other error occurred while locking
        if (err.code !== 'EEXIST') {
            return callback(err);
        }

        // Otherwise, check if lock is stale by analyzing the file mtime
        if (options.stale <= 0) {
            return callback(Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED', file }));
        }

        options.fs.stat(lockfilePath, (err, stat) => {
            if (err) {
                // Retry if the lockfile has been removed (meanwhile)
                // Skip stale check to avoid recursiveness
                if (err.code === 'ENOENT') {
                    return acquireLock(file, { ...options, stale: 0 }, callback);
                }

                return callback(err);
            }

            if (!isLockStale(stat, options)) {
                return callback(Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED', file }));
            }

            // If it's stale, remove it and try again!
            // Skip stale check to avoid recursiveness
            removeLock(file, options, (err) => {
                if (err) {
                    return callback(err);
                }

                acquireLock(file, { ...options, stale: 0 }, callback);
            });
        });
    });
}

function isLockStale(stat, options) {
    return stat.mtime.getTime() < Date.now() - options.stale;
}

function removeLock(file, options, callback) {
    // Remove lockfile, ignoring ENOENT errors
    options.fs.rmdir(getLockFile(file, options), (err) => {
        if (err && err.code !== 'ENOENT') {
            return callback(err);
        }

        callback();
    });
}

function updateLock(key, options) {
    const lock = locks[key];

    // PATCH: the retry paths of the stat/utimes callbacks re-enter this
    // function asynchronously; by then the lock may have been released and
    // removed from the registry. Bail out instead of crashing.
    if (!lock || lock.released) {
        return;
    }

    // Just for safety, should never happen
    /* istanbul ignore if */
    if (lock.updateTimeout) {
        return;
    }

    lock.updateDelay = lock.updateDelay || options.update;
    lock.updateTimeout = setTimeout(() => {
        lock.updateTimeout = null;

        // Stat the file to check if mtime is still ours
        // If it is, we can still recover from a system sleep or a busy event loop
        options.fs.stat(lock.lockfilePath, (err, stat) => {
            // PATCH: ignore if the lock was released while the stat was in
            // flight (mirrors the pre-existing guard in the utimes callback);
            // a released lock's missing lockfile is not a compromise.
            if (lock.released) {
                return;
            }

            const isOverThreshold = lock.lastUpdate + options.stale < Date.now();

            // If it failed to update the lockfile, keep trying unless
            // the lockfile was deleted or we are over the threshold
            if (err) {
                if (err.code === 'ENOENT' || isOverThreshold) {
                    return setLockAsCompromised(key, lock, Object.assign(err, { code: 'ECOMPROMISED' }));
                }

                lock.updateDelay = 1000;

                return updateLock(key, options);
            }

            const isMtimeOurs = lock.mtime.getTime() === stat.mtime.getTime();

            if (!isMtimeOurs) {
                return setLockAsCompromised(
                    key,
                    lock,
                    Object.assign(
                        new Error('Unable to update lock within the stale threshold'),
                        { code: 'ECOMPROMISED' }
                    ));
            }

            const mtime = mtimePrecision.getMtime(lock.mtimePrecision);

            options.fs.utimes(lock.lockfilePath, mtime, mtime, (err) => {
                const isOverThreshold = lock.lastUpdate + options.stale < Date.now();

                // Ignore if the lock was released
                if (lock.released) {
                    return;
                }

                // If it failed to update the lockfile, keep trying unless
                // the lockfile was deleted or we are over the threshold
                if (err) {
                    if (err.code === 'ENOENT' || isOverThreshold) {
                        return setLockAsCompromised(key, lock, Object.assign(err, { code: 'ECOMPROMISED' }));
                    }

                    lock.updateDelay = 1000;

                    return updateLock(key, options);
                }

                // All ok, keep updating..
                lock.mtime = mtime;
                lock.lastUpdate = Date.now();
                lock.updateDelay = null;
                updateLock(key, options);
            });
        });
    }, lock.updateDelay);

    // Unref the timer so that the nodejs process can exit freely
    // This is safe because all acquired locks will be automatically released
    // on process exit

    // We first check that `lock.updateTimeout.unref` exists because some users
    // may be using this module outside of NodeJS (e.g., in an electron app),
    // and in those cases `setTimeout` return an integer.
    /* istanbul ignore else */
    if (lock.updateTimeout.unref) {
        lock.updateTimeout.unref();
    }
}

function setLockAsCompromised(key, lock, err) {
    // Signal the lock has been released
    lock.released = true;

    // Cancel lock mtime update
    // Just for safety, at this point updateTimeout should be null
    /* istanbul ignore if */
    if (lock.updateTimeout) {
        clearTimeout(lock.updateTimeout);
    }

    if (locks[key] === lock) {
        delete locks[key];
    }

    lock.options.onCompromised(err);
}

// ----------------------------------------------------------

function lock(file, options, callback) {
    /* istanbul ignore next */
    options = {
        stale: 10000,
        update: null,
        realpath: true,
        retries: 0,
        fs,
        onCompromised: (err) => { throw err; },
        ...options,
    };

    options.retries = options.retries || 0;
    options.retries = typeof options.retries === 'number' ? { retries: options.retries } : options.retries;
    options.stale = Math.max(options.stale || 0, 2000);
    options.update = options.update == null ? options.stale / 2 : options.update || 0;
    options.update = Math.max(Math.min(options.update, options.stale / 2), 1000);

    // Resolve to a canonical file path
    resolveCanonicalPath(file, options, (err, file) => {
        if (err) {
            return callback(err);
        }

        // Attempt to acquire the lock
        const operation = retry.operation(options.retries);

        operation.attempt(() => {
            acquireLock(file, options, (err, mtime, mtimePrecision) => {
                if (operation.retry(err)) {
                    return;
                }

                if (err) {
                    return callback(operation.mainError());
                }

                // We now own the lock
                // PATCH: the registry is keyed by the lockfile path (not
                // the locked file), so locks on the same file with distinct
                // lockfilePath options do not clobber each other.
                const key = getLockFile(file, options);
                const lock = locks[key] = {
                    lockfilePath: key,
                    mtime,
                    mtimePrecision,
                    options,
                    lastUpdate: Date.now(),
                };

                // We must keep the lock fresh to avoid staleness
                updateLock(key, options);

                callback(null, (releasedCallback) => {
                    if (lock.released) {
                        return releasedCallback &&
                            releasedCallback(Object.assign(new Error('Lock is already released'), { code: 'ERELEASED' }));
                    }

                    // Not necessary to use realpath twice when unlocking
                    unlock(file, { ...options, realpath: false }, releasedCallback);
                });
            });
        });
    });
}

function unlock(file, options, callback) {
    options = {
        fs,
        realpath: true,
        ...options,
    };

    // Resolve to a canonical file path
    resolveCanonicalPath(file, options, (err, file) => {
        if (err) {
            return callback(err);
        }

        // Skip if the lock is not acquired
        // PATCH: registry keyed by lockfile path, see lock()
        const key = getLockFile(file, options);
        const lock = locks[key];

        if (!lock) {
            return callback(Object.assign(new Error('Lock is not acquired/owned by you'), { code: 'ENOTACQUIRED' }));
        }

        lock.updateTimeout && clearTimeout(lock.updateTimeout); // Cancel lock mtime update
        lock.released = true; // Signal the lock has been released
        delete locks[key]; // Delete from locks

        removeLock(file, options, callback);
    });
}

function check(file, options, callback) {
    options = {
        stale: 10000,
        realpath: true,
        fs,
        ...options,
    };

    options.stale = Math.max(options.stale || 0, 2000);

    // Resolve to a canonical file path
    resolveCanonicalPath(file, options, (err, file) => {
        if (err) {
            return callback(err);
        }

        // Check if lockfile exists
        options.fs.stat(getLockFile(file, options), (err, stat) => {
            if (err) {
                // If does not exist, file is not locked. Otherwise, callback with error
                return err.code === 'ENOENT' ? callback(null, false) : callback(err);
            }

            // Otherwise, check if lock is stale by analyzing the file mtime
            return callback(null, !isLockStale(stat, options));
        });
    });
}

function getLocks() {
    return locks;
}

// Remove acquired locks on exit
/* istanbul ignore next */
onExit(() => {
    // PATCH: registry keyed by lockfile path; the entry carries it directly
    for (const key in locks) {
        const lock = locks[key];

        try { lock.options.fs.rmdirSync(lock.lockfilePath); } catch (e) { /* Empty */ }
    }
});

module.exports.lock = lock;
module.exports.unlock = unlock;
module.exports.check = check;
module.exports.getLocks = getLocks;
