#!/usr/bin/env node
// auriga/query-soak-results.ts — reads the P1 soak test's actual pass bar
// (0 dropped tasks / 0 duplicated tasks / 0 orchestrator deaths) straight
// from the persisted better-sqlite3 records auriga/run.ts's process wrote
// during the run, per p1-soak-test-run.yaml's own acceptance criteria:
// "the report is generated from observability's persisted better-sqlite3
// records, not typed up from memory or self-reported by the orchestrator
// process itself."
//
// Run this AFTER the soak test process has stopped (or while it's still
// running, if you want an interim read — the underlying sqlite files are
// opened read/write in WAL mode by ObservabilityCounterStore/
// DeathEventStore, same as auriga/run.ts itself uses, so a concurrent read
// here is safe).
//
// Usage: npx tsx auriga/query-soak-results.ts
import { ObservabilityCounterStore } from "./observability/counters.ts";
import { DeathEventStore } from "./observability/death-detection.ts";
import { fileURLToPath } from "node:url";

const COUNTERS_DB_PATH = fileURLToPath(new URL("./observability/counters.db", import.meta.url));

const counterStore = new ObservabilityCounterStore(COUNTERS_DB_PATH);
const deathEventStore = new DeathEventStore(); // default path, same as auriga/run.ts uses

const dropped = counterStore.getDroppedTasks();
const duplicated = counterStore.getDuplicatedTasks();
const deaths = deathEventStore.getDeathEvents();

console.log("=== P1 soak test results (from observability's persisted records) ===");
console.log(`dropped tasks:    ${dropped.length}`);
console.log(`duplicated tasks: ${duplicated.length}`);
console.log(`death events:     ${deaths.length}`);
console.log();

if (dropped.length > 0) {
  console.log("--- dropped task detail ---");
  console.log(JSON.stringify(dropped, null, 2));
}
if (duplicated.length > 0) {
  console.log("--- duplicated task detail ---");
  console.log(JSON.stringify(duplicated, null, 2));
}
if (deaths.length > 0) {
  console.log("--- death event detail ---");
  console.log(JSON.stringify(deaths, null, 2));
}

const passed = dropped.length === 0 && duplicated.length === 0 && deaths.length === 0;
console.log();
console.log(passed ? "PASS: 0 dropped / 0 duplicated / 0 deaths." : "FAIL: see detail above.");

counterStore.close();
deathEventStore.close();

process.exit(passed ? 0 : 1);
