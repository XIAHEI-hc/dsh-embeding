# Local private runner material

This directory is intentionally ignored because it contains generated secrets and
user-specific runtime identities. Generate it on a deployment host with:

```sh
node scripts/bootstrap-private-runtime.mjs
```

The script creates separate A/B runner env files, `DSH_HOME` paths, workspace and
embed configs, a runtime registry, and random service/scope secrets. Replace the
development defaults with the real Memory Lab user IDs and service origin before
running the two-user acceptance cases.

The generated `runtime-secrets.json` is the Memory Lab control-plane mapping for
`AI_TOOL_RUNTIME_SECRETS_JSON`; inject its JSON contents into the Memory Lab
backend environment through the deployment secret manager. The runner credential
files must never be replaced with the shared `AI_TOOL_SERVICE_SECRET`.
