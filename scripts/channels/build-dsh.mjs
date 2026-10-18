import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (!process.argv[2])
  throw new Error('Usage: node scripts/channels/build-dsh.mjs /absolute/new/output');
const output = resolve(process.argv[2]);
execFileSync('pnpm', ['typecheck'], { cwd: root, stdio: 'inherit' });
try {
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@matchbot/dsh-matchbot',
      'deploy',
      '--legacy',
      '--prod',
      '--ignore-scripts',
      output,
    ],
    { cwd: root, stdio: 'inherit' },
  );
} finally {
  // pnpm legacy deploy refreshes workspace dependency-state metadata for --prod.
  // Restore the development install so subsequent check commands do not purge modules.
  execFileSync('pnpm', ['install', '--ignore-scripts', '--prod=false'], {
    cwd: root,
    stdio: 'inherit',
  });
}
// A local bundle references the deployed entry by absolute path, as DSH resolves
// module names from the profile, not from the patch directory. No private npm dependencies.
const bundle = join(output, 'bundle');
mkdirSync(bundle);
writeFileSync(
  join(bundle, 'package.json'),
  JSON.stringify(
    {
      name: '@matchbot/dsh-local-bundle',
      version: '0.1.0',
      private: true,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      files: ['cordis.patch.yml'],
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  join(bundle, 'cordis.patch.yml'),
  `- insert:\n    - id: matchbot\n      name: ${JSON.stringify(join(output, 'dist/index.js'))}\n      config:\n        enabled: true\n`,
);
console.log(`Local DSH bundle: ${bundle}`);
