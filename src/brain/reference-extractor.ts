/**
 * Reference Extractor Module
 *
 * Shared module for extracting file references from various file types.
 * Used by both project ingestion and touched-files-watcher.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import { isLocalPath } from '../utils/path-utils.js';

// ============================================
// Types
// ============================================

export type ReferenceType =
  | 'code'        // Import de code (.ts, .js, .py, etc.)
  | 'asset'       // Image, font, audio, video, 3D
  | 'document'    // Markdown, PDF, docs
  | 'stylesheet'  // CSS, SCSS
  | 'data'        // JSON, YAML
  | 'external'    // Package externe (npm, etc.)
  | 'url';        // URL web (http/https)

export type RelationType =
  | 'CONSUMES'          // Scope → Scope (code)
  | 'IMPORTS'           // File → File (fallback)
  | 'REFERENCES_ASSET'  // * → asset file
  | 'REFERENCES_DOC'    // * → document
  | 'REFERENCES_STYLE'  // * → stylesheet
  | 'REFERENCES_DATA'   // * → data file
  | 'LINKS_TO_URL'      // * → URL externe
  | 'MENTIONS_FILE'     // * → fichier mentionné (non résolu avec certitude)
  | 'PENDING_IMPORT';   // Non résolu

export interface ExtractedReference {
  /** Source brute (e.g., "./utils", "../styles/main.css", "https://example.com") */
  source: string;
  /** Symboles importés (e.g., ["foo", "bar"] ou ["*"] ou ["default"]) */
  symbols: string[];
  /** Type de référence détecté */
  type: ReferenceType;
  /** Ligne dans le fichier source (1-indexed) */
  line?: number;
  /** Est-ce une référence locale (vs package npm/externe) */
  isLocal: boolean;
  /** Pour les URLs: URL complète */
  url?: string;
  /** Score de confiance (0-1) pour les références extraites par heuristique */
  confidence?: number;
  /** Contexte d'extraction (pour debug/affichage) */
  context?: string;
}

export interface ResolvedReference extends ExtractedReference {
  /** Chemin absolu résolu */
  absolutePath: string;
  /** Chemin relatif au projet */
  relativePath: string;
  /** Type de relation à créer */
  relationType: RelationType;
}

export interface ReferenceCreationResult {
  /** Nombre de relations créées */
  created: number;
  /** Nombre de références en attente (non résolues) */
  pending: number;
  /** Détails des erreurs */
  errors: string[];
}

// ============================================
// Constants
// ============================================

/** Extensions par type de référence */
const TYPE_BY_EXTENSION: Record<string, ReferenceType> = {
  // Code
  '.ts': 'code', '.tsx': 'code', '.js': 'code', '.jsx': 'code',
  '.mjs': 'code', '.cjs': 'code',
  '.py': 'code', '.pyw': 'code',
  '.vue': 'code', '.svelte': 'code',
  '.go': 'code', '.rs': 'code', '.rb': 'code', '.php': 'code',
  // Assets - Images
  '.png': 'asset', '.jpg': 'asset', '.jpeg': 'asset', '.gif': 'asset',
  '.svg': 'asset', '.webp': 'asset', '.ico': 'asset', '.bmp': 'asset',
  // Assets - Fonts
  '.woff': 'asset', '.woff2': 'asset', '.ttf': 'asset', '.eot': 'asset', '.otf': 'asset',
  // Assets - Audio
  '.mp3': 'asset', '.wav': 'asset', '.ogg': 'asset', '.flac': 'asset', '.aac': 'asset',
  // Assets - Video
  '.mp4': 'asset', '.webm': 'asset', '.avi': 'asset', '.mov': 'asset', '.mkv': 'asset',
  // Assets - 3D
  '.glb': 'asset', '.gltf': 'asset', '.fbx': 'asset', '.obj': 'asset', '.stl': 'asset',
  // Assets - Other
  '.zip': 'asset', '.pdf': 'document',
  // Documents
  '.md': 'document', '.mdx': 'document', '.markdown': 'document',
  '.doc': 'document', '.docx': 'document',
  '.txt': 'document', '.rtf': 'document',
  // Stylesheets
  '.css': 'stylesheet', '.scss': 'stylesheet', '.sass': 'stylesheet', '.less': 'stylesheet',
  // Data
  '.json': 'data', '.yaml': 'data', '.yml': 'data', '.xml': 'data',
  '.toml': 'data', '.ini': 'data', '.env': 'data',
};

/** Extensions de code qui peuvent être omises dans les imports */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'];

/** Extensions d'index files */
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs'];

// ============================================
// Extraction Functions
// ============================================

/** Code file extensions - these get import-style extraction only */
const CODE_FILE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go', '.rs', '.rb', '.php', '.java', '.c', '.cpp', '.h', '.hpp',
  '.vue', '.svelte',
  '.css', '.scss', '.sass', '.less',
]);

/**
 * Extract all references from file content
 */
export function extractReferences(
  content: string,
  filePath: string
): ExtractedReference[] {
  const ext = path.extname(filePath).toLowerCase();
  const refs: ExtractedReference[] = [];

  // TypeScript / JavaScript
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    refs.push(...extractTypeScriptReferences(content));
  }
  // Python
  else if (['.py', '.pyw'].includes(ext)) {
    refs.push(...extractPythonReferences(content));
  }
  // Markdown - use both specific + generic extraction
  else if (['.md', '.mdx', '.markdown'].includes(ext)) {
    refs.push(...extractMarkdownReferences(content));
    // Also extract URLs and loose file paths from markdown content
    refs.push(...extractGenericReferences(content));
  }
  // CSS / SCSS
  else if (['.css', '.scss', '.sass', '.less'].includes(ext)) {
    refs.push(...extractCssReferences(content));
  }
  // HTML - use both specific + generic extraction
  else if (['.html', '.htm', '.xhtml'].includes(ext)) {
    refs.push(...extractHtmlReferences(content));
    // Also extract URLs and loose file paths from HTML text content
    refs.push(...extractGenericReferences(content));
  }
  // Vue / Svelte (extract from script section)
  else if (['.vue', '.svelte'].includes(ext)) {
    refs.push(...extractVueSvelteReferences(content));
  }
  // Non-code documents (PDF text, DOCX text, TXT, etc.) - generic extraction only
  else if (!CODE_FILE_EXTENSIONS.has(ext)) {
    refs.push(...extractGenericReferences(content));
  }

  // Deduplicate by source (keep first occurrence)
  const seen = new Set<string>();
  const deduped: ExtractedReference[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ref);
    }
  }

  return deduped;
}

/**
 * Extract TypeScript/JavaScript imports
 * Handles multi-line imports like:
 *   import {
 *     foo,
 *     bar,
 *   } from './module';
 */
function extractTypeScriptReferences(content: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];

  // Helper to get line number from character index
  const getLineNumber = (index: number): number => {
    return content.substring(0, index).split('\n').length;
  };

  // Named imports (multi-line safe): import { foo, bar } from './module'
  // Uses [\s\S] to match across lines
  const namedImportRegex = /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = namedImportRegex.exec(content)) !== null) {
    const symbolsBlock = match[1];
    const source = match[2];
    const symbols = symbolsBlock
      .split(',')
      .map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    refs.push({
      source,
      symbols,
      type: 'code',
      line: getLineNumber(match.index),
      isLocal: isLocalImport(source),
    });
  }

  // Default import: import Foo from './module'
  const defaultImportRegex = /import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;
  while ((match = defaultImportRegex.exec(content)) !== null) {
    refs.push({
      source: match[2],
      symbols: ['default'],
      type: 'code',
      line: getLineNumber(match.index),
      isLocal: isLocalImport(match[2]),
    });
  }

  // Namespace import: import * as Foo from './module'
  const namespaceImportRegex = /import\s*\*\s*as\s+(\w+)\s*from\s*['"]([^'"]+)['"]/g;
  while ((match = namespaceImportRegex.exec(content)) !== null) {
    refs.push({
      source: match[2],
      symbols: ['*'],
      type: 'code',
      line: getLineNumber(match.index),
      isLocal: isLocalImport(match[2]),
    });
  }

  // Side-effect import: import './module'
  const sideEffectImportRegex = /import\s+['"]([^'"]+)['"]/g;
  while ((match = sideEffectImportRegex.exec(content)) !== null) {
    const source = match[1];
    const ext = path.extname(source).toLowerCase();
    refs.push({
      source,
      symbols: [],
      type: TYPE_BY_EXTENSION[ext] || 'code',
      line: getLineNumber(match.index),
      isLocal: isLocalImport(source),
    });
  }

  // Dynamic import with destructuring: const { foo, bar } = await import('./module')
  const destructuredDynamicRegex = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = destructuredDynamicRegex.exec(content)) !== null) {
    const symbolsBlock = match[1];
    const source = match[2];
    const symbols = symbolsBlock
      .split(',')
      .map(s => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    refs.push({
      source,
      symbols,
      type: 'code',
      line: getLineNumber(match.index),
      isLocal: isLocalImport(source),
    });
  }

  // Dynamic import with namespace: const module = await import('./module')
  const namespaceDynamicRegex = /(?:const|let|var)\s+(\w+)\s*=\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = namespaceDynamicRegex.exec(content)) !== null) {
    refs.push({
      source: match[2],
      symbols: ['*'],
      type: 'code',
      line: getLineNumber(match.index),
      isLocal: isLocalImport(match[2]),
    });
  }

  // Inline dynamic import: (await import('./module')).foo
  const inlineDynamicRegex = /\(\s*await\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)\.(\w+)/g;
  while ((match = inlineDynamicRegex.exec(content)) !== null) {
    refs.push({
      source: match[1],
      symbols: [match[2]],
      type: 'code',
      line: getLineNumber(match.index),
      isLocal: isLocalImport(match[1]),
    });
  }

  // Fallback: Simple dynamic import without assignment (for side effects or untracked usage)
  // Only match if not already captured by previous patterns
  const simpleDynamicRegex = /(?<!(?:const|let|var)\s*(?:\{[^}]*\}|\w+)\s*=\s*await\s+)import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = simpleDynamicRegex.exec(content)) !== null) {
    const source = match[1];
    const line = getLineNumber(match.index);
    // Check if this wasn't already captured
    const existsAlready = refs.some(r => r.source === source && r.line === line);
    if (!existsAlready) {
      refs.push({
        source,
        symbols: ['*'],
        type: 'code',
        line,
        isLocal: isLocalImport(source),
      });
    }
  }

  // Re-exports (multi-line safe): export { foo } from './module'
  const reexportRegex = /export\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((match = reexportRegex.exec(content)) !== null) {
    const symbolsBlock = match[1];
    const symbols = symbolsBlock
      .split(',')
      .map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    refs.push({
      source: match[2],
      symbols,
      type: 'code',
      line: getLineNumber(match.index),
      isLocal: isLocalImport(match[2]),
    });
  }

  // Export all: export * from './module'
  const exportAllRegex = /export\s*\*\s*from\s*['"]([^'"]+)['"]/g;
  while ((match = exportAllRegex.exec(content)) !== null) {
    refs.push({
      source: match[1],
      symbols: ['*'],
      type: 'code',
      line: getLineNumber(match.index),
      isLocal: isLocalImport(match[1]),
    });
  }

  return refs;
}

/**
 * Extract Python imports
 */
function extractPythonReferences(content: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // from .module import foo, bar
    const fromMatch = line.match(/from\s+(\.+\w*(?:\.\w+)*)\s+import\s+(.+)/);
    if (fromMatch) {
      const source = fromMatch[1];
      const symbolsPart = fromMatch[2].split('#')[0]; // Remove comments
      const symbols = symbolsPart.split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      refs.push({
        source,
        symbols,
        type: 'code',
        line: lineNum,
        isLocal: source.startsWith('.'),
      });
      continue;
    }

    // import module (absolute - skip for now as not local)
    const importMatch = line.match(/^import\s+(\w+(?:\.\w+)*)/);
    if (importMatch) {
      refs.push({
        source: importMatch[1],
        symbols: ['*'],
        type: 'code',
        line: lineNum,
        isLocal: false, // Absolute imports are usually packages
      });
    }
  }

  return refs;
}

/**
 * Extract Markdown references (links and images)
 */
function extractMarkdownReferences(content: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Links: [text](./path/to/file.md)
    const linkMatches = line.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g);
    for (const match of linkMatches) {
      let target = match[2];
      // Skip external URLs
      if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:')) {
        continue;
      }
      // Remove anchor
      target = target.split('#')[0];
      if (!target) continue;

      const ext = path.extname(target).toLowerCase();
      refs.push({
        source: target,
        symbols: [],
        type: TYPE_BY_EXTENSION[ext] || 'document',
        line: lineNum,
        isLocal: true,
      });
    }

    // Images: ![alt](./path/to/image.png)
    const imgMatches = line.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g);
    for (const match of imgMatches) {
      let target = match[2];
      // Skip external URLs
      if (target.startsWith('http://') || target.startsWith('https://')) {
        continue;
      }

      refs.push({
        source: target,
        symbols: [],
        type: 'asset',
        line: lineNum,
        isLocal: true,
      });
    }
  }

  return refs;
}

/**
 * Extract CSS/SCSS references
 */
function extractCssReferences(content: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // @import "./file.css" or @import url("./file.css")
    const importMatches = line.matchAll(/@import\s+(?:url\s*\(\s*)?['"]([^'"]+)['"]\s*\)?/g);
    for (const match of importMatches) {
      const source = match[1];
      if (source.startsWith('http://') || source.startsWith('https://')) {
        continue;
      }
      refs.push({
        source,
        symbols: [],
        type: 'stylesheet',
        line: lineNum,
        isLocal: true,
      });
    }

    // url() references for fonts, images, etc.
    const urlMatches = line.matchAll(/url\s*\(\s*['"]?([^'")]+)['"]?\s*\)/g);
    for (const match of urlMatches) {
      const source = match[1];
      // Skip external URLs and data URIs
      if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('data:')) {
        continue;
      }
      // Skip if already captured by @import
      if (line.includes('@import')) continue;

      const ext = path.extname(source).toLowerCase();
      refs.push({
        source,
        symbols: [],
        type: TYPE_BY_EXTENSION[ext] || 'asset',
        line: lineNum,
        isLocal: true,
      });
    }
  }

  return refs;
}

/**
 * Extract HTML references
 */
function extractHtmlReferences(content: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];

  // Track line numbers approximately
  let currentLine = 1;
  const getLineNumber = (index: number): number => {
    const before = content.substring(0, index);
    return before.split('\n').length;
  };

  // <script src="...">
  const scriptMatches = content.matchAll(/<script[^>]+src\s*=\s*['"]([^'"]+)['"]/gi);
  for (const match of scriptMatches) {
    const source = match[1];
    if (source.startsWith('http://') || source.startsWith('https://')) continue;
    refs.push({
      source,
      symbols: [],
      type: 'code',
      line: getLineNumber(match.index || 0),
      isLocal: true,
    });
  }

  // <link href="..."> (stylesheets)
  const linkMatches = content.matchAll(/<link[^>]+href\s*=\s*['"]([^'"]+)['"]/gi);
  for (const match of linkMatches) {
    const source = match[1];
    if (source.startsWith('http://') || source.startsWith('https://')) continue;
    const ext = path.extname(source).toLowerCase();
    refs.push({
      source,
      symbols: [],
      type: ext === '.css' || ext === '.scss' ? 'stylesheet' : TYPE_BY_EXTENSION[ext] || 'asset',
      line: getLineNumber(match.index || 0),
      isLocal: true,
    });
  }

  // <img src="...">
  const imgMatches = content.matchAll(/<img[^>]+src\s*=\s*['"]([^'"]+)['"]/gi);
  for (const match of imgMatches) {
    const source = match[1];
    if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('data:')) continue;
    refs.push({
      source,
      symbols: [],
      type: 'asset',
      line: getLineNumber(match.index || 0),
      isLocal: true,
    });
  }

  // <a href="..."> (internal links only)
  const anchorMatches = content.matchAll(/<a[^>]+href\s*=\s*['"]([^'"]+)['"]/gi);
  for (const match of anchorMatches) {
    let source = match[1];
    // Skip external URLs, anchors, and special protocols
    if (source.startsWith('http://') || source.startsWith('https://') ||
        source.startsWith('mailto:') || source.startsWith('tel:') ||
        source.startsWith('#') || source.startsWith('javascript:')) {
      continue;
    }
    // Remove anchor
    source = source.split('#')[0];
    if (!source) continue;

    const ext = path.extname(source).toLowerCase();
    refs.push({
      source,
      symbols: [],
      type: TYPE_BY_EXTENSION[ext] || 'document',
      line: getLineNumber(match.index || 0),
      isLocal: true,
    });
  }

  return refs;
}

/**
 * Extract references from Vue/Svelte files
 */
function extractVueSvelteReferences(content: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];

  // Extract from <script> sections
  const scriptMatch = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  if (scriptMatch) {
    const scriptContent = scriptMatch[1];
    const scriptRefs = extractTypeScriptReferences(scriptContent);

    // Adjust line numbers based on script position
    const scriptStart = content.substring(0, content.indexOf(scriptMatch[0])).split('\n').length;
    for (const ref of scriptRefs) {
      if (ref.line) {
        ref.line += scriptStart;
      }
      refs.push(ref);
    }
  }

  // Extract from <style> sections
  const styleMatch = content.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (styleMatch) {
    const styleContent = styleMatch[1];
    const styleRefs = extractCssReferences(styleContent);

    const styleStart = content.substring(0, content.indexOf(styleMatch[0])).split('\n').length;
    for (const ref of styleRefs) {
      if (ref.line) {
        ref.line += styleStart;
      }
      refs.push(ref);
    }
  }

  // Extract from <template> - img src, a href, etc.
  const templateMatch = content.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
  if (templateMatch) {
    const templateContent = templateMatch[1];
    const templateRefs = extractHtmlReferences(templateContent);

    const templateStart = content.substring(0, content.indexOf(templateMatch[0])).split('\n').length;
    for (const ref of templateRefs) {
      if (ref.line) {
        ref.line += templateStart;
      }
      refs.push(ref);
    }
  }

  return refs;
}

// ============================================
// Generic Reference Extraction (URLs & Loose Paths)
// ============================================

/**
 * Common file extensions for detection in plain text
 */
const FILE_EXTENSIONS_PATTERN = /\.(ts|tsx|js|jsx|py|md|json|yaml|yml|xml|html|css|scss|vue|svelte|go|rs|rb|php|java|c|cpp|h|hpp|txt|pdf|docx?|xlsx?|csv|png|jpe?g|gif|svg|webp|mp[34]|wav|zip|tar|gz)$/i;

/**
 * Extract web URLs from any text content
 * Captures: http://, https://, www.
 */
function extractWebUrls(content: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const lines = content.split('\n');
  const seenUrls = new Set<string>();

  // URL patterns
  const urlPatterns = [
    // Full URLs: http:// or https://
    /https?:\/\/[^\s<>"')\]]+/gi,
    // www. URLs without protocol
    /(?<![\/\w])www\.[^\s<>"')\]]+/gi,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    for (const pattern of urlPatterns) {
      const matches = line.matchAll(pattern);
      for (const match of matches) {
        let url = match[0];

        // Clean trailing punctuation that's likely not part of URL
        url = url.replace(/[.,;:!?)]+$/, '');

        // Skip if already seen
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);

        // Add protocol if missing
        const fullUrl = url.startsWith('www.') ? `https://${url}` : url;

        refs.push({
          source: fullUrl,
          symbols: [],
          type: 'url',
          line: lineNum,
          isLocal: false,
          url: fullUrl,
          confidence: 1.0,
        });
      }
    }
  }

  return refs;
}

/**
 * Extract loose file paths from plain text
 * Detects paths mentioned without explicit link syntax
 *
 * Examples:
 * - "see src/utils.ts for details"
 * - "the config is in ./config/settings.json"
 * - "open /home/user/file.md"
 * - "check C:\Users\file.txt"
 */
function extractLooseFilePaths(content: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const lines = content.split('\n');
  const seenPaths = new Set<string>();

  // Patterns for file paths in plain text
  const pathPatterns = [
    // Unix absolute paths: /home/user/file.ts
    /(?<![:\w])\/(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,5}(?![\/\w])/g,

    // Relative paths with ./ or ../
    /\.\.?\/(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,5}(?![\/\w])/g,

    // Paths starting with common directories: src/, lib/, docs/, etc.
    /(?<![\/\w])(?:src|lib|docs|test|tests|spec|app|packages|components|utils|helpers|config|public|assets|images|styles|scripts|bin|dist|build|node_modules)\/(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,5}(?![\/\w])/gi,

    // Windows paths: C:\Users\file.txt
    /[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+\.[a-zA-Z0-9]{1,5}(?![\\\/\w])/g,

    // Home directory: ~/Documents/file.md
    /~\/(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,5}(?![\/\w])/g,

    // Simple filename with extension in context (lower confidence)
    // e.g., "voir le fichier config.json" or "edit Button.tsx"
    /(?<=\s|^|["'`])[\w.-]+(?:\.(?:ts|tsx|js|jsx|py|md|json|yaml|yml|xml|html|css|vue|svelte|pdf|docx?|xlsx?))(?=[\s,;:.\-!?)"'`]|$)/gi,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip lines that look like code (imports, requires, etc.)
    if (/^\s*(import|export|require|from|const|let|var|function|class)\s/.test(line)) {
      continue;
    }

    for (let patternIndex = 0; patternIndex < pathPatterns.length; patternIndex++) {
      const pattern = pathPatterns[patternIndex];
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;

      const matches = line.matchAll(pattern);
      for (const match of matches) {
        let filePath = match[0];

        // Normalize Windows paths to Unix
        filePath = filePath.replace(/\\/g, '/');

        // Skip if doesn't have a valid file extension
        if (!FILE_EXTENSIONS_PATTERN.test(filePath)) {
          continue;
        }

        // Skip URLs (already handled by extractWebUrls)
        if (filePath.includes('://') || filePath.startsWith('www.')) {
          continue;
        }

        // Skip if already seen
        const normalizedPath = filePath.toLowerCase();
        if (seenPaths.has(normalizedPath)) continue;
        seenPaths.add(normalizedPath);

        // Determine confidence based on pattern
        // Simple filenames have lower confidence than full paths
        const isSimpleFilename = !filePath.includes('/');
        const confidence = isSimpleFilename ? 0.6 : 0.9;

        // Extract context (surrounding text for debugging)
        const matchIndex = match.index || 0;
        const contextStart = Math.max(0, matchIndex - 20);
        const contextEnd = Math.min(line.length, matchIndex + filePath.length + 20);
        const context = line.substring(contextStart, contextEnd).trim();

        // Determine reference type based on extension
        const ext = path.extname(filePath).toLowerCase();
        const refType = TYPE_BY_EXTENSION[ext] || 'document';

        refs.push({
          source: filePath,
          symbols: [],
          type: refType,
          line: lineNum,
          isLocal: true,
          confidence,
          context,
        });
      }
    }
  }

  return refs;
}

/**
 * Extract generic references (URLs + loose file paths) from any document content
 * Called for all non-code documents (markdown, pdf, docx, txt, etc.)
 */
export function extractGenericReferences(content: string): ExtractedReference[] {
  const refs: ExtractedReference[] = [];

  // Extract web URLs
  refs.push(...extractWebUrls(content));

  // Extract loose file paths
  refs.push(...extractLooseFilePaths(content));

  return refs;
}

// ============================================
// Fuzzy Resolution Heuristics
// ============================================

/**
 * Levenshtein distance for fuzzy matching
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity score (0-1) between two strings
 */
function similarityScore(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  return 1 - distance / maxLen;
}

export interface FuzzyMatchResult {
  uuid: string;
  path: string;
  name: string;
  score: number;
  matchType: 'exact' | 'ends_with' | 'filename' | 'fuzzy';
  labels: string[];
}

/**
 * All node labels that represent files/documents for fuzzy resolution
 * Includes code files, documents, data files, media, etc.
 */
const FILE_NODE_LABELS = [
  'File',
  'Scope',
  // Documents
  'MarkdownDocument',
  'MarkdownSection',
  'PDFDocument',
  'WordDocument',
  'SpreadsheetDocument',
  'DocumentFile',
  // Data files
  'DataFile',
  // Code components
  'VueSFC',
  'SvelteComponent',
  'Stylesheet',
  // Media
  'ImageFile',
  'MediaFile',
  'ThreeDFile',
  // Generic
  'GenericFile',
];

/**
 * Build Cypher label condition from FILE_NODE_LABELS
 * Returns: "(n:File OR n:Scope OR n:MarkdownDocument OR ...)"
 */
function buildLabelCondition(varName: string = 'n'): string {
  return '(' + FILE_NODE_LABELS.map(l => `${varName}:${l}`).join(' OR ') + ')';
}

/**
 * Try to resolve a loose file reference using multiple heuristics
 *
 * Strategies (in order of preference):
 * 1. Exact path match (ends with the reference)
 * 2. Exact filename match
 * 3. Fuzzy filename match (Levenshtein)
 *
 * Searches across ALL file/document types:
 * - Code: File, Scope, VueSFC, SvelteComponent, Stylesheet
 * - Documents: MarkdownDocument, PDFDocument, WordDocument, SpreadsheetDocument
 * - Data: DataFile (JSON, YAML, XML, etc.)
 * - Media: ImageFile, MediaFile, ThreeDFile
 *
 * @param neo4jClient - Neo4j client
 * @param projectId - Project to search in
 * @param reference - The loose reference (e.g., "Button.tsx", "src/utils.ts", "config.json", "readme.md")
 * @param minSimilarity - Minimum similarity score for fuzzy matches (default: 0.7)
 */
export async function resolveLooseReference(
  neo4jClient: Neo4jClient,
  projectId: string,
  reference: string,
  minSimilarity: number = 0.7
): Promise<FuzzyMatchResult | null> {
  const fileName = path.basename(reference);
  const fileNameNoExt = path.basename(reference, path.extname(reference));
  const ext = path.extname(reference).toLowerCase();
  const labelCondition = buildLabelCondition('n');

  // Strategy 1: Exact path match (path ends with reference)
  if (reference.includes('/')) {
    const exactResult = await neo4jClient.run(`
      MATCH (n)
      WHERE n.projectId = $projectId
        AND (n.absolutePath ENDS WITH $reference
             OR n.file ENDS WITH $reference
             OR n.path ENDS WITH $reference)
        AND ${labelCondition}
      RETURN n.uuid as uuid, n.absolutePath as path, n.name as name, labels(n) as labels
      LIMIT 1
    `, { projectId, reference });

    if (exactResult.records.length > 0) {
      const record = exactResult.records[0];
      return {
        uuid: record.get('uuid'),
        path: record.get('path') || reference,
        name: record.get('name') || fileName,
        score: 1.0,
        matchType: 'ends_with',
        labels: record.get('labels') as string[],
      };
    }
  }

  // Strategy 2: Exact filename match
  const filenameResult = await neo4jClient.run(`
    MATCH (n)
    WHERE n.projectId = $projectId
      AND ${labelCondition}
      AND (
        n.name = $fileName
        OR n.absolutePath ENDS WITH $fileNameWithSlash
        OR n.file ENDS WITH $fileNameWithSlash
      )
    RETURN n.uuid as uuid, n.absolutePath as path, n.name as name, labels(n) as labels
    LIMIT 5
  `, {
    projectId,
    fileName,
    fileNameWithSlash: '/' + fileName,
  });

  if (filenameResult.records.length === 1) {
    // Single exact match - high confidence
    const record = filenameResult.records[0];
    return {
      uuid: record.get('uuid'),
      path: record.get('path') || fileName,
      name: record.get('name') || fileName,
      score: 0.95,
      matchType: 'filename',
      labels: record.get('labels') as string[],
    };
  } else if (filenameResult.records.length > 1) {
    // Multiple matches - return first but with lower confidence
    const record = filenameResult.records[0];
    return {
      uuid: record.get('uuid'),
      path: record.get('path') || fileName,
      name: record.get('name') || fileName,
      score: 0.7, // Lower score due to ambiguity
      matchType: 'filename',
      labels: record.get('labels') as string[],
    };
  }

  // Strategy 3: Fuzzy filename match
  // Get all files with the same extension and fuzzy match
  if (ext) {
    const fuzzyResult = await neo4jClient.run(`
      MATCH (n)
      WHERE n.projectId = $projectId
        AND ${labelCondition}
        AND (n.absolutePath ENDS WITH $ext OR n.name ENDS WITH $ext)
      RETURN n.uuid as uuid, n.absolutePath as path, n.name as name, labels(n) as labels
      LIMIT 100
    `, { projectId, ext });

    let bestMatch: FuzzyMatchResult | null = null;
    let bestScore = 0;

    for (const record of fuzzyResult.records) {
      const nodePath = record.get('path') as string || '';
      const nodeName = record.get('name') as string || path.basename(nodePath);

      // Compare filenames
      const nodeFileName = path.basename(nodePath);
      const score = similarityScore(fileName, nodeFileName);

      if (score > bestScore && score >= minSimilarity) {
        bestScore = score;
        bestMatch = {
          uuid: record.get('uuid'),
          path: nodePath,
          name: nodeName,
          score,
          matchType: 'fuzzy',
          labels: record.get('labels') as string[],
        };
      }
    }

    if (bestMatch) {
      return bestMatch;
    }
  }

  // Strategy 4: Fuzzy match on name without extension (for typos)
  const allFilesResult = await neo4jClient.run(`
    MATCH (n)
    WHERE n.projectId = $projectId
      AND ${labelCondition}
    RETURN n.uuid as uuid, n.absolutePath as path, n.name as name, labels(n) as labels
    LIMIT 200
  `, { projectId });

  let bestMatch: FuzzyMatchResult | null = null;
  let bestScore = 0;

  for (const record of allFilesResult.records) {
    const nodePath = record.get('path') as string || '';
    const nodeFileName = path.basename(nodePath);
    const nodeFileNameNoExt = path.basename(nodePath, path.extname(nodePath));

    // Compare both with and without extension
    const scoreWithExt = similarityScore(fileName, nodeFileName);
    const scoreNoExt = similarityScore(fileNameNoExt, nodeFileNameNoExt);
    const score = Math.max(scoreWithExt, scoreNoExt * 0.9); // Slight penalty for no-ext match

    if (score > bestScore && score >= minSimilarity) {
      bestScore = score;
      bestMatch = {
        uuid: record.get('uuid'),
        path: nodePath,
        name: record.get('name') || nodeFileName,
        score,
        matchType: 'fuzzy',
        labels: record.get('labels') as string[],
      };
    }
  }

  return bestMatch;
}

// ============================================
// Resolution Functions
// ============================================

/**
 * Check if an import source is local (vs npm package)
 */
function isLocalImport(source: string): boolean {
  return isLocalPath(source);
}

/**
 * Try to resolve a path with common extensions
 * Handles TypeScript ESM convention where imports use .js but files are .ts
 */
async function resolveWithExtensions(
  source: string,
  baseDir: string
): Promise<string | null> {
  const ext = path.extname(source);

  // If source has extension
  if (ext) {
    const fullPath = path.resolve(baseDir, source);

    // Try the exact path first
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // TypeScript ESM: imports use .js but files are .ts/.tsx
      if (ext === '.js' || ext === '.jsx') {
        const tsExt = ext === '.js' ? '.ts' : '.tsx';
        const tsPath = fullPath.replace(/\.(js|jsx)$/, tsExt);
        try {
          await fs.access(tsPath);
          return tsPath;
        } catch {
          // Also try .tsx for .js imports
          if (ext === '.js') {
            const tsxPath = fullPath.replace(/\.js$/, '.tsx');
            try {
              await fs.access(tsxPath);
              return tsxPath;
            } catch {
              // Fall through to extension search
            }
          }
        }
      }
    }
  }

  // Try without extension, adding common code extensions
  const basePath = ext ? source.slice(0, -ext.length) : source;
  for (const codeExt of CODE_EXTENSIONS) {
    const fullPath = path.resolve(baseDir, basePath + codeExt);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // Continue trying
    }
  }

  // Try as directory with index file
  for (const indexFile of INDEX_FILES) {
    const fullPath = path.resolve(baseDir, basePath, indexFile);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // Continue trying
    }
  }

  return null;
}

/**
 * Resolve a reference to an absolute path
 */
export async function resolveReference(
  ref: ExtractedReference,
  sourceFilePath: string,
  projectPath: string
): Promise<ResolvedReference | null> {
  if (!ref.isLocal) {
    return null; // Skip external packages
  }

  const sourceDir = path.dirname(sourceFilePath);
  const absolutePath = await resolveWithExtensions(ref.source, sourceDir);

  if (!absolutePath) {
    return null; // Cannot resolve
  }

  const relativePath = path.relative(projectPath, absolutePath);
  const targetExt = path.extname(absolutePath).toLowerCase();
  const targetType = TYPE_BY_EXTENSION[targetExt] || 'code';

  // Determine relation type based on target
  let relationType: RelationType;
  switch (targetType) {
    case 'asset':
      relationType = 'REFERENCES_ASSET';
      break;
    case 'document':
      relationType = 'REFERENCES_DOC';
      break;
    case 'stylesheet':
      relationType = 'REFERENCES_STYLE';
      break;
    case 'data':
      relationType = 'REFERENCES_DATA';
      break;
    default:
      relationType = 'CONSUMES';
  }

  return {
    ...ref,
    absolutePath,
    relativePath,
    relationType,
  };
}

/**
 * Resolve all references from a file
 */
export async function resolveAllReferences(
  refs: ExtractedReference[],
  sourceFilePath: string,
  projectPath: string
): Promise<ResolvedReference[]> {
  const resolved: ResolvedReference[] = [];

  for (const ref of refs) {
    const result = await resolveReference(ref, sourceFilePath, projectPath);
    if (result) {
      resolved.push(result);
    }
  }

  return resolved;
}

// ============================================
// Relation Creation Functions
// ============================================

/**
 * Create reference relations in Neo4j
 */
export async function createReferenceRelations(
  neo4jClient: Neo4jClient,
  sourceNodeUuid: string,
  sourceFile: string,
  refs: ResolvedReference[],
  projectId: string,
  options: {
    /** Create PENDING_IMPORT for unresolved refs (default: true) */
    createPending?: boolean;
    /** Use absolutePath for matching (for orphan files) */
    useAbsolutePath?: boolean;
  } = {}
): Promise<ReferenceCreationResult> {
  const { createPending = true, useAbsolutePath = false } = options;

  let created = 0;
  let pending = 0;
  const errors: string[] = [];

  for (const ref of refs) {
    try {
      // Handle URL references specially - create WebReference node
      if (ref.relationType === 'LINKS_TO_URL' && ref.url) {
        // Create or find WebReference node for this URL
        const urlDomain = new URL(ref.url).hostname;
        await neo4jClient.run(`
          MATCH (source {uuid: $sourceUuid})
          MERGE (webRef:WebReference {url: $url})
          ON CREATE SET
            webRef.uuid = randomUUID(),
            webRef.domain = $domain,
            webRef.projectId = $projectId,
            webRef.createdAt = datetime()
          MERGE (source)-[r:LINKS_TO_URL]->(webRef)
          SET r.line = $line,
              r.context = $context,
              r.createdAt = datetime()
        `, {
          sourceUuid: sourceNodeUuid,
          url: ref.url,
          domain: urlDomain,
          projectId,
          line: ref.line || null,
          context: ref.context || null,
        });
        created++;
        continue;
      }

      // Handle MENTIONS_FILE - use fuzzy resolution to find best match
      if (ref.relationType === 'MENTIONS_FILE') {
        // Use fuzzy resolution to find the best matching file
        const fuzzyMatch = await resolveLooseReference(
          neo4jClient,
          projectId,
          ref.source,
          0.7 // minSimilarity threshold
        );

        if (fuzzyMatch) {
          // Combine confidence scores: original ref confidence * fuzzy match score
          const combinedConfidence = (ref.confidence || 0.5) * fuzzyMatch.score;

          await neo4jClient.run(`
            MATCH (source {uuid: $sourceUuid})
            MATCH (target {uuid: $targetUuid})
            MERGE (source)-[r:MENTIONS_FILE]->(target)
            SET r.mentionedAs = $source,
                r.confidence = $confidence,
                r.matchType = $matchType,
                r.matchScore = $matchScore,
                r.line = $line,
                r.context = $context,
                r.resolved = true,
                r.createdAt = datetime()
          `, {
            sourceUuid: sourceNodeUuid,
            targetUuid: fuzzyMatch.uuid,
            source: ref.source,
            confidence: combinedConfidence,
            matchType: fuzzyMatch.matchType,
            matchScore: fuzzyMatch.score,
            line: ref.line || null,
            context: ref.context || null,
          });
          created++;
        } else {
          // Create MENTIONS_FILE as self-loop with target info (for future resolution)
          await neo4jClient.run(`
            MATCH (source {uuid: $sourceUuid})
            MERGE (source)-[r:MENTIONS_FILE {mentionedAs: $source}]->(source)
            SET r.confidence = $confidence,
                r.line = $line,
                r.context = $context,
                r.absolutePath = $absolutePath,
                r.resolved = false,
                r.createdAt = datetime()
          `, {
            sourceUuid: sourceNodeUuid,
            source: ref.source,
            confidence: ref.confidence || 0.5,
            line: ref.line || null,
            context: ref.context || null,
            absolutePath: ref.absolutePath,
          });
          pending++;
        }
        continue;
      }

      // Build the match condition based on options
      const pathCondition = useAbsolutePath
        ? 'target.absolutePath = $absolutePath'
        : '(target.file = $relativePath OR target.path = $relativePath OR target.absolutePath = $absolutePath)';

      // Try to find target node - check multiple node types
      const targetResult = await neo4jClient.run(`
        MATCH (target)
        WHERE target.projectId = $projectId
          AND ${pathCondition}
          AND (target:Scope OR target:File OR target:MarkdownDocument OR target:MarkdownSection
               OR target:Stylesheet OR target:DataFile OR target:MediaFile OR target:ImageFile
               OR target:ThreeDFile OR target:VueSFC OR target:SvelteComponent)
        RETURN target.uuid as uuid, labels(target) as labels
        LIMIT 1
      `, {
        projectId,
        relativePath: ref.relativePath,
        absolutePath: ref.absolutePath,
      });

      if (targetResult.records.length > 0) {
        const targetUuid = targetResult.records[0].get('uuid');
        const targetLabels = targetResult.records[0].get('labels') as string[];

        // For CONSUMES, try to find specific Scope with matching symbol
        if (ref.relationType === 'CONSUMES' && ref.symbols.length > 0 && !ref.symbols.includes('*')) {
          // Try to find Scope with matching exported name
          const scopeResult = await neo4jClient.run(`
            MATCH (scope:Scope {projectId: $projectId})
            WHERE (scope.absolutePath = $absolutePath OR scope.file = $relativePath OR scope.path = $relativePath)
              AND scope.name IN $symbols
            RETURN scope.uuid as uuid
            LIMIT 1
          `, { projectId, relativePath: ref.relativePath, absolutePath: ref.absolutePath, symbols: ref.symbols });

          if (scopeResult.records.length > 0) {
            const scopeUuid = scopeResult.records[0].get('uuid');
            await neo4jClient.run(`
              MATCH (source {uuid: $sourceUuid})
              MATCH (target:Scope {uuid: $targetUuid})
              MERGE (source)-[r:CONSUMES]->(target)
              SET r.symbols = $symbols,
                  r.createdAt = datetime()
            `, { sourceUuid: sourceNodeUuid, targetUuid: scopeUuid, symbols: ref.symbols });
            created++;
            continue;
          }
        }

        // Create the relationship to the found node
        await neo4jClient.run(`
          MATCH (source {uuid: $sourceUuid})
          MATCH (target {uuid: $targetUuid})
          MERGE (source)-[r:${ref.relationType}]->(target)
          SET r.symbols = $symbols,
              r.createdAt = datetime()
        `, { sourceUuid: sourceNodeUuid, targetUuid, symbols: ref.symbols });

        created++;
      } else if (createPending) {
        // Create PENDING_IMPORT for later resolution
        await neo4jClient.run(`
          MATCH (source {uuid: $sourceUuid})
          MERGE (source)-[r:PENDING_IMPORT {targetPath: $targetPath}]->(source)
          SET r.symbols = $symbols,
              r.intendedRelationType = $relationType,
              r.absolutePath = $absolutePath,
              r.createdAt = datetime()
        `, {
          sourceUuid: sourceNodeUuid,
          targetPath: ref.relativePath,
          symbols: ref.symbols,
          relationType: ref.relationType,
          absolutePath: ref.absolutePath,
        });

        pending++;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to create relation for ${ref.source}: ${errMsg}`);
    }
  }

  return { created, pending, errors };
}

/**
 * Resolve pending imports after new files are indexed
 * Call this after ingesting new files to convert PENDING_IMPORT to actual relations
 */
export async function resolvePendingImports(
  neo4jClient: Neo4jClient,
  projectId: string
): Promise<{ resolved: number; remaining: number }> {
  let resolved = 0;

  // Find all PENDING_IMPORT relations
  const pendingResult = await neo4jClient.run(`
    MATCH (source)-[r:PENDING_IMPORT]->(source)
    WHERE source.projectId = $projectId
    RETURN source.uuid as sourceUuid, r.targetPath as targetPath, r.symbols as symbols,
           r.intendedRelationType as relationType, r.absolutePath as absolutePath
  `, { projectId });

  for (const record of pendingResult.records) {
    const sourceUuid = record.get('sourceUuid');
    const targetPath = record.get('targetPath');
    const symbols = record.get('symbols') || [];
    const relationType = record.get('relationType') || 'CONSUMES';
    const absolutePath = record.get('absolutePath');

    // Try to find the target now
    const targetResult = await neo4jClient.run(`
      MATCH (target)
      WHERE target.projectId = $projectId
        AND (target.file = $targetPath OR target.path = $targetPath OR target.absolutePath = $absolutePath)
        AND (target:Scope OR target:File OR target:MarkdownDocument OR target:Stylesheet
             OR target:DataFile OR target:MediaFile OR target:ImageFile)
      RETURN target.uuid as uuid
      LIMIT 1
    `, { projectId, targetPath, absolutePath });

    if (targetResult.records.length > 0) {
      const targetUuid = targetResult.records[0].get('uuid');

      // Create the actual relation
      await neo4jClient.run(`
        MATCH (source {uuid: $sourceUuid})
        MATCH (target {uuid: $targetUuid})
        MERGE (source)-[r:${relationType}]->(target)
        SET r.symbols = $symbols,
            r.resolvedFrom = 'pending',
            r.createdAt = datetime()
      `, { sourceUuid, targetUuid, symbols });

      // Delete the PENDING_IMPORT
      await neo4jClient.run(`
        MATCH (source {uuid: $sourceUuid})-[r:PENDING_IMPORT {targetPath: $targetPath}]->(source)
        DELETE r
      `, { sourceUuid, targetPath });

      resolved++;
    }
  }

  // Count remaining
  const remainingResult = await neo4jClient.run(`
    MATCH (source)-[r:PENDING_IMPORT]->(source)
    WHERE source.projectId = $projectId
    RETURN count(r) as count
  `, { projectId });

  const remaining = remainingResult.records[0]?.get('count')?.toNumber() || 0;

  return { resolved, remaining };
}

/**
 * Resolve unresolved MENTIONS_FILE relations using fuzzy matching
 * Call this after ingesting new files to try to resolve loose file mentions
 */
export async function resolveUnresolvedMentions(
  neo4jClient: Neo4jClient,
  projectId: string,
  minSimilarity: number = 0.7
): Promise<{ resolved: number; remaining: number; details: Array<{ mention: string; matchedTo: string; score: number; matchType: string }> }> {
  let resolved = 0;
  const details: Array<{ mention: string; matchedTo: string; score: number; matchType: string }> = [];

  // Find all unresolved MENTIONS_FILE relations (self-loops with resolved=false)
  const unresolvedResult = await neo4jClient.run(`
    MATCH (source)-[r:MENTIONS_FILE]->(source)
    WHERE source.projectId = $projectId
      AND r.resolved = false
    RETURN source.uuid as sourceUuid, r.mentionedAs as mention,
           r.confidence as confidence, r.line as line, r.context as context
  `, { projectId });

  for (const record of unresolvedResult.records) {
    const sourceUuid = record.get('sourceUuid');
    const mention = record.get('mention');
    const originalConfidence = record.get('confidence') || 0.5;
    const line = record.get('line');
    const context = record.get('context');

    // Try fuzzy resolution
    const fuzzyMatch = await resolveLooseReference(
      neo4jClient,
      projectId,
      mention,
      minSimilarity
    );

    if (fuzzyMatch) {
      const combinedConfidence = originalConfidence * fuzzyMatch.score;

      // Delete the self-loop
      await neo4jClient.run(`
        MATCH (source {uuid: $sourceUuid})-[r:MENTIONS_FILE {mentionedAs: $mention}]->(source)
        DELETE r
      `, { sourceUuid, mention });

      // Create the actual relation to the matched target
      await neo4jClient.run(`
        MATCH (source {uuid: $sourceUuid})
        MATCH (target {uuid: $targetUuid})
        MERGE (source)-[r:MENTIONS_FILE]->(target)
        SET r.mentionedAs = $mention,
            r.confidence = $confidence,
            r.matchType = $matchType,
            r.matchScore = $matchScore,
            r.line = $line,
            r.context = $context,
            r.resolved = true,
            r.resolvedFrom = 'deferred',
            r.createdAt = datetime()
      `, {
        sourceUuid,
        targetUuid: fuzzyMatch.uuid,
        mention,
        confidence: combinedConfidence,
        matchType: fuzzyMatch.matchType,
        matchScore: fuzzyMatch.score,
        line: line || null,
        context: context || null,
      });

      resolved++;
      details.push({
        mention,
        matchedTo: fuzzyMatch.path,
        score: fuzzyMatch.score,
        matchType: fuzzyMatch.matchType,
      });
    }
  }

  // Count remaining unresolved
  const remainingResult = await neo4jClient.run(`
    MATCH (source)-[r:MENTIONS_FILE]->(source)
    WHERE source.projectId = $projectId
      AND r.resolved = false
    RETURN count(r) as count
  `, { projectId });

  const remaining = remainingResult.records[0]?.get('count')?.toNumber() || 0;

  return { resolved, remaining, details };
}

// ============================================
// Utility Functions
// ============================================

/**
 * Get the reference type for a file extension
 */
export function getReferenceType(filePath: string): ReferenceType {
  const ext = path.extname(filePath).toLowerCase();
  return TYPE_BY_EXTENSION[ext] || 'code';
}

/**
 * Get the relation type for a target file
 */
export function getRelationType(targetFilePath: string): RelationType {
  const type = getReferenceType(targetFilePath);
  switch (type) {
    case 'asset': return 'REFERENCES_ASSET';
    case 'document': return 'REFERENCES_DOC';
    case 'stylesheet': return 'REFERENCES_STYLE';
    case 'data': return 'REFERENCES_DATA';
    default: return 'CONSUMES';
  }
}
