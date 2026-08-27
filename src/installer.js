'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const fsp = fs.promises;

const START_MARKER = '<!-- slaunt-agent-instruction-install:start -->';
const END_MARKER = '<!-- slaunt-agent-instruction-install:end -->';
const DEFAULT_INSTRUCTIONS_PATH = path.resolve(__dirname, '..', 'instructions.md');
const MAX_FILE_BYTES = 16 * 1024 * 1024;

class InstallerError extends Error {
  constructor(message, code = 'INSTALLER_ERROR') {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
  }
}

function expandHome(input, homeDir = os.homedir()) {
  if (input === '~') {
    return homeDir;
  }

  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(homeDir, input.slice(2));
  }

  return input;
}

function resolveInputPath(input, { cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new InstallerError('A destination path must be a non-empty string.', 'INVALID_PATH');
  }

  return path.resolve(cwd, expandHome(input, homeDir));
}

async function lstatIfExists(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function assertDestinationStat(filePath, stat) {
  if (stat.isSymbolicLink()) {
    throw new InstallerError(
      `Refusing to modify symbolic-link target: ${filePath}. Pass an explicit regular-file path after reviewing the link.`,
      'SYMLINK_DESTINATION'
    );
  }

  if (!stat.isFile()) {
    throw new InstallerError(`Destination is not a regular file: ${filePath}`, 'NON_FILE_DESTINATION');
  }

  if (stat.size > MAX_FILE_BYTES) {
    throw new InstallerError(
      `Destination is larger than the ${MAX_FILE_BYTES} byte safety limit: ${filePath}`,
      'DESTINATION_TOO_LARGE'
    );
  }
}

function statFingerprint(stat) {
  if (!stat) {
    return null;
  }

  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs === undefined ? stat.mtimeMs : stat.mtimeNs.toString(),
    stat.ctimeNs === undefined ? stat.ctimeMs : stat.ctimeNs.toString()
  ].join(':');
}

function sameStat(left, right) {
  return statFingerprint(left) === statFingerprint(right);
}

function decodeUtf8(bytes, filePath) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new InstallerError(
      `Destination must be valid UTF-8 text; refusing to rewrite ${filePath}.`,
      'INVALID_ENCODING'
    );
  }
}

async function readSnapshot(filePath) {
  const initialStat = await lstatIfExists(filePath);
  if (!initialStat) {
    return { stat: null, bytes: Buffer.alloc(0), text: '' };
  }

  assertDestinationStat(filePath, initialStat);
  const bytes = await fsp.readFile(filePath);
  const finalStat = await lstatIfExists(filePath);

  if (!finalStat || !sameStat(initialStat, finalStat)) {
    throw new InstallerError(
      `Destination changed while it was being read; retry the installation: ${filePath}`,
      'CONCURRENT_MODIFICATION'
    );
  }

  return { stat: finalStat, bytes, text: decodeUtf8(bytes, filePath) };
}

function normalizeInstructionText(text, sourcePath = 'instructions') {
  if (typeof text !== 'string') {
    throw new InstallerError(`Instructions from ${sourcePath} must be text.`, 'INVALID_INSTRUCTIONS');
  }

  const body = text.replace(/\r\n?/g, '\n').trim();
  if (!body) {
    throw new InstallerError(`Instructions from ${sourcePath} are empty.`, 'EMPTY_INSTRUCTIONS');
  }

  if (body.includes(START_MARKER) || body.includes(END_MARKER)) {
    throw new InstallerError(
      `Instructions from ${sourcePath} contain reserved installer markers.`,
      'RESERVED_MARKER'
    );
  }

  return body;
}

async function loadInstructions(instructionsPath = DEFAULT_INSTRUCTIONS_PATH, options = {}) {
  const filePath = resolveInputPath(instructionsPath, options);
  const snapshot = await readSnapshot(filePath);

  if (!snapshot.stat) {
    throw new InstallerError(`Instruction source does not exist: ${filePath}`, 'MISSING_INSTRUCTIONS');
  }

  return normalizeInstructionText(snapshot.text, filePath);
}

function detectNewline(text) {
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfCount = (text.replace(/\r\n/g, '').match(/\n/g) || []).length;
  return crlfCount > lfCount ? '\r\n' : '\n';
}

function separatorFor(text, newline) {
  if (!text) {
    return '';
  }

  if (text.endsWith('\n')) {
    return text.endsWith(`${newline}${newline}`) ? '' : newline;
  }

  return `${newline}${newline}`;
}

function hasCompleteInstallBlock(text, filePath) {
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);

  if (start === -1 && end === -1) {
    return false;
  }

  if (start === -1 || end === -1 || end < start) {
    throw new InstallerError(
      `Found an incomplete installer marker in ${filePath}; refusing to append another block.`,
      'INCOMPLETE_MARKER'
    );
  }

  return true;
}

function renderBlock(body, newline) {
  const content = body.replace(/\n/g, newline);
  return `${START_MARKER}${newline}${content}${newline}${END_MARKER}${newline}`;
}

async function planAppend(target, instructionBody) {
  const snapshot = await readSnapshot(target.path);
  if (hasCompleteInstallBlock(snapshot.text, target.path)) {
    return {
      ...target,
      status: 'already-installed',
      existingStat: snapshot.stat,
      existingBytes: snapshot.bytes,
      fullBytes: snapshot.bytes
    };
  }

  const newline = detectNewline(snapshot.text);
  const appendText = `${separatorFor(snapshot.text, newline)}${renderBlock(instructionBody, newline)}`;
  const appendBytes = Buffer.from(appendText, 'utf8');

  return {
    ...target,
    status: 'append',
    existingStat: snapshot.stat,
    existingBytes: snapshot.bytes,
    appendBytes,
    fullBytes: Buffer.concat([snapshot.bytes, appendBytes])
  };
}

async function syncDirectory(directoryPath) {
  let handle;
  try {
    handle = await fsp.open(directoryPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (handle) {
      await handle.close();
    }
  }
}

async function commitAppend(plan) {
  const directoryPath = path.dirname(plan.path);
  await fsp.mkdir(directoryPath, { recursive: true, mode: plan.directoryMode });

  const current = await readSnapshot(plan.path);
  const unchanged = plan.existingStat
    ? current.stat && sameStat(plan.existingStat, current.stat) && plan.existingBytes.equals(current.bytes)
    : !current.stat;

  if (!unchanged) {
    throw new InstallerError(
      `Destination changed before it could be updated; retry the installation: ${plan.path}`,
      'CONCURRENT_MODIFICATION'
    );
  }

  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(plan.path)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  let handle;

  try {
    handle = await fsp.open(temporaryPath, 'wx', plan.fileMode);
    await handle.writeFile(plan.fullBytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporaryPath, plan.path);
    await syncDirectory(directoryPath);
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fsp.unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}

async function pathExists(filePath) {
  return Boolean(await lstatIfExists(filePath));
}

async function findProjectRoot(startPath) {
  let current = path.resolve(startPath);
  const startStat = await lstatIfExists(current);
  if (!startStat || !startStat.isDirectory()) {
    throw new InstallerError(`Project directory does not exist or is not a directory: ${current}`, 'INVALID_PROJECT_DIR');
  }

  while (true) {
    if (await pathExists(path.join(current, '.git'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startPath);
    }
    current = parent;
  }
}

async function chooseCodexPath(directoryPath) {
  const overridePath = path.join(directoryPath, 'AGENTS.override.md');
  if (await pathExists(overridePath)) {
    return { path: overridePath, reason: 'AGENTS.override.md is the effective Codex document at this scope' };
  }

  return { path: path.join(directoryPath, 'AGENTS.md'), reason: 'Codex base instruction document' };
}

async function chooseClaudePath(directoryPath) {
  const rootPath = path.join(directoryPath, 'CLAUDE.md');
  if (await pathExists(rootPath)) {
    return { path: rootPath, reason: 'existing Claude Code instruction document' };
  }

  const nestedPath = path.join(directoryPath, '.claude', 'CLAUDE.md');
  if (await pathExists(nestedPath)) {
    return { path: nestedPath, reason: 'existing .claude/CLAUDE.md instruction document' };
  }

  return { path: rootPath, reason: 'default Claude Code instruction document' };
}

function selectedTools(only) {
  if (only === undefined || only === null || only === '') {
    return ['codex', 'claude'];
  }

  const values = Array.isArray(only) ? only : String(only).split(',');
  const normalized = [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 1 && normalized[0] === 'both') {
    return ['codex', 'claude'];
  }
  if (normalized.length === 0 || normalized.some((value) => !['codex', 'claude'].includes(value))) {
    throw new InstallerError('`only` must be `codex`, `claude`, or `both`.', 'INVALID_ONLY');
  }

  return normalized;
}

function makeTarget(tool, selected, scope, directoryMode, fileMode) {
  return {
    tool,
    scope,
    path: selected.path,
    reason: selected.reason,
    directoryMode,
    fileMode
  };
}

async function discoverTargets({
  scope = 'user',
  only = 'both',
  cwd = process.cwd(),
  homeDir = os.homedir(),
  env = process.env,
  projectDir,
  codexPath,
  claudePath
} = {}) {
  if (!['user', 'project'].includes(scope)) {
    throw new InstallerError('Scope must be `user` or `project`.', 'INVALID_SCOPE');
  }

  const tools = selectedTools(only);
  const targets = [];

  if (tools.includes('codex')) {
    const selected = codexPath
      ? { path: resolveInputPath(codexPath, { cwd, homeDir }), reason: 'explicit Codex destination' }
      : await chooseCodexPath(
          scope === 'user'
            ? resolveInputPath(env.CODEX_HOME || path.join(homeDir, '.codex'), { cwd, homeDir })
            : await findProjectRoot(projectDir || cwd)
        );
    targets.push(
      makeTarget(
        'codex',
        selected,
        scope,
        scope === 'user' ? 0o700 : 0o755,
        scope === 'user' ? 0o600 : 0o644
      )
    );
  }

  if (tools.includes('claude')) {
    const selected = claudePath
      ? { path: resolveInputPath(claudePath, { cwd, homeDir }), reason: 'explicit Claude Code destination' }
      : await chooseClaudePath(
          scope === 'user'
            ? resolveInputPath(env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude'), { cwd, homeDir })
            : await findProjectRoot(projectDir || cwd)
        );
    targets.push(
      makeTarget(
        'claude',
        selected,
        scope,
        scope === 'user' ? 0o700 : 0o755,
        scope === 'user' ? 0o600 : 0o644
      )
    );
  }

  return targets;
}

function parseOnly(value) {
  const normalizedValue = String(value).trim().toLowerCase();
  if (normalizedValue === 'both') {
    return 'both';
  }

  const values = normalizedValue
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0 || values.some((item) => !['codex', 'claude'].includes(item))) {
    throw new InstallerError('`--only` accepts `codex`, `claude`, or `both`.', 'INVALID_ONLY');
  }
  return values;
}

function parseCliArgs(argv) {
  const options = {
    scope: 'user',
    only: 'both',
    dryRun: false,
    pathsOnly: false
  };

  const valueOptions = new Map([
    ['--scope', 'scope'],
    ['--only', 'only'],
    ['--instructions', 'instructionsPath'],
    ['--codex-path', 'codexPath'],
    ['--claude-path', 'claudePath'],
    ['--project-dir', 'projectDir']
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--version' || argument === '-v') {
      options.version = true;
      continue;
    }
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (argument === '--paths') {
      options.pathsOnly = true;
      continue;
    }

    const optionName = argument.split('=', 1)[0];
    const optionKey = valueOptions.get(optionName);
    if (!optionKey) {
      throw new InstallerError(`Unknown option: ${argument}`, 'UNKNOWN_OPTION');
    }

    const inlineValue = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : undefined;
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new InstallerError(`Missing value for ${optionName}.`, 'MISSING_OPTION_VALUE');
    }

    options[optionKey] = optionKey === 'only' ? parseOnly(value) : value;
  }

  if (options.scope !== 'user' && options.scope !== 'project') {
    throw new InstallerError('`--scope` accepts `user` or `project`.', 'INVALID_SCOPE');
  }

  if (options.help && (options.version || options.dryRun || options.pathsOnly)) {
    throw new InstallerError('Do not combine --help with other operational flags.', 'CONFLICTING_OPTIONS');
  }

  if (options.version && (options.dryRun || options.pathsOnly)) {
    throw new InstallerError('Do not combine --version with operational flags.', 'CONFLICTING_OPTIONS');
  }

  return options;
}

async function installInstructions(options = {}) {
  const targets = await discoverTargets(options);
  if (options.pathsOnly) {
    return targets.map((target) => ({ ...target, status: 'path-only' }));
  }

  const instructionBody = options.instructionsText !== undefined
    ? normalizeInstructionText(options.instructionsText, 'inline instructions')
    : await loadInstructions(options.instructionsPath || DEFAULT_INSTRUCTIONS_PATH, options);
  const plans = await Promise.all(targets.map((target) => planAppend(target, instructionBody)));

  if (options.dryRun) {
    return plans.map((plan) => ({ ...plan, status: plan.status === 'append' ? 'would-append' : plan.status }));
  }

  const results = [];
  for (const plan of plans) {
    if (plan.status === 'append') {
      await commitAppend(plan);
      results.push({ ...plan, status: 'appended' });
    } else {
      results.push(plan);
    }
  }

  return results;
}

module.exports = {
  DEFAULT_INSTRUCTIONS_PATH,
  END_MARKER,
  InstallerError,
  MAX_FILE_BYTES,
  START_MARKER,
  appendInstructionsToFile: async (filePath, instructionsText, options = {}) => {
    const target = makeTarget(
      options.tool || 'custom',
      { path: resolveInputPath(filePath, options), reason: 'explicit destination' },
      options.scope || 'custom',
      options.directoryMode || 0o700,
      options.fileMode || 0o600
    );
    const body = normalizeInstructionText(instructionsText, 'inline instructions');
    const plan = await planAppend(target, body);
    if (plan.status === 'append') {
      await commitAppend(plan);
      return { ...plan, status: 'appended' };
    }
    return plan;
  },
  discoverTargets,
  findProjectRoot,
  installInstructions,
  loadInstructions,
  parseCliArgs,
  resolveInputPath
};
