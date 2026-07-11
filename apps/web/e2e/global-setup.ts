import { connect } from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";

const REDIS_HOST = "127.0.0.1";
const REDIS_PORT = 6379;
const REDIS_DIR = path.resolve(__dirname, "../../../.tools/redis");

function isRedisUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: REDIS_HOST, port: REDIS_PORT, timeout: 500 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * SC-4 (notificação chega in-app e email) precisa do
 * NotificationWorkerService real rodando, que precisa de Redis (ver
 * .planning/STATE.md). Sem instalador MSI viável neste ambiente, o
 * projeto usa um build portátil do Redis (.tools/redis/, gitignored
 * -- ver T-5.1.2). globalSetup garante que ele está no ar antes do
 * webServer da API subir com NOTIFICATIONS_WORKER_ENABLED=true.
 */
export default async function globalSetup(): Promise<void> {
  if (await isRedisUp()) {
    return;
  }
  const child = spawn(path.join(REDIS_DIR, "redis-server.exe"), [path.join(REDIS_DIR, "redis.windows.conf")], {
    detached: true,
    stdio: "ignore",
    cwd: REDIS_DIR,
  });
  child.unref();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isRedisUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Redis não subiu a tempo (globalSetup) -- verifique .tools/redis/ em apps/web/e2e/global-setup.ts");
}
