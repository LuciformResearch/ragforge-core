/**
 * Reference Linker - Simplified API for linking cross-file references
 *
 * This module coordinates reference linking after node ingestion:
 * 1. Extract references from source files
 * 2. Resolve paths to absolute locations
 * 3. Create CONSUMES/IMPORTS relationships
 * 4. Update state machine to 'linked' state
 *
 * Uses reference-extractor.ts under the hood but provides a simpler API
 * that integrates with the state machine workflow.
 *
 * @module reference-linker
 */

import type { Driver, Session } from 'neo4j-driver';
import * as path from 'path';
import * as fs from 'fs/promises';
import { STATE_PROPERTIES as P } from './state-types.js';
import {
  extractReferences,
  resolveAllReferences,
  type ExtractedReference,
  type ResolvedReference,
  type ReferenceType,
} from '../brain/reference-extractor.js';

// ============================================================
// TYPES
// ============================================================

/**
 * Options for linking references
 */
export interface LinkOptions {
  /** Project ID for scoping */
  projectId?: string;
  /** Project root path for resolving relative imports */
  projectRoot?: string;
  /** Mark linked nodes in state machine */
  updateState?: boolean;
  /** Verbose logging */
  verbose?: boolean;
}

/**
 * Statistics from a link operation
 */
export interface LinkStats {
  /** Files processed */
  filesProcessed: number;
  /** References extracted */
  referencesExtracted: number;
  /** References resolved */
  referencesResolved: number;
  /** Relationships created */
  relationshipsCreated: number;
  /** Pending references (unresolved) */
  pendingReferences: number;
  /** Time taken in ms */
  linkTimeMs: number;
}

/**
 * Reference with source context
 */
interface ContextualReference {
  /** Source file path */
  sourceFile: string;
  /** Source node UUID */
  sourceUuid?: string;
  /** Extracted reference */
  reference: ExtractedReference;
  /** Resolved reference (if resolved) */
  resolved?: ResolvedReference;
}

// ============================================================
// REFERENCE LINKER
// ============================================================

/**
 * ReferenceLinker - Coordinates cross-file reference linking
 *
 * @example
 * ```typescript
 * const linker = new ReferenceLinker(driver);
 *
 * // Link references for specific files
 * const stats = await linker.linkReferences(
 *   ['/path/to/file1.ts', '/path/to/file2.ts'],
 *   { projectId: 'my-project', projectRoot: '/path/to/project' }
 * );
 *
 * // Link all pending references in project
 * const stats = await linker.linkPendingReferences('my-project');
 * ```
 */
export class ReferenceLinker {
  private driver: Driver;

  constructor(driver: Driver) {
    this.driver = driver;
  }

  /**
   * Link references for specific files
   *
   * @param files - File paths to process
   * @param options - Link options
   * @returns Link statistics
   */
  async linkReferences(
    files: string[],
    options: LinkOptions = {}
  ): Promise<LinkStats> {
    const startTime = Date.now();
    const {
      projectId,
      projectRoot,
      updateState = true,
      verbose = false,
    } = options;

    const stats: LinkStats = {
      filesProcessed: 0,
      referencesExtracted: 0,
      referencesResolved: 0,
      relationshipsCreated: 0,
      pendingReferences: 0,
      linkTimeMs: 0,
    };

    if (files.length === 0) {
      return stats;
    }

    const session = this.driver.session();
    try {
      // Step 1: Extract references from all files
      const allRefs: ContextualReference[] = [];

      for (const filePath of files) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const refs = extractReferences(content, filePath);

          for (const ref of refs) {
            allRefs.push({
              sourceFile: filePath,
              reference: ref,
            });
          }

          stats.filesProcessed++;
          stats.referencesExtracted += refs.length;

          if (verbose) {
            console.log(`   📎 Extracted ${refs.length} references from ${path.basename(filePath)}`);
          }
        } catch (error) {
          // File might not exist or not be readable
          if (verbose) {
            console.warn(`   ⚠️ Could not extract references from ${filePath}: ${error}`);
          }
        }
      }

      // Step 2: Resolve references
      const root = projectRoot || this.inferProjectRoot(files);
      const resolved = await this.resolveReferences(allRefs, root);

      stats.referencesResolved = resolved.filter(r => r.resolved).length;
      stats.pendingReferences = resolved.filter(r => !r.resolved).length;

      // Step 3: Create relationships
      stats.relationshipsCreated = await this.createRelationships(
        session,
        resolved.filter(r => r.resolved),
        projectId,
        verbose
      );

      // Step 4: Update state machine
      if (updateState && projectId) {
        await this.markAsLinked(session, files, projectId);
      }

    } finally {
      await session.close();
    }

    stats.linkTimeMs = Date.now() - startTime;
    return stats;
  }

  /**
   * Link all pending references in a project
   *
   * Finds nodes in 'parsed' state and links their references.
   */
  async linkPendingReferences(
    projectId: string,
    options: Omit<LinkOptions, 'projectId'> = {}
  ): Promise<LinkStats> {
    const session = this.driver.session();
    try {
      // Find files with nodes in 'parsed' state
      const result = await session.run(
        `
        MATCH (n {projectId: $projectId})
        WHERE n.${P.state} = 'parsed'
        AND (n.file IS NOT NULL OR n.sourcePath IS NOT NULL)
        RETURN DISTINCT coalesce(n.file, n.sourcePath) as file
        `,
        { projectId }
      );

      const files = result.records
        .map(r => r.get('file'))
        .filter(Boolean) as string[];

      if (files.length === 0) {
        return {
          filesProcessed: 0,
          referencesExtracted: 0,
          referencesResolved: 0,
          relationshipsCreated: 0,
          pendingReferences: 0,
          linkTimeMs: 0,
        };
      }

      // Link references for these files
      return this.linkReferences(files, { ...options, projectId });

    } finally {
      await session.close();
    }
  }

  /**
   * Resolve pending imports (retry previously unresolved)
   *
   * Some imports can't be resolved immediately because the target
   * file hasn't been ingested yet. This retries those.
   */
  async resolvePendingImports(
    projectId: string,
    verbose = false
  ): Promise<number> {
    const session = this.driver.session();
    try {
      // Find PENDING_IMPORT relationships
      const result = await session.run(
        `
        MATCH (from)-[r:PENDING_IMPORT]->(placeholder)
        WHERE from.projectId = $projectId
        RETURN from, r, placeholder
        `,
        { projectId }
      );

      if (result.records.length === 0) return 0;

      let resolved = 0;

      for (const record of result.records) {
        const fromNode = record.get('from');
        const rel = record.get('r');
        const importPath = rel.properties.importPath;

        // Try to find the target
        const targetResult = await session.run(
          `
          MATCH (target)
          WHERE target.projectId = $projectId
          AND (target.file = $importPath OR target.path = $importPath)
          RETURN target
          LIMIT 1
          `,
          { projectId, importPath }
        );

        if (targetResult.records.length > 0) {
          const targetNode = targetResult.records[0].get('target');

          // Create actual CONSUMES relationship
          await session.run(
            `
            MATCH (from {uuid: $fromUuid})
            MATCH (to {uuid: $toUuid})
            MERGE (from)-[r:CONSUMES]->(to)
            SET r.resolvedAt = datetime()
            `,
            {
              fromUuid: fromNode.properties.uuid,
              toUuid: targetNode.properties.uuid,
            }
          );

          // Delete pending import
          await session.run(
            `
            MATCH (from {uuid: $fromUuid})-[r:PENDING_IMPORT]->()
            WHERE r.importPath = $importPath
            DELETE r
            `,
            { fromUuid: fromNode.properties.uuid, importPath }
          );

          resolved++;
        }
      }

      if (verbose && resolved > 0) {
        console.log(`   🔗 Resolved ${resolved} pending imports`);
      }

      return resolved;

    } finally {
      await session.close();
    }
  }

  // ============================================================
  // PRIVATE METHODS
  // ============================================================

  /**
   * Resolve references to absolute paths
   */
  private async resolveReferences(
    refs: ContextualReference[],
    projectRoot: string
  ): Promise<ContextualReference[]> {
    const results: ContextualReference[] = [];

    for (const ref of refs) {
      if (!ref.reference.isLocal) {
        // External references (npm packages, URLs) - skip resolution
        results.push(ref);
        continue;
      }

      // Resolve local reference
      const resolved = await resolveAllReferences(
        [ref.reference],
        ref.sourceFile,
        projectRoot
      );

      if (resolved.length > 0 && resolved[0].absolutePath) {
        results.push({
          ...ref,
          resolved: resolved[0],
        });
      } else {
        results.push(ref);
      }
    }

    return results;
  }

  /**
   * Create relationships in Neo4j
   */
  private async createRelationships(
    session: Session,
    refs: ContextualReference[],
    projectId: string | undefined,
    verbose: boolean
  ): Promise<number> {
    let created = 0;

    // Group by source file for batch processing
    const bySource = new Map<string, ContextualReference[]>();
    for (const ref of refs) {
      if (!bySource.has(ref.sourceFile)) {
        bySource.set(ref.sourceFile, []);
      }
      bySource.get(ref.sourceFile)!.push(ref);
    }

    for (const [sourceFile, fileRefs] of bySource) {
      // Find source Scope nodes
      const sourceResult = await session.run(
        `
        MATCH (s:Scope)
        WHERE s.file = $file
        ${projectId ? 'AND s.projectId = $projectId' : ''}
        RETURN s.uuid as uuid, s.name as name, s.startLine as startLine, s.endLine as endLine
        `,
        { file: sourceFile, projectId }
      );

      const sourceScopes = sourceResult.records.map(r => ({
        uuid: r.get('uuid'),
        name: r.get('name'),
        startLine: r.get('startLine')?.toNumber?.() ?? r.get('startLine'),
        endLine: r.get('endLine')?.toNumber?.() ?? r.get('endLine'),
      }));

      for (const ref of fileRefs) {
        if (!ref.resolved) continue;

        // Find target file/scope
        const targetPath = ref.resolved.absolutePath;
        const relType = ref.resolved.relationType;

        // Find best matching source scope (by line number)
        let sourceUuid: string | undefined;
        if (ref.reference.line && sourceScopes.length > 0) {
          const matchingScope = sourceScopes.find(
            s => s.startLine <= ref.reference.line! && s.endLine >= ref.reference.line!
          );
          sourceUuid = matchingScope?.uuid || sourceScopes[0]?.uuid;
        } else if (sourceScopes.length > 0) {
          sourceUuid = sourceScopes[0]?.uuid;
        }

        if (!sourceUuid) {
          // Fall back to File node
          const fileResult = await session.run(
            `
            MATCH (f:File {path: $path})
            ${projectId ? 'WHERE f.projectId = $projectId' : ''}
            RETURN f.uuid as uuid
            `,
            { path: sourceFile, projectId }
          );
          sourceUuid = fileResult.records[0]?.get('uuid');
        }

        if (!sourceUuid) continue;

        // Find target node
        const targetResult = await session.run(
          `
          MATCH (t)
          WHERE (t.file = $path OR t.path = $path OR t.sourcePath = $path)
          ${projectId ? 'AND t.projectId = $projectId' : ''}
          RETURN t.uuid as uuid, labels(t)[0] as label
          LIMIT 1
          `,
          { path: targetPath, projectId }
        );

        const targetUuid = targetResult.records[0]?.get('uuid');

        if (targetUuid) {
          // Create relationship
          await session.run(
            `
            MATCH (from {uuid: $fromUuid})
            MATCH (to {uuid: $toUuid})
            MERGE (from)-[r:${relType}]->(to)
            SET r.symbols = $symbols,
                r.line = $line,
                r.createdAt = datetime()
            `,
            {
              fromUuid: sourceUuid,
              toUuid: targetUuid,
              symbols: ref.reference.symbols,
              line: ref.reference.line,
            }
          );
          created++;
        }
      }
    }

    if (verbose && created > 0) {
      console.log(`   🔗 Created ${created} reference relationships`);
    }

    return created;
  }

  /**
   * Mark nodes as linked in state machine
   */
  private async markAsLinked(
    session: Session,
    files: string[],
    projectId: string
  ): Promise<void> {
    await session.run(
      `
      UNWIND $files AS filePath
      MATCH (n {projectId: $projectId})
      WHERE (n.file = filePath OR n.sourcePath = filePath)
      AND n.${P.state} = 'parsed'
      SET n.${P.state} = 'linked',
          n.${P.linkedAt} = datetime(),
          n.${P.stateChangedAt} = datetime()
      `,
      { files, projectId }
    );
  }

  /**
   * Infer project root from file paths
   */
  private inferProjectRoot(files: string[]): string {
    if (files.length === 0) return process.cwd();

    // Find common prefix
    const parts = files[0].split(path.sep);
    let commonParts = parts.length;

    for (const file of files.slice(1)) {
      const fileParts = file.split(path.sep);
      for (let i = 0; i < commonParts; i++) {
        if (fileParts[i] !== parts[i]) {
          commonParts = i;
          break;
        }
      }
    }

    return parts.slice(0, commonParts).join(path.sep) || '/';
  }
}

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================

/**
 * Create a ReferenceLinker instance
 */
export function createReferenceLinker(driver: Driver): ReferenceLinker {
  return new ReferenceLinker(driver);
}
