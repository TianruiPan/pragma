# Compatibility Handshake

Producer, publisher, test, or diagnostic deployments that invoke Pragma commands must verify the installed artifact first:

```powershell
pragma --version --json
```

The response includes:

- CLI version from `package.json`;
- Pragma package schema version;
- Governance/Pragma integration contract version;
- optional build commit.

Local checkouts may leave `buildCommit` null. Pilot and production producer artifacts must inject `PRAGMA_BUILD_COMMIT`, and the invoking producer/publisher deployment must pin and compare it before running design commands.

Development consumption does not use this CLI handshake. The Governance Runner consumes schema `2.0` files through `pragma-integration/v2`, emits `pragma-context-descriptor/v1`, and starts Codex only after native resolution succeeds. Developer machines, Codex app-server, and development Agents do not require an installed Pragma artifact.

The current cross-repository boundary is `pragma-integration/v2` and uses Pragma schema `2.0`. v2 separates canonical package identity from stored artifact-byte integrity; v1 packages must be republished rather than reinterpreted.
