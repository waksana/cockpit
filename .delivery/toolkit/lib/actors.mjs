import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';

export async function readActors(config) {
  const actors = [...config.actors];
  if (!config.actorsDirectory) return actors;
  for (const name of await readdir(config.actorsDirectory)) {
    if (!/^[\w.-]+\.json$/.test(name)) throw Error('Unexpected actor configuration entry');
    const path = join(config.actorsDirectory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.mode & 0o077) throw Error('Actor file must be private and regular');
    const actor = JSON.parse(await readFile(path, 'utf8'));
    if (actor.role !== 'submit' || !/^[\w.-]{8,120}$/.test(actor.id)
      || typeof actor.token !== 'string' || actor.token.length < 32
      || (actor.sessionId && !/^[a-f0-9-]{36}$/.test(actor.sessionId))
      || actors.some(existing => existing.id === actor.id)) throw Error('Invalid or duplicate submit actor');
    actors.push(actor);
  }
  return actors;
}
