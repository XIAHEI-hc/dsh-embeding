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
