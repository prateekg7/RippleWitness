import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb } from "./db.js";

const out = process.argv[2] ?? "seed/seed.db";
mkdirSync(dirname(out), { recursive: true });
openDb(out);
console.log(`seeded ${out}`);
