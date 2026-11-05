// Points this clone's git hooks at .githooks (repo-local config only). Runs on `npm install`.
import { execFileSync } from 'node:child_process';

if (process.env.CI) process.exit(0);
try {
  execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    stdio: 'ignore',
    windowsHide: true,
  });
} catch {
  // Not a git checkout (for example an npm tarball): nothing to set up.
}
