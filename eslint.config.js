// eslint.config.js
// ESLint 9 flat config using neostandard (the successor of standard-js).
// Style baseline: no semicolons, single quotes, 2-space indent,
// space before function parentheses - i.e. classic standard style.
const neostandard = require('neostandard')
const globals = require('globals')

module.exports = [
  ...neostandard({
    // Reuse the repository's .gitignore (node_modules, coverage, etc.).
    // src/vendor holds patched third-party code that keeps its upstream
    // style (semicolons, 4-space indent) for diffability.
    ignores: [...neostandard.resolveIgnoresFromGitignore(), 'src/vendor/**']
  }),
  {
    // Declare the Jest globals (describe, it, expect, ...) for test files,
    // otherwise no-undef flags every single test
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.jest }
    }
  }
]
