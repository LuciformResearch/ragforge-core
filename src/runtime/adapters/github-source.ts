/**
 * GitHub Source Adapter
 *
 * Downloads GitHub repositories and returns virtual files for ingestion.
 * Supports:
 * - Public repositories (via GitHub API ZIP download)
 * - Private repositories (requires GitHub token)
 * - Specific branches/tags/commits
 *
 * @since 2026-01-18
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream, createReadStream } from 'fs';
import { promisify } from 'util';
import { exec } from 'child_process';
import type { VirtualFile } from './types.js';

const execAsync = promisify(exec);

// ============================================
// Types
// ============================================

/**
 * GitHub repository reference
 */
export interface GitHubRepoRef {
  /** Repository owner (e.g., "anthropics") */
  owner: string;
  /** Repository name (e.g., "claude-code") */
  repo: string;
  /** Branch, tag, or commit SHA (default: "main") */
  ref?: string;
}

/**
 * Options for downloading GitHub repository
 */
export interface GitHubDownloadOptions {
  /** GitHub API token for private repos (optional for public repos) */
  token?: string;
  /** Include patterns (glob) - default: all files */
  include?: string[];
  /** Exclude patterns (glob) - default: common excludes */
  exclude?: string[];
  /** Maximum file size in bytes (default: 10MB) */
  maxFileSize?: number;
  /** Download method: 'api' (ZIP via GitHub API) or 'git' (git clone) */
  method?: 'api' | 'git';
  /** Include git submodules (only for method: 'git', default: true) */
  includeSubmodules?: boolean;
}

/**
 * Result of downloading GitHub repository
 */
export interface GitHubDownloadResult {
  /** Virtual files (path + content) */
  files: VirtualFile[];
  /** Repository metadata */
  metadata: {
    owner: string;
    repo: string;
    ref: string;
    totalFiles: number;
    totalSize: number;
    downloadTimeMs: number;
  };
  /** Warnings during download */
  warnings: string[];
}

// ============================================
// URL Parsing
// ============================================

/**
 * Parse a GitHub URL into owner/repo/ref
 *
 * Supports formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo/tree/branch
 * - https://github.com/owner/repo/blob/branch/path
 * - github.com/owner/repo
 * - owner/repo
 */
export function parseGitHubUrl(url: string): GitHubRepoRef {
  // Remove protocol and www
  let cleaned = url.replace(/^(https?:\/\/)?(www\.)?/, '');

  // Remove github.com prefix if present
  cleaned = cleaned.replace(/^github\.com\//, '');

  // Split into parts
  const parts = cleaned.split('/');

  if (parts.length < 2) {
    throw new Error(`Invalid GitHub URL: ${url}. Expected format: owner/repo or https://github.com/owner/repo`);
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, ''); // Remove .git suffix if present

  // Check for branch/tag reference
  let ref = 'main';
  if (parts.length > 3 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    ref = parts[3];
  }

  return { owner, repo, ref };
}

/**
 * Build GitHub API URL for downloading ZIP archive
 */
function buildZipUrl(ref: GitHubRepoRef): string {
  return `https://api.github.com/repos/${ref.owner}/${ref.repo}/zipball/${ref.ref || 'main'}`;
}

/**
 * Build git clone URL
 */
function buildCloneUrl(ref: GitHubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
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
// Download Functions
// ============================================

/**
 * Download a GitHub repository and return virtual files
 */
export async function downloadGitHubRepo(
  urlOrRef: string | GitHubRepoRef,
  options: GitHubDownloadOptions = {}
): Promise<GitHubDownloadResult> {
  const startTime = Date.now();
  const ref = typeof urlOrRef === 'string' ? parseGitHubUrl(urlOrRef) : urlOrRef;
  const method = options.method || 'api';

  let result: GitHubDownloadResult;

  if (method === 'git') {
    result = await downloadViaGitClone(ref, options);
  } else {
    result = await downloadViaZipApi(ref, options);
  }

  result.metadata.downloadTimeMs = Date.now() - startTime;
  return result;
}

/**
 * Download via GitHub ZIP API (faster, doesn't require git)
 */
async function downloadViaZipApi(
  ref: GitHubRepoRef,
  options: GitHubDownloadOptions
): Promise<GitHubDownloadResult> {
  const AdmZip = (await import('adm-zip')).default;

  const zipUrl = buildZipUrl(ref);
  const warnings: string[] = [];
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  // Prepare headers
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'RagForge/1.0',
  };
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }

  // Download ZIP
  console.log(`[GitHub] Downloading ${ref.owner}/${ref.repo}@${ref.ref || 'main'} via API...`);

  const response = await fetch(zipUrl, { headers });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Repository not found: ${ref.owner}/${ref.repo}. Make sure it exists and is accessible.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Access denied to ${ref.owner}/${ref.repo}. For private repos, provide a GitHub token.`);
    }
    throw new Error(`Failed to download repository: ${response.status} ${response.statusText}`);
  }

  // Read ZIP into buffer
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  console.log(`[GitHub] Downloaded ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  // Extract ZIP
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  // Find root directory (GitHub adds owner-repo-sha prefix)
  let rootDir = '';
  for (const entry of entries) {
    if (entry.isDirectory && entry.entryName.split('/').length === 2) {
      rootDir = entry.entryName;
      break;
    }
  }

  // Build file list
  const allPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) {
      // Remove root directory prefix
      const relativePath = entry.entryName.replace(rootDir, '');
      if (relativePath) {
        allPaths.push(relativePath);
      }
    }
  }

  // Apply include/exclude filters
  const excludePatterns = options.exclude ?? DEFAULT_EXCLUDE_PATTERNS;
  const { minimatch } = await import('minimatch');

  // Filter paths
  const filteredPaths = allPaths.filter(p => {
    // Check exclude patterns - if any pattern matches, exclude the file
    const matchesExclude = excludePatterns.some(pattern => minimatch(p, pattern, { dot: true }));
    return !matchesExclude;
  });

  // Extract files as VirtualFile[]
  const files: VirtualFile[] = [];
  let totalSize = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const relativePath = entry.entryName.replace(rootDir, '');
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

  console.log(`[GitHub] Extracted ${files.length} files (${(totalSize / 1024 / 1024).toFixed(2)} MB total)`);

  return {
    files,
    metadata: {
      owner: ref.owner,
      repo: ref.repo,
      ref: ref.ref || 'main',
      totalFiles: files.length,
      totalSize,
      downloadTimeMs: 0, // Set by caller
    },
    warnings,
  };
}

/**
 * Download via git clone (supports more features, requires git)
 */
async function downloadViaGitClone(
  ref: GitHubRepoRef,
  options: GitHubDownloadOptions
): Promise<GitHubDownloadResult> {
  const fg = (await import('fast-glob')).default;

  const warnings: string[] = [];
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  // Create temp directory
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ragforge-github-'));

  try {
    // Build clone URL with token if provided
    let cloneUrl = buildCloneUrl(ref);
    if (options.token) {
      cloneUrl = `https://${options.token}@github.com/${ref.owner}/${ref.repo}.git`;
    }

    // Clone repository
    const includeSubmodules = options.includeSubmodules !== false; // default: true
    console.log(`[GitHub] Cloning ${ref.owner}/${ref.repo}@${ref.ref || 'main'}${includeSubmodules ? ' (with submodules)' : ''}...`);

    // Build clone command with submodules support
    const submoduleFlag = includeSubmodules ? '--recurse-submodules --shallow-submodules' : '';
    const branchFlag = ref.ref ? `--branch ${ref.ref}` : '';
    const cloneCmd = `git clone --depth 1 ${submoduleFlag} ${branchFlag} ${cloneUrl} ${tempDir}`.replace(/\s+/g, ' ').trim();

    await execAsync(cloneCmd, { maxBuffer: 50 * 1024 * 1024 });

    // Find files
    const excludePatterns = options.exclude ?? DEFAULT_EXCLUDE_PATTERNS;
    const includePatterns = options.include ?? ['**/*'];

    const filePaths = await fg(includePatterns, {
      cwd: tempDir,
      ignore: excludePatterns,
      onlyFiles: true,
      absolute: false,
    });

    console.log(`[GitHub] Found ${filePaths.length} files after filtering`);

    // Read files as VirtualFile[]
    const files: VirtualFile[] = [];
    let totalSize = 0;

    for (const relativePath of filePaths) {
      const absolutePath = path.join(tempDir, relativePath);

      try {
        const stat = await fs.stat(absolutePath);

        if (stat.size > maxFileSize) {
          warnings.push(`Skipped ${relativePath}: exceeds max file size (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
          continue;
        }

        const content = await fs.readFile(absolutePath);
        files.push({
          path: `/${relativePath}`,
          content: content,
          metadata: {
            size: content.length,
          },
        });
        totalSize += content.length;
      } catch (error) {
        warnings.push(`Failed to read ${relativePath}: ${error}`);
      }
    }

    console.log(`[GitHub] Loaded ${files.length} files (${(totalSize / 1024 / 1024).toFixed(2)} MB total)`);

    return {
      files,
      metadata: {
        owner: ref.owner,
        repo: ref.repo,
        ref: ref.ref || 'main',
        totalFiles: files.length,
        totalSize,
        downloadTimeMs: 0, // Set by caller
      },
      warnings,
    };
  } finally {
    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Check if a GitHub URL is valid and accessible
 */
export async function validateGitHubUrl(
  urlOrRef: string | GitHubRepoRef,
  token?: string
): Promise<{ valid: boolean; error?: string; metadata?: { owner: string; repo: string; ref: string } }> {
  try {
    const ref = typeof urlOrRef === 'string' ? parseGitHubUrl(urlOrRef) : urlOrRef;

    // Check repository exists via GitHub API
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'RagForge/1.0',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        return { valid: false, error: `Repository not found: ${ref.owner}/${ref.repo}` };
      }
      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: `Access denied. For private repos, provide a GitHub token.` };
      }
      return { valid: false, error: `GitHub API error: ${response.status}` };
    }

    return {
      valid: true,
      metadata: {
        owner: ref.owner,
        repo: ref.repo,
        ref: ref.ref || 'main',
      },
    };
  } catch (error) {
    return { valid: false, error: `Failed to validate: ${error}` };
  }
}
