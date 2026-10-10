# @dsh-agent-group/host

Host-side support package for Agent Organization（智能体组织）, published as [`dsh-agent-group`](https://github.com/SNRoman/dsh-agent-group). It owns the durable organization domain, colleague runtime, dispatcher, memory/task policies, and live turn projection for DeepSeek Harness. Its service identifier remains `agentWorkspace`.

Most users should not install this package directly. Install the profile bundle instead:

```sh
dsh plugin --profile web add dsh-agent-group@0.4.0
```

Version `0.4.0` keeps the durable domain at version `0` and preserves formal Tasks, human grants, retryable delivery, cancellation, immutable definition revisions, unified Memory, and ephemeral Runtime activity while adapting to the current DSH APIs. It strictly validates the complete aggregate and loads released `0.1.x` records without migration. Policy failures cross RPC as stable business-error codes and JSON-safe details; localized prose belongs to the Browser package.

Group membership creation requires an explicit memory start: new events after the join, or an inclusive historical event range. Active silent members receive memory entries for room events even when they are not mentioned; mention routing alone decides which agents run.

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

The development-only `@dsh-agent-group/host/workspace-import` leaf provides `prepareWorkspaceImportV1(json, options)`. It validates an existing forward-v1 document and returns a detached candidate for a caller-assigned new organization ID. It does not write storage, create an organization, register a service, restore model sessions, or run work. The published v0.4.0 package does not contain this leaf; there is not yet a Browser recovery control.

The caller supplies positive safe-integer limits for UTF-8 document bytes (`maxBytes`), aggregate records including memory entries (`maxEntities`), events (`maxEvents`), each string/key's UTF-8 bytes (`maxStringBytes`), and JSON container depth (`maxDepth`). The decoder verifies the SHA-256 digest of the original parsed envelope, strict version-1 fields, and all aggregate relationships. It rejects `__proto__` fields before schema conversion, and rejects duplicate object fields and invalid Unicode as required by [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), while accepting whitespace and arbitrary field ordering. A digest detects corruption; it does not establish authorship. Exports contain potentially sensitive role instructions and complete organization history, so callers must obtain human confirmation before later committing a candidate.

Candidates retain entity/event IDs, event order, employment periods, definitions, grants, tasks, and personal memory. They discard old Session bindings and rebase task-delivery message IDs to the new organization ID without changing the source document. Pending task deliveries and running children are rejected rather than resumed or silently repaired. Source plugin versions and declared import ranges remain diagnostic information, not an acceptance policy.

Multiple organizations, idempotent create-new persistence, legacy record migration, archiving, and Browser import/export are subsequent integration work. The pure decoder alone is not a completed backup-and-restore workflow.

DeepSeek Harness compatibility is `>=0.2.0-rc.2 <0.2.1-0`, verified at `0.2.0-rc.2` commit `639ed015397290b3745d163aafe02ffee4aa3f84`.

See the repository README for architecture, compatibility, development, and release details.

License: MIT
