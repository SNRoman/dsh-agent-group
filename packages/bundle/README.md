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

Compatibility for v0.3.0 is intentionally limited to DeepSeek Harness `>=0.1.7-alpha.2 <0.1.8-0`, verified at `0.1.7-alpha.2` commit `00102833dfaee1da9f48a3a8eae9d34005a75218`. Deployments on DSH `0.1.1` continue to use the plugin's `0.2.x` line.

The release gate installs this bundle from packed tarballs into a clean Web profile, verifies the installed Host's forward exporter against a legacy aggregate, runs the Definitions, Tasks, Memory, and Runtime Browser scenario, restarts the installed Host, removes the bundle, and reopens a pre-existing core DSH conversation. Publication uses the exact three tarballs named by that successful smoke receipt.

For features, architecture, limitations, development, and release instructions, see the [repository README](https://github.com/SNRoman/dsh-agent-group#readme).

License: MIT
