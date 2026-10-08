# @dsh-agent-group/host

Host-side support package for [`dsh-agent-group`](https://github.com/SNRoman/dsh-agent-group). It owns the durable Agent Workspace domain, employee runtime, dispatcher, memory/task policies, and live turn projection for DeepSeek Harness.

Most users should not install this package directly. Install the profile bundle instead:

```sh
dsh plugin --profile web add dsh-agent-group
```

Version `0.4.0` keeps the durable domain at version `0` and preserves formal Tasks, human grants, retryable delivery, cancellation, immutable definition revisions, unified Memory, and ephemeral Runtime activity while adapting to the current DSH APIs. It strictly validates the complete aggregate and loads released `0.1.x` records without migration. Policy failures cross RPC as stable business-error codes and JSON-safe details; localized prose belongs to the Browser package.

Group membership creation requires an explicit memory start: new events after the join, or an inclusive historical event range. Active silent members receive memory entries for room events even when they are not mentioned; mention routing alone decides which agents run.

One-shot child runs use the registered DSH subagent provider named by the Host plugin's `childProvider` option. The default is `spawn`; deployments can select another installed provider in `cordis.yml`:

```yaml
plugins:
  dsh-agent-group/host:
    childProvider: spawn
```

Configuration fails at the child-run boundary when the selected provider is not registered; the Host does not silently substitute another provider.

The package exports `createForwardWorkspaceExportV1` and the frozen format constants from `@dsh-agent-group/host/forward-export`. The helper validates and clones a local aggregate, omits workspace-local session bindings, and returns an RFC 8785 canonical document with a SHA-256 digest. The repository command `pnpm export:forward-v1` is a read-only file adapter; v0.4.0 exposes no import API.

DeepSeek Harness compatibility is `>=0.2.0-rc.2 <0.2.1-0`, verified at `0.2.0-rc.2` commit `639ed015397290b3745d163aafe02ffee4aa3f84`.

See the repository README for architecture, compatibility, development, and release details.

License: MIT
