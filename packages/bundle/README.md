# dsh-agent-group

Installable Agent Workspace profile bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Install

```sh
dsh plugin --profile web add dsh-agent-group
```

## Update

```sh
dsh plugin --profile web update dsh-agent-group
```

## Remove

```sh
dsh plugin --profile web remove dsh-agent-group
```

This bundle mounts `@dsh-agent-group/host` and `@dsh-agent-group/web` through its `dsh.bundle.patch` declaration. It expects the selected DeepSeek Harness profile to provide the normal core and storage stack.

Compatibility for v0.1.0 is intentionally limited to the verified DeepSeek Harness `0.1.1` release line starting at `0.1.1-rc.2`.

For features, architecture, limitations, development, and release instructions, see the [repository README](https://github.com/SNRoman/dsh-agent-group#readme).

License: MIT
