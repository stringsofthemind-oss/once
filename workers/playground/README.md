# Once Playground Worker

This directory contains the recovered source for the production Once playground Worker.

## Production identity

Worker:

`once-sandbox-playground`

Customer-facing URL:

`https://playground.onceexec.com`

Legacy compatibility URL:

`https://once-sandbox-playground.pennywatch.workers.dev`

Production runtime:

`https://api.onceexec.com`

## Recovered production baseline

The Worker source in this directory was recovered from the deployed Cloudflare Worker and preserved in Git after the Once domain migration.

Production version promoted on 2026-09-21:

`df45784c-d797-450d-b013-c2e64ae137d8`

Deployment tag:

`once-domain-20260921`

Previous rollback version:

`18b0b44a-f7f7-4664-8f8a-b5fb9db4f460`

## Durable Objects

The Worker exports:

- `SandboxClaim`
- `SandboxDemoEffect`

Bindings:

- `Q18_TRUTH` -> `Q18Truth` in `once-q18-cloud`
- `SANDBOX_CLAIMS` -> `SandboxClaim`
- `SANDBOX_DEMO` -> `SandboxDemoEffect`

The deployed Worker currently retains the existing Durable Object migration lifecycle with migration tag:

`sandbox-demo-v1`

Wrangler 4.135.0 warns that local configuration does not contain newer `exports` lifecycle declarations.

Do not add or change Durable Object lifecycle configuration merely to silence this warning.

Any migration from the existing lifecycle configuration must be treated as a separate infrastructure change and verified against the existing Durable Object namespaces before deployment.

## Secrets

Production uses Cloudflare-managed secrets including:

- `SANDBOX_DEMO_PROVIDER_TOKEN`
- `SANDBOX_SESSION_SECRET`
- `STRIPE_SECRET_KEY`

Secret values are not stored in this repository.

## Deployment safety

Before modifying or deploying this Worker:

1. Confirm the current production Worker version.
2. Inspect the candidate with `wrangler versions view`.
3. Confirm Durable Object namespace identities remain unchanged.
4. Upload a candidate version before directing production traffic to it.
5. Smoke-test both the branded and legacy playground URLs after promotion.

Do not remove the legacy workers.dev URL while published SDKs may still depend on it.