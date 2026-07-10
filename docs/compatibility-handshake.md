# Compatibility Handshake

Deployments and downstream contract tests must verify the installed Pragma artifact before invoking design commands:

```powershell
pragma --version --json
```

The response includes:

- CLI version from `package.json`;
- Pragma package schema version;
- Governance/Pragma integration contract version;
- optional build commit.

Local checkouts may leave `buildCommit` null. Pilot and production artifacts must inject `PRAGMA_BUILD_COMMIT`, and the consuming deployment must pin and compare it before dispatching Pragma-backed work.

The current cross-repository boundary is `pragma-integration/v1` and uses Pragma schema `2.0`.
