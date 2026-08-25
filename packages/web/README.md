# @dsh-agent-group/web

Browser support package for [`dsh-agent-group`](https://github.com/SNRoman/dsh-agent-group). It adds the Agent Workspace footer action and overlay to DeepSeek Harness and renders durable messages plus live text, reasoning, and tool activity with Harness-native UI primitives.

Most users should not install this package directly. Install the profile bundle instead:

```sh
dsh plugin --profile web add dsh-agent-group
```

The package is additive: it registers only `sidebar.footer.action` and `shell.overlay` and does not replace the core conversation surfaces.

License: MIT
