import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

export function chargeExternal(amountCents) {
  const bodyHash = createHash("sha256").update(String(amountCents)).digest("hex").slice(0, 12);
  if ((process.env.EXTERNAL_MODE ?? "mock") === "mock") {
    if (process.env.OUTBOUND_LOG) {
      appendFileSync(process.env.OUTBOUND_LOG, JSON.stringify({ method: "POST", url: "https://payments.example/charge", bodyHash }) + "\n");
    }
    return { ok: true, id: "pay_mock_1" };
  }
  throw new Error("external calls disabled outside mock mode in demo app");
}
