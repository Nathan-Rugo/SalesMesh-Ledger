import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Anything that can run a query: a Pool or a checked-out client inside a transaction. */
export interface Db {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/** A pool that can also hand out a client for an explicit transaction. */
export interface TxDb extends Db {
  connect(): Promise<PoolClient>;
}

/** Runs `fn` in one transaction on a dedicated client; rolls back on any throw. */
export async function withTransaction<T>(db: TxDb, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Thrown inside withTransaction to roll back on purpose and report why. */
export class Rollback<T = unknown> extends Error {
  constructor(public readonly value: T) {
    super('rollback');
  }
}
