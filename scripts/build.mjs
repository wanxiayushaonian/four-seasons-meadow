import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist');
const siteFiles = [
  'index.html',
  'seasons/index.html',
  'seasons/style.css',
  'seasons/scene.js',
  'seasons/cat-skin.js',
  'seasons/foxtail-jump.js',
  'seasons/summer-flight.js',
  'seasons/vendor/three.module.js',
  'seasons/vendor/three.core.js',
  'seasons/vendor/THREE-LICENSE.txt',
];

const staging = await mkdtemp(join(root, '.dist-'));
const stagedSite = join(staging, 'site');
const archiveName = 'seasons-cloudflare.zip';
const archive = process.argv.includes('--zip') ? join(staging, archiveName) : null;
try {
  for (const file of siteFiles) {
    const target = join(stagedSite, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  if (archive) await promisify(execFile)('zip', ['-qr', archive, '.'], { cwd: stagedSite });
  await rm(output, { recursive: true, force: true });
  await rename(stagedSite, output);
  if (archive) await rename(archive, join(root, archiveName));
  console.log(`Built ${siteFiles.length} static files in dist/`);
  if (archive) console.log(`Created ${archiveName}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
