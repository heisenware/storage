// tests/git-sync.spec.js
const path = require('path')
const fs = require('fs-extra')
const { execSync } = require('child_process')
const Storage = require('../src/Storage')
const GitManager = require('../src/GitManager')

/** Silent logger to keep Jest output free of expected warnings. */
const silentLog = { info () {}, warn () {}, error () {} }

/**
 * Polls an async predicate until it returns true or the timeout is reached.
 */
async function waitFor (predicate, timeout = 3000, interval = 50) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  return false
}

/**
 * Commits a { key, value } JSON file into a fresh clone of the given bare
 * remote and pushes it - the canonical way to make the remote diverge from
 * (or advance beyond) the local storage.
 */
function pushFromClone (remoteDir, cloneDir, key, value) {
  fs.rmSync(cloneDir, { recursive: true, force: true })
  execSync(`git clone ${remoteDir} ${cloneDir}`, { stdio: 'ignore' })
  fs.writeJsonSync(path.join(cloneDir, `${key}.json`), { key, value })
  execSync('git add .', { cwd: cloneDir })
  execSync(
    `git -c user.name=clone -c user.email=clone@test commit -m "clone: ${key}"`,
    { cwd: cloneDir }
  )
  execSync('git push origin master', { cwd: cloneDir, stdio: 'ignore' })
}

/** Resolves the current commit hash of a repository (bare or working). */
function headOf (repoDir, ref = 'HEAD') {
  return execSync(`git rev-parse ${ref}`, {
    cwd: repoDir,
    stdio: ['pipe', 'pipe', 'ignore'] // polled on not-yet-existing refs
  })
    .toString()
    .trim()
}

// ===========================================================================
// TOKEN AUTHENTICATION (ENV-INJECTED CREDENTIAL HELPER)
// ===========================================================================
describe('git token authentication', () => {
  const dir = path.join(__dirname, 'test-storage-git-auth')
  const TOKEN = 'sekret-test-token-12345'

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('builds an auth env that never contains the token in the helper string', () => {
    const env = GitManager._buildAuthEnv({ token: TOKEN })

    expect(env.STORAGE_GIT_AUTH_TOKEN).toBe(TOKEN)
    expect(env.STORAGE_GIT_AUTH_USER).toBe('oauth2')
    expect(env.GIT_CONFIG_VALUE_1).not.toContain(TOKEN)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('respects a custom username', () => {
    const env = GitManager._buildAuthEnv({
      token: TOKEN,
      username: 'x-access-token'
    })
    expect(env.STORAGE_GIT_AUTH_USER).toBe('x-access-token')
  })

  it('makes real git resolve the credentials from the environment', () => {
    // 'git credential fill' runs the configured helpers exactly like an
    // HTTPS push/pull would - this proves end-to-end resolution without
    // needing a network remote
    const env = { ...process.env, ...GitManager._buildAuthEnv({ token: TOKEN }) }
    const output = execSync('git credential fill', {
      env,
      input: 'protocol=https\nhost=example.com\n\n'
    }).toString()

    expect(output).toContain('username=oauth2')
    expect(output).toContain(`password=${TOKEN}`)
  })

  it('never persists the token or helper to .git/config', async () => {
    const storage = await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, auth: { token: TOKEN } }
    })

    await storage.setItem('auth-item', { secret: false })
    await storage.commit('feat: add item with auth configured')

    const gitConfig = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf-8')
    expect(gitConfig).not.toContain(TOKEN)
    expect(gitConfig).not.toContain('credential')
  })

  it('keeps the inherited process environment alive (PATH etc.)', async () => {
    const storage = await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, auth: { token: TOKEN } }
    })

    // The helper is visible through the instance's injected environment ...
    const configList = await storage._gitManager.git.raw(['config', '--list'])
    expect(configList).toContain('credential.helper=!f()')

    // ... but not to plain git in the same repository (nothing persisted),
    // proving the configuration lives in the child env only
    const plainConfig = execSync('git config --list', { cwd: dir }).toString()
    expect(plainConfig).not.toContain('!f()')
  })
})

// ===========================================================================
// PULL STRATEGIES (DIVERGED HISTORIES)
// ===========================================================================
describe('pull strategies against a diverged remote', () => {
  const dir = path.join(__dirname, 'test-storage-git-sync')
  const remoteDir = path.join(__dirname, 'test-storage-git-sync-bare')
  const cloneDir = path.join(__dirname, 'test-storage-git-sync-clone')
  let storage

  beforeAll(async () => {
    fs.mkdirpSync(remoteDir)
    execSync('git init --bare -b master .', { cwd: remoteDir })

    storage = await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, remote: remoteDir }
    })
    await storage.setItem('base', { seeded: true })
    await storage.commit('feat: seed')
    await storage.push()
  })

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(remoteDir, { recursive: true, force: true })
    fs.rmSync(cloneDir, { recursive: true, force: true })
  })

  it("strategy 'fail' throws GIT_DIVERGED and leaves local state untouched", async () => {
    await storage.setItem('local-item', { origin: 'local' })
    await storage.commit('feat: local change')
    pushFromClone(remoteDir, cloneDir, 'remote-item', { origin: 'clone' })

    const headBefore = headOf(dir)
    await expect(storage.pull({ strategy: 'fail' })).rejects.toMatchObject({
      name: 'GitSyncError',
      code: 'GIT_DIVERGED'
    })

    expect(headOf(dir)).toBe(headBefore)
    await expect(storage.getItem('local-item')).resolves.toEqual({
      origin: 'local'
    })
    expect(storage.has('remote-item')).toBe(false)
  })

  it('default (local-wins) merges both sides and enables a plain push', async () => {
    // Still diverged from the previous test
    await storage.pull()

    // Non-conflicting changes from BOTH sides survive the merge
    await expect(storage.getItem('local-item')).resolves.toEqual({
      origin: 'local'
    })
    expect(storage.has('remote-item')).toBe(true)

    // The remote history was consumed, so no force is needed
    await storage.push()
    expect(headOf(remoteDir, 'master')).toBe(headOf(dir))
  })

  it('default (local-wins) resolves same-key conflicts in favor of local content', async () => {
    await storage.setItem('conflict-key', { winner: 'local' })
    await storage.commit('feat: local conflict side')
    pushFromClone(remoteDir, cloneDir, 'conflict-key', { winner: 'clone' })

    await storage.pull()
    await storage.push()

    await expect(storage.getItem('conflict-key')).resolves.toEqual({
      winner: 'local'
    })
    expect(headOf(remoteDir, 'master')).toBe(headOf(dir))
  })

  it("strategy 'remote-wins' resets local to the exact remote state", async () => {
    await storage.setItem('local-2', { origin: 'local' })
    await storage.commit('feat: second local change')
    pushFromClone(remoteDir, cloneDir, 'remote-2', { origin: 'clone' })

    await storage.pull({ strategy: 'remote-wins' })

    expect(headOf(dir)).toBe(headOf(remoteDir, 'master'))
    expect(storage.has('remote-2')).toBe(true)
    expect(storage.has('local-2')).toBe(false)
  })

  it('fast-forwards when merely behind - under every strategy', async () => {
    pushFromClone(remoteDir, cloneDir, 'remote-3', { origin: 'clone' })

    // 'fail' only rejects DIVERGED histories, not plain catch-ups
    await storage.pull({ strategy: 'fail' })

    expect(storage.has('remote-3')).toBe(true)
    expect(headOf(dir)).toBe(headOf(remoteDir, 'master'))
  })

  it('rejects an unknown strategy', async () => {
    await expect(storage.pull({ strategy: 'nope' })).rejects.toThrow(
      /Unknown pull strategy/
    )
  })

  it('restore() re-establishes an old version and syncs like a normal change', async () => {
    await storage.createTag('pre-rollback')
    await storage.setItem('post-tag', { late: true })
    await storage.commit('feat: post tag')
    await storage.push()

    // Roll FORWARD to the tagged version: a new commit, no branch rewind
    await storage.restore('pre-rollback')
    expect(storage.has('post-tag')).toBe(false)

    // The restore commit is ahead-only: pull stays a no-op (the rollback
    // survives synchronization) and push needs no force
    await storage.pull()
    expect(storage.has('post-tag')).toBe(false)

    await storage.push()
    expect(headOf(remoteDir, 'master')).toBe(headOf(dir))
  })

  it('rejects tag checkouts in favor of restore()', async () => {
    await expect(storage.checkout('pre-rollback')).rejects.toThrow(
      /existing branches only/
    )
  })
})

// ===========================================================================
// PULL CONFIGURATION & EDGE CASES
// ===========================================================================
describe('pull configuration and edge cases', () => {
  const cfgDir = path.join(__dirname, 'test-storage-git-cfg')
  const cfgRemoteDir = path.join(__dirname, 'test-storage-git-cfg-bare')
  const cfgCloneDir = path.join(__dirname, 'test-storage-git-cfg-clone')
  const emptyDir = path.join(__dirname, 'test-storage-git-empty')
  const emptyRemoteDir = path.join(__dirname, 'test-storage-git-empty-bare')
  const lonelyDir = path.join(__dirname, 'test-storage-git-lonely')
  const seedDir = path.join(__dirname, 'test-storage-git-seed')
  const joinDir = path.join(__dirname, 'test-storage-git-join')
  const joinRemoteDir = path.join(__dirname, 'test-storage-git-join-bare')

  afterAll(async () => {
    for (const d of [cfgDir, emptyDir, lonelyDir, seedDir, joinDir]) {
      await Storage.dispose(d)
    }
    for (const d of [
      cfgDir,
      cfgRemoteDir,
      cfgCloneDir,
      emptyDir,
      emptyRemoteDir,
      lonelyDir,
      seedDir,
      joinDir,
      joinRemoteDir
    ]) {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })

  it('honors the git.strategy config default', async () => {
    fs.mkdirpSync(cfgRemoteDir)
    execSync('git init --bare -b master .', { cwd: cfgRemoteDir })

    const storage = await Storage.open({
      dir: cfgDir,
      log: silentLog,
      git: { init: true, remote: cfgRemoteDir, strategy: 'fail' }
    })
    await storage.setItem('cfg-base', { seeded: true })
    await storage.commit('feat: seed')
    await storage.push()

    await storage.setItem('cfg-local', { origin: 'local' })
    await storage.commit('feat: local')
    pushFromClone(cfgRemoteDir, cfgCloneDir, 'cfg-remote', { origin: 'clone' })

    // A bare pull() must apply the configured 'fail' strategy
    await expect(storage.pull()).rejects.toMatchObject({
      code: 'GIT_DIVERGED'
    })
  })

  it('treats the first pull against an empty remote as a no-op', async () => {
    fs.mkdirpSync(emptyRemoteDir)
    execSync('git init --bare -b master .', { cwd: emptyRemoteDir })

    const storage = await Storage.open({
      dir: emptyDir,
      log: silentLog,
      git: { init: true, remote: emptyRemoteDir }
    })
    await storage.setItem('only-local', { fresh: true })

    await expect(storage.pull()).resolves.toBeUndefined()
    await expect(storage.getItem('only-local')).resolves.toEqual({
      fresh: true
    })
  })

  it('lets a fresh storage adopt an established remote (unrelated histories)', async () => {
    fs.mkdirpSync(joinRemoteDir)
    execSync('git init --bare -b master .', { cwd: joinRemoteDir })

    // Node A seeds the remote
    const seeder = await Storage.open({
      dir: seedDir,
      log: silentLog,
      git: { init: true, remote: joinRemoteDir }
    })
    await seeder.setItem('seeded-item', { from: 'seeder' })
    await seeder.commit('feat: seed shared remote')
    await seeder.push()

    // Node B initializes its OWN unrelated repository, then joins:
    // having no versioned data, it must adopt the remote outright
    const joiner = await Storage.open({
      dir: joinDir,
      log: silentLog,
      git: { init: true, remote: joinRemoteDir }
    })
    await joiner.pull()

    expect(joiner.has('seeded-item')).toBe(true)
    expect(headOf(joinDir)).toBe(headOf(joinRemoteDir, 'master'))
  })

  it('rejects push and pull with GIT_NO_REMOTE when no origin is configured', async () => {
    const storage = await Storage.open({
      dir: lonelyDir,
      log: silentLog,
      git: { init: true }
    })

    await expect(storage.push()).rejects.toMatchObject({
      code: 'GIT_NO_REMOTE'
    })
    await expect(storage.pull()).rejects.toMatchObject({
      code: 'GIT_NO_REMOTE'
    })
  })
})

// ===========================================================================
// AUTO-SYNC
// ===========================================================================
describe('git auto-sync', () => {
  const dir = path.join(__dirname, 'test-storage-git-autosync')
  const remoteDir = path.join(__dirname, 'test-storage-git-autosync-bare')
  const cloneDir = path.join(__dirname, 'test-storage-git-autosync-clone')
  let storage

  beforeAll(async () => {
    fs.mkdirpSync(remoteDir)
    execSync('git init --bare -b master .', { cwd: remoteDir })

    storage = await Storage.open({
      dir,
      log: silentLog,
      // interval below the clamp: effectively runs every 1000ms
      git: { init: true, remote: remoteDir, autoSync: { interval: 1 } }
    })
  })

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(remoteDir, { recursive: true, force: true })
    fs.rmSync(cloneDir, { recursive: true, force: true })
  })

  it('automatically commits and pushes local changes', async () => {
    await storage.setItem('auto-item', { synced: 'hopefully' })

    const synced = await waitFor(async () => {
      try {
        return headOf(remoteDir, 'master') === headOf(dir)
      } catch (err) {
        return false // remote branch does not exist yet
      }
    }, 10000)

    expect(synced).toBe(true)
    const status = await storage.getGitStatus()
    expect(status.isClean).toBe(true)
  })

  it('automatically pulls remote changes in', async () => {
    pushFromClone(remoteDir, cloneDir, 'from-clone', { pushed: 'remotely' })

    const arrived = await waitFor(() => storage.has('from-clone'), 10000)
    expect(arrived).toBe(true)
  })

  it('skips cycles while a mass mutation holds the git lock', async () => {
    await storage.setItem('locked-item', { blocked: true })
    storage._gitLock = true
    try {
      await storage._gitManager._autoSyncCycle()
      // Nothing was committed: the change is still pending
      const status = await storage.getGitStatus()
      expect(status.isClean).toBe(false)
    } finally {
      storage._gitLock = false
    }
  })

  it('never overlaps cycles', async () => {
    storage._gitManager._autoSyncBusy = true
    try {
      await storage._gitManager._autoSyncCycle()
      const status = await storage.getGitStatus()
      expect(status.isClean).toBe(false) // 'locked-item' still uncommitted
    } finally {
      storage._gitManager._autoSyncBusy = false
    }
  })

  it('logs repeated failures only once', async () => {
    const errors = []
    const collectingLog = { ...silentLog, error: msg => errors.push(msg) }
    const brokenDir = path.join(__dirname, 'test-storage-git-autosync-broken')

    const broken = await Storage.open({
      dir: brokenDir,
      log: collectingLog,
      git: {
        init: true,
        remote: path.join(__dirname, 'does-not-exist-bare'),
        // Long interval: the timer never fires during the test - cycles
        // are driven manually for determinism
        autoSync: { interval: 600000 }
      }
    })
    try {
      await broken.setItem('doomed', { reach: 'never' })
      await broken._gitManager._autoSyncCycle()
      await broken._gitManager._autoSyncCycle()

      const syncErrors = errors.filter(e => /auto-sync failed/.test(e))
      expect(syncErrors).toHaveLength(1)
    } finally {
      await Storage.dispose(brokenDir)
      fs.rmSync(brokenDir, { recursive: true, force: true })
    }
  })

  it('pauses cycles while a non-sync branch is checked out', async () => {
    // Auto-sync has been running on 'master' - it is pinned to it now
    await storage.createBranch('side-experiments')
    await storage.setItem('side-item', { synced: false })

    await storage._gitManager._autoSyncCycle()

    // Nothing was committed or synced on the experiment branch
    const status = await storage.getGitStatus()
    expect(status.isClean).toBe(false)

    // Clean up: keep the experiment on its branch, go back to master
    await storage.commit('feat: side item')
    await storage.checkout('master')
    expect(storage.has('side-item')).toBe(false)
  })

  it('stops the loop on dispose()', async () => {
    expect(storage._gitManager._autoSyncTimer).not.toBeNull()
    await Storage.dispose(dir)
    expect(storage._gitManager._autoSyncTimer).toBeNull()
  })
})

// ===========================================================================
// RECORDED INITIALIZATION FAILURE
// ===========================================================================
describe('recorded init failure', () => {
  const dir = path.join(__dirname, 'test-storage-git-broken-init')

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('open() succeeds, but remote operations re-throw the init failure', async () => {
    // A .git FILE with garbage content makes every git command fail while
    // the storage itself stays perfectly usable
    fs.mkdirpSync(dir)
    fs.writeFileSync(path.join(dir, '.git'), 'this is not a repository\n')

    const storage = await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, remote: '/somewhere/else' }
    })

    // Local data operations are unaffected
    await storage.setItem('still-works', { fine: true })
    await expect(storage.getItem('still-works')).resolves.toEqual({
      fine: true
    })

    // Remote operations surface the recorded failure clearly
    await expect(storage.push()).rejects.toThrow(
      /Git initialization failed earlier/
    )
    await expect(storage.pull()).rejects.toThrow(
      /Git initialization failed earlier/
    )
  })
})
