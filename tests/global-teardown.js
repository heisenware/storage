// tests/global-teardown.js
// Diagnostic: prints every libuv handle still active when Jest finishes.
// Names the exact culprit type where --detectOpenHandles stays blind.
module.exports = async () => {
  // Give dispose() stragglers the same beat Jest gives them
  await new Promise(resolve => setTimeout(resolve, 100))

  const handles = process._getActiveHandles()
  const summary = {}
  for (const h of handles) {
    const name = h?.constructor?.name || 'Unknown'
    summary[name] = (summary[name] || 0) + 1
  }
  console.log('[teardown] active handles:', JSON.stringify(summary))
}
