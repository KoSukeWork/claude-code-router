# Claude Code Router Bugfix Fork

[中文说明](README_zh.md)

This repository is a bugfix-oriented fork of [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router).

The original usage guide still applies. For configuration, commands, and day-to-day usage, please refer to the upstream repository.

This fork exists because some bugfix PRs needed for my own use were not merged upstream for a long time. I maintain this branch for personal use first, and I am sharing it in case it helps others.

This repository does not accept Issues. If you run into problems, please open an issue in the upstream repository instead:

[musistudio/claude-code-router Issues](https://github.com/musistudio/claude-code-router/issues)

## Installation

If you already have the upstream package `@musistudio/claude-code-router@2.0.0` installed globally, uninstall it first:

```bash
npm uninstall -g @musistudio/claude-code-router
```

Then install this fork from npm:

```bash
npm install -g @kosukework/claude-code-router-fix
```

The command name remains `ccr`, so uninstalling the upstream global package first helps avoid command conflicts.

## Fixed Issues

This branch currently includes the following fixes:

- Stabilized Anthropic content block streaming.
- Preserved Windows `argv` semantics when launching Claude from the CLI.
- Stripped unsupported `thinking` fields from OpenAI Responses input.

This list reflects the fixes currently carried by this branch and may be updated over time.
