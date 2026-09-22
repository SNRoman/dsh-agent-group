# v0.2.0 forward-export fixture

`agent-workspace.json` is a version-0 `agent_workspace` storage document captured from the locally packed v0.2 candidate workflow. It contains representative definitions, employment lifecycle, rooms, task attempts and results, cancellation, child runs, memory, and local session bindings.

`portable-workspace-v1.json` is generated from that source with the public `export:forward-v1` command and the fixed timestamp `2026-09-04T00:00:00.000Z`. It is the frozen producer-side input for the future v0.3 cross-version acceptance matrix. It is local candidate evidence, not proof that v0.2.0 has been published to a registry.

The portable document deliberately omits workspace-local session bindings and exposes no import endpoint.
