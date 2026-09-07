# @dsh-agent-group/web

Browser support package for [`dsh-agent-group`](https://github.com/SNRoman/dsh-agent-group). It adds the Agent Workspace footer action and overlay to DeepSeek Harness and renders durable messages plus live text, reasoning, and tool activity with Harness-native UI primitives.

Most users should not install this package directly. Install the profile bundle instead:

```sh
dsh plugin --profile web add dsh-agent-group
```

The package is additive: it registers only `sidebar.footer.action` and `shell.overlay` and does not replace the core conversation surfaces.

The overlay requires the user to choose a memory start for every group join. Its plugin-owned labels, accessibility text, empty states, status text, and policy errors use aligned Simplified Chinese and English dictionaries. Agent names, room names, messages, model output, and tool data remain unchanged user or runtime content.

DeepSeek Harness compatibility is `>=0.1.1-rc.2 <0.1.2-0`, verified at `0.1.1-rc.2` commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

License: MIT
