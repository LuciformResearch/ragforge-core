/**
 * CwdFileCache - Cache for directory file type statistics
 *
 * Scans a directory to determine if it's code-heavy or document-heavy,
 * allowing the agent to adapt its search patterns accordingly.
 */

import { glob } from 'glob';
import * as path from 'path';

/**
 * File type categories
 */
const CODE_EXTENSIONS = new Set([
  // JavaScript/TypeScript
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  // Web
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte',
  // Python
  '.py', '.pyw', '.pyi',
  // Other languages
  '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.swift', '.kt', '.scala', '.clj', '.ex', '.exs', '.erl', '.hs',
  // Shell/Scripts
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
]);

const DOCUMENT_EXTENSIONS = new Set([
  // Markdown
  '.md', '.markdown', '.mdx',
  // Office documents
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  // Text
  '.txt', '.rst', '.asciidoc', '.adoc', '.org',
  // Other docs
  '.rtf', '.odt', '.ods', '.odp',
]);

const DATA_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.xml', '.csv',
]);

export type DominantType = 'code' | 'documents' | 'mixed';

export interface CwdStats {
  cwd: string;
  scannedAt: Date;
  extensions: Record<string, number>;
  codeCount: number;
  documentCount: number;
  dataCount: number;
  otherCount: number;
  totalFiles: number;
  dominantType: DominantType;
  codeRatio: number;
  documentRatio: number;
}

export interface CwdFileCacheOptions {
  /**
   * Time-to-live for cached stats in milliseconds
   * @default 60000 (1 minute)
   */
  ttlMs?: number;

  /**
   * Threshold ratio for specializing on code (0-1)
   * If codeRatio >= threshold, dominantType = 'code'
   * If documentRatio >= threshold, dominantType = 'documents'
   * Otherwise, dominantType = 'mixed'
   * @default 0.7 (70%)
   */
  specializationThreshold?: number;

  /**
   * Maximum files to scan (for performance)
   * @default 10000
   */
  maxFiles?: number;
}

/**
 * Cache for directory file statistics
 * Used to determine if a directory is code-heavy or document-heavy
 */
export class CwdFileCache {
  private cache = new Map<string, CwdStats>();
  private ttlMs: number;
  private specializationThreshold: number;
  private maxFiles: number;

  constructor(options: CwdFileCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60000;
    this.specializationThreshold = options.specializationThreshold ?? 0.7;
    this.maxFiles = options.maxFiles ?? 10000;
  }

  /**
   * Get stats for a directory (from cache or fresh scan)
   */
  async getStats(cwd: string): Promise<CwdStats> {
    const normalizedCwd = path.resolve(cwd);
    const cached = this.cache.get(normalizedCwd);

    if (cached && Date.now() - cached.scannedAt.getTime() < this.ttlMs) {
      return cached;
    }

    const stats = await this.scan(normalizedCwd);
    this.cache.set(normalizedCwd, stats);
    return stats;
  }

  /**
   * Invalidate cache for a directory
   */
  invalidate(cwd: string): void {
    const normalizedCwd = path.resolve(cwd);
    this.cache.delete(normalizedCwd);
  }

  /**
   * Clear all cached stats
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Scan a directory and compute file type statistics
   */
  private async scan(cwd: string): Promise<CwdStats> {
    const extensions: Record<string, number> = {};
    let codeCount = 0;
    let documentCount = 0;
    let dataCount = 0;
    let otherCount = 0;

    try {
      // Glob all files, excluding common non-content directories
      const files = await glob('**/*', {
        cwd,
        nodir: true,
        ignore: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/build/**',
          '**/.next/**',
          '**/__pycache__/**',
          '**/venv/**',
          '**/.venv/**',
          '**/coverage/**',
          '**/.cache/**',
        ],
        maxDepth: 10, // Don't go too deep
      });

      // Limit files for performance
      const filesToProcess = files.slice(0, this.maxFiles);

      for (const file of filesToProcess) {
        const ext = path.extname(file).toLowerCase();
        if (!ext) continue;

        // Count by extension
        extensions[ext] = (extensions[ext] || 0) + 1;

        // Categorize
        if (CODE_EXTENSIONS.has(ext)) {
          codeCount++;
        } else if (DOCUMENT_EXTENSIONS.has(ext)) {
          documentCount++;
        } else if (DATA_EXTENSIONS.has(ext)) {
          dataCount++;
        } else {
          otherCount++;
        }
      }
    } catch (error) {
      // If scan fails, return neutral stats
      console.warn(`[CwdFileCache] Failed to scan ${cwd}:`, error);
    }

    const totalFiles = codeCount + documentCount + dataCount + otherCount;
    const relevantFiles = codeCount + documentCount; // Exclude data/other from ratio

    const codeRatio = relevantFiles > 0 ? codeCount / relevantFiles : 0.5;
    const documentRatio = relevantFiles > 0 ? documentCount / relevantFiles : 0.5;

    // Determine dominant type based on threshold
    let dominantType: DominantType;
    if (codeRatio >= this.specializationThreshold) {
      dominantType = 'code';
    } else if (documentRatio >= this.specializationThreshold) {
      dominantType = 'documents';
    } else {
      dominantType = 'mixed';
    }

    return {
      cwd,
      scannedAt: new Date(),
      extensions,
      codeCount,
      documentCount,
      dataCount,
      otherCount,
      totalFiles,
      dominantType,
      codeRatio,
      documentRatio,
    };
  }

  /**
   * Get recommended glob pattern based on dominant type
   */
  getRecommendedGlobPattern(stats: CwdStats): string {
    switch (stats.dominantType) {
      case 'code':
        return '**/*.{ts,tsx,js,jsx,mjs,py,html,htm,css,scss,vue,svelte,java,go,rs,c,cpp,h,hpp}';
      case 'documents':
        return '**/*.{md,mdx,pdf,docx,doc,xlsx,txt,rst,html,ts,js,py}';
      case 'mixed':
      default:
        return '**/*.{ts,tsx,js,jsx,py,md,mdx,pdf,docx,html,vue,svelte,json,yaml}';
    }
  }

  /**
   * Get recommended node types for semantic search based on dominant type
   */
  getRecommendedNodeTypes(stats: CwdStats): string[] {
    switch (stats.dominantType) {
      case 'code':
        return ['Scope'];
      case 'documents':
        return ['MarkdownSection', 'MarkdownDocument', 'PDFDocument', 'WebPage', 'WordDocument', 'Scope'];
      case 'mixed':
      default:
        return ['Scope', 'MarkdownSection', 'MarkdownDocument'];
    }
  }

  /**
   * Get aggregated stats from multiple directories
   * Useful when cwd contains multiple sub-projects
   */
  async getAggregatedStats(paths: string[]): Promise<CwdStats> {
    if (paths.length === 0) {
      // Return neutral stats if no paths
      return {
        cwd: '',
        scannedAt: new Date(),
        extensions: {},
        codeCount: 0,
        documentCount: 0,
        dataCount: 0,
        otherCount: 0,
        totalFiles: 0,
        dominantType: 'mixed',
        codeRatio: 0.5,
        documentRatio: 0.5,
      };
    }

    if (paths.length === 1) {
      return this.getStats(paths[0]);
    }

    // Aggregate stats from all paths
    const allStats = await Promise.all(paths.map(p => this.getStats(p)));

    const aggregated: CwdStats = {
      cwd: paths.join(', '),
      scannedAt: new Date(),
      extensions: {},
      codeCount: 0,
      documentCount: 0,
      dataCount: 0,
      otherCount: 0,
      totalFiles: 0,
      dominantType: 'mixed',
      codeRatio: 0.5,
      documentRatio: 0.5,
    };

    // Sum up counts from all stats
    for (const stats of allStats) {
      aggregated.codeCount += stats.codeCount;
      aggregated.documentCount += stats.documentCount;
      aggregated.dataCount += stats.dataCount;
      aggregated.otherCount += stats.otherCount;
      aggregated.totalFiles += stats.totalFiles;

      // Merge extensions
      for (const [ext, count] of Object.entries(stats.extensions)) {
        aggregated.extensions[ext] = (aggregated.extensions[ext] || 0) + count;
      }
    }

    // Recalculate ratios and dominant type
    const relevantFiles = aggregated.codeCount + aggregated.documentCount;
    aggregated.codeRatio = relevantFiles > 0 ? aggregated.codeCount / relevantFiles : 0.5;
    aggregated.documentRatio = relevantFiles > 0 ? aggregated.documentCount / relevantFiles : 0.5;

    if (aggregated.codeRatio >= this.specializationThreshold) {
      aggregated.dominantType = 'code';
    } else if (aggregated.documentRatio >= this.specializationThreshold) {
      aggregated.dominantType = 'documents';
    } else {
      aggregated.dominantType = 'mixed';
    }

    return aggregated;
  }
}

// Singleton instance for shared use
let defaultInstance: CwdFileCache | null = null;

export function getDefaultCwdFileCache(): CwdFileCache {
  if (!defaultInstance) {
    defaultInstance = new CwdFileCache();
  }
  return defaultInstance;
}
