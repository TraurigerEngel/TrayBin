'use strict';
// Used by CREATE-SOURCE-ARCHIVE.ps1; compatible with Node.js 22 on Windows.
const fs = require('node:fs');

function fail(reason) {
  process.stderr.write(`NPM LOCK VERIFY FAILED: ${reason}\n`);
  process.exitCode = 2;
}

const [lockPath, expectedVersion, expectedName] = process.argv.slice(2);
if (!lockPath || !expectedVersion || !expectedName) {
  fail('Expected path, version, and name');
} else {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const root = lock.packages && lock.packages[''];
    if (!root || lock.version !== expectedVersion || root.version !== expectedVersion ||
        lock.name !== expectedName || (root.name && root.name !== expectedName)) {
      fail('Version or package name differs from package.json');
    } else {
      process.stdout.write('NPM LOCK VERIFIED\n');
    }
  } catch (error) {
    fail(error.message);
  }
}
