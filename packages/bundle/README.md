# dsh-agent-group

Installable Agent Organization（智能体组织）profile bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The npm name remains `dsh-agent-group`.

## Install

```sh
dsh plugin --profile web add dsh-agent-group@0.5.0
```

## Update

```sh
dsh plugin --profile web update dsh-agent-group@0.5.0
```

## Remove

```sh
dsh plugin --profile web remove dsh-agent-group
```

This bundle mounts `@dsh-agent-group/host` and `@dsh-agent-group/web` through its `dsh.bundle.patch` declaration. It expects the selected DeepSeek Harness profile to provide the normal core and storage stack.

Version `0.5.0` includes independent organizations, Browser backup and restore, chat-first work assignment, withdrawal with optional local file recovery, optional group-memory removal, scene-aware personal memory and a shared four-view workbench. Backup format 4 creates a new organization and omits Sessions, extraction audit/cache domains and file bytes. Withdrawal retains raw audit history; it is not physical erasure.

Compatibility for v0.5.0 is intentionally limited to DeepSeek Harness `>=0.2.0-rc.2 <0.2.1-0`, verified at `0.2.0-rc.2` commit `639ed015397290b3745d163aafe02ffee4aa3f84`. The predecessor `0.4.x` uses the same Harness line. Deployments on DSH `0.1.1` continue to use the plugin's `0.2.x` line, and deployments on DSH `0.1.7` use `0.3.x`.

Before upgrading from `0.4.x`, stop the profile and back up its configuration, organization storage and Session files. Startup upgrades organization records; package downgrade does not reverse that upgrade. Rollback requires the pre-upgrade backup. See the [v0.5.0 release notes](https://github.com/SNRoman/dsh-agent-group/blob/v0.5.0/docs/releases/v0.5.0.md) for details.

The release gate installs this bundle from packed tarballs into a clean Web profile, verifies the installed Host's forward exporter against a legacy aggregate, runs the Browser scenario, restarts the installed Host, removes the bundle, and reopens a pre-existing core DSH conversation. Staged publication uploads the exact three tarballs named by that successful smoke receipt; npm website approval follows Host → Web → bundle order.

For features, architecture, limitations, development, and release instructions, see the [repository README](https://github.com/SNRoman/dsh-agent-group#readme).

License: MIT
