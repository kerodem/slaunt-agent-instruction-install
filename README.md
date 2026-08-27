# slaunt-install

An approachable, append-only `npx` installer for Slaunt instructions in Claude Code and Codex.

## Quick start

```sh
npx slaunt-install
```

When you run it in a terminal, the installer guides you through three simple choices:

1. Install for your user account or only this project.
2. Configure Claude Code, Codex, or both.
3. Review the exact document paths and confirm.

Press Enter to accept the recommended choice. Type `cancel` at any prompt to leave everything unchanged.

The default user-level targets are:

| Agent | Target | Profile override |
| --- | --- | --- |
| Codex | `~/.codex/AGENTS.override.md` when present, otherwise `~/.codex/AGENTS.md` | `CODEX_HOME` |
| Claude Code | `~/.claude/CLAUDE.md`, or `CLAUDE_CONFIG_DIR/CLAUDE.md` | `CLAUDE_CONFIG_DIR` |

These locations follow the agents’ documented instruction discovery rules. The installer reports the exact paths it selected.

The shorter `slaunt-install` command is the recommended name. The older `slaunt-agent-instruction-install` command remains available as an alias.

## Safe behavior

- Existing bytes are preserved and the bundled block is appended at the end.
- A unique start/end marker makes the operation idempotent; rerunning the command does not duplicate the block.
- Existing files are read as strict UTF-8. Symbolic links, directories, non-UTF-8 files, oversized files, and incomplete installer markers are refused.
- Updates are written to a same-directory temporary file, flushed, and atomically renamed into place. A concurrent change causes a retryable error instead of overwriting the newer file.
- Missing user directories and documents are created with private permissions (`0700` directories and `0600` files). Project documents use normal source-control-friendly modes (`0755` directories and `0644` files).
- The package has no runtime dependencies and does not make network requests.

Preview the resolved paths and planned actions first:

```sh
npx slaunt-install --dry-run
npx slaunt-install --paths
```

For scripts and CI, explicitly opt out of the guided questions and confirmation:

```sh
npx slaunt-install --yes
```

If input is redirected or no terminal is available, the installer refuses to write unless `--yes` is present. This prevents an unattended command from changing an instruction document unexpectedly.

## Project-level instructions

To append to the instruction documents in the nearest Git repository root instead of user-level files:

```sh
npx slaunt-install --scope project
```

Use `--project-dir` when the working directory is elsewhere. Codex uses an existing root `AGENTS.override.md` when present and otherwise `AGENTS.md`. Claude Code uses an existing root `CLAUDE.md`, then `.claude/CLAUDE.md`, and otherwise creates root `CLAUDE.md`.

## Options

```text
--scope user|project
--only codex|claude|both
--instructions <path>
--codex-path <path>
--claude-path <path>
--project-dir <path>
--dry-run
--paths
--help
--version
```

`--codex-path` and `--claude-path` are useful for testing or for a profile that is intentionally outside the default environment. `--instructions` accepts a custom UTF-8 Markdown file; the same safety and idempotency rules apply.

## If something goes wrong

The installer explains what it found and suggests the next step for common issues, including a missing project folder, an invalid text encoding, an incomplete installer marker, a symbolic link, or a document that changed while it was being prepared. It stops before overwriting an existing document. Running the command again is safe because the marked section is idempotent.

## Agent documentation

- [Codex `AGENTS.md` configuration](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude Code memory and `CLAUDE.md`](https://code.claude.com/docs/en/memory)

## Development

```sh
npm test
npm run lint
npm run pack:check
```

Repository: <https://github.com/kerodem/slaunt-agent-instruction-install>
