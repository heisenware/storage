// index.mjs
// ESM entry point for dual-publishing. The CJS source stays canonical;
// this thin wrapper re-exports it for `import` consumers.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Storage = require('./src/Storage.js')

export default Storage
