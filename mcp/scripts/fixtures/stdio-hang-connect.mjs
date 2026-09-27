// Disposable process that never completes MCP initialization.
// Used only to prove the Once stdio proxy has a bounded connect wait.
process.stdin.resume();
setInterval(() => {}, 1_000);
