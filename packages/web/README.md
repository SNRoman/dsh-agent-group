# @dsh-agent-group/web

Browser support package for Agent Organization（智能体组织）, published as [`dsh-agent-group`](https://github.com/SNRoman/dsh-agent-group). It adds the Agent Organization footer action and overlay to DeepSeek Harness and renders durable messages plus live text, reasoning, and tool activity with Harness-native UI primitives.

Most users should not install this package directly. Install the profile bundle instead:

```sh
dsh plugin --profile web add dsh-agent-group@0.4.0
```

The package is additive: it registers only `sidebar.footer.action` and `shell.overlay` and does not replace the core conversation surfaces.

The overlay presents four views: Definitions for roles and immutable revision pins, Tasks for assignments/grants/attempts/results, Memory for one colleague's unified event history, and Runtime for live activity with exact stop controls. Mutations use Host-owned eligibility and revision checks; the client does not infer authority or rewrite durable history.

The overlay requires the user to choose a memory start for every group join. Its plugin-owned labels, accessibility text, empty states, status text, and policy errors use aligned Simplified Chinese and English dictionaries. Agent names, room names, messages, model output, and tool data remain unchanged user or runtime content.

The display name is “智能体组织” in Simplified Chinese and “Agent Organization” in English. The npm names, RPC channel, service identifier, and persisted workspace format remain unchanged. Personal memory keeps the admitted original events and their sources; agents can retrieve them by keyword and read details on demand.

Portable export remains deliberately outside the Browser. v0.4.0 has no import, backup, or restore control.

## Organization recovery development

Unreleased source adds an organization directory above the existing workbench. It provides create, rename, switch, archive with an explicit stop-or-wait choice, and reopen. Every workbench API and subscription is bound to an explicit organization identity; switching cancels the previous requests and resets drafts, entity selection and live projections. Archived workbenches retain history browsing but disable mutation controls.

Export displays a sensitive-history warning before downloading the JSON file. Import first reads and validates a chosen file and shows its source label/version, counts and excluded local Session bindings. The user can edit the new label before confirming creation of a separate organization. Confirmation keeps the current selection and never overwrites it; select the restored organization to inspect or reopen it. Imported history does not automatically start any employee or task.

The new directory, recovery controls and company workflow are development-source features; installing the existing registry `0.4.0` does not enable them. The transport remains the authenticated DSH Connection RPC path, not a second server or replacement core store. Business failures are decoded from its preserved error codes and exact details, including stale aggregate, workflow and draft revisions; malformed or unknown errors remain generic failures.

## Company workflow development

Tasks retains the existing task tree and runtime controls and adds drafts, task/company templates and exact-result review. Draft confirmation requires an explicitly selected employed assignee; no owner is automatically selected. Draft editing, discarding, template application, employee proposal, changes-requested and handoff do not assign or start work. Company configuration preview writes nothing; confirmation explicitly chooses new-events membership memory.

Results display their attempt/event identity and cancellation origin. Human acceptance is not model completion and does not apply to another result. Artifact path/link references are rendered as unverified inert text, not opened or fetched automatically. A handoff copies only the artifacts the human selects and still requires draft confirmation before execution.

Workflow requests use the immutable organization API and both displayed aggregate/workflow revisions. Identical retry retains its operation identity; changed input uses a new one. Organization switching, closing and unmounting abort stale work and prevent late responses from replacing current data. Archived organizations disable all workflow mutations. Export/import format 3 carries the workflow metadata; importing older formats supplies empty workflow state and never starts employees.

DeepSeek Harness compatibility is `>=0.2.0-rc.2 <0.2.1-0`, verified at `0.2.0-rc.2` commit `639ed015397290b3745d163aafe02ffee4aa3f84`.

License: MIT
