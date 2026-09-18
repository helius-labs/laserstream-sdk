// npm pack creates a local tarball only. Lifecycle scripts are explicitly disabled.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laserstream-account-index-pack-'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {cwd: source}));
  run('tar', ['-xzf', path.join(root, packed[0].filename), '-C', root], source);
  const artifact = path.join(root, 'package');
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(artifact, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(artifact, 'test'));
  for (const file of ['account-index-vectors.test.js', 'account-index-types.test.ts']) {
    fs.copyFileSync(path.join(__dirname, file), path.join(artifact, 'test', file));
  }
  run(process.execPath, ['test/account-index-vectors.test.js'], artifact);
  run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', 'test/account-index-types.test.ts'], artifact);
  // Native platform packages ship separately. Test the artifact with the local
  // ABI-matched build when requested, never a published/stale optional dependency.
  if (process.env.ACCOUNT_INDEX_NATIVE) {
    fs.copyFileSync(process.env.ACCOUNT_INDEX_NATIVE, path.join(artifact, 'laserstream-napi.linux-x64-gnu.node'));
    fs.copyFileSync(path.join(__dirname, 'account-index-subscribe.test.js'), path.join(artifact, 'test/account-index-subscribe.test.js'));
    run(process.execPath, ['test/account-index-subscribe.test.js'], artifact);
  }
  console.log(`account-index: unpacked npm artifact tests passed (${packed[0].filename})`);
} finally {
  fs.rmSync(root, {recursive: true, force: true});
}
