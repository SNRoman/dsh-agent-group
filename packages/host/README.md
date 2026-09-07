# @dsh-agent-group/host

Host-side support package for [`dsh-agent-group`](https://github.com/SNRoman/dsh-agent-group). It owns the durable Agent Workspace domain, employee runtime, dispatcher, memory/task policies, and live turn projection for DeepSeek Harness.

Most users should not install this package directly. Install the profile bundle instead:

```sh
dsh plugin --profile web add dsh-agent-group
```

Version `0.1.1` strictly validates the complete version-`0` aggregate and its cross-record relationships before each durable write. It loads the released `0.1.0` record format without migration. Policy failures cross RPC as stable business-error codes and JSON-safe details; localized prose belongs to the Browser package.

Group membership creation requires an explicit memory start: new events after the join, or an inclusive historical event range. Active silent members receive memory entries for room events even when they are not mentioned; mention routing alone decides which agents run.

DeepSeek Harness compatibility is `>=0.1.1-rc.2 <0.1.2-0`, verified at `0.1.1-rc.2` commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`.

See the repository README for architecture, compatibility, development, and release details.

License: MIT
