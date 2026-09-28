#!/usr/bin/env node
/**
 * Runs the headless smoke test inside Electron's own Node runtime.
 *
 * This matters more than it looks. The app's database layer is `node:sqlite`,
 * which only exists in Node 22.5+. Running the smoke test under whatever `node`
 * happens to be on the developer's machine would either fail outright (Node 20)
 * or, worse, test a different runtime than the one the app ships in. Running it
 * under Electron means the test exercises the exact runtime that ships.
 *
 * `ELECTRON_RUN_AS_NODE` makes Electron behave as a plain Node process: no
 * window, no GPU, no display server required.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

function electronBinary() {
  try {
    // `electron` exports the absolute path to the host binary.
    return require('electron');
  } catch {
    const fallback = join(here, '..', '..', 'node_modules', '.bin', 'electron');
    if (existsSync(fallback)) return fallback;
    throw new Error('Could not locate the Electron binary. Run `npm install` first.');
  }
}

const bundle = join(here, '..', 'out', 'smoke', 'smoke.mjs');
if (!existsSync(bundle)) {
  console.error(`smoke bundle missing at ${bundle}\nRun: npm run smoke:build`);
  process.exit(1);
}

const child = spawn(electronBinary(), [bundle], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
