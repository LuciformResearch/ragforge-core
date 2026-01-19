/**
 * ZIP Source Adapter
 *
 * Extracts files from ZIP archives and returns virtual files for ingestion.
 *
 * @since 2026-01-18
 */

import type { VirtualFile } from './types.js';

// ============================================
// Types
// ============================================

/**
 * Options for extracting ZIP files
 */
export interface ZipExtractOptions {
  /** Exclude patterns (glob) - default: common excludes */
  exclude?: string[];
  /** Include patterns (glob) - default: all files */
  include?: string[];
  /** Maximum file size in bytes (default: 10MB) */
  maxFileSize?: number;
  /** Strip root directory prefix if ZIP has a single root folder (default: true) */
  stripRootDir?: boolean;
}

/**
 * Result of extracting ZIP archive
 */
export interface ZipExtractResult {
  /** Virtual files (path + content) */
  files: VirtualFile[];
  /** Extraction metadata */
  metadata: {
    totalFiles: number;
    totalSize: number;
    rootDir?: string;
  };
  /** Warnings during extraction */
  warnings: string[];
}

// ============================================
// Default Patterns
// ============================================

const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/venv/**',
  '**/.venv/**',
  '**/target/**',
  '**/.cargo/**',
  '**/vendor/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/.DS_Store',
  '**/Thumbs.db',
];

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ============================================
// Extract Functions
// ============================================

/**
 * Extract files from a ZIP buffer and return virtual files
 *
 * @param zipBuffer - ZIP archive as Buffer
 * @param options - Extraction options
 * @returns Virtual files and metadata
 */
export async function extractZipToVirtualFiles(
  zipBuffer: Buffer,
  options: ZipExtractOptions = {}
): Promise<ZipExtractResult> {
  const AdmZip = (await import('adm-zip')).default;
  const { minimatch } = await import('minimatch');

  const warnings: string[] = [];
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const excludePatterns = options.exclude ?? DEFAULT_EXCLUDE_PATTERNS;
  const includePatterns = options.include;
  const stripRootDir = options.stripRootDir !== false; // default: true

  // Parse ZIP
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // Find root directory if ZIP has a single root folder
  let rootDir = '';
  if (stripRootDir) {
    // Check if all entries start with the same directory prefix
    const topLevelDirs = new Set<string>();
    for (const entry of entries) {
      const parts = entry.entryName.split('/');
      if (parts.length > 1 && parts[0]) {
        topLevelDirs.add(parts[0]);
      }
    }
    // If there's exactly one top-level directory, use it as root
    if (topLevelDirs.size === 1) {
      rootDir = [...topLevelDirs][0] + '/';
    }
  }

  // Build file list
  const allPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) {
      // Remove root directory prefix
      let relativePath = entry.entryName;
      if (rootDir && relativePath.startsWith(rootDir)) {
        relativePath = relativePath.slice(rootDir.length);
      }
      if (relativePath) {
        allPaths.push(relativePath);
      }
    }
  }

  // Apply include/exclude filters
  const filteredPaths = allPaths.filter(p => {
    // Check include patterns first (if specified)
    if (includePatterns && includePatterns.length > 0) {
      const matchesInclude = includePatterns.some(pattern => minimatch(p, pattern, { dot: true }));
      if (!matchesInclude) return false;
    }

    // Check exclude patterns
    const matchesExclude = excludePatterns.some(pattern => minimatch(p, pattern, { dot: true }));
    return !matchesExclude;
  });

  // Extract files as VirtualFile[]
  const files: VirtualFile[] = [];
  let totalSize = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    // Get relative path (with root stripped if applicable)
    let relativePath = entry.entryName;
    if (rootDir && relativePath.startsWith(rootDir)) {
      relativePath = relativePath.slice(rootDir.length);
    }
    if (!relativePath || !filteredPaths.includes(relativePath)) continue;

    // Check file size
    if (entry.header.size > maxFileSize) {
      warnings.push(`Skipped ${relativePath}: exceeds max file size (${(entry.header.size / 1024 / 1024).toFixed(2)} MB)`);
      continue;
    }

    try {
      const content = entry.getData();
      files.push({
        path: `/${relativePath}`,
        content: content,
        metadata: {
          size: content.length,
          compressed: entry.header.compressedSize,
        },
      });
      totalSize += content.length;
    } catch (error) {
      warnings.push(`Failed to extract ${relativePath}: ${error}`);
    }
  }

  return {
    files,
    metadata: {
      totalFiles: files.length,
      totalSize,
      rootDir: rootDir || undefined,
    },
    warnings,
  };
}

/**
 * Extract a single file from content (for single document uploads)
 *
 * @param content - File content as Buffer or string
 * @param fileName - Original file name
 * @param options - Optional metadata
 * @returns Single VirtualFile
 */
export function createVirtualFileFromContent(
  content: Buffer | string,
  fileName: string,
  metadata?: Record<string, unknown>
): VirtualFile {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

  return {
    path: `/${fileName}`,
    content: buffer,
    metadata: {
      size: buffer.length,
      ...metadata,
    },
  };
}

/**
 * Create multiple virtual files from an array of file uploads
 *
 * @param files - Array of { fileName, content } objects
 * @returns Array of VirtualFile
 */
export function createVirtualFilesFromUploads(
  files: Array<{ fileName: string; content: Buffer | string; metadata?: Record<string, unknown> }>
): VirtualFile[] {
  return files.map(f => createVirtualFileFromContent(f.content, f.fileName, f.metadata));
}
