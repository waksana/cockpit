import { ModuleCatalog } from './catalog.ts';
import { ModuleSessionRemoval } from './session-removal.ts';

const [userRoot, planId, operationId] = process.argv.slice(2);
await new ModuleSessionRemoval(new ModuleCatalog({ userRoot })).unbind('session-1', { planId, operationId });
process.stdout.write('completed\n');
