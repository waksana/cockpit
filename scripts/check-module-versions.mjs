import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownTree, nodeText, walk } from './markdown.mjs';

function cellLinks(cell) {
  const links = [];
  walk(cell, node => { if (node.type === 'link') links.push(node); });
  return links;
}

function githubPath(link) {
  const url = new URL(link.url);
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error(`Expected a plain GitHub repository/release URL: ${link.url}`);
  }
  return url.pathname.replace(/\/$/, '');
}

export function catalogEntries(source) {
  const tables = [];
  walk(markdownTree(source), node => {
    if (node.type !== 'table') return;
    const headings = node.children[0].children.map(nodeText);
    if (headings.includes('Module') && headings.includes('Latest release')) tables.push({ node, headings });
  });
  if (tables.length !== 1) throw new Error('Expected exactly one Module / Latest release table');
  const { node: table, headings } = tables[0];
  const entries = [];
  const seen = new Set();
  for (const row of table.children.slice(1)) {
    const modules = cellLinks(row.children[headings.indexOf('Module')]);
    const releases = cellLinks(row.children[headings.indexOf('Latest release')]);
    if (modules.length !== 1 || releases.length !== 1) throw new Error('Each module row needs one repository and one release link');
    const repository = githubPath(modules[0]).slice(1);
    if (!/^[\w-]+\/[\w.-]+$/.test(repository)) throw new Error(`Invalid repository: ${repository}`);
    const prefix = `/${repository}/releases/tag/`;
    const release = githubPath(releases[0]);
    if (!release.startsWith(prefix)) throw new Error(`Release does not belong to ${repository}`);
    const tag = decodeURIComponent(release.slice(prefix.length));
    if (!tag || nodeText(releases[0]) !== tag) throw new Error(`Release label/tag mismatch for ${repository}`);
    if (seen.has(repository.toLowerCase())) throw new Error(`Duplicate module ${repository}`);
    seen.add(repository.toLowerCase());
    entries.push({ repository, tag });
  }
  if (!entries.length) throw new Error('Module catalog has no entries');
  return entries;
}

export async function checkModuleVersions(source, latestRelease) {
  const results = [];
  for (const { repository, tag } of catalogEntries(source)) {
    const latest = await latestRelease(repository);
    if (!latest || typeof latest.tag_name !== 'string' || !latest.tag_name.trim()
      || latest.draft !== false || latest.prerelease !== false) {
      throw new Error(`Invalid Latest release response for ${repository}`);
    }
    results.push({ repository, documented: tag, latest: latest.tag_name, current: tag === latest.tag_name });
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = readFileSync(new URL('../docs/modules.md', import.meta.url), 'utf8');
  const results = await checkModuleVersions(source, repository => JSON.parse(execFileSync(
    'gh', ['api', `repos/${repository}/releases/latest`],
    { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  )));
  for (const row of results) {
    console.log(`${row.current ? 'OK' : 'STALE'} ${row.repository}: documented ${row.documented}; Latest ${row.latest}`);
  }
  if (results.some(row => !row.current)) {
    console.error('Review the catalog; a newer release does not establish an accepted host pairing.');
    process.exitCode = 1;
  }
}
