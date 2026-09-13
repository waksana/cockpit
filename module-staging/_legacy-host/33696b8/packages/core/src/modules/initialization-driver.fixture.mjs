import { ModuleCatalog } from './catalog.ts';
import { ModuleInitialization } from './initialization.ts';

const [userRoot, mode] = process.argv.slice(2);
const catalog = new ModuleCatalog({ userRoot });
if (mode === 'crash-before-hook') {
  const getInstalled = catalog.getInstalled.bind(catalog);
  let calls = 0;
  catalog.getInstalled = (...args) => {
    if (++calls === 2) process.exit(17);
    return getInstalled(...args);
  };
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const operation = await new ModuleInitialization(catalog).start(JSON.parse(input));
process.stdout.write(`${JSON.stringify(operation)}\n`);
