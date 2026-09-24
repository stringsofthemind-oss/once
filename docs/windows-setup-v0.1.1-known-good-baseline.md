# Windows Setup v0.1.1 — known-good baseline

Date verified: 2026-09-24

Baseline commit: `cd5c4f6b770401c1828a708b287b709e76d9506a`

Package: `Once.Setup` `0.1.1.0`

This commit is the known-good recovery point for the redesigned Windows evaluation installer. Preserve it as the rollback baseline while post-install UX evolves.

## Verified user flow

A clean Windows test installation completed successfully on a real user machine.

Verified outcomes:

- Windows reports `Once.Setup 0.1.1.0` with status `Ok`.
- The redesigned setup UI renders without the earlier text/button clipping failures.
- The evaluation flow creates the demo project successfully.
- `package.json` exists.
- `.env` exists.
- `.gitignore` exists.
- `once-demo.mjs` exists.
- `node_modules/@once-agent/sdk` exists.
- `ONCE_API_KEY` is configured without displaying the secret during verification.
- `.env` is protected by `.gitignore`.
- The end-to-end retry-suppression proof prints `ONCE_DEMO_PASS`.

## Meaning of the proof

The demo executes one logical operation, retries the same operation ID, verifies the first execution reaches `CONFIRMED` with one side effect, then verifies the retry returns `already_executed` while side effects remain at one.

## Change policy after this point

Treat `cd5c4f6b770401c1828a708b287b709e76d9506a` as the recovery point for the Windows setup path. Post-install UX changes should use a new package version so test machines cannot confuse a new build with this verified baseline.
