import { spawn } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { watchServer } from "../src/watchdog";

// Long-running stand-ins for the extension host and `opencode serve`.
const idle = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (check()) return true;
  return false;
}

const started: number[] = [];
afterEach(() => {
  for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
});

describe("watchServer", () => {
  it("stops the server when its owner dies without stopping it", async () => {
    const owner = idle();
    const server = idle();
    const exited = new Promise((r) => server.once("exit", r));
    const dog = watchServer(server.pid!, owner.pid!, 100);
    started.push(owner.pid!, server.pid!, dog.pid!);

    owner.kill("SIGKILL");
    await expect(Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 6000))])).resolves.toBe(true);
    expect(await until(() => !alive(dog.pid!))).toBe(true);
  });

  it("leaves the server alone while its owner lives, and exits once the server has", async () => {
    const owner = idle();
    const server = idle();
    const dog = watchServer(server.pid!, owner.pid!, 100);
    started.push(owner.pid!, server.pid!, dog.pid!);

    await new Promise((r) => setTimeout(r, 500));
    expect(alive(server.pid!)).toBe(true);
    server.kill();
    expect(await until(() => !alive(dog.pid!))).toBe(true);
  });
});
