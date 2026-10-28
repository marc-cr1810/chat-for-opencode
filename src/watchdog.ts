import { spawn } from "child_process";

// Runs in its own process: stops the server once its owner (the extension host) is gone, and exits
// once the server has. Polling works the same on every platform, where a parent-death signal doesn't.
const SCRIPT = `
const [owner, server, every] = process.argv.slice(-3).map(Number);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const timer = setInterval(() => {
  if (!alive(server)) process.exit(0);
  if (alive(owner)) return;
  clearInterval(timer);
  try { process.kill(server, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(server, "SIGKILL"); } catch {} process.exit(0); }, 3000);
}, every);
`;

/**
 * Stops `serverPid` if this process dies without stopping it itself (a crash, or the extension host
 * being killed), so no `opencode serve` is left running with nothing using it.
 */
export function watchServer(serverPid: number, ownerPid = process.pid, everyMs = 1000) {
  // VS Code's extension host is Electron; this makes it run the script as plain Node.
  const child = spawn(process.execPath, ["-e", SCRIPT, String(ownerPid), String(serverPid), String(everyMs)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.unref();
  return child;
}
