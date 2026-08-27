#!/usr/bin/env node
'use strict';

const packageJson = require('../package.json');
const { InstallerError, installInstructions, parseCliArgs } = require('../src/installer');

const HELP = `Usage: npx slaunt-agent-instruction-install [options]

Append the bundled Slaunt instructions to the effective user-level Claude Code
and Codex instruction documents without replacing existing text.

Options:
  --scope user|project       Install globally (default) or in the detected project root.
  --only codex|claude|both   Limit installation to one agent (default: both).
  --instructions <path>      Use a UTF-8 instruction file instead of the bundled file.
  --codex-path <path>        Use an explicit Codex destination document.
  --claude-path <path>       Use an explicit Claude Code destination document.
  --project-dir <path>       Project directory used with --scope project.
  --dry-run                  Resolve and inspect targets without writing.
  --paths                    Print resolved targets without reading instruction content.
  -h, --help                 Show this help.
  -v, --version              Show the package version.

Environment overrides:
  CODEX_HOME                 Codex home directory (default: ~/.codex).
  CLAUDE_CONFIG_DIR          Claude Code config directory (default: ~/.claude).
`;

function printResults(results, dryRun = false) {
  for (const result of results) {
    const label = result.tool === 'claude' ? 'Claude Code' : result.tool === 'codex' ? 'Codex' : result.tool;
    const action = result.status === 'path-only'
      ? 'target'
      : result.status === 'would-append'
        ? 'would append'
        : result.status === 'appended'
          ? 'appended'
          : 'already installed';
    console.log(`${label}: ${result.path} (${action})`);
    if (!dryRun && result.status === 'appended') {
      console.log('  Existing bytes preserved; installer markers surround the appended block.');
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseCliArgs(argv);
    if (options.help) {
      console.log(HELP);
      return 0;
    }
    if (options.version) {
      console.log(packageJson.version);
      return 0;
    }

    const results = await installInstructions(options);
    printResults(results, options.dryRun);
    return 0;
  } catch (error) {
    const message = error instanceof InstallerError || error instanceof Error ? error.message : String(error);
    console.error(`slaunt-agent-instruction-install: ${message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = { HELP, main, printResults };
