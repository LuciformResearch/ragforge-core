/**
 * File State Machine
 *
 * Manages the lifecycle states of files during ingestion.
 * Replaces the simple schemaDirty/embeddingsDirty booleans with a proper state machine.
 *
 * States:
 * - discovered: File detected by watcher, needs parsing
 * - parsing: Currently being parsed
 * - parsed: Nodes created, awaiting relations
 * - relations: Relations being created
 * - linked: Relations created, awaiting embeddings
 * - embedding: Embeddings being generated
 * - embedded: Fully processed
 * - error: Failed at some stage (with errorType)
 */

import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import type { Record as Neo4jRecord } from 'neo4j-driver';

/**
 * File states in the ingestion pipeline:
 * - mentioned: Referenced by another file but not yet accessed directly
 * - discovered: Directly accessed/touched, ready for parsing
 * - parsing: Currently being parsed
 * - parsed: Parsing complete
 * - relations: Building relationships
 * - linked: Relationships built, ready for embedding
 * - embedding: Currently generating embeddings
 * - embedded: Fully processed with embeddings
 * - error: Processing failed
 */
export type FileState =
  | 'mentioned'
  | 'discovered'
  | 'parsing'
  | 'parsed'
  | 'relations'
  | 'linked'
  | 'embedding'
  | 'embedded'
  | 'error';

export type ErrorType = 'parse' | 'relations' | 'embed';

export interface StateTransition {
  from: FileState | FileState[];
  to: FileState;
  action: string;
}

export interface FileStateInfo {
  uuid: string;
  file: string;
  state: FileState;
  errorType?: ErrorType;
  errorMessage?: string;
  retryCount?: number;
  stateUpdatedAt?: string;
  parsedContentHash?: string;
  embeddedContentHash?: string;
}

export interface TransitionOptions {
  errorType?: ErrorType;
  errorMessage?: string;
  contentHash?: string;
}

// Valid state transitions
const VALID_TRANSITIONS: StateTransition[] = [
  // Normal flow
  { from: ['discovered', 'error'], to: 'parsing', action: 'startParsing' },
  { from: 'parsing', to: 'parsed', action: 'finishParsing' },
  { from: 'parsing', to: 'error', action: 'failParsing' },
  { from: 'parsed', to: 'relations', action: 'startRelations' },
  { from: 'relations', to: 'linked', action: 'finishRelations' },
  { from: 'relations', to: 'error', action: 'failRelations' },
  { from: 'linked', to: 'embedding', action: 'startEmbedding' },
  { from: 'embedding', to: 'embedded', action: 'finishEmbedding' },
  { from: 'embedding', to: 'error', action: 'failEmbedding' },
  // Reset on file change
  {
    from: ['parsed', 'relations', 'linked', 'embedding', 'embedded', 'error'],
    to: 'discovered',
    action: 'fileChanged',
  },
  // Skip relations (for files without references)
  { from: 'parsed', to: 'linked', action: 'skipRelations' },
  // Skip embedding (batch mode)
  { from: 'linked', to: 'embedded', action: 'skipEmbedding' },
];

/**
 * Checks if a transition is valid
 */
export function isValidTransition(from: FileState, to: FileState): boolean {
  return VALID_TRANSITIONS.some((t) => {
    const fromStates = Array.isArray(t.from) ? t.from : [t.from];
    return fromStates.includes(from) && t.to === to;
  });
}

/**
 * Get the next expected state in the normal flow
 */
export function getNextState(current: FileState): FileState | null {
  const flow: FileState[] = ['discovered', 'parsing', 'parsed', 'relations', 'linked', 'embedding', 'embedded'];
  const idx = flow.indexOf(current);
  if (idx === -1 || idx === flow.length - 1) return null;
  return flow[idx + 1];
}

/**
 * Manages file states during ingestion
 */
export class FileStateMachine {
  constructor(private neo4jClient: Neo4jClient) {}

  /**
   * Transition a file to a new state
   */
  async transition(fileUuid: string, newState: FileState, options?: TransitionOptions): Promise<boolean> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {uuid: $uuid})
      SET f.state = $newState,
          f.stateUpdatedAt = datetime(),
          f.errorType = $errorType,
          f.errorMessage = $errorMessage,
          f.parsedContentHash = CASE WHEN $newState = 'parsed' AND $contentHash IS NOT NULL
                                     THEN $contentHash
                                     ELSE f.parsedContentHash END,
          f.embeddedContentHash = CASE WHEN $newState = 'embedded' AND $contentHash IS NOT NULL
                                       THEN $contentHash
                                       ELSE f.embeddedContentHash END,
          f.retryCount = CASE WHEN $newState = 'error'
                              THEN coalesce(f.retryCount, 0) + 1
                              ELSE CASE WHEN $newState = 'discovered' THEN 0 ELSE f.retryCount END END
      RETURN f.state as state
    `,
      {
        uuid: fileUuid,
        newState,
        errorType: options?.errorType || null,
        errorMessage: options?.errorMessage || null,
        contentHash: options?.contentHash || null,
      }
    );

    return result.records.length > 0;
  }

  /**
   * Transition multiple files to a new state (batch)
   */
  async transitionBatch(fileUuids: string[], newState: FileState, options?: TransitionOptions): Promise<number> {
    if (fileUuids.length === 0) return 0;

    const result = await this.neo4jClient.run(
      `
      MATCH (f:File)
      WHERE f.uuid IN $uuids
      SET f.state = $newState,
          f.stateUpdatedAt = datetime(),
          f.errorType = $errorType,
          f.errorMessage = $errorMessage,
          f.parsedContentHash = CASE WHEN $newState = 'parsed' AND $contentHash IS NOT NULL
                                     THEN $contentHash
                                     ELSE f.parsedContentHash END,
          f.embeddedContentHash = CASE WHEN $newState = 'embedded' AND $contentHash IS NOT NULL
                                       THEN $contentHash
                                       ELSE f.embeddedContentHash END,
          f.retryCount = CASE WHEN $newState = 'error'
                              THEN coalesce(f.retryCount, 0) + 1
                              ELSE CASE WHEN $newState = 'discovered' THEN 0 ELSE f.retryCount END END
      RETURN count(f) as count
    `,
      {
        uuids: fileUuids,
        newState,
        errorType: options?.errorType || null,
        errorMessage: options?.errorMessage || null,
        contentHash: options?.contentHash || null,
      }
    );

    return result.records[0]?.get('count')?.toNumber?.() || result.records[0]?.get('count') || 0;
  }

  /**
   * Get files in a specific state
   */
  async getFilesInState(
    projectId: string,
    state: FileState | FileState[]
  ): Promise<FileStateInfo[]> {
    const states = Array.isArray(state) ? state : [state];

    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.state IN $states
      RETURN f.uuid as uuid,
             f.file as file,
             f.state as state,
             f.errorType as errorType,
             f.errorMessage as errorMessage,
             f.retryCount as retryCount,
             f.stateUpdatedAt as stateUpdatedAt
      ORDER BY f.stateUpdatedAt ASC
    `,
      { projectId, states }
    );

    return result.records.map((r: Neo4jRecord) => ({
      uuid: r.get('uuid'),
      file: r.get('file'),
      state: r.get('state') || 'discovered',
      errorType: r.get('errorType'),
      errorMessage: r.get('errorMessage'),
      retryCount: r.get('retryCount')?.toNumber?.() || r.get('retryCount') || 0,
      stateUpdatedAt: r.get('stateUpdatedAt')?.toString(),
    }));
  }

  /**
   * Get files that don't have a state yet (for migration)
   */
  async getFilesWithoutState(projectId: string): Promise<Array<{ uuid: string; file: string }>> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.state IS NULL
      RETURN f.uuid as uuid, f.file as file
    `,
      { projectId }
    );

    return result.records.map((r: Neo4jRecord) => ({
      uuid: r.get('uuid'),
      file: r.get('file'),
    }));
  }

  /**
   * Get state statistics for a project
   */
  async getStateStats(projectId: string): Promise<Record<FileState, number>> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      RETURN f.state as state, count(f) as count
    `,
      { projectId }
    );

    const stats: Record<string, number> = {
      discovered: 0,
      parsing: 0,
      parsed: 0,
      relations: 0,
      linked: 0,
      embedding: 0,
      embedded: 0,
      error: 0,
    };

    for (const record of result.records) {
      const state = record.get('state') || 'discovered';
      const count = record.get('count');
      stats[state] = count?.toNumber?.() || count || 0;
    }

    return stats as Record<FileState, number>;
  }

  /**
   * Get detailed error statistics
   */
  async getErrorStats(projectId: string): Promise<Record<ErrorType, number>> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId, state: 'error'})
      RETURN f.errorType as errorType, count(f) as count
    `,
      { projectId }
    );

    const stats: Record<string, number> = {
      parse: 0,
      relations: 0,
      embed: 0,
    };

    for (const record of result.records) {
      const errorType = record.get('errorType');
      if (errorType) {
        const count = record.get('count');
        stats[errorType] = count?.toNumber?.() || count || 0;
      }
    }

    return stats as Record<ErrorType, number>;
  }

  /**
   * Get files that need retry (in error state with retryCount < maxRetries)
   */
  async getRetryableFiles(
    projectId: string,
    maxRetries: number = 3
  ): Promise<Array<FileStateInfo & { errorType: ErrorType; retryCount: number }>> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId, state: 'error'})
      WHERE coalesce(f.retryCount, 0) < $maxRetries
      RETURN f.uuid as uuid,
             f.file as file,
             f.state as state,
             f.errorType as errorType,
             f.errorMessage as errorMessage,
             f.retryCount as retryCount
      ORDER BY f.retryCount ASC, f.stateUpdatedAt ASC
    `,
      { projectId, maxRetries }
    );

    return result.records.map((r: Neo4jRecord) => ({
      uuid: r.get('uuid'),
      file: r.get('file'),
      state: 'error' as const,
      errorType: r.get('errorType') || 'parse',
      errorMessage: r.get('errorMessage'),
      retryCount: r.get('retryCount')?.toNumber?.() || r.get('retryCount') || 0,
    }));
  }

  /**
   * Reset files that have been stuck in a processing state too long
   */
  async resetStuckFiles(projectId: string, stuckThresholdMs: number = 5 * 60 * 1000): Promise<number> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.state IN ['parsing', 'relations', 'embedding']
        AND f.stateUpdatedAt < datetime() - duration({milliseconds: $threshold})
      SET f.state = 'discovered',
          f.stateUpdatedAt = datetime(),
          f.errorMessage = 'Reset: stuck in processing state'
      RETURN count(f) as count
    `,
      { projectId, threshold: stuckThresholdMs }
    );

    return result.records[0]?.get('count')?.toNumber?.() || result.records[0]?.get('count') || 0;
  }

  /**
   * Mark a file as changed (reset to discovered)
   */
  async markFileChanged(fileUuid: string): Promise<boolean> {
    return this.transition(fileUuid, 'discovered');
  }

  /**
   * Mark files as changed by path pattern
   */
  async markFilesChangedByPath(projectId: string, pathPattern: string): Promise<number> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.file =~ $pattern OR f.absolutePath =~ $pattern
      SET f.state = 'discovered',
          f.stateUpdatedAt = datetime(),
          f.retryCount = 0
      RETURN count(f) as count
    `,
      { projectId, pattern: pathPattern }
    );

    return result.records[0]?.get('count')?.toNumber?.() || result.records[0]?.get('count') || 0;
  }

  /**
   * Get incomplete files (not in 'embedded' state)
   */
  async getIncompleteFiles(projectId: string): Promise<FileStateInfo[]> {
    return this.getFilesInState(projectId, ['discovered', 'parsing', 'parsed', 'relations', 'linked', 'embedding']);
  }

  /**
   * Check if all files in a project are fully processed
   */
  async isProjectFullyProcessed(projectId: string): Promise<boolean> {
    const stats = await this.getStateStats(projectId);
    const incomplete = stats.discovered + stats.parsing + stats.parsed + stats.relations + stats.linked + stats.embedding + stats.error;
    return incomplete === 0;
  }

  /**
   * Get processing progress for a project
   */
  async getProgress(projectId: string): Promise<{ processed: number; total: number; percentage: number }> {
    const stats = await this.getStateStats(projectId);
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    const processed = stats.embedded;
    const percentage = total > 0 ? Math.round((100 * processed) / total) : 100;
    return { processed, total, percentage };
  }
}

/**
 * Migration helpers for existing data
 */
export class FileStateMigration {
  constructor(private neo4jClient: Neo4jClient) {}

  /**
   * Migrate existing files to the state machine model
   * Call this once to initialize states for existing data
   */
  async migrateExistingFiles(projectId: string): Promise<{
    embedded: number;
    linked: number;
    discovered: number;
  }> {
    // 1. Files with embeddings → 'embedded'
    const embeddedResult = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.state IS NULL
        AND EXISTS {
          MATCH (s:Scope)-[:DEFINED_IN]->(f)
          WHERE s.embedding_content IS NOT NULL
        }
      SET f.state = 'embedded',
          f.stateUpdatedAt = datetime()
      RETURN count(f) as count
    `,
      { projectId }
    );

    // 2. Files with Scopes but without embeddings → 'linked'
    const linkedResult = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.state IS NULL
        AND EXISTS { MATCH (s:Scope)-[:DEFINED_IN]->(f) }
      SET f.state = 'linked',
          f.stateUpdatedAt = datetime()
      RETURN count(f) as count
    `,
      { projectId }
    );

    // 3. Files without Scopes → 'discovered'
    const discoveredResult = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.state IS NULL
      SET f.state = 'discovered',
          f.stateUpdatedAt = datetime()
      RETURN count(f) as count
    `,
      { projectId }
    );

    // 4. Handle embeddingsDirty on Scopes
    await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.state = 'embedded'
        AND EXISTS {
          MATCH (s:Scope)-[:DEFINED_IN]->(f)
          WHERE s.embeddingsDirty = true
        }
      SET f.state = 'linked'
    `,
      { projectId }
    );

    // 5. Handle schemaDirty on Scopes
    await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.state IN ['linked', 'embedded']
        AND EXISTS {
          MATCH (n)-[:DEFINED_IN]->(f)
          WHERE n.schemaDirty = true
        }
      SET f.state = 'discovered'
    `,
      { projectId }
    );

    return {
      embedded: embeddedResult.records[0]?.get('count')?.toNumber?.() || embeddedResult.records[0]?.get('count') || 0,
      linked: linkedResult.records[0]?.get('count')?.toNumber?.() || linkedResult.records[0]?.get('count') || 0,
      discovered: discoveredResult.records[0]?.get('count')?.toNumber?.() || discoveredResult.records[0]?.get('count') || 0,
    };
  }

  /**
   * Check if migration is needed for a project
   */
  async needsMigration(projectId: string): Promise<boolean> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.state IS NULL
      RETURN count(f) > 0 as needsMigration
    `,
      { projectId }
    );

    return result.records[0]?.get('needsMigration') || false;
  }

  /**
   * Migrate all projects
   */
  async migrateAllProjects(): Promise<Map<string, { embedded: number; linked: number; discovered: number }>> {
    const projectsResult = await this.neo4jClient.run(`
      MATCH (p:Project)
      RETURN p.projectId as projectId
    `);

    const results = new Map<string, { embedded: number; linked: number; discovered: number }>();

    for (const record of projectsResult.records) {
      const projectId = record.get('projectId');
      if (await this.needsMigration(projectId)) {
        const stats = await this.migrateExistingFiles(projectId);
        results.set(projectId, stats);
      }
    }

    return results;
  }
}
