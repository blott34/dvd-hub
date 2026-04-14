#!/usr/bin/env node
// Writes public/version.json with a fresh identifier on every build so
// deployed clients can detect a new deployment and self-reload.
// Runs as the `prebuild` npm script; Vite then copies public/ into dist/.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, '..', 'public', 'version.json');

let sha = 'nogit';
try {
  sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim() || 'nogit';
} catch {
  // Vercel and local builds without git still produce a unique value via the timestamp.
}

const version = `${sha}-${Date.now()}`;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ version }) + '\n');
console.log(`[write-version] wrote ${outPath}: ${version}`);
