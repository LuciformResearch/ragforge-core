/**
 * Clean command - Remove embeddings and/or all ingested data for a project
 *
 * Usage:
 *   ragforge clean <project-path> [--embeddings-only] [--all]
 *
 * Options:
 *   --embeddings-only    Remove only embeddings (keep nodes)
 *   --all                Remove all nodes and embeddings (full cleanup)
 *   -h, --help          Show help
 */

import process from 'process';
import * as path from 'path';
import { BrainManager } from '@luciformresearch/ragforge';
import { ensureEnvLoaded } from '../utils/env.js';

export interface CleanOptions {
  projectPath: string;
  embeddingsOnly: boolean;
  all: boolean;
}

export function parseCleanOptions(args: string[]): CleanOptions {
  let projectPath: string | undefined;
  let embeddingsOnly = false;
  let all = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--embeddings-only':
        embeddingsOnly = true;
        break;
      case '--all':
        all = true;
        break;
      case '-h':
      case '--help':
        printCleanHelp();
        process.exit(0);
        break;
      default:
        if (!projectPath && !arg.startsWith('-')) {
          projectPath = path.resolve(arg);
        } else {
          throw new Error(`Unknown option: ${arg}`);
        }
    }
  }

  if (!projectPath) {
    throw new Error('Project path is required. Usage: ragforge clean <project-path> [--embeddings-only|--all]');
  }

  if (!embeddingsOnly && !all) {
    // Default: embeddings only (safer)
    embeddingsOnly = true;
  }

  if (embeddingsOnly && all) {
    throw new Error('Cannot use both --embeddings-only and --all. Choose one.');
  }

  return {
    projectPath,
    embeddingsOnly,
    all,
  };
}

export async function runClean(options: CleanOptions): Promise<void> {
  const rootDir = ensureEnvLoaded(import.meta.url);
  const brain = await BrainManager.getInstance();

  const resolvedPath = path.resolve(options.projectPath);
  console.log(`🧹 Cleaning project: ${resolvedPath}`);

  // Find project by path (try cache first)
  let project = brain.findProjectByPath(resolvedPath);
  let projectId: string | null = null;
  
  // If not found in cache, search directly in Neo4j
  if (!project) {
    console.log(`📡 Project not in cache, searching in Neo4j...`);
    const neo4jClient = (brain as any).neo4jClient;
    if (!neo4jClient) {
      console.error(`❌ Neo4j client not initialized. Is the daemon running?`);
      process.exitCode = 1;
      return;
    }
    
    // Try by projectId first (in case user passed a projectId instead of path)
    let result = await neo4jClient.run(
      `MATCH (p:Project {projectId: $search})
       OPTIONAL MATCH (n {projectId: p.projectId})
       WITH p, count(n) as nodeCount
       RETURN p.projectId as id, p.rootPath as path, p.type as type,
              p.lastAccessed as lastAccessed, p.excluded as excluded,
              p.autoCleanup as autoCleanup, p.name as displayName,
              nodeCount`,
      { search: options.projectPath } // Try original input as projectId
    );
    
    // If not found, try exact path match
    if (result.records.length === 0) {
      result = await neo4jClient.run(
        `MATCH (p:Project {rootPath: $path})
         OPTIONAL MATCH (n {projectId: p.projectId})
         WITH p, count(n) as nodeCount
         RETURN p.projectId as id, p.rootPath as path, p.type as type,
                p.lastAccessed as lastAccessed, p.excluded as excluded,
                p.autoCleanup as autoCleanup, p.name as displayName,
                nodeCount`,
        { path: resolvedPath }
      );
    }
    
    // If still not found, try matching any project where the path starts with the resolved path
    if (result.records.length === 0) {
      result = await neo4jClient.run(
        `MATCH (p:Project)
         WHERE p.rootPath STARTS WITH $path OR $path STARTS WITH p.rootPath
         OPTIONAL MATCH (n {projectId: p.projectId})
         WITH p, count(n) as nodeCount
         RETURN p.projectId as id, p.rootPath as path, p.type as type,
                p.lastAccessed as lastAccessed, p.excluded as excluded,
                p.autoCleanup as autoCleanup, p.name as displayName,
                nodeCount
         ORDER BY length(p.rootPath) DESC
         LIMIT 1`,
        { path: resolvedPath }
      );
    }
    
    if (result.records.length > 0) {
      const r = result.records[0];
      const lastAccessed = r.get('lastAccessed');
      project = {
        id: r.get('id'),
        path: r.get('path'),
        type: r.get('type') || 'quick-ingest',
        lastAccessed: lastAccessed ? (lastAccessed instanceof Date ? lastAccessed : new Date(lastAccessed)) : new Date(),
        nodeCount: r.get('nodeCount')?.toNumber() || 0,
        excluded: r.get('excluded') || false,
        autoCleanup: r.get('autoCleanup') || false,
        displayName: r.get('displayName'),
      };
      projectId = project.id;
    } else {
      // List all available projects
      const allProjectsResult = await neo4jClient.run(
        `MATCH (p:Project) RETURN p.projectId as id, p.rootPath as path ORDER BY p.rootPath`
      );
      console.error(`❌ Project not found: ${resolvedPath}`);
      console.log(`\n💡 Available projects:`);
      if (allProjectsResult.records.length === 0) {
        console.log(`   (no projects found)`);
      } else {
        allProjectsResult.records.forEach((r: any) => {
          console.log(`   - ${r.get('path')} (ID: ${r.get('id')})`);
        });
      }
      process.exitCode = 1;
      return;
    }
  } else {
    projectId = project.id;
  }

  console.log(`📦 Project ID: ${projectId}`);
  console.log(`📁 Root path: ${project.path}`);

  try {
    if (options.embeddingsOnly) {
      console.log(`\n🗑️  Removing embeddings only (nodes will be kept)...`);
      const stats = await brain.removeProjectEmbeddings(projectId!);
      console.log(`✅ Removed embeddings:`);
      console.log(`   - Scope embeddings: ${stats.scopeEmbeddings}`);
      console.log(`   - File embeddings: ${stats.fileEmbeddings}`);
      console.log(`   - MarkdownSection embeddings: ${stats.markdownSectionEmbeddings}`);
      console.log(`   - CodeBlock embeddings: ${stats.codeBlockEmbeddings}`);
      console.log(`   - Other embeddings: ${stats.otherEmbeddings}`);
      console.log(`\n💡 Nodes are still in the database. Re-run ingestion to regenerate embeddings.`);
      console.log(`💡 All nodes are now marked as "dirty" (hash = null) and will be re-embedded.`);
    } else if (options.all) {
      console.log(`\n⚠️  Removing ALL nodes and embeddings (full cleanup)...`);
      const confirmed = await confirmDeletion();
      if (!confirmed) {
        console.log(`❌ Cancelled.`);
        return;
      }
      await brain.forgetPath(resolvedPath);
      console.log(`✅ Project completely removed from brain.`);
      console.log(`💡 Re-run ingestion to re-index the project.`);
    }
  } catch (error: any) {
    console.error(`❌ Error during cleanup: ${error.message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

async function confirmDeletion(): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    console.log(`\n⚠️  This will permanently delete all data for this project.`);
    console.log(`   Type 'yes' to confirm, or press Ctrl+C to cancel: `);

    process.stdin.once('data', (key: string) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      const input = key.toString().trim().toLowerCase();
      resolve(input === 'yes' || input === 'y');
    });
  });
}

export function printCleanHelp(): void {
  console.log(`
Clean - Remove embeddings and/or all ingested data for a project

Usage:
  ragforge clean <project-path> [options]

Options:
  --embeddings-only    Remove only embeddings (keep nodes)
                       Default behavior if no option specified
  --all                Remove all nodes and embeddings (full cleanup)
                       Requires confirmation
  -h, --help          Show this help message

Examples:
  # Remove embeddings only (safer, allows re-generation)
  ragforge clean /path/to/project --embeddings-only

  # Remove everything (full cleanup)
  ragforge clean /path/to/project --all

  # Default: embeddings only
  ragforge clean /path/to/project

Notes:
  - After removing embeddings, re-run ingestion to regenerate them
  - After --all cleanup, the project must be re-ingested completely
  - Use 'ragforge list-projects' to see all registered projects
`);
}
