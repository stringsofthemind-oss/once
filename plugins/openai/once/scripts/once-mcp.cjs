const { spawn } = require("node:child_process");

const isWindows = process.platform === "win32";
const command = isWindows ? (process.env.ComSpec || "cmd.exe") : "npx";
const args = isWindows
  ? ["/d", "/s", "/c", "call npx.cmd -y @once-agent/mcp@0.1.3"]
  : ["-y", "@once-agent/mcp@0.1.3"];

const child = spawn(command, args, {
  stdio: "inherit",
  env: process.env,
  windowsHide: true,
});

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
