// Publishes a new version of Hatch from this PC (no GitHub Actions): builds the Windows installer,
// pushes the code and the version tag, and creates the GitHub release that installed copies update from.
//
//   npm version patch          (1.0.0 -> 1.0.1; or minor / major) commits the new version and tags it
//   npm run release            builds and publishes it
//   npm run release -- "What's new in this version"     (optional notes; otherwise GitHub writes them from the commits)
//
// Needs Git, and the GitHub CLI (gh) signed in to the account that owns the repo.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const { owner, repo } = pkg.build.publish;
const slug = `${owner}/${repo}`;
const tag = `v${pkg.version}`;
const notes = process.argv.slice(2).join(' ').trim();

const run = (cmd, args, { quiet = false } = {}) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
const ok = (cmd, args) => { try { run(cmd, args, { quiet: true }); return true; } catch { return false; } };
const stop = msg => { console.error(`\n${msg}`); process.exit(1); };

console.log(`Releasing Hatch ${pkg.version} to github.com/${slug}\n`);

if (!ok('gh', ['auth', 'status'])) stop('Sign in to GitHub first: gh auth login');
if (run('git', ['status', '--porcelain'], { quiet: true }).trim()) stop('There are uncommitted changes. Commit them first (then run "npm version patch" for a new version).');
if (ok('gh', ['release', 'view', tag, '--repo', slug])) stop(`${tag} is already released. Make a new version first: npm version patch`);

// the build
console.log('Building the installer (this takes a few minutes)...');
execSync('npx electron-builder --win --x64 --publish never', { cwd: root, stdio: 'inherit' });   // npx needs a shell on Windows
const files = [`Hatch-Setup-${pkg.version}.exe`, `Hatch-Setup-${pkg.version}.exe.blockmap`, 'latest.yml'].map(f => path.join(root, 'dist', f));
for (const f of files) if (!fs.existsSync(f)) stop(`The build didn't make ${path.basename(f)}.`);

// the code, then the release (latest.yml in it is what installed copies check for updates)
if (!ok('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])) run('git', ['tag', tag]);
console.log('\nPushing the code and the tag...');
run('git', ['push', 'origin', 'HEAD']);
run('git', ['push', 'origin', tag]);
console.log('\nCreating the release and uploading the installer...');
run('gh', ['release', 'create', tag, ...files, '--repo', slug, '--title', `Hatch ${pkg.version}`,
  ...(notes ? ['--notes', notes] : ['--generate-notes'])]);

console.log(`\nDone: https://github.com/${slug}/releases/tag/${tag}\nInstalled copies of Hatch will find this update within a few hours (or right away from Settings > About).`);
