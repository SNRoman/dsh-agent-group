# @dsh-agent-group/web

Browser support package for Agent Organization（智能体组织）, published as [`dsh-agent-group`](https://github.com/SNRoman/dsh-agent-group). It adds the Agent Organization footer action and overlay to DeepSeek Harness and renders durable messages plus live text, reasoning, and tool activity with Harness-native UI primitives.

Most users should not install this package directly. Install the profile bundle instead:

```sh
dsh plugin --profile web add dsh-agent-group@0.5.0
```

The package is additive: it registers only `sidebar.footer.action` and `shell.overlay` and does not replace the core conversation surfaces.

The overlay presents four views: Conversations, Colleagues, Tasks and Memory. Shared role templates and immutable history stay folded away from everyday profile editing. Personal work cards show sources and results; colleague-owned Memory provides search and Chinese event labels. Mutations use Host-owned eligibility and revision checks; the client does not infer authority or rewrite durable history.

Each personal memory row has a folded explanation with its source, applicable fact scope, known event sequence and processing state. The state distinguishes unprocessed, pending, completed and failed v2 extraction; current extraction-model availability is shown separately, so an unavailable service does not erase saved v2 progress. v1 extraction audits remain stored but their free-key facts are not displayed as current v2 candidates. Candidate details label current, default, conditional, historical, removed and unresolved status, the set/remove/clear operation, application range, exact source quotation and any explicit condition. Old event sequences are not presented as calendar dates. The explanation is localized in Chinese and English and follows the selected organization/colleague request, so late responses cannot replace a newer selection. This is a read-only diagnostic, not a claim that every remembered source was used in a particular answer.

The overlay opens a searchable **Add colleague** dialog with spacious person cards and multiple selection; selections survive searches, and a partial failure retains only colleagues still awaiting admission for retry. Joining automatically admits the group's complete chat history and future messages; the user does not choose event numbers or a memory range. Its plugin-owned labels, accessibility text, empty states, status text, and policy errors use aligned Simplified Chinese and English dictionaries. Agent names, room names, messages, model output, and tool data remain unchanged user or runtime content.

Removing a group colleague opens a confirmation and retains their group memory by default. The optional **Also remove this colleague's memory of this group** ends their current reply and rebuilds their context, removing chat memory admitted through this group and the colleague's traceable retellings. Independently assigned tasks and subagent results remain available under their task permissions. Group messages and other members' memories remain available; rejoining synchronizes the complete group history again. An incomplete cleanup keeps its selection and operation identity for retry, including a retry action in the group's member panel after the colleague has left. Pending removal keeps the confirmation open.

The display name is “智能体组织” in Simplified Chinese and “Agent Organization” in English. The npm names, RPC channel, service identifier, and persisted workspace format remain unchanged. Personal memory keeps the admitted original events and their sources; agents can retrieve them by keyword and read details on demand.

Version `0.5.0` includes Browser backup and restore controls. Format-4 exports preserve organization history, workflow and communication metadata, including withdrawals and incomplete resets. They exclude local Sessions, extraction audit/projection domains and file bytes; import creates a separate organization and never resumes old Sessions.

## Organization recovery

The organization directory provides create, rename, switch, archive with an explicit stop-or-wait choice, and reopen. Every workbench API and subscription is bound to an explicit organization identity; switching cancels the previous requests and resets drafts, entity selection and live projections. Archived workbenches retain history browsing but disable mutation controls.

Organization selection, four-view navigation and runtime controls share one workbench header; **Manage organization** opens creation, naming, archive and backup controls below its trigger, using a viewport-constrained panel on narrow screens. Escape closes that panel and restores trigger focus; clicking outside dismisses it without submitting changes. It opens automatically for an empty directory and closes before import/export confirmation. Controls, surfaces and focus indicators use Harness theme colors. Wide windows retain separate selection and content panes; narrow chat uses a compact room picker so the message editor remains visible. The Tasks pane scrolls complete briefs and results together instead of clipping the editor into a second limited-height region.

Export displays a sensitive-history warning before downloading the JSON file. Import first reads and validates a chosen file and shows its source label/version, counts and excluded local Session bindings. The user can edit the new label before confirming creation of a separate organization. Confirmation keeps the current selection and never overwrites it; select the restored organization to inspect or reopen it. Imported history does not automatically start any employee or task.

The transport remains the authenticated DSH Connection RPC path, not a second server or replacement core store. Business failures are decoded from its preserved error codes and exact details, including stale aggregate, workflow and draft revisions; malformed or unknown errors remain generic failures. Exported raw history can contain withdrawn messages; the checksum detects corruption, not authorship. Keep backups private and retain a complete pre-upgrade profile backup for rollback to older package versions.

## Chat-first colleagues

The workbench displays human and colleague messages as distinct bubbles. Author avatars, author names, admitted mentions and group-member names open the same colleague details. Mention decoration uses Markdown text positions, excludes code, existing links and email addresses, and binds clicks to persisted recipient identities. Browser-authored mentions store stable identity markers so renaming a colleague does not retarget previous messages. Group titles have an inline rename editor; the room identity, messages and memberships remain unchanged.

Colleagues is a directory of named people with current pinned responsibilities. Details open as a profile; **Edit profile** reveals the name editor, with cancellation and retained input after a save failure. Cancellation and successful saving return focus to the edit button; failed saving keeps the input focused. Work and memory actions share that person's selection. Shared role templates and revision history remain collapsed. Role editing retains the explicit synchronize-none/all/subset choice. A colleague rename changes neither their pinned role nor their personal memory. Group members start collapsed and open through the chat header toggle; member actions wrap independently of long names. Profile dialogs support Escape, focus containment and returning focus to the identity that opened them.

The colleague directory, group members and the group-admission picker share avatar, name, role and employment presentation. Idle activity is omitted; active and failed activity remains visible. Directory and group identity rows share spacing and hover/focus styling. Group-only direct-message and removal actions remain separate controls, never nested inside the identity button. Escape dismisses only the uppermost open panel before underlying navigation can close.

Work cards prioritize the task title, status and owner before the chat source. Empty proposal lists use a compact secondary row. Personal memory keeps search and category visible, folds source and advanced filters, and leads each entry with its source and author. Markdown previews display plain text without fetching links or modifying original records. Original text and processing diagnostics remain separately expandable; the interface generates neither replacement summaries nor new memory facts.

Chat distinguishes ordinary messages from explicit work assignment. Pending proposal cards appear in their source chat and personal work overview, supporting complete brief editing, rejection and confirmation in the same composer; confirmation writes the real human message before execution. Work and memory sources jump to the exact message. Historical work without a recorded source is labeled honestly. Message and task content waits for matching withdrawal metadata; withdrawn proposals do not expose their briefs. Withdrawal replaces already-read Sessions, hides affected message content and disables invalidated work; failed cleanup keeps colleagues paused with a durable retry. Optional file recovery defaults off and displays its results separately from memory reset.

Each derived task has its own chat source. Expanded memory uses the same Markdown renderer as chat, including lists and code blocks. File recovery shows a folded before/after text preview when trusted text checkpoints exist and limits outcomes to the selected withdrawal. A page-refresh failure after completed withdrawal does not relabel memory cleanup as failed.

Withdrawal and optional group-memory removal exclude affected sources from effective memory, but retain raw history, original Session files and local extraction audit records. File recovery applies only to attributed existing local regular files with trusted byte checkpoints; it leaves conflicting or unsupported paths untouched and cannot undo arbitrary shell/network effects.

The chat composer groups the editor, keyboard hint and single-line send control in one rounded panel. Ctrl/⌘ + Enter sends; Enter inserts a line break. Reply completion and withdrawal-metadata refresh preserve bottom following or the user's earlier reading position. Sending a message resumes bottom following; opening a source keeps its message in view through later metadata refreshes. Each newly selected chat starts at its latest message.

## Company workflow

Tasks retains work history and runtime controls, with advanced task/company templates and exact-result review folded away. Draft confirmation requires an explicitly selected employed assignee and sends a new human instruction in chat. A task template copies its complete brief into the composer. Employee proposals, change requests and handoffs remain pending until chat confirmation. Company configuration preview writes nothing; confirmation explicitly chooses new-events membership memory.

Results display their attempt/event identity and cancellation origin. Human acceptance is not model completion and does not apply to another result. Artifact path/link references are rendered as unverified inert text, not opened or fetched automatically. A handoff copies only the artifacts the human selects and still requires draft confirmation before execution.

Workflow requests use the immutable organization API and both displayed aggregate/workflow revisions. Identical retry retains its operation identity; changed input uses a new one. Organization switching, closing and unmounting abort stale work and prevent late responses from replacing current data. Archived organizations disable all workflow mutations. The current export uses format 4, and import accepts formats 1–4. Formats 3 and 4 carry workflow metadata; importing formats 1 and 2 supplies empty workflow state and never starts employees. Pending or failed context resets remain blocked after import until cleanup succeeds.

DeepSeek Harness compatibility is `>=0.2.0-rc.2 <0.2.1-0`, verified at `0.2.0-rc.2` commit `639ed015397290b3745d163aafe02ffee4aa3f84`.

License: MIT
