# slaunt-agent-instruction-install

An append-only `npx` installer for Slaunt instructions in Claude Code and Codex.

## Install

```sh
npx slaunt-agent-instruction-install
```

The default user-level targets are:

| Agent | Target | Profile override |
| --- | --- | --- |
| Codex | `~/.codex/AGENTS.override.md` when present, otherwise `~/.codex/AGENTS.md` | `CODEX_HOME` |
| Claude Code | `~/.claude/CLAUDE.md`, or `CLAUDE_CONFIG_DIR/CLAUDE.md` | `CLAUDE_CONFIG_DIR` |

These locations follow the agents’ documented instruction discovery rules. The installer reports the exact paths it selected.

## Safe behavior

- Existing bytes are preserved and the bundled block is appended at the end.
- A unique start/end marker makes the operation idempotent; rerunning the command does not duplicate the block.
- Existing files are read as strict UTF-8. Symbolic links, directories, non-UTF-8 files, oversized files, and incomplete installer markers are refused.
- Updates are written to a same-directory temporary file, flushed, and atomically renamed into place. A concurrent change causes a retryable error instead of overwriting the newer file.
- Missing user directories and documents are created with private permissions (`0700` directories and `0600` files). Project documents use normal source-control-friendly modes (`0755` directories and `0644` files).
- The package has no runtime dependencies and does not make network requests.

Preview the resolved paths and planned actions first:

```sh
npx slaunt-agent-instruction-install --dry-run
npx slaunt-agent-instruction-install --paths
```

## Project-level instructions

To append to the instruction documents in the nearest Git repository root instead of user-level files:

```sh
npx slaunt-agent-instruction-install --scope project
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
