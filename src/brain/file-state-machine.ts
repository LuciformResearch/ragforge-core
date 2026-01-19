/**
 * File State Machine
 *
 * Manages the lifecycle states of files during ingestion.
 * Replaces the simple schemaDirty/embeddingsDirty booleans with a proper state machine.
 * Updated: 2026-01-17 - Added _pending cleanup on File node MERGE
 *
 * States:
 * - discovered: File detected by watcher, needs parsing
 * - parsing: Currently being parsed
 * - parsed: Nodes created, awaiting relations
 * - relations: Relations being created
 * - linked: Relations created, awaiting entity extraction
 * - entities: Entity extraction in progress (GLiNER)
 * - embedding: Embeddings being generated
 * - embedded: Fully processed
 * - error: Failed at some stage (with errorType)
 */

import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import type { Record as Neo4jRecord } from 'neo4j-driver';
import { UniqueIDHelper } from '../runtime/utils/UniqueIDHelper.js';

/**
 * File states in the ingestion pipeline:
 * - mentioned: Referenced by another file but not yet accessed directly
 * - discovered: Directly accessed/touched, ready for parsing
 * - parsing: Currently being parsed
 * - parsed: Parsing complete
 * - relations: Building relationships
 * - linked: Relationships built, ready for entity extraction
 * - entities: Entity extraction in progress (GLiNER)
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
  | 'entities'
  | 'embedding'
  | 'embedded'
  | 'error';

export type ErrorType = 'parse' | 'relations' | 'entities' | 'embed';

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
  /** True if this is a virtual file (content stored in Neo4j _rawContent) */
  isVirtual?: boolean;
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
  { from: 'linked', to: 'entities', action: 'startEntities' },
  { from: 'entities', to: 'embedding', action: 'finishEntities' },
  { from: 'entities', to: 'error', action: 'failEntities' },
  { from: 'embedding', to: 'embedded', action: 'finishEmbedding' },
  { from: 'embedding', to: 'error', action: 'failEmbedding' },
  // Reset on file change
  {
    from: ['parsed', 'relations', 'linked', 'entities', 'embedding', 'embedded', 'error'],
    to: 'discovered',
    action: 'fileChanged',
  },
  // Skip relations (for files without references)
  { from: 'parsed', to: 'linked', action: 'skipRelations' },
  // Skip entities (for files without document content)
  { from: 'linked', to: 'embedding', action: 'skipEntities' },
  // Skip embedding (batch mode)
  { from: 'entities', to: 'embedded', action: 'skipEmbedding' },
  { from: 'linked', to: 'embedded', action: 'skipEntitiesAndEmbedding' },
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
  const flow: FileState[] = ['discovered', 'parsing', 'parsed', 'relations', 'linked', 'entities', 'embedding', 'embedded'];
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
      SET f._state = $newState,
          f._stateUpdatedAt = datetime(),
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
      RETURN f._state as state
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
      SET f._state = $newState,
          f._stateUpdatedAt = datetime(),
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
   *
   * Supports both disk files (have absolutePath) and virtual files (have _rawContent).
   * Returns files that have either:
   * - An absolutePath (disk files)
   * - A _rawContent property (virtual files stored in Neo4j)
   */
  async getFilesInState(
    projectId: string,
    state: FileState | FileState[]
  ): Promise<FileStateInfo[]> {
    const states = Array.isArray(state) ? state : [state];

    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f._state IN $states
        AND (f.absolutePath IS NOT NULL OR f._rawContent IS NOT NULL)
      RETURN f.uuid as uuid,
             f.absolutePath as file,
             f._state as state,
             f.errorType as errorType,
             f.errorMessage as errorMessage,
             f.retryCount as retryCount,
             f._stateUpdatedAt as stateUpdatedAt,
             f._rawContent IS NOT NULL as isVirtual
      ORDER BY f._stateUpdatedAt ASC
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
      isVirtual: r.get('isVirtual') || false,
    }));
  }

  /**
   * Get files that don't have a state yet (for migration)
   */
  async getFilesWithoutState(projectId: string): Promise<Array<{ uuid: string; file: string }>> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f._state IS NULL
      RETURN f.uuid as uuid, f.absolutePath as file
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
      RETURN f._state as state, count(f) as count
    `,
      { projectId }
    );

    const stats: Record<string, number> = {
      discovered: 0,
      parsing: 0,
      parsed: 0,
      relations: 0,
      linked: 0,
      entities: 0,
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
      entities: 0,
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
             f.absolutePath as file,
             f._state as state,
             f.errorType as errorType,
             f.errorMessage as errorMessage,
             f.retryCount as retryCount
      ORDER BY f.retryCount ASC, f._stateUpdatedAt ASC
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
      WHERE f._state IN ['parsing', 'relations', 'entities', 'embedding']
        AND f._stateUpdatedAt < datetime() - duration({milliseconds: $threshold})
      SET f._state = 'discovered',
          f._stateUpdatedAt = datetime(),
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
   * Mark a file as discovered by its absolute path.
   * Creates the File node if it doesn't exist.
   * If the file exists and is in 'embedded' state, resets to 'discovered'.
   * If the file is already being processed (other states), leaves it alone.
   *
   * @param absolutePath - Absolute path to the file
   * @param projectId - Project ID
   * @param relativePath - Optional relative path (for display)
   * @returns Object with created (new file) and reset (existing file reset) flags
   */
  async markDiscovered(
    absolutePath: string,
    projectId: string,
    relativePath?: string
  ): Promise<{ created: boolean; reset: boolean; uuid: string }> {
    const uuid = UniqueIDHelper.GenerateFileUUID(absolutePath);
    const now = new Date().toISOString();

    // MERGE: create if not exists, then conditionally update state
    const result = await this.neo4jClient.run(
      `
      MERGE (f:File {uuid: $uuid})
      ON CREATE SET
        f.file = $relativePath,
        f.absolutePath = $absolutePath,
        f.projectId = $projectId,
        f._state = 'discovered',
        f._stateUpdatedAt = datetime(),
        f.createdAt = $now,
        f.retryCount = 0,
        f._wasCreated = true
      ON MATCH SET
        f._wasCreated = false,
        f._previousState = f._state,
        f._pending = null,
        f._state = CASE
          WHEN f._state = 'embedded' THEN 'discovered'
          WHEN f._state = 'error' THEN 'discovered'
          ELSE f._state
        END,
        f._stateUpdatedAt = CASE
          WHEN f._state IN ['embedded', 'error'] THEN datetime()
          ELSE f._stateUpdatedAt
        END,
        f.retryCount = CASE
          WHEN f._state IN ['embedded', 'error'] THEN 0
          ELSE f.retryCount
        END
      RETURN f._wasCreated as wasCreated,
             f._previousState as previousState,
             f._state as currentState,
             f.uuid as uuid
    `,
      {
        uuid,
        absolutePath,
        projectId,
        relativePath: relativePath || absolutePath,
        now,
      }
    );

    if (result.records.length === 0) {
      return { created: false, reset: false, uuid };
    }

    const record = result.records[0];
    const wasCreated = record.get('wasCreated');
    const previousState = record.get('previousState');
    const currentState = record.get('currentState');

    // Clean up temporary properties
    await this.neo4jClient.run(
      `
      MATCH (f:File {uuid: $uuid})
      REMOVE f._wasCreated, f._previousState
    `,
      { uuid }
    );

    return {
      created: wasCreated === true,
      reset: !wasCreated && previousState !== currentState,
      uuid,
    };
  }

  /**
   * Mark multiple files as discovered (batch version)
   */
  async markDiscoveredBatch(
    files: Array<{ absolutePath: string; relativePath?: string }>,
    projectId: string
  ): Promise<{ created: number; reset: number; skipped: number }> {
    console.log(`[FileStateMachine] markDiscoveredBatch: ${files.length} files for project ${projectId}`);
    if (files.length === 0) {
      return { created: 0, reset: 0, skipped: 0 };
    }

    if (files.length <= 5) {
      console.log(`[FileStateMachine] Files: ${files.map(f => f.absolutePath).join(', ')}`);
    } else {
      console.log(`[FileStateMachine] First 5 files: ${files.slice(0, 5).map(f => f.absolutePath).join(', ')}...`);
    }

    const now = new Date().toISOString();
    const fileData = files.map((f) => ({
      uuid: UniqueIDHelper.GenerateFileUUID(f.absolutePath),
      absolutePath: f.absolutePath,
      relativePath: f.relativePath || f.absolutePath,
    }));

    const result = await this.neo4jClient.run(
      `
      UNWIND $files as fileData
      MERGE (f:File {uuid: fileData.uuid})
      ON CREATE SET
        f.file = fileData.relativePath,
        f.absolutePath = fileData.absolutePath,
        f.projectId = $projectId,
        f._state = 'discovered',
        f._stateUpdatedAt = datetime(),
        f.createdAt = $now,
        f.retryCount = 0,
        f._action = 'created'
      ON MATCH SET
        f._action = CASE
          WHEN f._state IN ['embedded', 'error'] THEN 'reset'
          ELSE 'skipped'
        END,
        f._pending = null,
        f._state = CASE
          WHEN f._state IN ['embedded', 'error'] THEN 'discovered'
          ELSE f._state
        END,
        f._stateUpdatedAt = CASE
          WHEN f._state IN ['embedded', 'error'] THEN datetime()
          ELSE f._stateUpdatedAt
        END,
        f.retryCount = CASE
          WHEN f._state IN ['embedded', 'error'] THEN 0
          ELSE f.retryCount
        END
      WITH f, f._action as action
      REMOVE f._action
      RETURN action, count(*) as cnt
    `,
      { files: fileData, projectId, now }
    );

    let created = 0;
    let reset = 0;
    let skipped = 0;

    for (const record of result.records) {
      const action = record.get('action');
      const count = record.get('cnt')?.toNumber?.() || record.get('cnt') || 0;

      if (action === 'created') created = count;
      else if (action === 'reset') reset = count;
      else if (action === 'skipped') skipped = count;
    }

    console.log(`[FileStateMachine] markDiscoveredBatch result: created=${created}, reset=${reset}, skipped=${skipped}`);
    return { created, reset, skipped };
  }

  /**
   * Mark files as changed by path pattern
   */
  async markFilesChangedByPath(projectId: string, pathPattern: string): Promise<number> {
    const result = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f.file =~ $pattern OR f.absolutePath =~ $pattern
      SET f._state = 'discovered',
          f._stateUpdatedAt = datetime(),
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
    return this.getFilesInState(projectId, ['discovered', 'parsing', 'parsed', 'relations', 'linked', 'entities', 'embedding']);
  }

  /**
   * Check if all files in a project are fully processed
   */
  async isProjectFullyProcessed(projectId: string): Promise<boolean> {
    const stats = await this.getStateStats(projectId);
    const incomplete = stats.discovered + stats.parsing + stats.parsed + stats.relations + stats.linked + stats.entities + stats.embedding + stats.error;
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
      WHERE f._state IS NULL
        AND EXISTS {
          MATCH (s:Scope)-[:DEFINED_IN]->(f)
          WHERE s.embedding_content IS NOT NULL
        }
      SET f._state = 'embedded',
          f._stateUpdatedAt = datetime()
      RETURN count(f) as count
    `,
      { projectId }
    );

    // 2. Files with Scopes but without embeddings → 'linked'
    const linkedResult = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f._state IS NULL
        AND EXISTS { MATCH (s:Scope)-[:DEFINED_IN]->(f) }
      SET f._state = 'linked',
          f._stateUpdatedAt = datetime()
      RETURN count(f) as count
    `,
      { projectId }
    );

    // 3. Files without Scopes → 'discovered'
    const discoveredResult = await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f._state IS NULL
      SET f._state = 'discovered',
          f._stateUpdatedAt = datetime()
      RETURN count(f) as count
    `,
      { projectId }
    );

    // 4. Handle scopes that need embeddings (_state = 'linked' or 'entities')
    await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f._state = 'embedded'
        AND EXISTS {
          MATCH (s:Scope)-[:DEFINED_IN]->(f)
          WHERE s._state IN ['linked', 'entities']
        }
      SET f._state = 'linked'
    `,
      { projectId }
    );

    // 5. Handle schemaDirty on Scopes
    await this.neo4jClient.run(
      `
      MATCH (f:File {projectId: $projectId})
      WHERE f._state IN ['linked', 'embedded']
        AND EXISTS {
          MATCH (n)-[:DEFINED_IN]->(f)
          WHERE n.schemaDirty = true
        }
      SET f._state = 'discovered'
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
      WHERE f._state IS NULL
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
