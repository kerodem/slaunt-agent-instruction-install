#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const packageJson = require('../package.json');
const {
  InstallerError,
  applyInstructionPlans,
  installInstructions,
  parseCliArgs,
  planInstructions
} = require('../src/installer');

const HELP = `Usage: npx slaunt-install [options]

Add Slaunt's instructions to the Claude Code and Codex instruction documents
that these tools already use. When run in a terminal, a short guided setup
helps you choose the right location. Existing text is never replaced.

Options:
  --scope user|project       Install for your user account (default) or this project.
  --only codex|claude|both   Choose which assistant(s) to configure (default: both).
  --instructions <path>      Use a UTF-8 instruction file instead of the bundled file.
  --codex-path <path>        Use an explicit Codex destination document.
  --claude-path <path>       Use an explicit Claude Code destination document.
  --project-dir <path>       Project directory used with --scope project.
  --dry-run                  Show what would happen without writing anything.
  --paths                    Show the selected document locations and exit.
  -y, --yes                  Skip the guided questions and confirmation (for scripts).
  -h, --help                 Show this help.
  -v, --version              Show the package version.

Environment overrides:
  CODEX_HOME                 Codex home directory (default: ~/.codex).
  CLAUDE_CONFIG_DIR          Claude Code config directory (default: ~/.claude).

Examples:
  npx slaunt-install
  npx slaunt-install --dry-run
  npx slaunt-install --scope project
  npx slaunt-install --yes --only codex
`;

class UserCancelledError extends Error {
  constructor(message = 'Setup cancelled. No files were changed.') {
    super(message);
    this.name = 'UserCancelledError';
    this.code = 'USER_CANCELLED';
  }
}

function writeLine(output, message = '') {
  output.write(`${message}\n`);
}

function toolLabel(tool) {
  return tool === 'claude' ? 'Claude Code' : tool === 'codex' ? 'Codex' : tool;
}

function actionLabel(status) {
  if (status === 'path-only') {
    return 'target';
  }
  if (status === 'would-append') {
    return 'would append';
  }
  if (status === 'append') {
    return 'ready to append';
  }
  if (status === 'appended') {
    return 'appended';
  }
  return 'already installed';
}

function printResults(results, dryRun = false, output = process.stdout) {
  for (const result of results) {
    writeLine(output, `${toolLabel(result.tool)}: ${result.path} (${actionLabel(result.status)})`);
    if (result.status === 'appended') {
      writeLine(output, '  Existing text preserved; installer markers surround the appended section.');
    } else if (result.status === 'would-append' || (dryRun && result.status === 'append')) {
      const destinationState = result.existingStat ? 'The existing document will stay intact.' : 'A new document will be created.';
      writeLine(output, `  ${destinationState}`);
    } else if (result.status === 'already-installed') {
      writeLine(output, '  Nothing to change here; the marked Slaunt section is already present.');
    }
  }
}

function wasProvided(options, key) {
  return Array.isArray(options.provided) && options.provided.includes(key);
}

function isInteractive({ input, output, env }) {
  return Boolean(input.isTTY && output.isTTY && !env.CI && !env.SLAUNT_NON_INTERACTIVE);
}

function askLine(readlineInterface, question) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onClose = () => {
      if (!settled) {
        settled = true;
        reject(new UserCancelledError());
      }
    };

    readlineInterface.once('close', onClose);
    readlineInterface.question(question, (answer) => {
      if (settled) {
        return;
      }
      settled = true;
      readlineInterface.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

function createReadlineInterface(input, output) {
  const readlineInterface = readline.createInterface({
    input,
    output,
    terminal: Boolean(output.isTTY)
  });
  readlineInterface.on('SIGINT', () => readlineInterface.close());
  return readlineInterface;
}

async function askChoice(readlineInterface, output, question, choices, defaultIndex = 0) {
  while (true) {
    writeLine(output, `\n${question}`);
    choices.forEach((choice, index) => {
      const recommendation = index === defaultIndex ? ' (recommended)' : '';
      writeLine(output, `  ${index + 1}) ${choice.label}${recommendation}`);
      writeLine(output, `     ${choice.description}`);
    });

    const answer = (await askLine(readlineInterface, `Choose 1-${choices.length} [${defaultIndex + 1}]: `))
      .trim()
      .toLowerCase();
    if (!answer) {
      return choices[defaultIndex].value;
    }
    if (['q', 'quit', 'cancel', 'c', 'exit'].includes(answer)) {
      throw new UserCancelledError();
    }

    const selectedIndex = Number.parseInt(answer, 10) - 1;
    const selected = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < choices.length
      ? choices[selectedIndex]
      : choices.find((choice) => choice.aliases.includes(answer));
    if (selected) {
      return selected.value;
    }

    writeLine(output, 'Please choose one of the numbered options, or type cancel.');
  }
}

async function askConfirmation(readlineInterface, output) {
  while (true) {
    const answer = (await askLine(readlineInterface, 'Continue and add the marked section? [Y/n]: '))
      .trim()
      .toLowerCase();
    if (!answer || ['y', 'yes'].includes(answer)) {
      return true;
    }
    if (['n', 'no', 'q', 'quit', 'cancel', 'c'].includes(answer)) {
      return false;
    }
    writeLine(output, 'Please answer yes or no, or press Enter to continue.');
  }
}

async function runGuidedSetup(options, { input, output, readlineInterface: providedInterface }) {
  writeLine(output, '\nSlaunt setup');
  writeLine(output, 'This will add Slaunt instructions so Claude Code and/or Codex can use your workspace guidance.');
  writeLine(output, 'Your existing instruction text will stay in place. You can review the exact files before anything changes.');

  const readlineInterface = providedInterface || createReadlineInterface(input, output);
  const ownsInterface = !providedInterface;

  try {
    if (!wasProvided(options, 'scope') && !wasProvided(options, 'codexPath') && !wasProvided(options, 'claudePath')) {
      options.scope = await askChoice(readlineInterface, output, 'Where should Slaunt be available?', [
        {
          value: 'user',
          label: 'My user account',
          description: 'Available across your projects on this computer.',
          aliases: ['user', 'account', 'personal']
        },
        {
          value: 'project',
          label: 'This project',
          description: 'Add it only to the project folder you are working in.',
          aliases: ['project', 'repo', 'repository']
        }
      ]);
    }

    if (!wasProvided(options, 'only')) {
      const hasCodexPath = wasProvided(options, 'codexPath');
      const hasClaudePath = wasProvided(options, 'claudePath');
      if (hasCodexPath && !hasClaudePath) {
        options.only = 'codex';
      } else if (hasClaudePath && !hasCodexPath) {
        options.only = 'claude';
      } else {
        options.only = await askChoice(readlineInterface, output, 'Which assistants should Slaunt configure?', [
          {
            value: 'both',
            label: 'Claude Code and Codex',
            description: 'Recommended: keep the same workspace guidance in both tools.',
            aliases: ['both', 'all', 'two']
          },
          {
            value: 'codex',
            label: 'Codex only',
            description: 'Configure Codex and leave Claude Code unchanged.',
            aliases: ['codex', 'openai']
          },
          {
            value: 'claude',
            label: 'Claude Code only',
            description: 'Configure Claude Code and leave Codex unchanged.',
            aliases: ['claude', 'claude code', 'anthropic']
          }
        ]);
      }
    }
  } catch (error) {
    if (ownsInterface) {
      readlineInterface.close();
    }
    throw error;
  }

  if (ownsInterface) {
    readlineInterface.close();
  }

  return options;
}

function printPreview(plans, output) {
  writeLine(output, '\nHere is what will happen:');
  printResults(
    plans.map((plan) => ({ ...plan, status: plan.status === 'append' ? 'would-append' : plan.status })),
    true,
    output
  );
  writeLine(output, '\nOnly the Slaunt section at the end of a document will be added. Existing text will not be replaced.');
}

function friendlyError(error, output) {
  const suggestions = {
    NON_INTERACTIVE_CONFIRMATION_REQUIRED: 'Run this command in a terminal, or add --yes when you intentionally want to run it without prompts.',
    SYMLINK_DESTINATION: 'For safety, choose the real document path instead of a symbolic link.',
    CONCURRENT_MODIFICATION: 'The document changed while it was being prepared. Nothing was overwritten; run the command again.',
    INCOMPLETE_MARKER: 'Remove or finish the old installer markers after reviewing that document, then try again.',
    INVALID_ENCODING: 'Save the document as UTF-8 text, then try again.',
    DESTINATION_TOO_LARGE: 'Choose a smaller instruction document or review the destination manually.',
    INVALID_PROJECT_DIR: 'Check the project folder path and try again.',
    MISSING_INSTRUCTIONS: 'Check the instruction file path, or omit --instructions to use the bundled instructions.'
  };
  const code = error && error.code;
  writeLine(output, `\nslaunt-install could not finish safely: ${error instanceof Error ? error.message : String(error)}`);
  writeLine(output, 'Existing instruction text is never replaced. If another target was completed before this error, rerunning is safe because the marked section is idempotent.');
  if (suggestions[code]) {
    writeLine(output, `Tip: ${suggestions[code]}`);
  }
}

async function main(argv = process.argv.slice(2), io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const errorOutput = io.error || process.stderr;
  const env = io.env || process.env;
  let guidedInterface;

  try {
    const options = parseCliArgs(argv);
    options.env = env;
    if (options.help) {
      writeLine(output, HELP.trimEnd());
      return 0;
    }
    if (options.version) {
      writeLine(output, packageJson.version);
      return 0;
    }

    const interactive = isInteractive({ input, output, env }) && !options.yes;
    if (!interactive && !options.yes && !options.dryRun && !options.pathsOnly) {
      throw new InstallerError(
        'No interactive terminal was detected, so confirmation is required before changing instruction files.',
        'NON_INTERACTIVE_CONFIRMATION_REQUIRED'
      );
    }

    if (options.pathsOnly) {
      const results = await installInstructions(options);
      printResults(results, false, output);
      return 0;
    }

    if (options.dryRun) {
      writeLine(output, '\nPreview only. No files will be changed.');
      const results = await installInstructions(options);
      printResults(results, true, output);
      return 0;
    }

    if (interactive) {
      guidedInterface = createReadlineInterface(input, output);
      await runGuidedSetup(options, { input, output, readlineInterface: guidedInterface });
    }

    const plans = await planInstructions(options);
    const pendingChanges = plans.filter((plan) => plan.status === 'append');
    if (interactive) {
      if (pendingChanges.length === 0) {
        printResults(plans, false, output);
        writeLine(output, '\nEverything is already set up. No files were changed.');
        return 0;
      }

      printPreview(plans, output);
      let confirmed;
      confirmed = await askConfirmation(guidedInterface, output);
      if (!confirmed) {
        writeLine(output, '\nNo files were changed.');
        return 0;
      }
    }

    const results = await applyInstructionPlans(plans);
    printResults(results, false, output);
    writeLine(output, '\nDone. Slaunt is ready, and your existing instruction text was preserved.');
    return 0;
  } catch (error) {
    if (error && error.code === 'USER_CANCELLED') {
      writeLine(output, `\n${error.message}`);
      return 0;
    }
    friendlyError(error, errorOutput);
    return 1;
  } finally {
    if (guidedInterface) {
      guidedInterface.close();
    }
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  HELP,
  UserCancelledError,
  askChoice,
  askConfirmation,
  main,
  printResults,
  runGuidedSetup
};
