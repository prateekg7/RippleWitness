import { createServer } from "node:net";

/** True when nothing is listening on 127.0.0.1:port. */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/** Ask the OS for a free port. */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Use `preferred` when free, else the next free port (IT-REP-08). */
export async function resolvePort(preferred: number): Promise<{ port: number; conflict: boolean }> {
  if (await isPortFree(preferred)) return { port: preferred, conflict: false };
  return { port: await pickFreePort(), conflict: true };
}
