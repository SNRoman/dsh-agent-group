# @dsh-agent-group/host

Host-side support package for Agent Organization（智能体组织）, published as [`dsh-agent-group`](https://github.com/SNRoman/dsh-agent-group). It owns the durable organization domain, colleague runtime, dispatcher, memory/task policies, and live turn projection for DeepSeek Harness. Its service identifier remains `agentWorkspace`.

Most users should not install this package directly. Install the profile bundle instead:

```sh
dsh plugin --profile web add dsh-agent-group@0.4.0
```

Version `0.4.0` keeps the durable domain at version `0` and preserves formal Tasks, human grants, retryable delivery, cancellation, immutable definition revisions, unified Memory, and ephemeral Runtime activity while adapting to the current DSH APIs. It strictly validates the complete aggregate and loads released `0.1.x` records without migration. Policy failures cross RPC as stable business-error codes and JSON-safe details; localized prose belongs to the Browser package.

Group membership creation requires an explicit memory start: new events after the join, or an inclusive historical event range. Active silent members receive memory entries for room events even when they are not mentioned; mention routing alone decides which agents run.

Group names and colleague names can be changed through revision-checked commands without replacing identities, memberships, personal memory or role revisions. Direct-room labels remain derived from their colleague. A resident colleague's identity prompt is refreshed after its earlier work reaches idle, without replacing its Session.

Room replies and formal task deliveries use the colleague's unified personal history. Colleagues can search admitted events by keyword, receive references with sources and excerpts, and read original events on demand. Retrieval does not grant access to events absent from their personal memory, perform semantic/vector search, or enforce secrecy between rooms.

One-shot child runs use the registered DSH subagent provider named by the Host plugin's `childProvider` option. The default is `spawn`; deployments can select another installed provider in `cordis.yml`:

```yaml
plugins:
  dsh-agent-group/host:
    childProvider: spawn
    memoryCharacterBudget: 4000
    memorySearchResultLimit: 10
```

Configuration fails at the child-run boundary when the selected provider is not registered; the Host does not silently substitute another provider.

`memoryCharacterBudget` bounds rendered automatic recall and the source text returned by each memory tool call. `memorySearchResultLimit` bounds search previews. Both settings are positive integers validated when the plugin loads; response metadata is additional. `workspace_search_memory` returns acquired event IDs, source-labelled excerpts, and `hasMore`; `workspace_read_memory` returns original text, event sequence/type, first acquisition source, and a `nextOffset` for long text. Tools resolve the caller from its live employee handle, not from a supplied colleague ID.

The package exports `createForwardWorkspaceExportV1` and the frozen format constants from `@dsh-agent-group/host/forward-export`. The helper validates and clones a local aggregate, omits workspace-local session bindings, and returns an RFC 8785 canonical document with a SHA-256 digest. The repository command `pnpm export:forward-v1` is a read-only file adapter; v0.4.0 exposes no import API.

## Organization recovery development

The development-only `@dsh-agent-group/host/workspace-import` leaf provides `prepareWorkspaceImportV1(json, options)`. It validates an existing forward-v1 document and returns a detached candidate for a caller-assigned new organization ID. It does not write storage, create an organization, register a service, restore model sessions, or run work. The published v0.4.0 package contains neither this leaf nor the development Browser recovery controls.

The caller supplies positive safe-integer limits for UTF-8 document bytes (`maxBytes`), aggregate records including memory entries (`maxEntities`), events (`maxEvents`), each string/key's UTF-8 bytes (`maxStringBytes`), and JSON container depth (`maxDepth`). The decoder verifies the SHA-256 digest of the original parsed envelope, strict version-1 fields, and all aggregate relationships. It rejects `__proto__` fields before schema conversion, and rejects duplicate object fields and invalid Unicode as required by [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), while accepting whitespace and arbitrary field ordering. A digest detects corruption; it does not establish authorship. Exports contain potentially sensitive role instructions and complete organization history, so callers must obtain human confirmation before later committing a candidate.

Candidates retain entity/event IDs, event order, employment periods, definitions, grants, tasks, and personal memory. They discard old Session bindings and rebase task-delivery message IDs to the new organization ID without changing the source document. Pending task deliveries and running children are rejected rather than resumed or silently repaired. Source plugin versions and declared import ranges remain diagnostic information, not an acceptance policy.

Development source exposes a durable directory and `ctx.agentWorkspace.forWorkspace(id)` for fixed organization runtimes. The strict version-`0` domain reader accepts released local aggregates and version-`1`/`2` organization records. Startup validates all records before upgrading bare/v1 records to v2 once, adding empty workflow metadata without fabricating facts; events, memory, entity IDs and local Session bindings remain unchanged. Each organization has its own runtime, pool, activity stream and child controls. Creation/import retries reuse a durable operation identity; reusing it with different input fails instead of creating another copy.

`@dsh-agent-group/host/workspace-portable` exposes `createWorkspaceExportV3` and `prepareWorkspaceImport` for workflow-aware exports and the shared v1/v2/v3 reader. The frozen v1 producer and descriptor-only `createWorkspaceExportV2` retain their formats and omit workflow metadata. The live service enforces idle export, read-only previews and create-new import. It rejects unfinished durable work, removes old Session bindings, and never runs imported tasks automatically. Archive closes admission before persisting its lifecycle; stop mode cancels exact organization-owned work, while wait mode drains already admitted work. Both wait through settlement, Session persistence and child disposal. An archive write failure restores admission without stopping work. Reopen requires quiescence.

The following validated positive safe-integer settings own import budgets. Defaults keep JSON-wrapped requests within the Browser adapter's default one-MiB body limit:

```yaml
plugins:
  dsh-agent-group/host:
    importMaxBytes: 262144
    importMaxEntities: 50000
    importMaxEvents: 20000
    importMaxStringBytes: 131072
    importMaxDepth: 64
```

Larger backups require increasing `importMaxBytes` and, when appropriate, the other budgets. Also increase `maxRequestBodyBytes` on the installed `@dsh-agent-group/host/web-rpc` adapter enough to accommodate the file encoded inside the RPC JSON envelope. Import errors omit source text. A checksum is not an authentication mechanism. These source features and the portable leaf are not part of the existing registry `0.4.0` release.

Host unloading rejects new directory and runtime work, stops admitted execution, and waits for outstanding directory writes, task settlement, child disposal and employee Session cleanup before closing the domain. Cleanup attempts every organization even if one fails; Cordis reports rejected teardown effects through its logger rather than rejecting `fiber.dispose()`.

## Company workflow development

`WorkspaceRecordV2` stores the frozen aggregate beside `workflow`, which owns drafts, immutable task/company template revisions, confirmed task briefs, exact-result artifacts and reviews, handoff snapshots, operation receipts and ordered facts. Both are validated and saved in one atomic record update. Aggregate-only writes preserve workflow metadata. Human writes carry both revisions; durable operation replay is checked before CAS and returns the same receipt without repeating task assignment or delivery. Changing the semantic command under the same operation ID fails.

The type-only `@dsh-agent-group/host/workflow-contract` leaf is safe for Browser type imports. Model-visible full briefs are rendered from confirmed persisted metadata and logged in the existing DSH Session user input; legacy tasks keep title-only delivery. An available coordinator starts delivery only after commit. A committed but undelivered task after a crash or runtime absence remains explicitly retryable; operation replay and later runtime availability do not start it.

Only the trusted actual employee Agent can call `workspace_propose_task`, and the atomic write rechecks employment. Proposals create drafts and return bounded identifiers and a waiting-for-human status, never tasks or delegation grants. Template preview/application does not wake employees. Company configuration confirmation creates new colleagues pinned to selected role revisions, groups and explicit new-events memberships atomically, without copying historical work or Sessions.

Artifacts and human reviews identify an exact task result event and delivery attempt. Path and HTTP(S) references are inert and unverified. Changes-requested and handoff operations copy result context into a draft; handoffs copy only explicitly selected artifacts. They neither execute work nor transfer authority. Workflow operations share organization admission, archive read-only enforcement, cancellation and root teardown with existing work.

DeepSeek Harness compatibility is `>=0.2.0-rc.2 <0.2.1-0`, verified at `0.2.0-rc.2` commit `639ed015397290b3745d163aafe02ffee4aa3f84`.

See the repository README for architecture, compatibility, development, and release details.

License: MIT
