import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/** The transaction handle Drizzle passes to `db.transaction(cb)`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything that can run queries: the base connection or an open transaction. */
export type DbExecutor = Database | Transaction;

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
}

/** Create a Drizzle client + connection pool for the given connection string. */
export function createDb(databaseUrl: string): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
