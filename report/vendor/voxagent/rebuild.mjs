/** Optional maintainer build; normal npm ci / report generation does not run this. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'exec', '--yes', '--package=esbuild@0.25.10', '--', 'esbuild',
  'source/renderer/cli.ts', '--bundle', '--platform=node', '--target=node22',
  '--format=esm', '--jsx=automatic', '--loader:.css=text',
  '--external:react', '--external:react-dom', '--external:zod',
  '--outfile=render-static.js',
], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
