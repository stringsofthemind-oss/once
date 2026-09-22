import { join } from 'node:path';
import { loadRuntime, storage, execute } from './harness.mjs';

const [dir, boundary] = process.argv.slice(2);
const { Runtime } = await loadRuntime();
const store = storage(join(dir, 'ledger.db'));
const effects = storage(join(dir, 'provider.db'));
effects.sql.exec('CREATE TABLE effects (operation_id TEXT)');
const runtime = new Runtime({ storage: store }, {});
runtime.getProvider = async () => undefined;
if (boundary === 'before_dispatch') store.sync = async () => process.exit(77);
runtime.executeProvider = async () => {
  effects.sql.exec('INSERT INTO effects VALUES (?)', 'race');
  process.exit(77);
};
await execute(runtime);
throw new Error('crash boundary not reached');
