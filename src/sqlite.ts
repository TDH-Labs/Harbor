/**
 * sqlite.ts — cross-runtime SQLite constructor resolution.
 *
 * Harbor's modules (scheduler, session, compaction, approval, isolation) are
 * loaded both by Bun (native) and — via the pi skill-accessor extension →
 * harbor-tugboat → registerHarborSkills chain — by pi, which runs on Node. A
 * hard `import { Database } from "bun:sqlite"` crashes Node because bun:sqlite is
 * Bun-only. So the Database constructor is resolved dynamically, mirroring
 * src/db.ts:
 *   - under Bun -> Bun's native `Database`
 *   - under Node -> node:sqlite (Node 22.5+) wrapped in a thin adapter that
 *     exposes the bun-style `.query(sql)` method (returning a prepared statement
 *     with .all()/.run()/.get()) and `.transaction(fn)` with deferred / immediate
 *     / exclusive variants (IMMEDIATE is required for correct budget-debit
 *     concurrency; see db.ts).
 *
 * This module only fixes the IMPORT crash during pi's skill discovery; it does
 * NOT turn Harbor into the scheduler — n8n remains the trigger/scheduler.
 */

type DatabaseCtor = new (path: string) => any;

let DatabaseConstructor: DatabaseCtor;

if (typeof Bun !== "undefined") {
  const bunDb = await import("bun:sqlite");
  DatabaseConstructor = bunDb.Database;
} else {
  const { DatabaseSync } = await import("node:sqlite");
  DatabaseConstructor = class NodeSqliteDB extends DatabaseSync {
    query(sql: string) {
      return this.prepare(sql);
    }
    transaction(fn: (...args: any[]) => any) {
      const runTx = (type: string, args: any[]) => {
        this.exec(`BEGIN ${type} TRANSACTION`);
        try {
          const result = fn(...args);
          this.exec("COMMIT");
          return result;
        } catch (err) {
          this.exec("ROLLBACK");
          throw err;
        }
      };
      const wrapped = (...args: any[]) => runTx("DEFERRED", args);
      wrapped.immediate = (...args: any[]) => runTx("IMMEDIATE", args);
      wrapped.exclusive = (...args: any[]) => runTx("EXCLUSIVE", args);
      wrapped.deferred = (...args: any[]) => runTx("DEFERRED", args);
      return wrapped;
    }
  };
}

/** The shared Database constructor, resolved for the current runtime. */
export function getDatabaseConstructor(): DatabaseCtor {
  return DatabaseConstructor;
}
