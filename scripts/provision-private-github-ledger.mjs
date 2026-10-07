import { openSync, closeSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [flag, statePath, runtimePackage] = process.argv.slice(2);
if (flag !== '--explicitly-new-ledger' || !statePath || !path.isAbsolute(statePath) || !runtimePackage || !path.isAbsolute(runtimePackage)) throw Error('Required: --explicitly-new-ledger ABSOLUTE_NEW_LEDGER ABSOLUTE_RUNTIME_PACKAGE_JSON. Never use for restoration or an expected existing ledger.');
const require = createRequire(runtimePackage);
const { createLocalProtectionSession } = await import(pathToFileURL(require.resolve('@once-agent/sdk/connect')).href);
mkdirSync(path.dirname(statePath),{recursive:true});
closeSync(openSync(statePath,'wx',0o600)); // Existing files, including invalid ones, are never reset.
const session = createLocalProtectionSession(statePath);
try { await session.databaseForCall(); } finally { session.close(); }
console.log('Explicit NEW ledger provisioned. Keep this path and all task identities across restarts.');
