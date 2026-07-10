# Development Consumption Contract

Pragma produces versioned Design Context Packages. Development consumption uses the stable package file protocol and does not require Pragma CLI.

## Runtime Boundary

```text
Dev Issue + ready Design Issue
-> Governance Runner pins the workspace commit
-> Runner resolves current.json and the immutable manifest
-> trusted materializer restores a Registry artifact when required
-> Runner emits pragma-context-descriptor/v1
-> Codex app-server starts
-> development Agent reads the supplied files directly
```

Developer machines, Codex app-server, development Agents, and repo hooks must not install or invoke Pragma CLI as part of the normal Dev Issue workflow. They also must not receive Gitea Package Registry read or publish credentials.

## Runner Resolution

For `requires_design_issue: true`, the Runner resolves the package before starting or resuming a Codex turn:

1. require a numeric same-repo Design Issue and blocking dependency;
2. pin the workspace commit that contains the merged Context PR;
3. read `.pragma/design-contexts/issue-<n>/current.json` from that commit;
4. resolve the immutable `versions/vN/manifest.json`;
5. verify schema `2.0`, repo, Design Issue, linked Dev Issue, version, checksum, and required entrypoints;
6. use the version directory directly for repo-native packages;
7. use a trusted pre-dispatch materializer for Gitea Generic Package artifacts;
8. emit `pragma-context-descriptor/v1` and expose its entrypoints read-only;
9. start or resume Codex app-server only after resolution succeeds.

The descriptor pins at least the repo, Dev Issue, Design Issue, source commit, current pointer, manifest path, version, checksum, storage, resolved root, entrypoints, and read order. An in-flight turn never follows a later `current.json` update.

## Registry Materialization

Registry artifacts are restored outside the Git worktree into a checksum-keyed cache. The materializer uses a read-only credential that is removed before app-server starts and is never inherited by the Agent shell or hooks.

Materialization must reject:

- a URL outside the configured Gitea authority;
- compressed or extracted size above platform limits;
- excessive file count;
- checksum mismatch;
- absolute paths or parent-directory traversal;
- symbolic links or hard links;
- attempts to overwrite an existing cache key with different content.

The result is exposed through a read-only Runner mount or equivalent sandbox-readable path. Large artifacts are not extracted back into the Git worktree and are not committed by development PRs.

## CLI Role

Pragma CLI remains supported for:

- Figma capture preparation and source synchronization;
- package ingest, pack, publish, validate, and Issue fragment generation;
- producer pipeline smoke checks;
- human diagnostics and local reproduction.

`pragma design read` is a diagnostic/reference implementation of package resolution. It is not a runtime dependency for a development Agent or a requirement for dispatching a Dev Issue.

## Blocking Rule

If the Design Issue, merged Context PR, current pointer, manifest, checksum, linked Dev Issue, required entrypoint, or Registry artifact is missing or inconsistent, the Runner blocks before starting Codex. The Agent must not guess missing design facts or bypass the resolver.
