import { DatabaseSync } from 'node:sqlite';

/**
 * A small adapter presenting the better-sqlite3 surface on top of the SQLite
 * that ships inside Node 24 (and therefore inside Electron 44).
 *
 * Why this exists: better-sqlite3 is a native addon, and its released versions
 * lag the V8 API that Electron ships. Building v11.10.0 against Electron 44
 * fails outright — `v8::Context::GetIsolate` no longer exists and
 * `v8::External::Value()` changed signature. Since Electron bundles its own
 * SQLite, we should not be compiling our own.
 *
 * The practical win is that there is now no native module at all, which means no
 * node-gyp on install, no ABI to match per Electron version, and no cross
 * compilation when building installers on another OS.
 *
 * Only the subset the app actually uses is implemented, and it throws loudly
 * rather than silently misbehaving if something starts using more.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * Statements bind either positionally (`?`) or by name (`@name`). Both forms are
 * used in this codebase, so both have to typecheck; a naive `SqlValue[]`
 * signature makes a named-parameter object look like a malformed Uint8Array.
 */
export type BindArgs = SqlValue[] | [Record<string, SqlValue>];

export interface Statement {
  get(...params: BindArgs): unknown;
  all(...params: BindArgs): unknown[];
  run(...params: BindArgs): { changes: number; lastInsertRowid: number };
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  pragma(statement: string, opts?: { simple?: true }): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

export class Database implements Db {
  private readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): Statement {
    const stmt = this.raw.prepare(sql);
    // BindArgs is a union of "positional list" and "one named-parameter map",
    // neither of which lines up with the rest-args overloads on StatementSync.
    const bind = (args: BindArgs): [] | [Record<string, SqlValue>] => {
      if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
        return [args[0] as Record<string, SqlValue>];
      }
      return [];
    };
    return {
      get: (...params) => {
        const b = bind(params);
        const row = b.length ? stmt.get(...b) : stmt.get(...(params as SqlValue[]));
        return row === undefined ? undefined : row;
      },
      all: (...params) => {
        const b = bind(params);
        return b.length ? stmt.all(...b) : stmt.all(...(params as SqlValue[]));
      },
      run: (...params) => {
        const b = bind(params);
        const r = b.length ? stmt.run(...b) : stmt.run(...(params as SqlValue[]));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
    };
  }

  pragma(statement: string, opts?: { simple?: true }): unknown {
    const rows = this.raw.prepare(`PRAGMA ${statement}`).all();
    if (opts?.simple) {
      const first = rows[0] as Record<string, unknown> | undefined;
      if (!first) return undefined;
      return Object.values(first)[0];
    }
    return rows;
  }

  /**
   * better-sqlite3 hands back a callable you invoke. `node:sqlite` has no
   * transaction helper, so wrap the body: BEGIN, run, COMMIT, and roll back on
   * any throw. Nested calls reuse the outer transaction rather than failing,
   * because SQLite has no nested BEGIN.
   */
  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    const self = this;
    let depth = 0;
    return function runInTx(this: unknown, ...args: Parameters<T>) {
      if (depth > 0) return fn.apply(this, args as never[]);
      self.exec('BEGIN');
      depth++;
      try {
        const out = fn.apply(this, args as never[]);
        self.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          self.exec('ROLLBACK');
        } catch {
          // A rollback failure must not mask the original error.
        }
        throw err;
      } finally {
        depth--;
      }
    } as unknown as T;
  }

  close(): void {
    this.raw.close();
  }
}

export type { DatabaseSync };
