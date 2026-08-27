'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const cliPath = path.resolve(__dirname, '..', 'bin', 'cli.js');
const {
  END_MARKER,
  START_MARKER,
  appendInstructionsToFile,
  discoverTargets,
  installInstructions
} = require('../src/installer');

async function temporaryDirectory(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'slaunt-agent-install-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('appends after existing bytes and is idempotent', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'AGENTS.md');
  const original = Buffer.from('# Existing guidance\r\n- keep this exactly\r\n', 'utf8');
  await fsp.writeFile(filePath, original);

  const first = await appendInstructionsToFile(filePath, '# Slaunt\n\n- Search CCR first.');
  const firstBytes = await fsp.readFile(filePath);

  assert.equal(first.status, 'appended');
  assert.deepEqual(firstBytes.subarray(0, original.length), original);
  assert.match(firstBytes.toString('utf8'), new RegExp(`${START_MARKER}\\r\\n# Slaunt`));
  assert.match(firstBytes.toString('utf8'), new RegExp(`${END_MARKER}\\r\\n$`));

  const second = await appendInstructionsToFile(filePath, '# Slaunt\n\n- Search CCR first.');
  const secondBytes = await fsp.readFile(filePath);
  assert.equal(second.status, 'already-installed');
  assert.deepEqual(secondBytes, firstBytes);
});

test('creates a missing destination and its parent with safe defaults', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, '.claude', 'CLAUDE.md');

  const result = await appendInstructionsToFile(filePath, '# Slaunt');
  const stat = await fsp.stat(filePath);
  const content = await fsp.readFile(filePath, 'utf8');

  assert.equal(result.status, 'appended');
  assert.equal(stat.isFile(), true);
  assert.match(content, /# Slaunt/);
  assert.match(content, new RegExp(START_MARKER));
});

test('discovers effective user documents and honors profile environment variables', async (t) => {
  const directory = await temporaryDirectory(t);
  const codexHome = path.join(directory, 'codex-home');
  const claudeConfig = path.join(directory, 'claude-config');
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.mkdir(claudeConfig, { recursive: true });
  await fsp.writeFile(path.join(codexHome, 'AGENTS.override.md'), 'temporary override\n');
  await fsp.writeFile(path.join(claudeConfig, 'CLAUDE.md'), 'user instructions\n');

  const targets = await discoverTargets({
    scope: 'user',
    env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeConfig },
    homeDir: directory,
    cwd: directory
  });

  assert.deepEqual(
    targets.map((target) => target.path),
    [path.join(codexHome, 'AGENTS.override.md'), path.join(claudeConfig, 'CLAUDE.md')]
  );
});

test('discovers project targets from the nearest repository root', async (t) => {
  const directory = await temporaryDirectory(t);
  const projectRoot = path.join(directory, 'project');
  const nested = path.join(projectRoot, 'packages', 'app');
  await fsp.mkdir(path.join(projectRoot, '.git'), { recursive: true });
  await fsp.mkdir(nested, { recursive: true });
  await fsp.mkdir(path.join(projectRoot, '.claude'), { recursive: true });
  await fsp.writeFile(path.join(projectRoot, 'AGENTS.md'), 'existing codex\n');
  await fsp.writeFile(path.join(projectRoot, '.claude', 'CLAUDE.md'), 'existing claude\n');

  const targets = await discoverTargets({ scope: 'project', cwd: nested, homeDir: directory });
  assert.deepEqual(
    targets.map((target) => target.path),
    [path.join(projectRoot, 'AGENTS.md'), path.join(projectRoot, '.claude', 'CLAUDE.md')]
  );
});

test('dry-run resolves both targets without creating missing directories', async (t) => {
  const directory = await temporaryDirectory(t);
  const codexHome = path.join(directory, 'codex-home');
  const claudeConfig = path.join(directory, 'claude-config');

  const results = await installInstructions({
    scope: 'user',
    env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeConfig },
    homeDir: directory,
    cwd: directory,
    dryRun: true
  });

  assert.deepEqual(results.map((result) => result.status), ['would-append', 'would-append']);
  await assert.rejects(() => fsp.stat(codexHome), { code: 'ENOENT' });
  await assert.rejects(() => fsp.stat(claudeConfig), { code: 'ENOENT' });
});

test('CLI installs both targets and reports the resolved locations', async (t) => {
  const directory = await temporaryDirectory(t);
  const codexHome = path.join(directory, 'codex-home');
  const claudeConfig = path.join(directory, 'claude-config');
  const env = { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeConfig };

  const paths = await runCli(['--paths'], env);
  assert.equal(paths.code, 0);
  assert.match(paths.stdout, new RegExp(`${codexHome}.*target`));
  assert.match(paths.stdout, new RegExp(`${claudeConfig}.*target`));

  const installed = await runCli([], env);
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stdout, /Codex: .*appended/);
  assert.match(installed.stdout, /Claude Code: .*appended/);

  const repeat = await runCli([], env);
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.match(repeat.stdout, /already installed/);
});

test('refuses to modify a symlink destination', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires elevated privileges on some Windows environments');
    return;
  }

  const directory = await temporaryDirectory(t);
  const realPath = path.join(directory, 'real.md');
  const linkPath = path.join(directory, 'link.md');
  await fsp.writeFile(realPath, 'keep me\n');
  await fsp.symlink(realPath, linkPath);

  await assert.rejects(
    () => appendInstructionsToFile(linkPath, '# Slaunt'),
    (error) => error.code === 'SYMLINK_DESTINATION'
  );
  assert.equal(await fsp.readFile(realPath, 'utf8'), 'keep me\n');
});

test('refuses invalid UTF-8 and incomplete installer markers without changing the file', async (t) => {
  const directory = await temporaryDirectory(t);
  const invalidPath = path.join(directory, 'invalid.md');
  await fsp.writeFile(invalidPath, Buffer.from([0xff, 0xfe]));
  await assert.rejects(
    () => appendInstructionsToFile(invalidPath, '# Slaunt'),
    (error) => error.code === 'INVALID_ENCODING'
  );

  const incompletePath = path.join(directory, 'incomplete.md');
  const incomplete = `${START_MARKER}\nexisting\n`;
  await fsp.writeFile(incompletePath, incomplete);
  await assert.rejects(
    () => appendInstructionsToFile(incompletePath, '# Slaunt'),
    (error) => error.code === 'INCOMPLETE_MARKER'
  );
  assert.equal(await fsp.readFile(incompletePath, 'utf8'), incomplete);
});
