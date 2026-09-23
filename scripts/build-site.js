// Builds the static website into _site/ for GitHub Pages: copies site/ and
// combines every data/entries/*.json file into entries.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, REGIONS, RELEVANCE_LEVELS } from '../src/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildSite({ outDir = path.join(root, '_site'), dataDir = path.join(root, 'data', 'entries'), repo } = {}) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.cp(path.join(root, 'site'), outDir, { recursive: true });

  const files = (await fs.readdir(dataDir).catch(() => [])).filter((f) => f.endsWith('.json'));
  const entries = await Promise.all(
    files.map(async (f) => JSON.parse(await fs.readFile(path.join(dataDir, f), 'utf8'))),
  );
  entries.sort((a, b) => b.date_entered.localeCompare(a.date_entered) || b.id - a.id);

  const config = {
    repo: repo || null,
    newEntryUrl: repo ? `https://github.com/${repo}/issues/new?template=new-entry.yml` : null,
    categories: CATEGORIES,
    regions: REGIONS,
    relevanceLevels: RELEVANCE_LEVELS,
    builtAt: new Date().toISOString(),
  };

  await fs.writeFile(path.join(outDir, 'entries.json'), JSON.stringify(entries));
  await fs.writeFile(path.join(outDir, 'config.json'), JSON.stringify(config));
  await fs.writeFile(path.join(outDir, '.nojekyll'), '');
  return { count: entries.length, outDir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = process.env.GITHUB_REPOSITORY || 'U-PKB/ED-LGR-DB';
  const { count, outDir } = await buildSite({ repo });
  console.log(`Built ${count} entries into ${outDir}`);
}
