// Runtime-registered collection routes (json-server shape): generic
// parameterized registrations dispatch on data keys at runtime, and a
// terminal app.use fallback renders the response. Never executed.
import { app } from "./stub.js";

function parseListParams(req: { url: string }): { page: string | null } {
  const params = new URLSearchParams(req.url.split("?")[1] ?? "");
  const page = params.get("_page");
  const where = params.get("_where");
  return { page: where ?? page };
}

export function createApp(): void {
  app.get("/", () => "home");
  app.get("/:name", (req: { url: string }) => parseListParams(req));
  app.get("/:name/:id", () => "one");
  app.use("/:name", () => "fallback-render");
}
