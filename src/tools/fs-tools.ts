/**
 * File System Tools
 *
 * Agent tools for file system exploration and manipulation.
 * Uses fs-helpers.ts for actual implementation.
 *
 * @since 2025-12-07
 */

import path from 'path';
import type { GeneratedToolDefinition } from './types/index.js';
import * as fsHelpers from './fs-helpers.js';
import { distance as levenshtein } from 'fastest-levenshtein';
import pLimit from 'p-limit';
import { rgPath } from '@vscode/ripgrep';

// ============================================
// File Line Count Cache (in-memory, TTL-based)
// ============================================

interface CachedLineCount {
  lineCount: number;
  mtime: number; // File modification time for invalidation
  cachedAt: number;
}

const fileLineCountCache = new Map<string, CachedLineCount>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getFileLineCount(filePath: string, fs: typeof import('fs/promises')): Promise<number | undefined> {
  try {
    const stats = await fs.stat(filePath);
    const mtime = stats.mtimeMs;
    const now = Date.now();

    // Check cache
    const cached = fileLineCountCache.get(filePath);
    if (cached && cached.mtime === mtime && (now - cached.cachedAt) < CACHE_TTL_MS) {
      return cached.lineCount;
    }

    // Read and count lines
    const content = await fs.readFile(filePath, 'utf-8');
    const lineCount = content.split('\n').length;

    // Cache result
    fileLineCountCache.set(filePath, { lineCount, mtime, cachedAt: now });

    // Cleanup old entries (max 500 files in cache)
    if (fileLineCountCache.size > 500) {
      const entries = [...fileLineCountCache.entries()];
      entries.sort((a, b) => a[1].cachedAt - b[1].cachedAt);
      for (let i = 0; i < 100; i++) {
        fileLineCountCache.delete(entries[i][0]);
      }
    }

    return lineCount;
  } catch {
    return undefined;
  }
}

// ============================================
// Types
// ============================================

export interface FsToolsContext {
  /**
   * Project root directory (for relative paths)
   * Can be a string or a getter function for dynamic resolution
   */
  projectRoot: string | (() => string | null);

  /**
   * Callback after file deletion (for Neo4j cleanup)
   */
  onFileDeleted?: (filePath: string) => Promise<void>;

  /**
   * Callback after file move (for Neo4j update)
   */
  onFileMoved?: (source: string, destination: string) => Promise<void>;

  /**
   * Callback after file copy (for Neo4j tracking of destination)
   */
  onFileCopied?: (source: string, destination: string) => Promise<void>;
}

/**
 * Helper to resolve projectRoot from context
 */
function getProjectRoot(ctx: FsToolsContext): string | null {
  if (typeof ctx.projectRoot === 'function') {
    return ctx.projectRoot();
  }
  return ctx.projectRoot;
}

// ============================================
// Tool Definitions
// ============================================

export function generateListDirectoryTool(): GeneratedToolDefinition {
  return {
    name: 'list_directory',
    section: 'file_ops',
    description: `List files and directories in a given path.

Returns file names, types (file/directory), sizes, and modification times.
Use this to explore a codebase or check what files exist.

Parameters:
- path: Directory to list (default: project root)
- recursive: Include subdirectories (default: false)
- show_hidden: Include hidden files starting with . (default: false)
- no_default_excludes: Include node_modules, .git, dist, etc. (default: false)

Example: list_directory({ path: "src" })
Example: list_directory({ path: ".", recursive: true })
Example: list_directory({ path: "node_modules", no_default_excludes: true })`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list (default: project root)',
          optional: true,
        },
        recursive: {
          type: 'boolean',
          description: 'Include subdirectories recursively (default: false)',
          optional: true,
        },
        show_hidden: {
          type: 'boolean',
          description: 'Include hidden files starting with . (default: false)',
          optional: true,
        },
        no_default_excludes: {
          type: 'boolean',
          description: 'Disable default excludes (node_modules, .git, dist, etc.)',
          optional: true,
        },
      },
    },
  };
}

export function generateGlobFilesTool(): GeneratedToolDefinition {
  return {
    name: 'glob_files',
    section: 'file_ops',
    description: `Find files matching a glob pattern.

Useful to find all files of a certain type or in a specific location.
Does NOT read file contents - just returns matching paths.

Common patterns:
- "**/*.ts" - All TypeScript files recursively
- "src/**/*.vue" - All Vue files in src
- "*.json" - JSON files in current directory
- "**/*.{ts,tsx}" - TypeScript and TSX files

Parameters:
- pattern: Glob pattern to match
- cwd: Base directory for pattern (default: project root)
- ignore: Additional patterns to ignore
- no_default_excludes: Include node_modules, .git, dist, etc. (default: false)

Example: glob_files({ pattern: "**/*.ts" })
Example: glob_files({ pattern: "src/components/**/*.vue" })
Example: glob_files({ pattern: "node_modules/**/*.d.ts", no_default_excludes: true })`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.vue")',
        },
        cwd: {
          type: 'string',
          description: 'Base directory for pattern (default: project root)',
          optional: true,
        },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional patterns to ignore',
          optional: true,
        },
        no_default_excludes: {
          type: 'boolean',
          description: 'Disable default excludes (node_modules, .git, dist, etc.)',
          optional: true,
        },
      },
      required: ['pattern'],
    },
  };
}

export function generateFileExistsTool(): GeneratedToolDefinition {
  return {
    name: 'file_exists',
    section: 'file_ops',
    description: `Check if a file or directory exists.

Quick check without reading the file. Returns basic info if exists.

Parameters:
- path: Path to check

Example: file_exists({ path: "package.json" })
Example: file_exists({ path: "src/utils" })`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or directory path to check',
        },
      },
      required: ['path'],
    },
  };
}

export function generateGetFileInfoTool(): GeneratedToolDefinition {
  return {
    name: 'get_file_info',
    section: 'file_ops',
    description: `Get detailed information about a file or directory.

Returns: exists, type, size, created/modified/accessed times, permissions.

Parameters:
- path: Path to get info for

Example: get_file_info({ path: "package.json" })`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or directory path',
        },
      },
      required: ['path'],
    },
  };
}

export function generateDeletePathTool(): GeneratedToolDefinition {
  return {
    name: 'delete_path',
    section: 'file_ops',
    description: `Delete a file or directory.

By default, only deletes files and empty directories. Use recursive: true for non-empty directories.
The deletion is tracked and removed from the knowledge graph.

Parameters:
- path: File or directory to delete
- recursive: Delete non-empty directories (default: false)

Example: delete_path({ path: "src/old-file.ts" })
Example: delete_path({ path: "temp", recursive: true })`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to delete',
        },
        recursive: {
          type: 'boolean',
          description: 'Delete non-empty directories (default: false, DANGEROUS)',
          optional: true,
        },
      },
      required: ['path'],
    },
  };
}

export function generateMoveFileTool(): GeneratedToolDefinition {
  return {
    name: 'move_file',
    section: 'file_ops',
    description: `Move or rename a file or directory.

Creates parent directories if needed.
Updates the knowledge graph to reflect the new path.

Parameters:
- source: Current path
- destination: New path

Example: move_file({ source: "src/utils.ts", destination: "src/lib/utils.ts" })
Example: move_file({ source: "old-name.ts", destination: "new-name.ts" })`,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Current file/directory path',
        },
        destination: {
          type: 'string',
          description: 'New path',
        },
      },
      required: ['source', 'destination'],
    },
  };
}

export function generateCopyFileTool(): GeneratedToolDefinition {
  return {
    name: 'copy_file',
    section: 'file_ops',
    description: `Copy a file or directory.

Creates parent directories if needed.
Directories are copied recursively by default.
Fails if destination already exists (use overwrite: true to replace).

Parameters:
- source: File/directory to copy
- destination: Destination path
- overwrite: Replace if destination exists (default: false)

Example: copy_file({ source: "template.ts", destination: "src/new-file.ts" })
Example: copy_file({ source: "src/components", destination: "src/components-backup" })`,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Source path',
        },
        destination: {
          type: 'string',
          description: 'Destination path',
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace if destination exists (default: false)',
        },
      },
      required: ['source', 'destination'],
    },
  };
}

export function generateCreateDirectoryTool(): GeneratedToolDefinition {
  return {
    name: 'create_directory',
    section: 'file_ops',
    description: `Create a directory (and parent directories if needed).

Equivalent to "mkdir -p". Does nothing if directory already exists.

Parameters:
- path: Directory path to create

Example: create_directory({ path: "src/components/ui" })`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to create',
        },
      },
      required: ['path'],
    },
  };
}

// ============================================
// Handler Generators
// ============================================

export function generateListDirectoryHandler(ctx: FsToolsContext) {
  return async (params: {
    path?: string;
    recursive?: boolean;
    show_hidden?: boolean;
    no_default_excludes?: boolean;
  }) => {
    // Use projectRoot if available, otherwise fall back to cwd
    const projectRoot = getProjectRoot(ctx) || process.cwd();

    try {
      const dirPath = params.path || '.';
      return await fsHelpers.listDirectory(dirPath, {
        basePath: projectRoot,
        recursive: params.recursive,
        showHidden: params.show_hidden,
        noDefaultExcludes: params.no_default_excludes,
      });
    } catch (err: any) {
      return { error: err.message };
    }
  };
}

export function generateGlobFilesHandler(ctx: FsToolsContext) {
  return async (params: {
    pattern: string;
    cwd?: string;
    ignore?: string[];
    no_default_excludes?: boolean;
  }) => {
    // Use projectRoot if available, otherwise fall back to cwd
    const projectRoot = getProjectRoot(ctx) || process.cwd();

    try {
      const cwd = params.cwd
        ? (path.isAbsolute(params.cwd) ? params.cwd : path.join(projectRoot, params.cwd))
        : projectRoot;

      const defaultIgnore = params.no_default_excludes
        ? []
        : ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/__pycache__/**', '**/build/**', '**/.next/**', '**/.nuxt/**', '**/coverage/**'];
      const ignore = params.ignore ? [...defaultIgnore, ...params.ignore] : defaultIgnore;

      return await fsHelpers.globFiles(params.pattern, { cwd, ignore });
    } catch (err: any) {
      return { error: err.message };
    }
  };
}

export function generateFileExistsHandler(ctx: FsToolsContext) {
  return async (params: { path: string }) => {
    // Use projectRoot if available, otherwise fall back to cwd
    const projectRoot = getProjectRoot(ctx) || process.cwd();

    try {
      const exists = await fsHelpers.pathExists(params.path, { basePath: projectRoot });
      if (exists) {
        const info = await fsHelpers.getFileInfo(params.path, { basePath: projectRoot });
        return {
          exists: true,
          type: info.type,
          path: params.path,
          absolutePath: info.absolutePath,
        };
      }
      return { exists: false, path: params.path };
    } catch (err: any) {
      return { error: err.message };
    }
  };
}

export function generateGetFileInfoHandler(ctx: FsToolsContext) {
  return async (params: { path: string }) => {
    // Use projectRoot if available, otherwise fall back to cwd
    const projectRoot = getProjectRoot(ctx) || process.cwd();

    try {
      return await fsHelpers.getFileInfo(params.path, { basePath: projectRoot });
    } catch (err: any) {
      return { error: err.message };
    }
  };
}

export function generateDeletePathHandler(ctx: FsToolsContext) {
  return async (params: { path: string; recursive?: boolean }) => {
    // Use projectRoot if available, otherwise fall back to cwd
    const projectRoot = getProjectRoot(ctx) || process.cwd();

    try {
      const result = await fsHelpers.deletePath(params.path, {
        basePath: projectRoot,
        recursive: params.recursive,
      });

      // Notify for Neo4j cleanup
      if (ctx.onFileDeleted) {
        await ctx.onFileDeleted(result.absolutePath);
      }

      return result;
    } catch (err: any) {
      if (err.code === 'ENOTEMPTY') {
        return {
          error: `Directory not empty: ${params.path}. Use recursive: true to delete non-empty directories.`,
        };
      }
      return { error: err.message };
    }
  };
}

export function generateMoveFileHandler(ctx: FsToolsContext) {
  return async (params: { source: string; destination: string }) => {
    // Use projectRoot if available, otherwise fall back to cwd
    const projectRoot = getProjectRoot(ctx) || process.cwd();

    try {
      const result = await fsHelpers.moveFile(params.source, params.destination, {
        basePath: projectRoot,
      });

      // Notify for Neo4j update
      if (ctx.onFileMoved) {
        await ctx.onFileMoved(result.absoluteSource, result.absoluteDestination);
      }

      return result;
    } catch (err: any) {
      return { error: err.message };
    }
  };
}

export function generateCopyFileHandler(ctx: FsToolsContext) {
  return async (params: { source: string; destination: string; overwrite?: boolean }) => {
    // Use projectRoot if available, otherwise fall back to cwd
    const projectRoot = getProjectRoot(ctx) || process.cwd();

    try {
      const result = await fsHelpers.copyFile(params.source, params.destination, {
        basePath: projectRoot,
        overwrite: params.overwrite ?? false,
      });

      // Notify callback for tracking (re-ingestion + orphan tracking)
      if (ctx.onFileCopied && result.copied) {
        try {
          await ctx.onFileCopied(result.absoluteSource, result.absoluteDestination);
        } catch (err: any) {
          console.error('[FsTools] onFileCopied error:', err.message);
        }
      }

      return result;
    } catch (err: any) {
      return { error: err.message };
    }
  };
}

export function generateCreateDirectoryHandler(ctx: FsToolsContext) {
  return async (params: { path: string }) => {
    // Use projectRoot if available, otherwise fall back to cwd
    const projectRoot = getProjectRoot(ctx) || process.cwd();

    try {
      return await fsHelpers.createDirectory(params.path, { basePath: projectRoot });
    } catch (err: any) {
      return { error: err.message };
    }
  };
}

// ============================================
// Change Directory Tool
// ============================================

export function generateChangeDirectoryTool(): GeneratedToolDefinition {
  return {
    name: 'change_directory',
    section: 'file_ops',
    description: `Change the current working directory.

Changes the process working directory (like 'cd' in shell).
Use this to navigate before running commands or file operations.

Parameters:
- path: Directory to change to (absolute or relative)

Example: change_directory({ path: "src/components" })
Example: change_directory({ path: ".." })
Example: change_directory({ path: "/home/user/project" })`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to change to',
        },
      },
      required: ['path'],
    },
  };
}

export function generateChangeDirectoryHandler(ctx: FsToolsContext) {
  return async (params: { path: string }) => {
    const fs = await import('fs/promises');

    const projectRoot = getProjectRoot(ctx);
    const targetPath = path.isAbsolute(params.path)
      ? params.path
      : path.join(process.cwd(), params.path);

    // Check if directory exists
    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        return { error: `Not a directory: ${params.path}` };
      }
    } catch (err: any) {
      return { error: `Directory not found: ${params.path}` };
    }

    // Change directory
    const previousDir = process.cwd();
    try {
      process.chdir(targetPath);
      return {
        previous_directory: previousDir,
        current_directory: process.cwd(),
        success: true,
      };
    } catch (err: any) {
      return { error: `Failed to change directory: ${err.message}` };
    }
  };
}

// ============================================
// Search Tools (grep, fuzzy search)
// ============================================

export function generateGrepFilesTool(): GeneratedToolDefinition {
  return {
    name: 'grep_files',
    section: 'file_ops',
    description: `Search file contents using regex pattern.

Searches within files matching a glob pattern.
Returns matching lines with file path, line numbers, and file size (total lines).

Parameters:
- pattern: Glob pattern to filter files (e.g., "**/*.ts", "src/**/*.js")
- regex: Regular expression to search for in file contents
- ignore_case: Case insensitive search (default: false)
- context_lines: Number of lines to show before/after each match (default: 0, max: 5)
- max_results: Maximum number of matches to return (default: 100)
- extract_hierarchy: Extract dependency hierarchy for results (default: false). Requires brain to be available.
- analyze: Analyze matched files on-the-fly to extract scope relationships (CONSUMES, CONSUMED_BY, INHERITS_FROM, etc.). Scopes are filtered to only those containing matched lines. Default: false.

Example: grep_files({ pattern: "**/*.ts", regex: "function.*Handler" })
Example: grep_files({ pattern: "src/**/*.js", regex: "TODO|FIXME", ignore_case: true, context_lines: 3 })
Example: grep_files({ pattern: "**/*.ts", regex: "export function", extract_hierarchy: true })
Example: grep_files({ pattern: "**/*.ts", regex: "class.*Service", analyze: true })`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to filter files',
        },
        regex: {
          type: 'string',
          description: 'Regular expression to search for',
        },
        ignore_case: {
          type: 'boolean',
          description: 'Case insensitive search (default: false)',
        },
        context_lines: {
          type: 'number',
          description: 'Lines of context before/after each match (default: 0, max: 5)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum matches to return (default: 100)',
        },
        extract_hierarchy: {
          type: 'boolean',
          description: 'Extract dependency hierarchy for results (default: false). Requires brain to be available.',
        },
        analyze: {
          type: 'boolean',
          description: 'Analyze matched files on-the-fly to extract scope relationships (CONSUMES, CONSUMED_BY, INHERITS_FROM, etc.). Scopes are filtered to only those containing matched lines. Default: false.',
        },
      },
      required: ['pattern', 'regex'],
    },
  };
}

export function generateSearchFilesTool(): GeneratedToolDefinition {
  return {
    name: 'search_files',
    section: 'file_ops',
    description: `Fuzzy search file contents using Levenshtein distance.

Searches within files matching a glob pattern with typo tolerance.
Useful when you don't know the exact spelling.

**RECOMMENDED: Use multiple keywords for better precision.**
When searching for concepts, break your search into meaningful keywords.
Avoid common words like "test", "the", "is", "a", etc.

Parameters:
- pattern: Glob pattern to filter files (e.g., "**/*.ts")
- keywords: Array of keywords to search for (fuzzy matched). Use multiple keywords for better results!
- match_mode: "all" (require all keywords in same file) or "any" (match any keyword). Default: "any"
- threshold: Similarity threshold 0-1 (default: 0.7, higher = stricter)
- max_results: Maximum number of matches to return (default: 50)
- extract_hierarchy: Extract dependency hierarchy for results (default: false). Requires brain to be available.

Example (single keyword): search_files({ pattern: "**/*.ts", keywords: ["authentification"] })
Example (multiple keywords - recommended): search_files({ pattern: "**/*.ts", keywords: ["debug", "context", "tool"], match_mode: "all" })
Example (typo tolerant): search_files({ pattern: "src/**/*", keywords: ["levenshtien", "fuzzy"], threshold: 0.6 })`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to filter files',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of keywords to search for (fuzzy matched). Use multiple keywords for better precision!',
        },
        match_mode: {
          type: 'string',
          enum: ['all', 'any'],
          description: 'Match mode: "all" requires all keywords in same file, "any" matches any keyword (default: "any")',
        },
        threshold: {
          type: 'number',
          description: 'Similarity threshold 0-1 (default: 0.7)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum matches to return (default: 50)',
        },
        extract_hierarchy: {
          type: 'boolean',
          description: 'Extract dependency hierarchy for results (default: false). Requires brain to be available.',
        },
      },
      required: ['pattern', 'keywords'],
    },
  };
}

/**
 * Try to use ripgrep (rg) for grep - 10-100x faster than Node.js implementation
 */
async function tryRipgrep(
  projectRoot: string,
  pattern: string,
  regex: string,
  ignoreCase: boolean,
  maxResults: number,
  contextLines: number = 0
): Promise<{ success: boolean; matches?: Array<{ file: string; line: number; content: string; match: string; context_before?: string[]; context_after?: string[] }>; filesSearched?: number } | null> {
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    // Build rg command args
    const args = [
      '--json',                    // JSON output for easy parsing
      '--glob', pattern,           // File pattern
      '--max-count', String(Math.ceil(maxResults / 10)), // Limit per file
      '-g', '!node_modules',       // Ignore node_modules
      '-g', '!.git',               // Ignore .git
      '-g', '!dist',               // Ignore dist
      '--max-columns', '500',      // Limit line length
    ];

    if (ignoreCase) {
      args.push('-i');
    }

    // Add context lines if requested (max 5)
    if (contextLines > 0) {
      const ctx = Math.min(contextLines, 5);
      args.push('-C', String(ctx));
    }

    args.push(regex);  // The pattern to search
    args.push('.');    // Search in current directory

    const rg = spawn(rgPath, args, {
      cwd: projectRoot,
      timeout: 30000, // 30 second timeout
    });

    let stdout = '';
    let stderr = '';
    let matches: Array<{ file: string; line: number; content: string; match: string; context_before?: string[]; context_after?: string[] }> = [];
    let filesSearched = new Set<string>();

    // For context tracking: collect lines around matches
    let pendingContextBefore: Array<{ file: string; line: number; text: string }> = [];
    let lastMatch: { file: string; line: number; content: string; match: string; context_before?: string[]; context_after?: string[] } | null = null;

    rg.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();

      // Parse JSON lines as they come in (ripgrep outputs one JSON object per line)
      const lines = stdout.split('\n');
      stdout = lines.pop() || ''; // Keep incomplete line for next chunk

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);

          if (obj.type === 'context') {
            // Context line (before or after a match)
            const filePath = obj.data.path.text;
            const lineNum = obj.data.line_number;
            const lineText = obj.data.lines?.text?.trim() || '';

            if (lastMatch && lastMatch.file === filePath && lineNum > lastMatch.line) {
              // This is context AFTER the last match
              if (!lastMatch.context_after) lastMatch.context_after = [];
              lastMatch.context_after.push(`${lineNum}: ${lineText.substring(0, 150)}`);
            } else {
              // This is context BEFORE a future match
              pendingContextBefore.push({ file: filePath, line: lineNum, text: lineText });
              // Keep only recent context lines (max 5)
              if (pendingContextBefore.length > 5) pendingContextBefore.shift();
            }
          } else if (obj.type === 'match' && matches.length < maxResults) {
            const filePath = obj.data.path.text;
            filesSearched.add(filePath);

            // Handle submatches
            const lineText = obj.data.lines?.text || '';
            const submatches = obj.data.submatches || [];
            const matchText = submatches.length > 0 ? submatches[0].match.text : '';
            const lineNum = obj.data.line_number;

            // Collect context before (from same file, recent lines)
            const contextBefore = pendingContextBefore
              .filter(c => c.file === filePath && c.line < lineNum)
              .map(c => `${c.line}: ${c.text.substring(0, 150)}`);

            lastMatch = {
              file: filePath,
              line: lineNum,
              content: lineText.trim().substring(0, 200),
              match: matchText,
              ...(contextBefore.length > 0 && { context_before: contextBefore }),
            };
            matches.push(lastMatch);

            // Clear pending context for this file
            pendingContextBefore = pendingContextBefore.filter(c => c.file !== filePath);
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    });

    rg.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    rg.on('error', () => {
      // rg not found or other error - fallback to Node.js implementation
      resolve(null);
    });

    rg.on('close', (code) => {
      if (code === 0 || code === 1) { // 0 = matches found, 1 = no matches (both are valid)
        resolve({
          success: true,
          matches: matches.slice(0, maxResults),
          filesSearched: filesSearched.size,
        });
      } else {
        // rg failed - fallback
        resolve(null);
      }
    });
  });
}

export function generateGrepFilesHandler(ctx: FsToolsContext) {
  return async (params: { pattern: string; regex: string; ignore_case?: boolean; context_lines?: number; max_results?: number; extract_hierarchy?: boolean; analyze?: boolean }) => {
    const fs = await import('fs/promises');
    const { glob } = await import('glob');

    const projectRoot = getProjectRoot(ctx) || process.cwd();

    const { pattern, regex, ignore_case = false, context_lines = 0, max_results = 100, extract_hierarchy = false, analyze = false } = params;

    try {
      // Validate regex
      new RegExp(regex, ignore_case ? 'i' : '');
    } catch (err: any) {
      return { error: `Invalid regex: ${err.message}` };
    }

    // Try ripgrep first (10-100x faster)
    const rgResult = await tryRipgrep(projectRoot, pattern, regex, ignore_case, max_results, context_lines);

    if (rgResult?.success) {
      // Enrich matches with totalLines (file size) - uses cache
      const uniqueFiles = [...new Set(rgResult.matches!.map(m => m.file))];
      const fileLineCounts = new Map<string, number | undefined>();

      // Count lines in matched files (parallel, limited, cached)
      const limitLineCount = pLimit(10);
      await Promise.all(uniqueFiles.map(file => limitLineCount(async () => {
        const filePath = path.join(projectRoot, file);
        const lineCount = await getFileLineCount(filePath, fs);
        if (lineCount !== undefined) {
          fileLineCounts.set(file, lineCount);
        }
      })));

      // Add totalLines to each match
      const enrichedMatches = rgResult.matches!.map(m => ({
        ...m,
        totalLines: fileLineCounts.get(m.file),
      }));

      const result: any = {
        matches: enrichedMatches,
        files_searched: rgResult.filesSearched,
        total_matches: enrichedMatches.length,
        truncated: enrichedMatches.length >= max_results,
        engine: 'ripgrep',
      };

      // Handle extract_hierarchy
      if (extract_hierarchy && enrichedMatches.length > 0) {
        try {
          const { BrainManager } = await import('../brain/index.js');
          const { generateExtractDependencyHierarchyHandler } = await import('./brain-tools.js');
          const brain = await BrainManager.getInstance();

          const extractHandler = generateExtractDependencyHierarchyHandler({ brain });
          const hierarchyResult = await extractHandler({
            results: enrichedMatches,
            depth: 1,
            direction: 'both',
            max_scopes: Math.min(enrichedMatches.length, 10),
          });

          result.hierarchy = hierarchyResult;
        } catch (err: any) {
          result.hierarchy_error = err.message || 'Brain not available';
        }
      }

      // Handle analyze option - on-the-fly scope analysis filtered by matched lines
      if (analyze && enrichedMatches.length > 0) {
        try {
          // Group matches by file
          const matchesByFile = new Map<string, number[]>();
          for (const match of enrichedMatches) {
            const absPath = path.isAbsolute(match.file) ? match.file : path.join(projectRoot, match.file);
            if (!matchesByFile.has(absPath)) {
              matchesByFile.set(absPath, []);
            }
            matchesByFile.get(absPath)!.push(match.line);
          }

          // Analyze files with target lines for filtering
          const filePaths = [...matchesByFile.keys()];
          const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];
          const codeFiles = filePaths.filter(f => codeExtensions.some(ext => f.endsWith(ext)));

          if (codeFiles.length > 0) {
            // Build target_lines map for filtering
            const targetLines: Record<string, number[]> = {};
            for (const file of codeFiles) {
              targetLines[file] = matchesByFile.get(file)!;
            }

            // Call analyze_files directly (grep_files now runs in daemon, so we have latest code)
            const { generateAnalyzeFilesHandler } = await import('./brain-tools.js');
            const analyzeHandler = generateAnalyzeFilesHandler({ brain: null as any });

            // Call once with JSON format, then format to markdown if needed
            const jsonResult = await analyzeHandler({
              paths: codeFiles.slice(0, 10),
              target_lines: targetLines,
              format: 'json',
              include_source: true,  // Need source for markdown formatting
            }) as { success?: boolean; files?: any[]; totalScopes?: number; totalRelationships?: number; parseTimeMs?: number };

            // Generate markdown from the JSON result (avoids double parsing)
            let markdownResult: string | { success?: boolean; formatted_output?: string } | null = null;
            if (jsonResult?.success) {
              // Import markdown formatter and format the result
              const { formatAnalyzeFilesAsMarkdown } = await import('./brain-tools.js');
              const pathModule = await import('path');
              
              // Build file contents map from the JSON result (parallel)
              const fileContents = new Map<string, string>();
              const fsPromises = await import('fs/promises');
              const readPromises = (jsonResult.files || []).map(async (file) => {
                try {
                  const content = await fsPromises.readFile(file.path, 'utf-8');
                  return { path: file.path, content };
                } catch {
                  return null;
                }
              });
              const readResults = await Promise.all(readPromises);
              for (const r of readResults) {
                if (r) fileContents.set(r.path, r.content);
              }
              
              markdownResult = formatAnalyzeFilesAsMarkdown(
                { success: true, files: jsonResult.files || [], totalScopes: jsonResult.totalScopes || 0, totalRelationships: jsonResult.totalRelationships || 0, parseTimeMs: jsonResult.parseTimeMs || 0 },
                fileContents,
                pathModule,
                { maxTopScopes: 5 }
              );
            }

            // Enrich each match with its containing scope
            if (jsonResult?.success && jsonResult.files) {
              // Build a map of (file, line) -> scope info
              const scopesByFile = new Map<string, any[]>();
              for (const file of jsonResult.files) {
                scopesByFile.set(file.path, file.scopes || []);
              }

              // Add scope info to each match
              for (const match of enrichedMatches) {
                const absPath = path.isAbsolute(match.file) ? match.file : path.join(projectRoot, match.file);
                const scopes = scopesByFile.get(absPath);
                if (scopes) {
                  // Find the most specific scope containing this line
                  let bestScope: any = null;
                  for (const scope of scopes) {
                    if (match.line >= scope.startLine && match.line <= scope.endLine) {
                      if (!bestScope || (scope.endLine - scope.startLine) < (bestScope.endLine - bestScope.startLine)) {
                        bestScope = scope;
                      }
                    }
                  }
                  if (bestScope) {
                    // Only include basic scope info - relationships are in the ASCII graph
                    (match as any).scope = {
                      name: bestScope.name,
                      type: bestScope.type,
                      lines: `${bestScope.startLine}-${bestScope.endLine}`,
                    };
                  }
                }
              }
            }

            // When analyze=true, return clean markdown instead of JSON
            if (markdownResult && typeof markdownResult === 'string') {
              // Build compact matches table
              const matchesTable: string[] = [];
              matchesTable.push('# Grep Results');
              matchesTable.push('');
              matchesTable.push(`**Pattern:** \`${pattern}\` | **Regex:** \`${regex}\` | **Matches:** ${enrichedMatches.length}${result.truncated ? ' (truncated)' : ''}`);
              matchesTable.push('');
              matchesTable.push('| File | Line | Scope | Match |');
              matchesTable.push('|------|------|-------|-------|');

              for (const m of enrichedMatches) {
                const fileName = path.basename(m.file);
                const scopeInfo = (m as any).scope ? `${(m as any).scope.name}()` : '-';
                const matchContent = m.content.length > 60 ? m.content.slice(0, 57) + '...' : m.content;
                const escapedMatch = matchContent.replace(/\|/g, '\\|').replace(/`/g, "'");
                matchesTable.push(`| ${fileName} | ${m.line} | ${scopeInfo} | \`${escapedMatch}\` |`);
              }

              matchesTable.push('');
              matchesTable.push('---');
              matchesTable.push('');

              // Return pure markdown (matches table + analysis)
              return matchesTable.join('\n') + markdownResult;
            }
          }
        } catch (err: any) {
          result.analysis_error = err.message || 'Analysis failed';
        }
      }

      return result;
    }

    // Fallback to Node.js implementation if rg not available
    const regexFlags = ignore_case ? 'gi' : 'g';
    const searchRegex = new RegExp(regex, regexFlags);

    // Get files matching glob
    const files = await glob(pattern, {
      cwd: projectRoot,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    });

    if (files.length === 0) {
      return { matches: [], files_searched: 0, message: 'No files matched the glob pattern', engine: 'nodejs' };
    }

    const limit = pLimit(50); // Increased parallelism for fallback
    const matches: Array<{ file: string; line: number; content: string; match: string; totalLines?: number; context_before?: string[]; context_after?: string[] }> = [];
    let totalMatchCount = 0;
    const ctxLines = Math.min(context_lines, 5);

    const searchFile = async (file: string) => {
      if (totalMatchCount >= max_results) return;

      const filePath = path.join(projectRoot, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        const totalLines = lines.length;

        // Cache the line count
        const stats = await fs.stat(filePath);
        fileLineCountCache.set(filePath, { lineCount: totalLines, mtime: stats.mtimeMs, cachedAt: Date.now() });

        for (let i = 0; i < lines.length && totalMatchCount < max_results; i++) {
          const line = lines[i];
          searchRegex.lastIndex = 0; // Reset regex state
          const match = searchRegex.exec(line);

          if (match) {
            const result: typeof matches[0] = {
              file,
              line: i + 1,
              content: line.trim().substring(0, 200),
              match: match[0],
              totalLines,
            };

            // Add context lines if requested
            if (ctxLines > 0) {
              const beforeStart = Math.max(0, i - ctxLines);
              const afterEnd = Math.min(lines.length - 1, i + ctxLines);

              if (beforeStart < i) {
                result.context_before = lines.slice(beforeStart, i).map((l, idx) =>
                  `${beforeStart + idx + 1}: ${l.trim().substring(0, 150)}`
                );
              }
              if (afterEnd > i) {
                result.context_after = lines.slice(i + 1, afterEnd + 1).map((l, idx) =>
                  `${i + 2 + idx}: ${l.trim().substring(0, 150)}`
                );
              }
            }

            matches.push(result);
            totalMatchCount++;
          }
        }
      } catch {
        // Skip unreadable files (binary, etc.)
      }
    };

    await Promise.all(files.map(file => limit(() => searchFile(file))));

    const result: any = {
      matches,
      files_searched: files.length,
      total_matches: matches.length,
      truncated: totalMatchCount >= max_results,
      engine: 'nodejs',
    };

    // Note: extract_hierarchy is handled by the MCP server wrapper via daemon proxy
    // The daemon handler will automatically start watchers and sync projects (like brain_search)
    // For direct usage (non-MCP), try direct brain access
    if (extract_hierarchy && matches.length > 0) {
      try {
        const { BrainManager } = await import('../brain/index.js');
        const { generateExtractDependencyHierarchyHandler } = await import('./brain-tools.js');
        const brain = await BrainManager.getInstance();

        // Extract hierarchy (ensureProjectSynced is called inside the handler, like brain_search)
        const extractHandler = generateExtractDependencyHierarchyHandler({ brain });
        const hierarchyResult = await extractHandler({
          results: matches,
          depth: 1,
          direction: 'both',
          max_scopes: Math.min(matches.length, 10),
        });

        result.hierarchy = hierarchyResult;
      } catch (err: any) {
        // If brain is not available, extraction will be handled by MCP wrapper
        result.hierarchy_error = err.message || 'Brain not available (will be handled by MCP wrapper if available)';
      }
    }

    // Handle analyze option for Node.js fallback
    if (analyze && matches.length > 0) {
      try {
        const { generateAnalyzeFilesHandler } = await import('./brain-tools.js');
        const analyzeHandler = generateAnalyzeFilesHandler({ brain: null as any });

        // Group matches by file
        const matchesByFile = new Map<string, number[]>();
        for (const match of matches) {
          const absPath = path.isAbsolute(match.file) ? match.file : path.join(projectRoot, match.file);
          if (!matchesByFile.has(absPath)) {
            matchesByFile.set(absPath, []);
          }
          matchesByFile.get(absPath)!.push(match.line);
        }

        // Analyze files with target lines for filtering
        const filePaths = [...matchesByFile.keys()];
        const codeExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];
        const codeFiles = filePaths.filter(f => codeExtensions.some(ext => f.endsWith(ext)));

        if (codeFiles.length > 0) {
          // Build target_lines map for filtering
          const targetLines: Record<string, number[]> = {};
          for (const file of codeFiles) {
            targetLines[file] = matchesByFile.get(file)!;
          }

          // First get JSON to enrich matches
          const jsonResult = await analyzeHandler({
            paths: codeFiles.slice(0, 10),
            target_lines: targetLines,
            format: 'json',
            include_source: false,
          }) as { success?: boolean; files?: any[]; totalScopes?: number; totalRelationships?: number; parseTimeMs?: number };

          // Enrich each match with its containing scope
          if (jsonResult.success && jsonResult.files) {
            const scopesByFile = new Map<string, any[]>();
            for (const file of jsonResult.files) {
              scopesByFile.set(file.path, file.scopes || []);
            }

            for (const match of matches) {
              const absPath = path.isAbsolute(match.file) ? match.file : path.join(projectRoot, match.file);
              const scopes = scopesByFile.get(absPath);
              if (scopes) {
                let bestScope: any = null;
                for (const scope of scopes) {
                  if (match.line >= scope.startLine && match.line <= scope.endLine) {
                    if (!bestScope || (scope.endLine - scope.startLine) < (bestScope.endLine - bestScope.startLine)) {
                      bestScope = scope;
                    }
                  }
                }
                if (bestScope) {
                  // Only include basic scope info - relationships are in the ASCII graph
                  (match as any).scope = {
                    name: bestScope.name,
                    type: bestScope.type,
                    lines: `${bestScope.startLine}-${bestScope.endLine}`,
                  };
                }
              }
            }
          }

          // Generate markdown from the JSON result (avoids double parsing)
          if (jsonResult.success && jsonResult.files) {
            const { formatAnalyzeFilesAsMarkdown } = await import('./brain-tools.js');
            const fsPromises = await import('fs/promises');

            // Read file contents for code snippets (parallel)
            const fileContents = new Map<string, string>();
            const fileReadPromises = jsonResult.files.map(async (file) => {
              try {
                const content = await fsPromises.readFile(file.path, 'utf-8');
                return { path: file.path, content };
              } catch {
                return null;
              }
            });
            const fileResults = await Promise.all(fileReadPromises);
            for (const result of fileResults) {
              if (result) fileContents.set(result.path, result.content);
            }

            // Use totals already calculated by analyzeHandler
            const markdownResult = formatAnalyzeFilesAsMarkdown(
              {
                success: true,
                files: jsonResult.files,
                totalScopes: jsonResult.totalScopes || 0,
                totalRelationships: jsonResult.totalRelationships || 0,
                parseTimeMs: jsonResult.parseTimeMs || 0,
              },
              fileContents,
              path,
              { maxTopScopes: 5 }
            );

            // When analyze=true, return clean markdown instead of JSON
            if (markdownResult && typeof markdownResult === 'string') {
              // Build compact matches table
              const matchesTable: string[] = [];
              matchesTable.push('# Grep Results');
              matchesTable.push('');
              matchesTable.push(`**Pattern:** \`${pattern}\` | **Regex:** \`${regex}\` | **Matches:** ${matches.length}${result.truncated ? ' (truncated)' : ''}`);
              matchesTable.push('');
              matchesTable.push('| File | Line | Scope | Match |');
              matchesTable.push('|------|------|-------|-------|');

              for (const m of matches) {
                const fileName = path.basename(m.file);
                const scopeInfo = (m as any).scope ? `${(m as any).scope.name}()` : '-';
                const matchContent = m.content.length > 60 ? m.content.slice(0, 57) + '...' : m.content;
                const escapedMatch = matchContent.replace(/\|/g, '\\|').replace(/`/g, "'");
                matchesTable.push(`| ${fileName} | ${m.line} | ${scopeInfo} | \`${escapedMatch}\` |`);
              }

              matchesTable.push('');
              matchesTable.push('---');
              matchesTable.push('');

              // Return pure markdown (matches table + analysis)
              return matchesTable.join('\n') + markdownResult;
            }
          }
        }
      } catch (err: any) {
        result.analysis_error = err.message || 'Analysis failed';
      }
    }

    return result;
  };
}

/**
 * Try to use ugrep with fuzzy search (-Z) - much faster than Node.js Levenshtein
 * ugrep supports fuzzy matching with Levenshtein distance via -Z option
 */
async function tryUgrep(
  projectRoot: string,
  pattern: string,
  keyword: string,
  threshold: number,
  maxResults: number
): Promise<{ success: boolean; matches?: Array<{ file: string; line: number; content: string; matched_word: string; matched_keyword: string; similarity: number }>; filesSearched?: number } | null> {
  const { spawn } = await import('child_process');

  return new Promise((resolve) => {
    // Convert threshold to max Levenshtein distance
    // For a typical keyword length, calculate max allowed edits
    // threshold 0.7 with 10-char word = max 3 edits (30% of 10)
    const avgWordLen = Math.max(keyword.length, 5);
    const maxDistance = Math.max(1, Math.floor((1 - threshold) * avgWordLen));

    // Build ugrep command args
    const args = [
      '--json',                      // JSON output for easy parsing
      `-Z${maxDistance}`,            // Fuzzy search with max distance
      '-w',                          // Match whole words only
      '--glob', pattern,             // File pattern
      '-g', '!node_modules',         // Ignore node_modules
      '-g', '!.git',                 // Ignore .git
      '-g', '!dist',                 // Ignore dist
      '--max-count', String(Math.ceil(maxResults / 5)), // Limit per file
      '-i',                          // Case insensitive
      keyword,                       // The keyword to search
      '.',                           // Search in current directory
    ];

    const ug = spawn('ugrep', args, {
      cwd: projectRoot,
      timeout: 30000, // 30 second timeout
    });

    let stdout = '';
    let matches: Array<{ file: string; line: number; content: string; matched_word: string; matched_keyword: string; similarity: number }> = [];
    let filesSearched = new Set<string>();

    ug.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();

      // Parse JSON lines as they come in
      const lines = stdout.split('\n');
      stdout = lines.pop() || ''; // Keep incomplete line for next chunk

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'match' && matches.length < maxResults) {
            const filePath = obj.file || obj.path;
            filesSearched.add(filePath);

            const lineText = obj.lines || obj.line || '';
            const matchedWord = obj.match || lineText.trim().split(/\s+/).find((w: string) =>
              w.toLowerCase().includes(keyword.toLowerCase().substring(0, 3))
            ) || keyword;

            // Estimate similarity based on match
            const similarity = Math.max(threshold, 1 - (maxDistance / Math.max(keyword.length, matchedWord.length)));

            matches.push({
              file: filePath,
              line: obj.line_number || obj.lnum || 1,
              content: lineText.trim().substring(0, 200),
              matched_word: matchedWord,
              matched_keyword: keyword,
              similarity: Math.round(similarity * 100) / 100,
            });
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    });

    ug.on('error', () => {
      // ugrep not found or other error - fallback to Node.js implementation
      resolve(null);
    });

    ug.on('close', (code) => {
      if (code === 0 || code === 1) { // 0 = matches found, 1 = no matches
        resolve({
          success: true,
          matches: matches.slice(0, maxResults),
          filesSearched: filesSearched.size,
        });
      } else {
        // ugrep failed - fallback
        resolve(null);
      }
    });
  });
}

/**
 * Try ugrep for all keywords and merge results
 */
async function tryUgrepMultiKeyword(
  projectRoot: string,
  pattern: string,
  keywords: string[],
  matchMode: 'all' | 'any',
  threshold: number,
  maxResults: number
): Promise<{ success: boolean; matches?: Array<{ file: string; line: number; content: string; matched_word: string; matched_keyword: string; similarity: number }>; filesSearched?: number; filesWithAllKeywords?: number } | null> {
  // Run ugrep for each keyword in parallel
  const results = await Promise.all(
    keywords.map(keyword => tryUgrep(projectRoot, pattern, keyword, threshold, maxResults))
  );

  // Check if all succeeded
  if (results.some(r => r === null)) {
    return null; // Fallback to Node.js
  }

  // Merge results
  const allMatches: Array<{ file: string; line: number; content: string; matched_word: string; matched_keyword: string; similarity: number }> = [];
  const filesWithKeywords = new Map<string, Set<string>>();
  const allFilesSearched = new Set<string>();

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const keyword = keywords[i];

    for (const match of result.matches || []) {
      allMatches.push(match);
      allFilesSearched.add(match.file);

      if (!filesWithKeywords.has(match.file)) {
        filesWithKeywords.set(match.file, new Set());
      }
      filesWithKeywords.get(match.file)!.add(keyword);
    }
  }

  // Filter by match mode
  let finalMatches = allMatches;
  if (matchMode === 'all') {
    const filesWithAll = new Set(
      Array.from(filesWithKeywords.entries())
        .filter(([_, kws]) => kws.size === keywords.length)
        .map(([file]) => file)
    );
    finalMatches = allMatches.filter(m => filesWithAll.has(m.file));
  }

  // Sort by similarity
  finalMatches.sort((a, b) => b.similarity - a.similarity);

  // Count files with all keywords
  const filesWithAllCount = Array.from(filesWithKeywords.values())
    .filter(kws => kws.size === keywords.length).length;

  return {
    success: true,
    matches: finalMatches.slice(0, maxResults),
    filesSearched: allFilesSearched.size,
    filesWithAllKeywords: filesWithAllCount,
  };
}

export function generateSearchFilesHandler(ctx: FsToolsContext) {
  return async (params: {
    pattern: string;
    keywords: string[];
    match_mode?: 'all' | 'any';
    threshold?: number;
    max_results?: number;
    extract_hierarchy?: boolean
  }) => {
    const fs = await import('fs/promises');
    const { glob } = await import('glob');

    const projectRoot = getProjectRoot(ctx) || process.cwd();

    const { pattern, keywords, match_mode = 'any', threshold = 0.7, max_results = 50, extract_hierarchy = false } = params;

    // Try ugrep first (much faster with built-in fuzzy search)
    const ugrepResult = await tryUgrepMultiKeyword(projectRoot, pattern, keywords, match_mode, threshold, max_results);

    if (ugrepResult?.success) {
      const result: any = {
        keywords,
        match_mode,
        threshold,
        matches: ugrepResult.matches,
        files_searched: ugrepResult.filesSearched,
        files_with_matches: new Set(ugrepResult.matches?.map(m => m.file)).size,
        files_with_all_keywords: ugrepResult.filesWithAllKeywords,
        total_matches: ugrepResult.matches!.length,
        truncated: ugrepResult.matches!.length >= max_results,
        engine: 'ugrep',
      };

      // Handle extract_hierarchy for ugrep results
      if (extract_hierarchy && ugrepResult.matches!.length > 0) {
        try {
          const { BrainManager } = await import('../brain/index.js');
          const { generateExtractDependencyHierarchyHandler } = await import('./brain-tools.js');
          const brain = await BrainManager.getInstance();

          const extractHandler = generateExtractDependencyHierarchyHandler({ brain });
          const hierarchyResult = await extractHandler({
            results: ugrepResult.matches!.map(m => ({
              file: m.file,
              line: m.line,
              content: m.content,
              match: m.matched_word,
            })),
            depth: 1,
            direction: 'both',
            max_scopes: Math.min(ugrepResult.matches!.length, 10),
          });

          result.hierarchy = hierarchyResult;
        } catch (err: any) {
          result.hierarchy_error = err.message || 'Brain not available';
        }
      }

      return result;
    }

    // Fallback to Node.js implementation if ugrep not available
    // Normalize keywords
    const normalizedKeywords = keywords.map(k => ({
      original: k,
      lower: k.toLowerCase(),
      len: k.length,
    }));

    // Get files matching glob
    const files = await glob(pattern, {
      cwd: projectRoot,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    });

    if (files.length === 0) {
      return { matches: [], files_searched: 0, message: 'No files matched the glob pattern', engine: 'nodejs' };
    }

    const limit = pLimit(50); // Increased parallelism for fallback

    // Track matches per file for "all" mode
    type FileMatch = {
      file: string;
      line: number;
      content: string;
      matched_word: string;
      matched_keyword: string;
      similarity: number;
    };
    const allFileMatches: Map<string, { matches: FileMatch[]; keywordsFound: Set<string> }> = new Map();

    const searchFile = async (file: string) => {
      const filePath = path.join(projectRoot, file);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        const fileData: { matches: FileMatch[]; keywordsFound: Set<string> } = {
          matches: [],
          keywordsFound: new Set(),
        };

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Extract words from line (min 3 chars)
          const words = line.match(/\b\w{3,}\b/g) || [];

          for (const word of words) {
            const wordLower = word.toLowerCase();

            // Check against each keyword
            for (const keyword of normalizedKeywords) {
              const maxLen = Math.max(keyword.len, word.length);
              const distance = levenshtein(keyword.lower, wordLower);
              const similarity = 1 - distance / maxLen;

              if (similarity >= threshold) {
                fileData.keywordsFound.add(keyword.original);
                fileData.matches.push({
                  file,
                  line: i + 1,
                  content: line.trim().substring(0, 200),
                  matched_word: word,
                  matched_keyword: keyword.original,
                  similarity: Math.round(similarity * 100) / 100,
                });
                break; // One keyword match per word
              }
            }
          }
        }

        if (fileData.matches.length > 0) {
          allFileMatches.set(file, fileData);
        }
      } catch {
        // Skip unreadable files
      }
    };

    await Promise.all(files.map(file => limit(() => searchFile(file))));

    // Filter and collect final matches based on match_mode
    let finalMatches: FileMatch[] = [];

    if (match_mode === 'all') {
      // Only include files where ALL keywords were found
      for (const [file, data] of allFileMatches) {
        if (data.keywordsFound.size === normalizedKeywords.length) {
          finalMatches.push(...data.matches);
        }
      }
    } else {
      // "any" mode - include all matches
      for (const data of allFileMatches.values()) {
        finalMatches.push(...data.matches);
      }
    }

    // Sort by similarity (best first), then by file for consistency
    finalMatches.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return a.file.localeCompare(b.file);
    });

    // Apply max_results limit
    if (finalMatches.length > max_results) {
      finalMatches = finalMatches.slice(0, max_results);
    }

    // Calculate files with all keywords (for stats)
    const filesWithAllKeywords = Array.from(allFileMatches.entries())
      .filter(([_, data]) => data.keywordsFound.size === normalizedKeywords.length)
      .map(([file]) => file);

    const result: any = {
      keywords,
      match_mode,
      threshold,
      matches: finalMatches,
      files_searched: files.length,
      files_with_matches: allFileMatches.size,
      files_with_all_keywords: filesWithAllKeywords.length,
      total_matches: finalMatches.length,
      truncated: finalMatches.length >= max_results,
      engine: 'nodejs', // Fallback engine
    };

    // Note: extract_hierarchy is handled by the MCP server wrapper via daemon proxy
    // The daemon handler will automatically start watchers and sync projects (like brain_search)
    // For direct usage (non-MCP), try direct brain access
    if (extract_hierarchy && finalMatches.length > 0) {
      try {
        // Convert matches to format expected by extract_dependency_hierarchy
        const hierarchyMatches = finalMatches.map(m => ({
          file: m.file,
          line: m.line,
          content: m.content,
          match: m.matched_word,
        }));

        const { BrainManager } = await import('../brain/index.js');
        const { generateExtractDependencyHierarchyHandler } = await import('./brain-tools.js');
        const brain = await BrainManager.getInstance();

        // Extract hierarchy (ensureProjectSynced is called inside the handler, like brain_search)
        const extractHandler = generateExtractDependencyHierarchyHandler({ brain });
        const hierarchyResult = await extractHandler({
          results: hierarchyMatches,
          depth: 1,
          direction: 'both',
          max_scopes: Math.min(finalMatches.length, 10),
        });

        result.hierarchy = hierarchyResult;
      } catch (err: any) {
        // If brain is not available, extraction will be handled by MCP wrapper
        result.hierarchy_error = err.message || 'Brain not available (will be handled by MCP wrapper if available)';
      }
    }

    return result;
  };
}

// ============================================
// Export All FS Tools
// ============================================

export interface FsToolsResult {
  tools: GeneratedToolDefinition[];
  handlers: Record<string, (args: any) => Promise<any>>;
}

/**
 * Generate all file system tools with handlers
 */
export function generateFsTools(ctx: FsToolsContext): FsToolsResult {
  // NOTE: delete_path, move_file, copy_file moved to brain-tools.ts
  // Use generateBrainTools() for those - they have better handling for projects
  return {
    tools: [
      generateListDirectoryTool(),
      generateGlobFilesTool(),
      generateFileExistsTool(),
      generateGetFileInfoTool(),
      generateCreateDirectoryTool(),
      generateChangeDirectoryTool(),
      generateGrepFilesTool(),
      generateSearchFilesTool(),
    ],
    handlers: {
      list_directory: generateListDirectoryHandler(ctx),
      glob_files: generateGlobFilesHandler(ctx),
      file_exists: generateFileExistsHandler(ctx),
      get_file_info: generateGetFileInfoHandler(ctx),
      create_directory: generateCreateDirectoryHandler(ctx),
      change_directory: generateChangeDirectoryHandler(ctx),
      grep_files: generateGrepFilesHandler(ctx),
      search_files: generateSearchFilesHandler(ctx),
    },
  };
}
