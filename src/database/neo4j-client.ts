import type { QueryResult } from 'neo4j-driver';

/**
 * Interface for a Neo4j database client, abstracting the underlying neo4j-driver.
 * This allows the core package to define modules that depend on Neo4j connectivity
 * without directly importing concrete implementations from the runtime package.
 */
export interface INeo4jClient {
  /**
   * Executes a Cypher query against the Neo4j database.
   * @param cypher The Cypher query string.
   * @param params Optional parameters for the query.
   * @returns A promise that resolves to the Neo4j QueryResult.
   */
  run(cypher: string, params?: Record<string, any>): Promise<QueryResult>;

  /**
   * Closes the Neo4j driver connection.
   * @returns A promise that resolves when the connection is closed.
   */
  close(): Promise<void>;

  /**
   * Verifies connectivity to the Neo4j database.
   * @returns A promise that resolves if connectivity is successful, rejects otherwise.
   */
  verifyConnectivity(): Promise<void>;
}
