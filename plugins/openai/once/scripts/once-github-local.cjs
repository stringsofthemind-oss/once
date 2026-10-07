// Private bundle only. No npx fallback, credential forwarding or cloud fallback.
const { spawn } = require('node:child_process');
const path = require('node:path');
const host = path.join(__dirname, '..', 'runtime', 'node_modules', '@once-agent', 'mcp', 'dist', 'github-issue-host.js');
const child = spawn(process.execPath, [host], { stdio: 'inherit', windowsHide: true, env: { ONCE_GITHUB_CONFIG: process.env.ONCE_GITHUB_CONFIG, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
child.on('error', () => { process.stderr.write('Private Once host unavailable.\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.on('SIGTERM', () => child.kill());
process.on('SIGINT', () => child.kill());
