# JSON File Storage

Asynchronous persistent data structures in Node.js, modeled after HTML5
localStorage

_@heisenware/storage_ doesn't use a database. Instead, JSON documents are stored
in the file system for persistence. Because there is no network and relational
query overhead, _@heisenware/storage_ is just about as fast as a database can
get.

## Install

npm install @heisenware/storage

## Example

```javascript
const Storage = require('@heisenware/storage')
const path = require('path')

const storage = new Storage({ dir: path.join(__dirname, 'my-storage') })
await storage.setItem('item1', 'value1')
const item1 = await storage.getItem('item1')
console.log('item1:', item1)
await storage.removeItem('item1')
```
