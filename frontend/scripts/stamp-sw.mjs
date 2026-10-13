// prebuild: writes public/sw.js (gitignored) from the tracked scripts/sw.template.js with a fresh
// build ID as the SW cache name, and records it in .build-id, which next.config.ts uses as the Next
// build ID. predev runs it with --dev: a 'dev' copy only, no .build-id.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const dev = process.argv.includes('--dev');
const sha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'nogit';
  }
})();
const id = dev ? 'dev' : process.env.BUILD_ID || `${sha}-${Date.now().toString(36)}`;
if (!/^[\w.-]{1,64}$/.test(id)) throw new Error(`invalid BUILD_ID: ${id}`);

const src = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8');
const line = /^const BUILD_ID = '[^']*';$/m;
if (!line.test(src)) throw new Error('scripts/sw.template.js: BUILD_ID line not found');
writeFileSync(new URL('../public/sw.js', import.meta.url), src.replace(line, `const BUILD_ID = '${id}';`));
if (!dev) writeFileSync(new URL('../.build-id', import.meta.url), `${id}\n`);
console.log(`[stamp-sw] ${dev ? 'dev copy' : `build ${id}`}`);
