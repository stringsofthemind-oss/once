const { spawn } = require("node:child_process");

const command = process.platform === "win32" ? "npx.cmd" : "npx";

const child = spawn(
  command,
  ["-y", "@once-agent/mcp@0.1.2"],
  {
    stdio: "inherit",
    env: process.env,
  }
);

child.on("error", (error) => {
  console.error("Failed to start @once-agent/mcp:", error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
