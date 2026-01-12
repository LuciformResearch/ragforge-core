/**
 * NodeStateMachine - Universal state management for all nodes
 *
 * Manages the lifecycle states of nodes during ingestion.
 * Replaces the simple embeddingsDirty/schemaDirty booleans with a proper state machine.
 *
 * All state is persisted in Neo4j, allowing:
 * - Recovery after crash/restart
 * - Query nodes by state for batch processing
 * - Full audit trail with timestamps
 */

import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import {
  type NodeState,
  type StateErrorType,
  type TransitionOptions,
  type NodeStateInfo,
  type BatchTransition,
  type StateCounts,
  type StateQueryOptions,
  type RetryOptions,
  isValidTransition,
  STATE_PROPERTIES as P,
  STATEFUL_NODE_LABELS,
} from './state-types.js';

export class NodeStateMachine {
  constructor(private neo4jClient: Neo4jClient) {}

  /**
   * Transition a single node to a new state
   *
   * @param nodeUuid - UUID of the node
   * @param nodeLabel - Label of the node (Scope, File, etc.)
   * @param newState - Target state
   * @param options - Additional options (error info, hashes, etc.)
   * @returns true if transition was successful
   */
  async transition(
    nodeUuid: string,
    nodeLabel: string,
    newState: NodeState,
    options?: TransitionOptions
  ): Promise<boolean> {
    const now = new Date().toISOString();

    // Build SET clause based on the new state
    let additionalSets = '';
    if (newState === 'parsed') {
      additionalSets = `, n.${P.parsedAt} = datetime()`;
    } else if (newState === 'linked') {
      additionalSets = `, n.${P.linkedAt} = datetime()`;
    } else if (newState === 'ready') {
      additionalSets = `, n.${P.embeddedAt} = datetime()`;
    } else if (newState === 'pending') {
      // Reset timestamps when going back to pending
      additionalSets = `, n.${P.parsedAt} = null, n.${P.linkedAt} = null, n.${P.embeddedAt} = null`;
    }

    const result = await this.neo4jClient.run(
      `
      MATCH (n:${nodeLabel} {uuid: $uuid})
      SET n.${P.state} = $newState,
          n.${P.stateChangedAt} = datetime($now),
          n.${P.errorType} = $errorType,
          n.${P.errorMessage} = $errorMessage,
          n.${P.contentHash} = COALESCE($contentHash, n.${P.contentHash}),
          n.${P.embeddingProvider} = COALESCE($embeddingProvider, n.${P.embeddingProvider}),
          n.${P.embeddingModel} = COALESCE($embeddingModel, n.${P.embeddingModel}),
          n.${P.retryCount} = CASE
            WHEN $newState = 'error' THEN COALESCE(n.${P.retryCount}, 0) + 1
            WHEN $newState = 'pending' THEN 0
            ELSE n.${P.retryCount}
          END,
          n.${P.detectedAt} = COALESCE(n.${P.detectedAt}, datetime($now))
          ${additionalSets}
      RETURN n.${P.state} AS state
      `,
      {
        uuid: nodeUuid,
        newState,
        now,
        errorType: options?.errorType || null,
        errorMessage: options?.errorMessage || null,
        contentHash: options?.contentHash || null,
        embeddingProvider: options?.embeddingProvider || null,
        embeddingModel: options?.embeddingModel || null,
      }
    );

    return result.records.length > 0;
  }

  /**
   * Transition multiple nodes in a batch (more efficient)
   *
   * @param transitions - Array of transitions to perform
   * @returns Number of successful transitions
   */
  async transitionBatch(transitions: BatchTransition[]): Promise<number> {
    if (transitions.length === 0) return 0;

    const now = new Date().toISOString();

    // Group by label for efficient queries
    const byLabel = new Map<string, BatchTransition[]>();
    for (const t of transitions) {
      const existing = byLabel.get(t.label) || [];
      existing.push(t);
      byLabel.set(t.label, existing);
    }

    let totalTransitioned = 0;

    for (const [label, labelTransitions] of byLabel) {
      const data = labelTransitions.map(t => ({
        uuid: t.uuid,
        state: t.state,
        errorType: t.options?.errorType || null,
        errorMessage: t.options?.errorMessage || null,
        contentHash: t.options?.contentHash || null,
        embeddingProvider: t.options?.embeddingProvider || null,
        embeddingModel: t.options?.embeddingModel || null,
      }));

      const result = await this.neo4jClient.run(
        `
        UNWIND $data AS d
        MATCH (n:${label} {uuid: d.uuid})
        SET n.${P.state} = d.state,
            n.${P.stateChangedAt} = datetime($now),
            n.${P.errorType} = d.errorType,
            n.${P.errorMessage} = d.errorMessage,
            n.${P.contentHash} = COALESCE(d.contentHash, n.${P.contentHash}),
            n.${P.embeddingProvider} = COALESCE(d.embeddingProvider, n.${P.embeddingProvider}),
            n.${P.embeddingModel} = COALESCE(d.embeddingModel, n.${P.embeddingModel}),
            n.${P.retryCount} = CASE
              WHEN d.state = 'error' THEN COALESCE(n.${P.retryCount}, 0) + 1
              WHEN d.state = 'pending' THEN 0
              ELSE n.${P.retryCount}
            END,
            n.${P.detectedAt} = COALESCE(n.${P.detectedAt}, datetime($now)),
            n.${P.parsedAt} = CASE WHEN d.state = 'parsed' THEN datetime($now) ELSE n.${P.parsedAt} END,
            n.${P.linkedAt} = CASE WHEN d.state = 'linked' THEN datetime($now) ELSE n.${P.linkedAt} END,
            n.${P.embeddedAt} = CASE WHEN d.state = 'ready' THEN datetime($now) ELSE n.${P.embeddedAt} END
        RETURN count(n) AS count
        `,
        { data, now }
      );

      totalTransitioned += result.records[0]?.get('count')?.toNumber() || 0;
    }

    return totalTransitioned;
  }

  /**
   * Get nodes by state
   *
   * @param state - State to query
   * @param options - Query options (filters, limits, etc.)
   * @returns Array of node state info
   */
  async getNodesByState(
    state: NodeState,
    options?: StateQueryOptions
  ): Promise<NodeStateInfo[]> {
    const { label, projectId, errorType, limit = 100, offset = 0, includeDetails = true } = options || {};

    // Build WHERE clause
    const conditions: string[] = [`n.${P.state} = $state`];
    const params: Record<string, any> = { state, limit, offset };

    if (projectId) {
      conditions.push('n.projectId = $projectId');
      params.projectId = projectId;
    }
    if (errorType) {
      conditions.push(`n.${P.errorType} = $errorType`);
      params.errorType = errorType;
    }

    const whereClause = conditions.join(' AND ');

    // Build label match
    const labelMatch = label ? `:${label}` : '';

    // Build return clause
    const detailFields = includeDetails
      ? ', n.name AS name, n.file AS file, n.projectId AS projectId'
      : '';

    const result = await this.neo4jClient.run(
      `
      MATCH (n${labelMatch})
      WHERE ${whereClause}
      RETURN n.uuid AS uuid,
             labels(n)[0] AS label,
             n.${P.state} AS state,
             n.${P.errorType} AS errorType,
             n.${P.errorMessage} AS errorMessage,
             n.${P.retryCount} AS retryCount,
             n.${P.stateChangedAt} AS stateChangedAt,
             n.${P.detectedAt} AS detectedAt,
             n.${P.parsedAt} AS parsedAt,
             n.${P.linkedAt} AS linkedAt,
             n.${P.embeddedAt} AS embeddedAt,
             n.${P.contentHash} AS contentHash,
             n.${P.embeddingProvider} AS embeddingProvider,
             n.${P.embeddingModel} AS embeddingModel
             ${detailFields}
      ORDER BY n.${P.stateChangedAt} ASC
      SKIP $offset
      LIMIT $limit
      `,
      params
    );

    return result.records.map(r => this.recordToStateInfo(r, includeDetails));
  }

  /**
   * Count nodes by state
   *
   * @param projectId - Optional project filter
   * @returns Counts for each state
   */
  async countByState(projectId?: string): Promise<StateCounts> {
    const whereClause = projectId
      ? `WHERE n.projectId = $projectId AND n.${P.state} IS NOT NULL`
      : `WHERE n.${P.state} IS NOT NULL`;

    const result = await this.neo4jClient.run(
      `
      MATCH (n)
      ${whereClause}
      RETURN n.${P.state} AS state, count(n) AS count
      `,
      { projectId }
    );

    const counts: StateCounts = {
      pending: 0,
      parsing: 0,
      parsed: 0,
      linking: 0,
      linked: 0,
      embedding: 0,
      ready: 0,
      skip: 0,
      error: 0,
    };

    for (const record of result.records) {
      const state = record.get('state') as NodeState;
      const count = record.get('count')?.toNumber() || 0;
      if (state in counts) {
        counts[state] = count;
      }
    }

    return counts;
  }

  /**
   * Retry nodes in error state
   *
   * @param options - Retry options
   * @returns Number of nodes reset to pending
   */
  async retryErrors(options?: RetryOptions): Promise<number> {
    const { errorType, maxRetries = 3, projectId, label } = options || {};

    const conditions: string[] = [
      `n.${P.state} = 'error'`,
      `COALESCE(n.${P.retryCount}, 0) < $maxRetries`,
    ];
    const params: Record<string, any> = { maxRetries };

    if (errorType) {
      conditions.push(`n.${P.errorType} = $errorType`);
      params.errorType = errorType;
    }
    if (projectId) {
      conditions.push('n.projectId = $projectId');
      params.projectId = projectId;
    }

    const labelMatch = label ? `:${label}` : '';
    const whereClause = conditions.join(' AND ');
    const now = new Date().toISOString();

    const result = await this.neo4jClient.run(
      `
      MATCH (n${labelMatch})
      WHERE ${whereClause}
      SET n.${P.state} = 'pending',
          n.${P.stateChangedAt} = datetime($now),
          n.${P.errorType} = null,
          n.${P.errorMessage} = null
      RETURN count(n) AS count
      `,
      { ...params, now }
    );

    return result.records[0]?.get('count')?.toNumber() || 0;
  }

  /**
   * Mark a node as changed (reset to pending if content hash differs)
   *
   * @param nodeUuid - Node UUID
   * @param nodeLabel - Node label
   * @param newContentHash - New content hash
   * @returns true if node was reset
   */
  async markChanged(
    nodeUuid: string,
    nodeLabel: string,
    newContentHash: string
  ): Promise<boolean> {
    const now = new Date().toISOString();

    const result = await this.neo4jClient.run(
      `
      MATCH (n:${nodeLabel} {uuid: $uuid})
      WHERE n.${P.contentHash} IS NULL OR n.${P.contentHash} <> $newContentHash
      SET n.${P.state} = 'pending',
          n.${P.stateChangedAt} = datetime($now),
          n.${P.contentHash} = $newContentHash,
          n.${P.errorType} = null,
          n.${P.errorMessage} = null,
          n.${P.retryCount} = 0,
          n.${P.parsedAt} = null,
          n.${P.linkedAt} = null,
          n.${P.embeddedAt} = null
      RETURN n.uuid AS uuid
      `,
      { uuid: nodeUuid, newContentHash, now }
    );

    return result.records.length > 0;
  }

  /**
   * Mark multiple nodes as changed in batch
   *
   * @param changes - Array of {uuid, label, contentHash}
   * @returns Number of nodes reset
   */
  async markChangedBatch(
    changes: Array<{ uuid: string; label: string; contentHash: string }>
  ): Promise<number> {
    if (changes.length === 0) return 0;

    const now = new Date().toISOString();

    // Group by label
    const byLabel = new Map<string, Array<{ uuid: string; contentHash: string }>>();
    for (const c of changes) {
      const existing = byLabel.get(c.label) || [];
      existing.push({ uuid: c.uuid, contentHash: c.contentHash });
      byLabel.set(c.label, existing);
    }

    let totalReset = 0;

    for (const [label, labelChanges] of byLabel) {
      const result = await this.neo4jClient.run(
        `
        UNWIND $changes AS c
        MATCH (n:${label} {uuid: c.uuid})
        WHERE n.${P.contentHash} IS NULL OR n.${P.contentHash} <> c.contentHash
        SET n.${P.state} = 'pending',
            n.${P.stateChangedAt} = datetime($now),
            n.${P.contentHash} = c.contentHash,
            n.${P.errorType} = null,
            n.${P.errorMessage} = null,
            n.${P.retryCount} = 0,
            n.${P.parsedAt} = null,
            n.${P.linkedAt} = null,
            n.${P.embeddedAt} = null
        RETURN count(n) AS count
        `,
        { changes: labelChanges, now }
      );

      totalReset += result.records[0]?.get('count')?.toNumber() || 0;
    }

    return totalReset;
  }

  /**
   * Initialize state for new nodes (set to pending if no state)
   *
   * @param projectId - Optional project filter
   * @returns Number of nodes initialized
   */
  async initializeStates(projectId?: string): Promise<number> {
    const now = new Date().toISOString();
    let total = 0;

    for (const label of STATEFUL_NODE_LABELS) {
      const whereClause = projectId
        ? `WHERE n.${P.state} IS NULL AND n.projectId = $projectId`
        : `WHERE n.${P.state} IS NULL`;

      const result = await this.neo4jClient.run(
        `
        MATCH (n:${label})
        ${whereClause}
        SET n.${P.state} = 'pending',
            n.${P.stateChangedAt} = datetime($now),
            n.${P.detectedAt} = COALESCE(n.${P.detectedAt}, datetime($now)),
            n.${P.retryCount} = 0
        RETURN count(n) AS count
        `,
        { projectId, now }
      );

      total += result.records[0]?.get('count')?.toNumber() || 0;
    }

    return total;
  }

  /**
   * Get state info for a specific node
   *
   * @param nodeUuid - Node UUID
   * @param nodeLabel - Node label
   * @returns Node state info or null if not found
   */
  async getNodeState(nodeUuid: string, nodeLabel: string): Promise<NodeStateInfo | null> {
    const result = await this.neo4jClient.run(
      `
      MATCH (n:${nodeLabel} {uuid: $uuid})
      RETURN n.uuid AS uuid,
             labels(n)[0] AS label,
             n.${P.state} AS state,
             n.${P.errorType} AS errorType,
             n.${P.errorMessage} AS errorMessage,
             n.${P.retryCount} AS retryCount,
             n.${P.stateChangedAt} AS stateChangedAt,
             n.${P.detectedAt} AS detectedAt,
             n.${P.parsedAt} AS parsedAt,
             n.${P.linkedAt} AS linkedAt,
             n.${P.embeddedAt} AS embeddedAt,
             n.${P.contentHash} AS contentHash,
             n.${P.embeddingProvider} AS embeddingProvider,
             n.${P.embeddingModel} AS embeddingModel,
             n.name AS name,
             n.file AS file,
             n.projectId AS projectId
      `,
      { uuid: nodeUuid }
    );

    if (result.records.length === 0) return null;
    return this.recordToStateInfo(result.records[0], true);
  }

  /**
   * Get summary statistics for a project
   */
  async getProjectStats(projectId: string): Promise<{
    counts: StateCounts;
    errorsByType: Record<StateErrorType, number>;
    averageRetryCount: number;
    oldestPending: Date | null;
  }> {
    const counts = await this.countByState(projectId);

    // Get error breakdown
    const errorResult = await this.neo4jClient.run(
      `
      MATCH (n {projectId: $projectId})
      WHERE n.${P.state} = 'error'
      RETURN n.${P.errorType} AS errorType, count(n) AS count
      `,
      { projectId }
    );

    const errorsByType: Record<StateErrorType, number> = {
      parse: 0,
      link: 0,
      embed: 0,
    };
    for (const record of errorResult.records) {
      const type = record.get('errorType') as StateErrorType;
      if (type) {
        errorsByType[type] = record.get('count')?.toNumber() || 0;
      }
    }

    // Get average retry count
    const retryResult = await this.neo4jClient.run(
      `
      MATCH (n {projectId: $projectId})
      WHERE n.${P.retryCount} > 0
      RETURN avg(n.${P.retryCount}) AS avgRetry
      `,
      { projectId }
    );
    const averageRetryCount = retryResult.records[0]?.get('avgRetry') || 0;

    // Get oldest pending
    const oldestResult = await this.neo4jClient.run(
      `
      MATCH (n {projectId: $projectId})
      WHERE n.${P.state} = 'pending'
      RETURN min(n.${P.stateChangedAt}) AS oldest
      `,
      { projectId }
    );
    const oldestPending = oldestResult.records[0]?.get('oldest')?.toStandardDate() || null;

    return { counts, errorsByType, averageRetryCount, oldestPending };
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private recordToStateInfo(record: any, includeDetails: boolean): NodeStateInfo {
    const info: NodeStateInfo = {
      uuid: record.get('uuid'),
      label: record.get('label'),
      state: record.get('state') || 'pending',
      retryCount: record.get('retryCount')?.toNumber?.() || record.get('retryCount') || 0,
      stateChangedAt: record.get('stateChangedAt')?.toStandardDate?.() || new Date(),
    };

    const errorType = record.get('errorType');
    if (errorType) info.errorType = errorType;

    const errorMessage = record.get('errorMessage');
    if (errorMessage) info.errorMessage = errorMessage;

    const detectedAt = record.get('detectedAt');
    if (detectedAt) info.detectedAt = detectedAt.toStandardDate?.() || detectedAt;

    const parsedAt = record.get('parsedAt');
    if (parsedAt) info.parsedAt = parsedAt.toStandardDate?.() || parsedAt;

    const linkedAt = record.get('linkedAt');
    if (linkedAt) info.linkedAt = linkedAt.toStandardDate?.() || linkedAt;

    const embeddedAt = record.get('embeddedAt');
    if (embeddedAt) info.embeddedAt = embeddedAt.toStandardDate?.() || embeddedAt;

    const contentHash = record.get('contentHash');
    if (contentHash) info.contentHash = contentHash;

    const embeddingProvider = record.get('embeddingProvider');
    if (embeddingProvider) info.embeddingProvider = embeddingProvider;

    const embeddingModel = record.get('embeddingModel');
    if (embeddingModel) info.embeddingModel = embeddingModel;

    if (includeDetails) {
      const name = record.get('name');
      if (name) info.name = name;

      const file = record.get('file');
      if (file) info.file = file;

      const projectId = record.get('projectId');
      if (projectId) info.projectId = projectId;
    }

    return info;
  }
}
