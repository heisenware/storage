// tests/git.spec.js
const path = require('path')
const fs = require('fs-extra')
const { execSync } = require('child_process')
const Storage = require('../src/Storage')

/** Silent logger to keep Jest output free of expected warnings. */
const silentLog = { info () {}, warn () {}, error () {} }

// ===========================================================================
// GIT INTEGRATION
// ===========================================================================
describe('Git version control and branching', () => {
  const dir = path.join(__dirname, 'test-storage-git')
  let storage

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('initializes a git repository and writes a .gitignore', async () => {
    // open() resolves only when the repository is fully initialized -
    // no "wait for init" dance needed anymore
    storage = await Storage.open({ dir, log: silentLog, git: { init: true } })

    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true)
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(true)
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toContain(
      '*.tmp-*'
    )
  })

  it('accurately reports git status for new files', async () => {
    await storage.setItem('user-alice', { role: 'admin' })

    const status = await storage.getGitStatus()
    expect(status.isClean).toBe(false)
    expect(status.added).toContain('user-alice')
  })

  it('commits changes and generates auto-messages', async () => {
    const hash = await storage.commit()
    expect(hash).toBeTruthy()

    const status = await storage.getGitStatus()
    expect(status.isClean).toBe(true)
  })

  it('returns null when committing without changes', async () => {
    await expect(storage.commit()).resolves.toBeNull()
  })

  it('commits items living in subfolders', async () => {
    // Regression test: staging used a root-level '*.json' glob before,
    // silently skipping every item stored in a folder
    await storage.setItem('nested-item', { deep: true }, { folder: 'apps' })

    const hash = await storage.commit('feat: add nested item')
    expect(hash).toBeTruthy()

    const status = await storage.getGitStatus()
    expect(status.isClean).toBe(true)
  })

  it('safely switches branches and re-syncs the memory map', async () => {
    await storage.createBranch('feature-branch')
    await storage.checkout('feature-branch')

    await storage.setItem('user-bob', { role: 'user' })
    await storage.removeItem('user-alice')
    await storage.commit('chore: swap users')

    await expect(storage.getItem('user-alice')).resolves.toBeNull()
    await expect(storage.getItem('user-bob')).resolves.toEqual({ role: 'user' })

    await storage.checkout('master')

    await expect(storage.getItem('user-alice')).resolves.toEqual({
      role: 'admin'
    })
    await expect(storage.getItem('user-bob')).resolves.toBeNull()
  })

  it('creates tags and gracefully rolls back without detached HEAD', async () => {
    // 1. We are on 'master'. Create a baseline tag.
    await storage.createTag('v1.0.0', 'Stable baseline')

    // 2. Add some new data and commit it to master
    await storage.setItem('user-charlie', { role: 'guest' })
    await storage.commit('feat: add charlie')

    await expect(storage.getItem('user-charlie')).resolves.toEqual({
      role: 'guest'
    })

    // 3. Rollback to the tag! Because we don't provide a branch, it should
    //    smartly move 'master' back to this tag.
    await storage.checkout('v1.0.0')

    // 4. Verify the memory state rewound
    await expect(storage.getItem('user-charlie')).resolves.toBeNull()

    // 5. Verify we are NOT in detached HEAD, but safely still on master
    const status = await storage.getGitStatus()
    expect(status.branch).toBe('master')
  })

  it('checks out a tag onto an explicitly provided new branch', async () => {
    // 1. Create a new tag where we currently are
    await storage.createTag('v1.0.1')

    // 2. Move forward on master
    await storage.setItem('user-dave', { role: 'admin' })
    await storage.commit('feat: add dave')

    // 3. Checkout the older tag and explicitly attach it to a 'hotfix' branch
    await storage.checkout('v1.0.1', 'hotfix-v1')

    // 4. Verify we are on the new branch
    const status = await storage.getGitStatus()
    expect(status.branch).toBe('hotfix-v1')

    // 5. Verify the memory state reflects the tag, not the future master commit
    await expect(storage.getItem('user-dave')).resolves.toBeNull()
  })

  it('lists all created tags as a plain string array', async () => {
    const tags = await storage.listTags()
    expect(tags).toEqual(expect.arrayContaining(['v1.0.0', 'v1.0.1']))
  })

  it('deletes tags without touching the commit history', async () => {
    await storage.deleteTag('v1.0.0')

    const tags = await storage.listTags()
    expect(tags).not.toContain('v1.0.0')
    expect(tags).toContain('v1.0.1')
  })

  it('preserves .git during clear() operations', async () => {
    await storage.clear()

    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true)
    expect(storage.keys()).toEqual([])
  })
})

// ===========================================================================
// CONFIGURABLE DEFAULT BRANCH
// ===========================================================================
describe('configurable default branch', () => {
  const dir = path.join(__dirname, 'test-storage-git-main')

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('initializes fresh repositories on the configured branch', async () => {
    const storage = await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, branch: 'main' }
    })

    const status = await storage.getGitStatus()
    expect(status.branch).toBe('main')
  })
})

// ===========================================================================
// CONSUMER-PROVIDED IGNORE PATTERNS
// ===========================================================================
describe('consumer-provided .gitignore patterns', () => {
  const dir = path.join(__dirname, 'test-storage-git-ignore')

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('merges options.ignore into the generated .gitignore', async () => {
    await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, ignore: ['state/'] }
    })

    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('*.tmp-*')
    expect(gitignore).toContain('state/')
  })

  it('keeps ignored folders invisible to status and commit', async () => {
    const storage = await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, ignore: ['state/'] }
    })

    await storage.setItem('runtime-a', { lvc: 123 }, { folder: 'state' })

    const status = await storage.getGitStatus()
    expect(status.added).not.toContain('runtime-a')

    // Nothing to commit: the only change is inside an ignored folder
    await expect(storage.commit()).resolves.toBeNull()

    // The item itself is fully readable through the storage API
    await expect(storage.getItem('runtime-a')).resolves.toEqual({ lvc: 123 })
  })

  it('syncs new ignore patterns into EXISTING repositories', async () => {
    // Re-open after dispose with an extended pattern list: the idempotent
    // .gitignore sync must update repositories initialized before the change
    await Storage.dispose(dir)
    await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, ignore: ['state/', 'cache/'] }
    })

    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('cache/')
  })
})

// ===========================================================================
// REMOTE SYNCHRONIZATION (LOCAL BARE REPOSITORY)
// ===========================================================================
describe('push and pull against a local bare remote', () => {
  const dir = path.join(__dirname, 'test-storage-git-remote')
  const remoteDir = path.join(__dirname, 'test-storage-git-remote-bare')
  let storage

  beforeAll(() => {
    fs.mkdirpSync(remoteDir)
    execSync('git init --bare -b master .', { cwd: remoteDir })
  })

  afterAll(async () => {
    await Storage.dispose(dir)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(remoteDir, { recursive: true, force: true })
  })

  it('pushes local commits to the configured remote', async () => {
    storage = await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, remote: remoteDir }
    })

    await storage.setItem('shared-item', { revision: 1 })
    await storage.commit('feat: first shared revision')
    await storage.push()

    // The bare remote must now know the master branch
    const remoteHead = execSync('git rev-parse master', {
      cwd: remoteDir
    })
      .toString()
      .trim()
    expect(remoteHead).toMatch(/^[0-9a-f]{40}$/)
  })

  it('pulls remote changes and re-syncs the memory map', async () => {
    // Move forward locally and push, so the remote is ahead of what we
    // are about to reset to
    await storage.setItem('shared-item', { revision: 2 })
    await storage.commit('feat: second shared revision')
    await storage.push()

    // Simulate an outdated local state by hard-resetting one commit back
    execSync('git reset --hard HEAD~1', { cwd: dir })
    // Rebuild the memory map from the rewound working tree
    await Storage.dispose(dir)
    storage = await Storage.open({
      dir,
      log: silentLog,
      git: { init: true, remote: remoteDir }
    })
    await expect(storage.getItem('shared-item')).resolves.toEqual({
      revision: 1
    })

    // Pulling must fast-forward to the pushed state and re-sync memory
    await storage.pull()
    await expect(storage.getItem('shared-item')).resolves.toEqual({
      revision: 2
    })
  })
})
