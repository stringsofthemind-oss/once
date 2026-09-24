# Order Agent Fixture

This small project represents an AI-agent tool that creates orders
through an external provider.

The implementation in `src/create-order.mjs` is intentionally
minimal.

The external provider is simulated by `src/provider.mjs`.

Important provider behavior:

- an order can be committed successfully
- the response can then be lost
- the caller may therefore see an error even though the external
  side effect already happened
- provider state survives creation of a new provider instance

Modify the project as needed to make `create_order` safe under
retries, ambiguous outcomes, process restarts, and multiple workers.

Do not modify the provider simulator itself.
