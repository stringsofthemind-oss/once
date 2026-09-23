# Once Setup for Windows (MSIX experiment)

This folder contains the native Windows setup path for the frictionless Once evaluation experiment in PR #46.

## Intended customer flow

1. Start a Once technical evaluation.
2. Copy the `once_test_...` API key.
3. Install the trusted Once Setup Windows app.
4. Open Once Setup.
5. Choose either:
   - create a safe demo project automatically; or
   - select an existing Node.js project.
6. Confirm setup.
7. Once Setup verifies the key, installs `@once-agent/sdk`, persists the key to `.env`, adds `.env` to `.gitignore`, and verifies the API connection.
8. In demo mode it also proves retry suppression with the `blind_test` provider.

The customer should not need to type PowerShell, npm, or Once CLI commands.

## Private test package

Run on Windows with .NET 8 SDK and the Windows 10/11 SDK installed:

```powershell
./apps/once-setup-windows/build-msix.ps1
```

The default build creates a short-lived self-signed **test** certificate and a signed test MSIX in `apps/once-setup-windows/artifacts`.

This self-signed package is only for private development/sideload testing. The private key is deleted after signing and is never uploaded as an artifact.

## Public distribution boundary

Do not distribute the test-signed MSIX to customers.

For public Windows distribution, replace the test package identity/publisher with the authorized production identity and use the Microsoft Store signing path or another explicitly approved Microsoft-trusted code-signing route. Store publication, public deployment, release, or signing-credential changes are outside this experiment and require separate operator approval.
