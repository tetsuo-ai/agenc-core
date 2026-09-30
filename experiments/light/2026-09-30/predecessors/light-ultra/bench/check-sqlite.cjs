const { createRequire } = require('node:module');
const load = createRequire(process.argv[2] + '/package.json');
const DB = load('better-sqlite3');
const db = new DB(':memory:');
db.prepare('SELECT 1').get();
db.close();
console.log('SQLite startup check passed');
