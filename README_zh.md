# Claude Code Router Bugfix Fork

[English](README.md)

本仓库是 [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) 的一个 bugfix 版本。

使用说明、配置方法和日常使用方式请直接参考源仓库，本仓库主要用于提供尚未在上游合并的修复。

这个分支最初是因为源仓库长期没有应用我自己需要的修复 PR，所以我为自用维护了一份。现在把它共享出来，给有同样需求的人使用。

本仓库不提供 Issues。如有问题，请前往源仓库提 Issue：

[musistudio/claude-code-router Issues](https://github.com/musistudio/claude-code-router/issues)

## 安装说明

如果你已经全局安装了上游版本 `@musistudio/claude-code-router@2.0.0`，请先卸载：

```bash
npm uninstall -g @musistudio/claude-code-router
```

然后再安装这个 fork 版本：

```bash
npm install -g @kosukework/claude-code-router-fix
```

命令名仍然保持为 `ccr`，因此建议先卸载上游的全局安装，避免命令冲突。

## 已修复问题

当前分支包含以下修复：

- 修复 Anthropic content block streaming 的稳定性问题。
- 修复 Windows 下通过 CLI 启动 Claude 时 `argv` 语义异常的问题。
- 修复 OpenAI Responses 输入中不支持 `thinking` 字段时的兼容性问题。

此分区仅反映当前分支已包含的修复，后续如有新增会继续更新。
