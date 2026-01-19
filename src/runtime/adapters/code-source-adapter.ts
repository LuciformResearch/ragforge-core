/**
 * Code Source Adapter
 *
 * Parses codebases (TypeScript, Python, etc.) into Neo4j graph structure
 * using @luciformresearch/codeparsers
 *
 * NOTE: Historically, this adapter required specifying a language type (typescript,
 * python, html, auto) to determine which parser to use. This is becoming increasingly
 * irrelevant as we evolve toward a generalist code agent that automatically handles
 * all file types. The adapter now auto-detects file types and uses the appropriate
 * parser regardless of the configured adapter type. Eventually, the adapter field
 * may be deprecated entirely.
 */

import fg from 'fast-glob';
import { createHash } from 'crypto';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import pLimit from 'p-limit';
import { formatLocalDate } from '../utils/timestamp.js';
import { getLastSegment, getPathDepth, splitPath, isLocalPath, isAbsolutePath } from '../../utils/path-utils.js';
import {
  ParserRegistry,
  TypeScriptLanguageParser,
  PythonLanguageParser,
  RustLanguageParser,
  GoLanguageParser,
  CLanguageParser,
  CppLanguageParser,
  CSharpLanguageParser,
  HTMLDocumentParser,
  CSSParser,
  SCSSParser,
  VueParser,
  SvelteParser,
  MarkdownParser,
  GenericCodeParser,
  // Relationship resolution from codeparsers
  RelationshipResolver,
  type RelationshipResolutionResult,
  type ResolvedRelationship,
  type ParsedFilesMap,
  // Parallel parsing with worker threads
  ProjectParser,
  isCodeParserSupported,
  NonCodeProjectParser,
  isNonCodeParserSupported,
  detectNonCodeParserType,
  // TODO: Migrate to UniversalScope/FileAnalysis from './base'
  // These internal types (ScopeInfo, ScopeFileAnalysis) are used throughout this file
  // and require a larger refactoring effort to replace with the universal types.
  // See convertUniversalToScopeFileAnalysis() for the conversion layer.
  type ScopeFileAnalysis,
  type ScopeInfo,
  type HTMLParseResult,
  type DocumentInfo,
  type CSSParseResult,
  type StylesheetInfo,
  type SCSSParseResult,
  type VueSFCParseResult,
  type SvelteParseResult,
  type MarkdownParseResult,
  type GenericFileAnalysis,
} from '@luciformresearch/codeparsers';
import {
  SourceAdapter,
  type SourceConfig,
  type ParseOptions,
  type ParseResult,
  type ParsedNode,
  type ParsedRelationship,
  type ParsedGraph,
  type ValidationResult,
  type ParseProgress,
  type VirtualFile,
  type ParserOptionsConfig,
} from './types.js';
import { UniqueIDHelper } from '../utils/UniqueIDHelper.js';
import { ImportResolver } from '../utils/ImportResolver.js';
import { getLocalTimestamp } from '../utils/timestamp.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  parseDataFile,
  isDataFile,
  type DataFileInfo,
} from './data-file-parser.js';
import {
  parseMediaFile,
  isMediaFile,
  type MediaFileInfo,
  type ImageFileInfo,
  type ThreeDFileInfo,
  type PDFFileInfo,
} from './media-file-parser.js';
import {
  parseDocumentFile,
  parsePdfWithVision,
  isDocumentFile,
  getDocumentFormat,
  type DocumentFileInfo,
  type SpreadsheetInfo,
  type PDFInfo,
  type DOCXInfo,
  type ParsedSection,
} from './document-file-parser.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../../ingestion/constants.js';
import {
  createNodeFromRegistry,
  createStructuralNode,
  registerAllParsers,
  areParsersRegistered,
  getRawContentProp,
} from '../../ingestion/index.js';

const execAsync = promisify(exec);

/**
 * Code-specific source configuration
 *
 * @deprecated The 'adapter' field is becoming irrelevant. The code adapter now
 * auto-detects file types and uses appropriate parsers. Use 'auto' for new projects.
 */
export interface CodeSourceConfig extends SourceConfig {
  type: 'code';
  /**
   * @deprecated Use 'auto' - file types are now auto-detected regardless of this setting.
   * Kept for backward compatibility with existing configurations.
   */
  adapter: 'typescript' | 'python' | 'html' | 'auto';
  options?: {
    /** Export XML for debugging */
    exportXml?: boolean;
    /** XML export directory */
    xmlDir?: string;
    /** Parse comments/docstrings */
    parseComments?: boolean;
    /** Resolve imports */
    resolveImports?: boolean;
    /** Extract type definitions */
    extractTypes?: boolean;
  };
}

/**
 * Parsed package.json information
 */
export interface PackageJsonInfo {
  file: string;
  name: string;
  version: string;
  description?: string;
  dependencies: string[];
  devDependencies: string[];
  peerDependencies: string[];
  scripts: string[];
  main?: string;
  type?: 'module' | 'commonjs';
  raw: Record<string, any>;
}

/**
 * Adapter for parsing code sources (TypeScript, Python, HTML/Vue, etc.)
 */
export class CodeSourceAdapter extends SourceAdapter {
  readonly type = 'code';
  readonly adapterName: string;
  private registry: ParserRegistry;
  private htmlParser: HTMLDocumentParser | null = null;
  private cssParser: CSSParser | null = null;
  private scssParser: SCSSParser | null = null;
  private vueParser: VueParser | null = null;
  private svelteParser: SvelteParser | null = null;
  private markdownParser: MarkdownParser | null = null;
  private genericParser: GenericCodeParser | null = null;
  private projectParser: ProjectParser | null = null;
  private nonCodeProjectParser: NonCodeProjectParser | null = null;
  private uuidCache: Map<string, Map<string, string>>; // filePath -> (key -> uuid)

  constructor(adapterName: 'typescript' | 'python' | 'html' | 'auto') {
    super();
    this.adapterName = adapterName;
    this.registry = this.initializeRegistry();
    this.uuidCache = new Map();
  }

  /**
   * Compute file metadata for incremental ingestion
   * Returns rawContentHash (for pre-parsing skip) and mtime
   */
  private async computeFileMetadata(filePath: string): Promise<{
    rawContentHash?: string;
    mtime?: string;
  }> {
    try {
      const [fileContent, stat] = await Promise.all([
        fs.readFile(filePath),
        fs.stat(filePath)
      ]);
      return {
        rawContentHash: createHash('sha256').update(fileContent).digest('hex'),
        mtime: formatLocalDate(stat.mtime)
      };
    } catch {
      return {};
    }
  }

  /**
   * Get or initialize HTML parser
   */
  private async getHtmlParser(): Promise<HTMLDocumentParser> {
    if (!this.htmlParser) {
      this.htmlParser = new HTMLDocumentParser();
      await this.htmlParser.initialize();
    }
    return this.htmlParser;
  }

  /**
   * Get or initialize CSS parser
   */
  private async getCssParser(): Promise<CSSParser> {
    if (!this.cssParser) {
      this.cssParser = new CSSParser();
      await this.cssParser.initialize();
    }
    return this.cssParser;
  }

  /**
   * Get or initialize SCSS parser
   */
  private async getScssParser(): Promise<SCSSParser> {
    if (!this.scssParser) {
      this.scssParser = new SCSSParser();
      await this.scssParser.initialize();
    }
    return this.scssParser;
  }

  /**
   * Get or initialize Vue parser
   */
  private async getVueParser(): Promise<VueParser> {
    if (!this.vueParser) {
      this.vueParser = new VueParser();
      await this.vueParser.initialize();
    }
    return this.vueParser;
  }

  /**
   * Get or initialize Svelte parser
   */
  private async getSvelteParser(): Promise<SvelteParser> {
    if (!this.svelteParser) {
      this.svelteParser = new SvelteParser();
      await this.svelteParser.initialize();
    }
    return this.svelteParser;
  }

  /**
   * Get or initialize Markdown parser
   * Passes the ParserRegistry to reuse initialized parsers and avoid version conflicts
   */
  private async getMarkdownParser(): Promise<MarkdownParser> {
    if (!this.markdownParser) {
      this.markdownParser = new MarkdownParser(this.registry);
      await this.markdownParser.initialize();
    }
    return this.markdownParser;
  }

  /**
   * Get or initialize Generic code parser (fallback for unknown languages)
   */
  private async getGenericParser(): Promise<GenericCodeParser> {
    if (!this.genericParser) {
      this.genericParser = new GenericCodeParser();
      await this.genericParser.initialize();
    }
    return this.genericParser;
  }

  /**
   * Get or initialize ProjectParser for parallel code file parsing.
   * Uses worker threads for true parallelism on CPU-bound parsing tasks.
   */
  private getProjectParser(): ProjectParser {
    if (!this.projectParser) {
      // Use CPU count - 1 workers, minimum 1
      const maxWorkers = Math.max(1, (os.cpus().length || 4) - 1);
      this.projectParser = new ProjectParser({
        maxWorkers,
        verbose: false,
      });
      console.log(`[CodeSourceAdapter] ProjectParser initialized with ${maxWorkers} workers`);
    }
    return this.projectParser;
  }

  /**
   * Get or initialize NonCodeProjectParser for parallel non-code file parsing.
   * Uses worker threads for true parallelism.
   */
  private getNonCodeProjectParser(): NonCodeProjectParser {
    if (!this.nonCodeProjectParser) {
      // Use CPU count - 1 workers, minimum 1
      const maxWorkers = Math.max(1, (os.cpus().length || 4) - 1);
      this.nonCodeProjectParser = new NonCodeProjectParser({
        maxWorkers,
        verbose: false,
      });
      console.log(`[CodeSourceAdapter] NonCodeProjectParser initialized with ${maxWorkers} workers`);
    }
    return this.nonCodeProjectParser;
  }

  /**
   * Check if a file is a plain HTML file (not Vue/Svelte)
   */
  private isHtmlFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.html', '.htm', '.astro'].includes(ext);
  }

  /**
   * Check if a file is a Vue SFC
   */
  private isVueFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.vue';
  }

  /**
   * Check if a file is a Svelte component
   */
  private isSvelteFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.svelte';
  }

  /**
   * Check if a file is a plain CSS file
   */
  private isCssFile(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === '.css';
  }

  /**
   * Check if a file is an SCSS file
   */
  private isScssFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.scss', '.sass'].includes(ext);
  }

  /**
   * Check if a file is a Markdown file
   */
  private isMarkdownFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.md', '.mdx', '.markdown'].includes(ext);
  }

  /**
   * Check if a file is a text file that should be chunked
   */
  private isTextFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.txt', '.log', '.env.example', '.gitignore', '.dockerignore'].includes(ext) ||
           filePath.endsWith('.env.example') ||
           path.basename(filePath).startsWith('.');
  }

  /**
   * Initialize parser registry with available language parsers
   */
  private initializeRegistry(): ParserRegistry {
    const registry = new ParserRegistry();
    registry.register(new TypeScriptLanguageParser());
    registry.register(new PythonLanguageParser());
    registry.register(new RustLanguageParser());
    registry.register(new GoLanguageParser());
    registry.register(new CLanguageParser());
    registry.register(new CppLanguageParser());
    registry.register(new CSharpLanguageParser());
    return registry;
  }

  /**
   * Validate source configuration
   */
  async validate(config: SourceConfig): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (config.type !== 'code') {
      errors.push(`Invalid source type: ${config.type}. Expected 'code'`);
    }

    if (!config.root) {
      warnings.push('No root directory specified. Will use current working directory');
    }

    if (!config.include || config.include.length === 0) {
      warnings.push('No include patterns specified. Will parse all files in root directory');
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  /**
   * Parse source into Neo4j graph structure
   */
  async parse(options: ParseOptions): Promise<ParseResult> {
    const startTime = Date.now();
    const config = options.source as CodeSourceConfig;

    // Ensure parsers are registered for createNodeFromRegistry
    if (!areParsersRegistered()) {
      registerAllParsers();
    }

    // Detect project information
    const projectRoot = config.root || process.cwd();
    const projectInfo = await this.detectProjectInfo(projectRoot);
    console.log(`  ✓ Project: ${projectInfo.name}${projectInfo.gitRemote ? ' (' + projectInfo.gitRemote + ')' : ''}`);

    // Initialize ImportResolver for TypeScript projects
    const resolver = new ImportResolver(projectRoot);
    if (config.adapter === 'typescript') {
      try {
        await resolver.loadTsConfig();
        console.log('  ✓ Import resolver initialized with tsconfig.json');
      } catch (error) {
        console.warn('  ⚠️  No tsconfig.json found, continuing without import resolution');
      }
    }

    // Report progress: discovering files
    options.onProgress?.({
      phase: 'discovering',
      filesProcessed: 0,
      totalFiles: 0,
      percentComplete: 0
    });

    // Build contentMap for virtual files (in-memory parsing, no disk I/O)
    let contentMap: Map<string, string | Buffer> | undefined;
    let files: string[];

    if (config.virtualFiles && config.virtualFiles.length > 0) {
      // Virtual files mode: use in-memory content
      console.log(`📦 Virtual files mode: ${config.virtualFiles.length} files in memory`);
      contentMap = new Map();
      files = [];

      for (const vf of config.virtualFiles) {
        // Normalize path to absolute-like format for consistency
        const normalizedPath = vf.path.startsWith('/') ? vf.path : `/${vf.path}`;
        files.push(normalizedPath);
        contentMap.set(normalizedPath, vf.content);
      }
    } else {
      // Disk files mode: discover files using fast-glob
      files = await this.discoverFiles(config);

      // Filter out files that should be skipped (incremental ingestion)
      const rootDir = config.root || process.cwd();
      if (options.skipFiles && options.skipFiles.size > 0) {
        const beforeCount = files.length;
        files = files.filter(f => {
          const relPath = path.relative(rootDir, f);
          return !options.skipFiles!.has(relPath);
        });
        const skipped = beforeCount - files.length;
        if (skipped > 0) {
          console.log(`[CodeSourceAdapter] Skipped ${skipped} unchanged files (incremental)`);
        }
      }
    }

    if (files.length === 0) {
      return {
        graph: {
          nodes: [],
          relationships: [],
          metadata: {
            filesProcessed: 0,
            nodesGenerated: 0,
            relationshipsGenerated: 0,
            parseTimeMs: Date.now() - startTime,
            warnings: ['No files found matching include/exclude patterns']
          }
        },
        isIncremental: false
      };
    }

    // Report progress: parsing
    options.onProgress?.({
      phase: 'parsing',
      filesProcessed: 0,
      totalFiles: files.length,
      percentComplete: 0
    });

    // Parse all files (pass contentMap for virtual files)
    const {
      codeFiles,
      htmlFiles,
      cssFiles,
      scssFiles,
      vueFiles,
      svelteFiles,
      markdownFiles,
      genericFiles,
      packageJsonFiles,
      dataFiles,
      mediaFiles,
      documentFiles,
      fileMetadata,
      documentPageNumMap,
      documentMetadata,
    } = await this.parseFiles(files, config, (current) => {
      options.onProgress?.({
        phase: 'parsing',
        currentFile: current,
        filesProcessed: files.indexOf(current) + 1,
        totalFiles: files.length,
        percentComplete: ((files.indexOf(current) + 1) / files.length) * 100
      });
    }, contentMap, options.parserOptions);

    // Report progress: building graph
    options.onProgress?.({
      phase: 'building_graph',
      filesProcessed: files.length,
      totalFiles: files.length,
      percentComplete: 100
    });

    console.log(`✅ Parsing complete. Starting buildGraph...`);
    console.log(`   Code: ${codeFiles.size}, HTML: ${htmlFiles.size}, CSS: ${cssFiles.size}, SCSS: ${scssFiles.size}`);
    console.log(`   Vue: ${vueFiles.size}, Svelte: ${svelteFiles.size}, Markdown: ${markdownFiles.size}, Generic: ${genericFiles.size}`);

    // Build graph structure
    // Use provided projectId if available, otherwise fall back to project:name format
    const generatedProjectId = options.projectId || `project:${projectInfo.name}`;
    const graph = await this.buildGraph({
      codeFiles,
      htmlFiles,
      cssFiles,
      scssFiles,
      vueFiles,
      svelteFiles,
      markdownFiles,
      genericFiles,
      packageJsonFiles,
      dataFiles,
      mediaFiles,
      documentFiles,
      fileMetadata,
      documentPageNumMap,
      documentMetadata,
    }, config, resolver, projectInfo, generatedProjectId, options.existingUUIDMapping);

    // Export XML if requested
    if (config.options?.exportXml) {
      await this.exportXml(codeFiles, config);
    }

    // Report progress: complete
    options.onProgress?.({
      phase: 'complete',
      filesProcessed: files.length,
      totalFiles: files.length,
      percentComplete: 100
    });

    return {
      graph,
      isIncremental: false // TODO: Implement incremental updates
    };
  }

  /**
   * Discover files to parse based on include/exclude patterns
   */
  private async discoverFiles(config: CodeSourceConfig): Promise<string[]> {
    const patterns = config.include || ['**/*.ts', '**/*.tsx', '**/*.py', 'package.json'];
    const ignore = config.exclude || DEFAULT_EXCLUDE_PATTERNS;

    const cwd = config.root || process.cwd();

    console.log(`🔍 discoverFiles:`);
    console.log(`   cwd: ${cwd}`);
    console.log(`   include: ${patterns.slice(0, 5).join(', ')}${patterns.length > 5 ? ` (+${patterns.length - 5} more)` : ''}`);
    console.log(`   exclude: ${ignore.slice(0, 5).join(', ')}${ignore.length > 5 ? ` (+${ignore.length - 5} more)` : ''}`);

    const files = await fg(patterns, {
      cwd,
      ignore,
      absolute: true
    });

    // Always include package.json from project root if it exists
    const fs = await import('fs/promises');
    const packageJsonPath = path.join(cwd, 'package.json');
    try {
      await fs.access(packageJsonPath);
      if (!files.includes(packageJsonPath)) {
        files.push(packageJsonPath);
      }
    } catch {
      // No package.json in root, that's OK
    }

    return files;
  }

  /**
   * Check if a file is a package.json
   */
  private isPackageJson(filePath: string): boolean {
    return path.basename(filePath) === 'package.json';
  }

  /**
   * Parsed package.json info
   */
  private parsePackageJson(content: string, filePath: string): PackageJsonInfo | null {
    try {
      const pkg = JSON.parse(content);
      return {
        file: filePath,
        name: pkg.name || path.basename(path.dirname(filePath)),
        version: pkg.version || '0.0.0',
        description: pkg.description,
        dependencies: Object.keys(pkg.dependencies || {}),
        devDependencies: Object.keys(pkg.devDependencies || {}),
        peerDependencies: Object.keys(pkg.peerDependencies || {}),
        scripts: Object.keys(pkg.scripts || {}),
        main: pkg.main,
        type: pkg.type, // 'module' or 'commonjs'
        raw: pkg, // Keep full object for queries
      };
    } catch {
      console.warn(`Failed to parse package.json: ${filePath}`);
      return null;
    }
  }

  /**
   * Parse all files (code, HTML, CSS, Vue, Svelte, SCSS, Markdown, and package.json)
   * Uses p-limit for parallel processing (10 concurrent files)
   * 
   * @param contentMap - Optional map of filePath -> content for in-memory parsing
   */
  private async parseFiles(
    files: string[],
    config: CodeSourceConfig,
    onProgress: (file: string) => void,
    contentMap?: Map<string, string | Buffer>,
    parserOptions?: ParserOptionsConfig
  ): Promise<{
    codeFiles: Map<string, ScopeFileAnalysis>;
    htmlFiles: Map<string, HTMLParseResult>;
    cssFiles: Map<string, CSSParseResult>;
    scssFiles: Map<string, SCSSParseResult>;
    vueFiles: Map<string, VueSFCParseResult>;
    svelteFiles: Map<string, SvelteParseResult>;
    markdownFiles: Map<string, MarkdownParseResult>;
    genericFiles: Map<string, GenericFileAnalysis>;
    packageJsonFiles: Map<string, PackageJsonInfo>;
    dataFiles: Map<string, DataFileInfo>;
    mediaFiles: Map<string, MediaFileInfo>;
    documentFiles: Map<string, DocumentFileInfo>;
    fileMetadata: Map<string, { rawContentHash: string; mtime: string; rawContent?: string }>;
    /** Maps document file paths to their section pageNum mapping (startLine → pageNum) */
    documentPageNumMap: Map<string, Map<number, number>>;
    /** Document metadata (sourceFormat, pageCount, etc.) for files converted to markdown */
    documentMetadata: Map<string, { sourceFormat: string; pageCount?: number; parsedWith?: string }>;
  }> {
    const codeFiles = new Map<string, ScopeFileAnalysis>();
    const htmlFiles = new Map<string, HTMLParseResult>();
    const cssFiles = new Map<string, CSSParseResult>();
    const scssFiles = new Map<string, SCSSParseResult>();
    const vueFiles = new Map<string, VueSFCParseResult>();
    const svelteFiles = new Map<string, SvelteParseResult>();
    const markdownFiles = new Map<string, MarkdownParseResult>();
    const genericFiles = new Map<string, GenericFileAnalysis>();
    const packageJsonFiles = new Map<string, PackageJsonInfo>();
    const dataFiles = new Map<string, DataFileInfo>();
    const mediaFiles = new Map<string, MediaFileInfo>();
    const documentFiles = new Map<string, DocumentFileInfo>();
    // Pre-computed file metadata (hash + mtime + optional raw content) to avoid re-reading files in buildGraph
    const fileMetadata = new Map<string, { rawContentHash: string; mtime: string; rawContent?: string }>();
    // Document pageNum mapping: filePath → (startLine → pageNum)
    const documentPageNumMap = new Map<string, Map<number, number>>();
    // Document metadata for files converted to markdown
    const documentMetadata = new Map<string, { sourceFormat: string; pageCount?: number; parsedWith?: string }>();
    // Track which files are virtual (from contentMap) - only these get _rawContent stored
    const virtualFiles = new Set<string>(contentMap?.keys() || []);

    // Use p-limit for parallel processing (10 concurrent files)
    const limit = pLimit(10);
    let filesProcessed = 0;

    // Separate code files (for ProjectParser with true parallelism) from other files
    const codeFilePaths = files.filter(f => isCodeParserSupported(f));
    const otherFiles = files.filter(f => !isCodeParserSupported(f));

    console.log(`📊 Files breakdown: ${codeFilePaths.length} code files, ${otherFiles.length} other files`);

    // ========================================================================
    // PHASE 1: Parse CODE files with ProjectParser (true parallelism via workers)
    // ========================================================================
    if (codeFilePaths.length > 0) {
      console.log(`🚀 Starting parallel code parsing of ${codeFilePaths.length} files with worker threads...`);

      // First, read all code files and compute metadata (I/O bound, use pLimit)
      const codeContentMap = new Map<string, string>();
      await Promise.all(
        codeFilePaths.map(file => limit(async () => {
          try {
            let content: string;
            let mtime: string;

            if (contentMap && contentMap.has(file)) {
              // Virtual file: read from memory
              const virtualContent = contentMap.get(file)!;
              content = typeof virtualContent === 'string'
                ? virtualContent
                : virtualContent.toString('utf-8');
              mtime = formatLocalDate(new Date());
            } else {
              // Disk file: read from filesystem
              const fsModule = await import('fs');
              const [fileContent, stat] = await Promise.all([
                fsModule.promises.readFile(file, 'utf-8'),
                fsModule.promises.stat(file)
              ]);
              content = fileContent;
              mtime = formatLocalDate(stat.mtime);
            }

            // Store content for ProjectParser
            codeContentMap.set(file, content);

            // Pre-compute file metadata
            const rawContentHash = createHash('sha256').update(content).digest('hex');
            fileMetadata.set(file, {
              rawContentHash,
              mtime,
              rawContent: getRawContentProp(content),
            });
          } catch (err) {
            console.warn(`Failed to read code file ${file}:`, err);
          }
        }))
      );

      // Parse all code files with ProjectParser (CPU-bound, uses worker threads)
      const projectParser = this.getProjectParser();
      const parseResult = await projectParser.parseProject({
        root: config.root || process.cwd(),
        files: Array.from(codeContentMap.keys()),
        contentMap: codeContentMap,
        resolveRelationships: false, // We'll handle relationships separately in buildGraph
      });

      // Store results - ProjectParser returns ScopeFileAnalysis directly
      for (const [filePath, analysis] of parseResult.files) {
        codeFiles.set(filePath, analysis);
        filesProcessed++;
        onProgress(filePath);
      }

      // Log any errors
      if (parseResult.errors.length > 0) {
        console.warn(`⚠️ ${parseResult.errors.length} code files failed to parse:`);
        parseResult.errors.slice(0, 5).forEach(e => console.warn(`  - ${e.file}: ${e.error}`));
      }

      console.log(`✅ Code parsing complete: ${parseResult.stats.successfulFiles}/${parseResult.stats.totalFiles} files, ${parseResult.stats.totalScopes} scopes in ${parseResult.stats.parseTimeMs}ms`);
    }

    // ========================================================================
    // PHASE 2: Parse OTHER files with NonCodeProjectParser (true parallelism)
    // ========================================================================
    if (otherFiles.length > 0) {
      console.log(`🚀 Starting parallel parsing of ${otherFiles.length} non-code files with worker threads...`);

      // Separate files by type: binary (documents, media), text-parsable (md, css, html, vue, svelte), other (data, pkg.json)
      const binaryFiles: string[] = [];
      const nonCodeParsableFiles: string[] = [];
      const otherTextFiles: string[] = [];

      for (const file of otherFiles) {
        if (isDocumentFile(file) || isMediaFile(file)) {
          binaryFiles.push(file);
        } else if (isNonCodeParserSupported(file)) {
          nonCodeParsableFiles.push(file);
        } else {
          otherTextFiles.push(file);
        }
      }

      console.log(`   📊 Non-code breakdown: ${binaryFiles.length} binary, ${nonCodeParsableFiles.length} parsable, ${otherTextFiles.length} other`);

      // Map to store document markdown content (to be passed to markdown parser)
      const documentMarkdownMap = new Map<string, string>();

      // PHASE 2a: Process binary files (documents, media) with pLimit
      // Documents are converted to markdown and will be parsed by the standard markdown parser
      if (binaryFiles.length > 0) {
        await Promise.all(
          binaryFiles.map(file => limit(async () => {
            try {
              if (isDocumentFile(file)) {
                const format = getDocumentFormat(file);

                if (format === 'pdf' && parserOptions?.enableVision && parserOptions?.visionAnalyzer) {
                  // Use Vision-enhanced parsing for PDFs with images
                  const result = await parsePdfWithVision(file, {
                    visionAnalyzer: parserOptions.visionAnalyzer,
                    maxPages: parserOptions.maxPages,
                    sectionTitles: 'detect',
                    outputFormat: 'markdown',
                  });

                  // Store pageNum mapping for each section
                  const pageNumMap = new Map<number, number>();
                  for (const section of result.sections) {
                    pageNumMap.set(section.startLine, section.pageNum);
                  }
                  documentPageNumMap.set(file, pageNumMap);

                  // Store document metadata
                  documentMetadata.set(file, {
                    sourceFormat: 'pdf',
                    pageCount: result.pagesProcessed,
                    parsedWith: 'vision',
                  });

                  // Store markdown content to be parsed by standard markdown parser
                  documentMarkdownMap.set(file, result.content);

                } else {
                  // Basic text extraction (PDF, DOCX, etc.)
                  const docInfo = await parseDocumentFile(file, {
                    extractText: true,
                    useOcr: true,
                    visionAnalyzer: parserOptions?.visionAnalyzer,
                    analyzeImages: parserOptions?.enableVision,
                    extractImages: parserOptions?.enableVision,
                    maxOcrPages: parserOptions?.maxPages,
                  });

                  if (docInfo && docInfo.textContent) {
                    // Convert to simple markdown format
                    let markdownContent = '';
                    const fileName = path.basename(file);

                    // Add frontmatter
                    markdownContent += '---\n';
                    markdownContent += `sourceFormat: "${docInfo.format}"\n`;
                    markdownContent += `originalFileName: "${fileName}"\n`;
                    if (docInfo.pageCount) markdownContent += `pageCount: ${docInfo.pageCount}\n`;
                    markdownContent += '---\n\n';
                    markdownContent += `# ${fileName}\n\n`;
                    markdownContent += docInfo.textContent;

                    // For non-Vision parsing, we don't have per-section pageNum
                    // Just store basic metadata
                    documentMetadata.set(file, {
                      sourceFormat: docInfo.format,
                      pageCount: docInfo.pageCount,
                      parsedWith: 'text',
                    });

                    documentMarkdownMap.set(file, markdownContent);
                  } else {
                    // No text content could be extracted - skip this document
                    console.warn(`[CodeSourceAdapter] Document ${file} has no extractable text content, skipping`);
                  }
                }
              } else if (isMediaFile(file)) {
                // Map parserOptions to parseMediaFile options
                const mediaInfo = await parseMediaFile(file, {
                  enableVision: parserOptions?.enableVision,
                  visionAnalyzer: parserOptions?.visionAnalyzer,
                  render3D: parserOptions?.render3D,
                });
                if (mediaInfo) mediaFiles.set(file, mediaInfo);
              }
              filesProcessed++;
              onProgress(file);
            } catch (err) {
              console.warn(`Failed to parse binary file ${file}:`, err);
            }
          }))
        );
      }

      // PHASE 2b: Read and parse non-code parsable files with NonCodeProjectParser
      // Also includes document files converted to markdown in PHASE 2a
      if (nonCodeParsableFiles.length > 0 || documentMarkdownMap.size > 0) {
        // Read all non-code parsable files and compute metadata
        const nonCodeContentMap = new Map<string, string>();
        await Promise.all(
          nonCodeParsableFiles.map(file => limit(async () => {
            try {
              let content: string;
              let mtime: string;

              if (contentMap && contentMap.has(file)) {
                const virtualContent = contentMap.get(file)!;
                content = typeof virtualContent === 'string'
                  ? virtualContent
                  : virtualContent.toString('utf-8');
                mtime = formatLocalDate(new Date());
              } else {
                const fsModule = await import('fs');
                const [fileContent, stat] = await Promise.all([
                  fsModule.promises.readFile(file, 'utf-8'),
                  fsModule.promises.stat(file)
                ]);
                content = fileContent;
                mtime = formatLocalDate(stat.mtime);
              }

              nonCodeContentMap.set(file, content);

              const rawContentHash = createHash('sha256').update(content).digest('hex');
              fileMetadata.set(file, {
                rawContentHash,
                mtime,
                rawContent: getRawContentProp(content),
              });
            } catch (err) {
              console.warn(`Failed to read non-code file ${file}:`, err);
            }
          }))
        );

        // Add document markdown content to be parsed as markdown files
        // These documents (PDF, DOCX) were converted to markdown in PHASE 2a
        for (const [docPath, markdownContent] of documentMarkdownMap) {
          nonCodeContentMap.set(docPath, markdownContent);

          // Compute metadata for the markdown content
          const rawContentHash = createHash('sha256').update(markdownContent).digest('hex');
          const mtime = formatLocalDate(new Date());
          fileMetadata.set(docPath, {
            rawContentHash,
            mtime,
            rawContent: getRawContentProp(markdownContent),
          });
        }

        // Parse all non-code files with NonCodeProjectParser (uses worker threads)
        const nonCodeParser = this.getNonCodeProjectParser();
        const parseInputs = Array.from(nonCodeContentMap.entries()).map(([filePath, content]) => ({
          path: filePath,
          content,
          // Treat document files as markdown (they were converted in PHASE 2a)
          options: (this.isMarkdownFile(filePath) || documentMarkdownMap.has(filePath)) ? { parseCodeBlocks: false } : {},
        }));

        const nonCodeResult = await nonCodeParser.parseFiles({ files: parseInputs });

        // Store results
        for (const [filePath, result] of nonCodeResult.markdownFiles) {
          markdownFiles.set(filePath, result);
          filesProcessed++;
          onProgress(filePath);
        }
        for (const [filePath, result] of nonCodeResult.cssFiles) {
          cssFiles.set(filePath, result);
          filesProcessed++;
          onProgress(filePath);
        }
        for (const [filePath, result] of nonCodeResult.scssFiles) {
          scssFiles.set(filePath, result);
          filesProcessed++;
          onProgress(filePath);
        }
        for (const [filePath, result] of nonCodeResult.htmlFiles) {
          htmlFiles.set(filePath, result);
          filesProcessed++;
          onProgress(filePath);
        }
        for (const [filePath, result] of nonCodeResult.vueFiles) {
          vueFiles.set(filePath, result);
          filesProcessed++;
          onProgress(filePath);
        }
        for (const [filePath, result] of nonCodeResult.svelteFiles) {
          svelteFiles.set(filePath, result);
          filesProcessed++;
          onProgress(filePath);
        }
        for (const [filePath, result] of nonCodeResult.genericFiles) {
          genericFiles.set(filePath, result);
          filesProcessed++;
          onProgress(filePath);
        }

        if (nonCodeResult.errors.length > 0) {
          console.warn(`⚠️ ${nonCodeResult.errors.length} non-code files failed to parse:`);
          nonCodeResult.errors.slice(0, 5).forEach(e => console.warn(`  - ${e.file}: ${e.error}`));
        }

        console.log(`✅ Non-code parsing complete: ${nonCodeResult.stats.successfulFiles}/${nonCodeResult.stats.totalFiles} files in ${nonCodeResult.stats.parseTimeMs}ms`);
      }

      // PHASE 2c: Process other text files (package.json, data files) with pLimit
      if (otherTextFiles.length > 0) {
        await Promise.all(
          otherTextFiles.map(file => limit(async () => {
            try {
              let content: string;
              let mtime: string;

              if (contentMap && contentMap.has(file)) {
                const virtualContent = contentMap.get(file)!;
                content = typeof virtualContent === 'string'
                  ? virtualContent
                  : virtualContent.toString('utf-8');
                mtime = formatLocalDate(new Date());
              } else {
                const fsModule = await import('fs');
                const [fileContent, stat] = await Promise.all([
                  fsModule.promises.readFile(file, 'utf-8'),
                  fsModule.promises.stat(file)
                ]);
                content = fileContent;
                mtime = formatLocalDate(stat.mtime);
              }

              const rawContentHash = createHash('sha256').update(content).digest('hex');
              fileMetadata.set(file, {
                rawContentHash,
                mtime,
                rawContent: getRawContentProp(content),
              });

              // Handle package.json
              if (this.isPackageJson(file)) {
                const pkgInfo = this.parsePackageJson(content, file);
                if (pkgInfo) packageJsonFiles.set(file, pkgInfo);
              }
              // Handle data files (JSON, YAML, XML, TOML, ENV)
              else if (isDataFile(file)) {
                const dataInfo = parseDataFile(file, content);
                dataFiles.set(file, dataInfo);
              }
              // Fallback: GenericCodeParser
              else {
                const genericParser = await this.getGenericParser();
                const genericResult = await genericParser.parseFile(file, content);
                genericFiles.set(file, genericResult);
              }

              filesProcessed++;
              onProgress(file);
            } catch (err) {
              console.warn(`Failed to process file ${file}:`, err);
            }
          }))
        );
      }

      console.log(`✅ All non-code files processed. Total: ${filesProcessed}/${files.length}`);
    }

    return { codeFiles, htmlFiles, cssFiles, scssFiles, vueFiles, svelteFiles, markdownFiles, genericFiles, packageJsonFiles, dataFiles, mediaFiles, documentFiles, fileMetadata, documentPageNumMap, documentMetadata };
  }

  /**
   * Detect project information (git remote, name, etc.)
   */
  private async detectProjectInfo(projectPath: string): Promise<{
    name: string;
    gitRemote: string | null;
    rootPath: string;
  }> {
    const rootPath = projectPath;
    let gitRemote: string | null = null;

    // Try to get git remote
    try {
      const { stdout } = await execAsync('git remote get-url origin', { cwd: rootPath });
      gitRemote = stdout.trim();
    } catch {
      // Not a git repo or no origin
    }

    // Extract project name from git remote or use directory name
    let name: string;
    if (gitRemote) {
      // Extract from git remote: git@github.com:user/repo.git -> repo
      const match = gitRemote.match(/[\/:]([^\/]+?)(?:\.git)?$/);
      name = match ? match[1] : getLastSegment(gitRemote);
    } else {
      // Use directory name
      name = getLastSegment(rootPath);
    }

    return { name, gitRemote, rootPath };
  }

  /**
   * Build Neo4j graph structure from parsed files
   */
  private async buildGraph(
    parsedFiles: {
      codeFiles: Map<string, ScopeFileAnalysis>;
      htmlFiles: Map<string, HTMLParseResult>;
      cssFiles: Map<string, CSSParseResult>;
      scssFiles: Map<string, SCSSParseResult>;
      vueFiles: Map<string, VueSFCParseResult>;
      svelteFiles: Map<string, SvelteParseResult>;
      markdownFiles: Map<string, MarkdownParseResult>;
      genericFiles: Map<string, GenericFileAnalysis>;
      packageJsonFiles: Map<string, PackageJsonInfo>;
      dataFiles: Map<string, DataFileInfo>;
      mediaFiles: Map<string, MediaFileInfo>;
      documentFiles: Map<string, DocumentFileInfo>;
      fileMetadata: Map<string, { rawContentHash: string; mtime: string; rawContent?: string }>;
      /** Maps document file paths to their section pageNum mapping (startLine → pageNum) */
      documentPageNumMap: Map<string, Map<number, number>>;
      /** Document metadata (sourceFormat, pageCount, etc.) for files converted to markdown */
      documentMetadata: Map<string, { sourceFormat: string; pageCount?: number; parsedWith?: string }>;
    },
    config: CodeSourceConfig,
    resolver: ImportResolver,
    projectInfo: { name: string; gitRemote: string | null; rootPath: string },
    generatedProjectId: string,
    existingUUIDMapping?: Map<string, Array<{ uuid: string; file: string; type: string }>>
  ): Promise<ParsedGraph> {
    const {
      codeFiles,
      htmlFiles,
      cssFiles,
      scssFiles,
      vueFiles,
      svelteFiles,
      markdownFiles,
      genericFiles,
      packageJsonFiles,
      dataFiles,
      mediaFiles,
      documentFiles,
      fileMetadata,
      documentPageNumMap,
      documentMetadata,
    } = parsedFiles;
    const nodes: ParsedNode[] = [];
    const relationships: ParsedRelationship[] = [];
    const scopeMap = new Map<string, ScopeInfo>(); // uuid -> ScopeInfo

    // Log progress: building graph
    const totalFiles = codeFiles.size + htmlFiles.size + cssFiles.size + scssFiles.size +
      vueFiles.size + svelteFiles.size + markdownFiles.size + genericFiles.size +
      dataFiles.size + mediaFiles.size + documentFiles.size;
    console.log(`🔨 Building graph for ${totalFiles} files...`);

    // Create Project node using the generated projectId
    // This ensures consistency: Project node uuid = projectId used by all other nodes
    // Skip for 'touched-files' - orphan files don't need a Project node
    const projectId = generatedProjectId; // Use generated projectId consistently
    if (projectId !== 'touched-files') {
      nodes.push({
        labels: ['Project'],
        id: projectId,
        properties: {
          uuid: projectId, // Use generated projectId as uuid for consistency
          projectId: projectId, // Also set projectId explicitly
          name: projectInfo.name,
          gitRemote: projectInfo.gitRemote || null,
          rootPath: projectInfo.rootPath,
          indexedAt: getLocalTimestamp()
        }
      });
    }

    // Create PackageJson nodes
    const projectRoot = config.root || process.cwd();
    for (const [filePath, pkgInfo] of packageJsonFiles) {
      const relPath = path.relative(projectRoot, filePath);
      const pkgId = UniqueIDHelper.GeneratePackageJsonUUID(filePath);

      nodes.push({
        labels: ['PackageJson'],
        id: pkgId,
        properties: {
          uuid: pkgId,
          file: relPath,
          absolutePath: filePath,
          name: pkgInfo.name,
          version: pkgInfo.version,
          description: pkgInfo.description || null,
          dependencies: pkgInfo.dependencies,
          devDependencies: pkgInfo.devDependencies,
          peerDependencies: pkgInfo.peerDependencies,
          scripts: pkgInfo.scripts,
          main: pkgInfo.main || null,
          moduleType: pkgInfo.type || null,
          hash: createHash('sha256').update(JSON.stringify(pkgInfo.raw)).digest('hex').slice(0, 16),
          indexedAt: getLocalTimestamp()
        }
      });

      // Link to Project
      relationships.push({
        type: 'PACKAGE_OF',
        from: pkgId,
        to: projectId,
        properties: {}
      });

      // Create File node for package.json (needed for incremental hash tracking)
      const fileName = path.basename(filePath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash, mtime, rawContent } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension: '.json',
          ...(rawContentHash && { rawContentHash }),
          ...(mtime && { mtime }),
          ...(rawContent && { _rawContent: rawContent }),
        }
      });

      // Create BELONGS_TO relationship (File -> Project)
      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      // Create DEFINED_IN relationship (PackageJson -> File)
      relationships.push({
        type: 'DEFINED_IN',
        from: pkgId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });
    }

    // Store existingUUIDMapping for UUID preservation during re-ingestion
    // This MUST be set BEFORE buildGlobalUUIDMapping to ensure generateUUID uses it
    this.existingUUIDMapping = existingUUIDMapping;

    // Build global UUID mapping first (needed for parentUUID)
    const globalUUIDMapping = this.buildGlobalUUIDMapping(codeFiles);

    // Merge with existingUUIDMapping from database (for cross-file import resolution)
    if (existingUUIDMapping) {
      for (const [name, candidates] of existingUUIDMapping) {
        const existing = globalUUIDMapping.get(name) || [];
        // Add existing DB candidates that aren't already in the mapping
        for (const candidate of candidates) {
          const isDuplicate = existing.some(e => e.uuid === candidate.uuid);
          if (!isDuplicate) {
            existing.push(candidate);
          }
        }
        if (existing.length > 0) {
          globalUUIDMapping.set(name, existing);
        }
      }
    }

    // First pass: Create all scope nodes from code files
    if (codeFiles.size > 0) {
      const totalScopes = Array.from(codeFiles.values()).reduce((sum, a) => sum + a.scopes.length, 0);
      console.log(`   📝 Processing ${codeFiles.size} code files (${totalScopes} scopes)...`);
    }
    let codeFilesProcessed = 0;
    for (const [filePath, analysis] of codeFiles) {
      // Calculate relative path from project root
      const relPath = path.relative(projectRoot, filePath);

      for (const scope of analysis.scopes) {
        const uuid = this.generateUUID(scope, filePath);
        scopeMap.set(uuid, scope);

        // Find parent UUID if this scope has a parent
        const parentUuid = scope.parent
          ? this.findParentUUID(scope, filePath, globalUUIDMapping)
          : undefined;

        // Extract TypeScript-specific metadata (Phase 3)
        const tsMetadata = (scope as any).languageSpecific?.typescript;

        // Build raw properties - createNodeFromRegistry will normalize to _name, _content, _description
        const rawProps: Record<string, unknown> = {
          uuid,
          name: scope.name,
          type: scope.type,
          file: relPath,
          absolutePath: filePath,
          language: config.adapter,
          startLine: scope.startLine,
          endLine: scope.endLine,
          linesOfCode: scope.linesOfCode || (scope.endLine - scope.startLine + 1),
          // Raw content fields - will be extracted to _content/_description then removed
          source: scope.content || '',
          signature: this.extractSignature(scope),
          hash: this.hashScope(scope),
          // Additional properties from ScopeInfo
          ...(scope.returnType && { returnType: scope.returnType }),
          ...(scope.parameters && scope.parameters.length > 0 && {
            parameters: JSON.stringify(scope.parameters)
          }),
          ...(scope.parent && { parent: scope.parent }),
          ...(parentUuid && { parentUUID: parentUuid }),
          ...(scope.depth !== undefined && { depth: scope.depth }),
          ...(scope.modifiers && scope.modifiers.length > 0 && {
            modifiers: scope.modifiers.join(',')
          }),
          ...(scope.complexity !== undefined && { complexity: scope.complexity }),
          // Phase 3: Heritage clauses (extends/implements)
          ...(tsMetadata?.heritageClauses && tsMetadata.heritageClauses.length > 0 && {
            heritageClauses: JSON.stringify(tsMetadata.heritageClauses),
            extends: tsMetadata.heritageClauses
              .filter((c: any) => c.clause === 'extends')
              .flatMap((c: any) => c.types)
              .join(','),
            implements: tsMetadata.heritageClauses
              .filter((c: any) => c.clause === 'implements')
              .flatMap((c: any) => c.types)
              .join(',')
          }),
          // Phase 3: Generic parameters
          ...(tsMetadata?.genericParameters && tsMetadata.genericParameters.length > 0 && {
            genericParameters: JSON.stringify(tsMetadata.genericParameters),
            generics: tsMetadata.genericParameters.map((g: any) => g.name).join(',')
          }),
          // Phase 3: Decorators (TypeScript)
          ...(tsMetadata?.decoratorDetails && tsMetadata.decoratorDetails.length > 0 && {
            decoratorDetails: JSON.stringify(tsMetadata.decoratorDetails),
            decorators: tsMetadata.decoratorDetails.map((d: any) => d.name).join(',')
          }),
          // Phase 3: Enum members
          ...(tsMetadata?.enumMembers && tsMetadata.enumMembers.length > 0 && {
            enumMembers: JSON.stringify(tsMetadata.enumMembers)
          }),
          // Python-specific
          ...((scope as any).decorators && (scope as any).decorators.length > 0 && {
            decorators: (scope as any).decorators.join(',')
          }),
          ...((scope as any).docstring && { docstring: (scope as any).docstring }),
          // For constants/variables
          ...(scope.value && { value: scope.value })
        };

        // Create node with normalized properties (_name, _content, _description)
        // Raw content fields (source, docstring) are removed automatically
        nodes.push(createNodeFromRegistry('Scope', uuid, rawProps));

        // Create HAS_PARENT relationship if parent exists
        if (parentUuid) {
          relationships.push({
            type: 'HAS_PARENT',
            from: uuid,
            to: parentUuid
          });
        }

        // Create BELONGS_TO relationship (Scope -> Project)
        relationships.push({
          type: 'BELONGS_TO',
          from: uuid,
          to: projectId
        });
      }

      // Enrich class/interface nodes with their members summary
      // This helps search find classes when searching for method names
      this.enrichClassNodesWithMembers(nodes, analysis.scopes, filePath);

      // Create File node with full metadata (using relative paths)
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';

      // Calculate content hash (SHA-256 of parsed scopes - for detecting semantic changes)
      const contentHash = createHash('sha256').update(analysis.scopes.map(s => s.content || '').join('')).digest('hex');

      // Use pre-computed file metadata (computed during parallel parsing)
      const { rawContentHash, mtime, rawContent } = fileMetadata.get(filePath) || {};

      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid, // Required for relationship matching
          path: relPath,
          name: fileName,
          directory,
          extension,
          contentHash,
          ...(rawContentHash && { rawContentHash }),
          ...(mtime && { mtime }),
          ...(rawContent && { _rawContent: rawContent }),
          ...(analysis.totalLines && { lineCount: analysis.totalLines }),
        }
      });

      // Create BELONGS_TO relationship (File -> Project)
      relationships.push({
        type: 'BELONGS_TO',
        from: UniqueIDHelper.GenerateFileUUID(filePath),
        to: projectId
      });

      // Create DEFINED_IN relationships
      const fileUuidForScope = UniqueIDHelper.GenerateFileUUID(filePath);
      for (const scope of analysis.scopes) {
        const uuid = this.generateUUID(scope, filePath);
        relationships.push({
          type: 'DEFINED_IN',
          from: uuid,
          to: fileUuidForScope,
          targetLabel: 'File',
          targetProps: {
            _name: path.basename(filePath),
            absolutePath: filePath,
            path: relPath,
          }
        });
      }

      // Log progress every 500 files
      codeFilesProcessed++;
      if (codeFilesProcessed % 500 === 0) {
        console.log(`   ⏳ Processed ${codeFilesProcessed}/${codeFiles.size} code files...`);
      }
    }

    // Create Directory nodes and relationships (using relative paths)
    const directories = new Set<string>();

    // Extract all unique directories from file paths (using relative paths)
    for (const [filePath] of codeFiles) {
      const relPath = path.relative(projectRoot, filePath);
      let currentPath = relPath;

      while (true) {
        const dir = currentPath.includes('/') ? currentPath.substring(0, currentPath.lastIndexOf('/')) : '';
        if (!dir || dir === '.' || dir === '') break;

        directories.add(dir);

        // Create IN_DIRECTORY relationship (File -> Directory)
        if (currentPath === relPath) {
          const absDirPath = path.join(projectRoot, dir);
          const dirName = dir.includes('/') ? dir.substring(dir.lastIndexOf('/') + 1) : dir;
          relationships.push({
            type: 'IN_DIRECTORY',
            from: UniqueIDHelper.GenerateFileUUID(filePath),
            to: UniqueIDHelper.GenerateDirectoryUUID(absDirPath),
            targetLabel: 'Directory',
            targetProps: {
              _name: dirName,
              absolutePath: absDirPath,
              path: dir,
            }
          });
        }

        currentPath = dir;
      }
    }

    // Create Directory nodes
    for (const dir of directories) {
      const depth = getPathDepth(dir);
      const absDirPath = path.join(projectRoot, dir);
      const dirUuid = UniqueIDHelper.GenerateDirectoryUUID(absDirPath);
      nodes.push({
        labels: ['Directory'],
        id: dirUuid,
        properties: {
          uuid: dirUuid,
          path: dir,  // Keep relative for display
          absolutePath: absDirPath,
          depth
        }
      });
    }

    // Create PARENT_OF relationships (Directory -> Directory)
    for (const dir of directories) {
      const parentDir = dir.includes('/') ? dir.substring(0, dir.lastIndexOf('/')) : '';
      if (parentDir && parentDir !== '.' && parentDir !== '' && directories.has(parentDir)) {
        const absParentPath = path.join(projectRoot, parentDir);
        const absDirPath = path.join(projectRoot, dir);
        const dirName = dir.includes('/') ? dir.substring(dir.lastIndexOf('/') + 1) : dir;
        relationships.push({
          type: 'PARENT_OF',
          from: UniqueIDHelper.GenerateDirectoryUUID(absParentPath),
          to: UniqueIDHelper.GenerateDirectoryUUID(absDirPath),
          targetLabel: 'Directory',
          targetProps: {
            _name: dirName,
            absolutePath: absDirPath,
            path: dir,
          }
        });
      }
    }

    // Second pass: Create scope relationships using codeparsers' RelationshipResolver
    // This handles CONSUMES, INHERITS_FROM, IMPLEMENTS, DECORATED_BY for all languages
    console.log(`   🔗 Building scope relationships with RelationshipResolver...`);
    const scopeRelationships = await this.buildScopeRelationshipsWithResolver(
      codeFiles,
      projectRoot,
      scopeMap
    );
    relationships.push(...scopeRelationships);

    // Create ExternalLibrary nodes and USES_LIBRARY relationships
    console.log(`   📦 Processing external library references...`);
    const externalLibs = new Map<string, Set<string>>(); // library name -> symbols

    for (const [filePath, analysis] of codeFiles) {
      for (const scope of analysis.scopes) {
        const sourceUuid = this.generateUUID(scope, filePath);

        // Extract external imports (isLocal === false)
        if (scope.importReferences && Array.isArray(scope.importReferences)) {
          for (const imp of scope.importReferences.filter(i => !i.isLocal)) {
            // Track library and its symbols
            if (!externalLibs.has(imp.source)) {
              externalLibs.set(imp.source, new Set());
            }
            externalLibs.get(imp.source)!.add(imp.imported);

            // Create USES_LIBRARY relationship
            relationships.push({
              type: 'USES_LIBRARY',
              from: sourceUuid,
              to: UniqueIDHelper.GenerateExternalLibraryUUID(imp.source),
              properties: {
                symbol: imp.imported
              },
              targetLabel: 'ExternalLibrary',
              targetProps: {
                _name: imp.source,
                name: imp.source,
              }
            });
          }
        }
      }
    }

    // Create ExternalLibrary nodes
    for (const [libName] of externalLibs) {
      const libId = UniqueIDHelper.GenerateExternalLibraryUUID(libName);
      nodes.push({
        labels: ['ExternalLibrary'],
        id: libId,
        properties: {
          uuid: libId,
          name: libName
        }
      });
    }

    // Create WebDocument nodes for HTML/Vue/Svelte files
    // (Document is reserved for Tika, MarkdownDocument for Markdown)
    const webFileCount = htmlFiles.size + vueFiles.size + svelteFiles.size;
    if (webFileCount > 0) {
      console.log(`   🌐 Processing ${webFileCount} web documents (HTML/Vue/Svelte)...`);
    }
    for (const [filePath, htmlResult] of htmlFiles) {
      const relPath = path.relative(projectRoot, filePath);
      const doc = htmlResult.document;

      // Create WebDocument node
      const docId = UniqueIDHelper.GenerateWebDocumentUUID(filePath);
      nodes.push({
        labels: ['WebDocument'],
        id: docId,
        properties: {
          uuid: docId,
          file: relPath,
          absolutePath: filePath,
          type: doc.type, // 'html' | 'vue-sfc' | 'svelte' | 'astro'
          hash: doc.hash,
          hasTemplate: doc.hasTemplate,
          hasScript: doc.hasScript,
          hasStyle: doc.hasStyle,
          ...(doc.componentName && { componentName: doc.componentName }),
          ...(doc.scriptLang && { scriptLang: doc.scriptLang }),
          ...(doc.isScriptSetup !== undefined && { isScriptSetup: doc.isScriptSetup }),
          ...(doc.imports.length > 0 && { imports: JSON.stringify(doc.imports) }),
          ...(doc.usedComponents.length > 0 && { usedComponents: JSON.stringify(doc.usedComponents) }),
          ...(doc.images.length > 0 && { imageCount: doc.images.length })
        }
      });

      // Create BELONGS_TO relationship (WebDocument -> Project)
      relationships.push({
        type: 'BELONGS_TO',
        from: docId,
        to: projectId
      });

      // Create File node for HTML file
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash, mtime, rawContent } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: doc.hash,
          ...(rawContentHash && { rawContentHash }),
          ...(mtime && { mtime }),
          ...(rawContent && { _rawContent: rawContent }),
        }
      });

      // Create BELONGS_TO relationship (File -> Project)
      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      // Create DEFINED_IN relationship (WebDocument -> File)
      relationships.push({
        type: 'DEFINED_IN',
        from: docId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      // Create Image nodes and relationships
      for (const img of doc.images) {
        const imgId = UniqueIDHelper.GenerateImageUUID(filePath, img.line);
        nodes.push({
          labels: ['Image'],
          id: imgId,
          properties: {
            uuid: imgId,
            src: img.src,
            alt: img.alt || null,
            line: img.line
          }
        });

        // Create HAS_IMAGE relationship (WebDocument -> Image)
        relationships.push({
          type: 'HAS_IMAGE',
          from: docId,
          to: imgId
        });
      }

      // Add directory to set for HTML files too
      let currentPath = relPath;
      while (true) {
        const dir = currentPath.includes('/') ? currentPath.substring(0, currentPath.lastIndexOf('/')) : '';
        if (!dir || dir === '.' || dir === '') break;

        if (!directories.has(dir)) {
          directories.add(dir);
          const depth = getPathDepth(dir);
          const absDirPath = path.join(projectRoot, dir);
          const dirUuid = UniqueIDHelper.GenerateDirectoryUUID(absDirPath);
          nodes.push({
            labels: ['Directory'],
            id: dirUuid,
            properties: {
              uuid: dirUuid,
              path: dir,
              absolutePath: absDirPath,
              depth
            }
          });
        }

        // Create IN_DIRECTORY relationship (File -> Directory)
        if (currentPath === relPath) {
          const absDirPath = path.join(projectRoot, dir);
          const dirName = dir.includes('/') ? dir.substring(dir.lastIndexOf('/') + 1) : dir;
          relationships.push({
            type: 'IN_DIRECTORY',
            from: UniqueIDHelper.GenerateFileUUID(filePath),
            to: UniqueIDHelper.GenerateDirectoryUUID(absDirPath),
            targetLabel: 'Directory',
            targetProps: {
              _name: dirName,
              absolutePath: absDirPath,
              path: dir,
            }
          });
        }

        currentPath = dir;
      }

      // If HTML has embedded scripts that were parsed, create Scope nodes for them
      if (htmlResult.scopes && htmlResult.scopes.length > 0) {
        for (const scope of htmlResult.scopes) {
          const scopeUuid = this.generateUUID(scope, filePath);
          scopeMap.set(scopeUuid, scope);

          nodes.push({
            labels: ['Scope'],
            id: scopeUuid,
            properties: {
              uuid: scopeUuid,
              name: scope.name,
              type: scope.type,
              file: relPath,
              absolutePath: filePath,
              language: 'typescript', // Embedded scripts are typically TS/JS
              startLine: scope.startLine,
              endLine: scope.endLine,
              linesOfCode: scope.linesOfCode || (scope.endLine - scope.startLine + 1),
              source: scope.content || '',
              signature: this.extractSignature(scope),
              hash: this.hashScope(scope),
              ...(scope.returnType && { returnType: scope.returnType }),
              ...(scope.parameters && scope.parameters.length > 0 && {
                parameters: JSON.stringify(scope.parameters)
              }),
              ...(scope.parent && { parent: scope.parent })
            }
          });

          // Create BELONGS_TO relationship (Scope -> Project)
          relationships.push({
            type: 'BELONGS_TO',
            from: scopeUuid,
            to: projectId
          });

          // Create DEFINED_IN relationship (Scope -> File)
          relationships.push({
            type: 'DEFINED_IN',
            from: scopeUuid,
            to: fileUuid,
            targetLabel: 'File',
            targetProps: {
              _name: fileName,
              absolutePath: filePath,
              path: relPath,
            }
          });

          // Create SCRIPT_OF relationship (Scope -> WebDocument)
          relationships.push({
            type: 'SCRIPT_OF',
            from: scopeUuid,
            to: docId
          });
        }
      }
    }

    // Create Stylesheet nodes for CSS files
    for (const [filePath, cssResult] of cssFiles) {
      const relPath = path.relative(projectRoot, filePath);
      const stylesheet = cssResult.stylesheet;

      // Create Stylesheet node
      const stylesheetId = UniqueIDHelper.GenerateStylesheetUUID(filePath);
      nodes.push({
        labels: ['Stylesheet'],
        id: stylesheetId,
        properties: {
          uuid: stylesheetId,
          file: relPath,
          absolutePath: filePath,
          hash: stylesheet.hash,
          linesOfCode: stylesheet.linesOfCode,
          ruleCount: stylesheet.ruleCount,
          selectorCount: stylesheet.selectorCount,
          propertyCount: stylesheet.propertyCount,
          variableCount: stylesheet.variables.length,
          importCount: stylesheet.imports.length,
          fontFaceCount: stylesheet.fontFaceCount,
          keyframeNames: stylesheet.keyframeNames.length > 0 ? JSON.stringify(stylesheet.keyframeNames) : null,
          mediaQueries: stylesheet.mediaQueries.length > 0 ? JSON.stringify(stylesheet.mediaQueries) : null,
          indexedAt: getLocalTimestamp()
        }
      });

      // Create BELONGS_TO relationship (Stylesheet -> Project)
      relationships.push({
        type: 'BELONGS_TO',
        from: stylesheetId,
        to: projectId
      });

      // Create File node for CSS file
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash, mtime, rawContent } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: stylesheet.hash,
          ...(rawContentHash && { rawContentHash }),
          ...(mtime && { mtime }),
          ...(rawContent && { _rawContent: rawContent }),
        }
      });

      // Create BELONGS_TO relationship (File -> Project)
      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      // Create DEFINED_IN relationship (Stylesheet -> File)
      relationships.push({
        type: 'DEFINED_IN',
        from: stylesheetId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      // Create IMPORTS relationships for @import
      for (const importUrl of stylesheet.imports) {
        // Determine import type: HTTP URL, local file path, or npm package
        const isHttpUrl = importUrl.startsWith('http://') || importUrl.startsWith('https://');
        const isLocal = isLocalPath(importUrl); // handles ./relative, ../parent, /absolute, C:\windows

        let importUuid: string;
        let targetLabel: string;
        let targetProps: { _name: string; [key: string]: unknown };

        if (isHttpUrl) {
          // External URL (CDN, etc.)
          importUuid = UniqueIDHelper.GenerateExternalURLUUID(importUrl);
          targetLabel = 'ExternalURL';
          targetProps = { _name: importUrl, url: importUrl };
        } else if (isLocal) {
          // Local file (relative or absolute path)
          importUuid = UniqueIDHelper.GenerateFileUUID(path.resolve(path.dirname(filePath), importUrl));
          targetLabel = 'File';
          targetProps = { _name: path.basename(importUrl), path: importUrl };
        } else {
          // npm package (e.g., "tailwindcss", "@tailwind/forms")
          importUuid = UniqueIDHelper.GenerateExternalLibraryUUID(importUrl);
          targetLabel = 'ExternalLibrary';
          targetProps = { _name: importUrl, library: importUrl };
        }

        relationships.push({
          type: 'IMPORTS',
          from: stylesheetId,
          to: importUuid,
          properties: { originalUrl: importUrl },
          targetLabel,
          targetProps,
        });
      }

      // Create CSSVariable nodes
      for (const variable of stylesheet.variables) {
        const varId = UniqueIDHelper.GenerateCSSVariableUUID(filePath, variable.name);
        nodes.push({
          labels: ['CSSVariable'],
          id: varId,
          properties: {
            uuid: varId,
            name: variable.name,
            value: variable.value,
            scope: variable.scope,
            line: variable.line
          }
        });

        // Create DEFINES_VARIABLE relationship (Stylesheet -> CSSVariable)
        relationships.push({
          type: 'DEFINES_VARIABLE',
          from: stylesheetId,
          to: varId,
          targetLabel: 'CSSVariable',
          targetProps: {
            _name: variable.name,
            value: variable.value,
          }
        });
      }

      // Add directory to set for CSS files
      let currentPath = relPath;
      while (true) {
        const dir = currentPath.includes('/') ? currentPath.substring(0, currentPath.lastIndexOf('/')) : '';
        if (!dir || dir === '.' || dir === '') break;

        if (!directories.has(dir)) {
          directories.add(dir);
          const absDirPath = path.join(projectRoot, dir);
          const dirUuid = UniqueIDHelper.GenerateDirectoryUUID(absDirPath);
          const depth = getPathDepth(dir);
          nodes.push({
            labels: ['Directory'],
            id: dirUuid,
            properties: {
              uuid: dirUuid,
              path: dir,
              absolutePath: absDirPath,
              depth
            }
          });
        }

        if (currentPath === relPath) {
          const absDirPath = path.join(projectRoot, dir);
          const dirName = dir.includes('/') ? dir.substring(dir.lastIndexOf('/') + 1) : dir;
          relationships.push({
            type: 'IN_DIRECTORY',
            from: fileUuid,
            to: UniqueIDHelper.GenerateDirectoryUUID(absDirPath),
            targetLabel: 'Directory',
            targetProps: {
              _name: dirName,
              absolutePath: absDirPath,
              path: dir,
            }
          });
        }

        currentPath = dir;
      }
    }

    // Create Stylesheet nodes for SCSS files (similar to CSS)
    for (const [filePath, scssResult] of scssFiles) {
      const relPath = path.relative(projectRoot, filePath);
      const stylesheet = scssResult.stylesheet;

      // Create Stylesheet node (same label as CSS, but with scss type)
      const stylesheetId = UniqueIDHelper.GenerateStylesheetUUID(filePath);
      nodes.push({
        labels: ['Stylesheet'],
        id: stylesheetId,
        properties: {
          uuid: stylesheetId,
          file: relPath,
          absolutePath: filePath,
          type: 'scss',
          hash: stylesheet.hash,
          linesOfCode: stylesheet.linesOfCode,
          ruleCount: stylesheet.ruleCount,
          selectorCount: stylesheet.selectorCount,
          propertyCount: stylesheet.propertyCount,
          variableCount: stylesheet.variables.length,
          importCount: stylesheet.imports.length,
          mixinCount: stylesheet.mixins?.length ?? 0,
          functionCount: stylesheet.functions?.length ?? 0,
          indexedAt: getLocalTimestamp()
        }
      });

      // Create BELONGS_TO relationship (Stylesheet -> Project)
      relationships.push({
        type: 'BELONGS_TO',
        from: stylesheetId,
        to: projectId
      });

      // Create File node
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash: scssRawHash, mtime: scssMtime, rawContent: scssRawContent } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: stylesheet.hash,
          ...(scssRawHash && { rawContentHash: scssRawHash }),
          ...(scssMtime && { mtime: scssMtime }),
          ...(scssRawContent && { _rawContent: scssRawContent }),
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      relationships.push({
        type: 'DEFINED_IN',
        from: stylesheetId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      // Add directory handling
      this.ensureDirectoryNodes(relPath, directories, nodes, relationships, fileUuid, projectRoot);
    }

    // Create VueSFC nodes for Vue files
    for (const [filePath, vueResult] of vueFiles) {
      const relPath = path.relative(projectRoot, filePath);
      const sfc = vueResult.sfc; // Access nested VueSFCInfo

      const vueId = UniqueIDHelper.GenerateVueSFCUUID(filePath);
      nodes.push({
        labels: ['VueSFC'],
        id: vueId,
        properties: {
          uuid: vueId,
          file: relPath,
          absolutePath: filePath,
          componentName: sfc.componentName || path.basename(relPath, '.vue'),
          hash: sfc.hash,
          hasTemplate: sfc.hasTemplate,
          hasScript: sfc.hasScript,
          hasStyle: sfc.hasStyle,
          scriptLang: sfc.scriptLang || null,
          styleLang: sfc.styleLang || null,
          hasScriptSetup: sfc.hasScriptSetup || false,
          styleScoped: sfc.styleScoped || false,
          ...(sfc.props && sfc.props.length > 0 && { props: JSON.stringify(sfc.props) }),
          ...(sfc.emits && sfc.emits.length > 0 && { emits: JSON.stringify(sfc.emits) }),
          ...(sfc.componentUsages && sfc.componentUsages.length > 0 && { componentUsages: JSON.stringify(sfc.componentUsages) }),
          indexedAt: getLocalTimestamp()
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: vueId,
        to: projectId
      });

      // Create File node
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = '.vue';
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash: vueRawHash, mtime: vueMtime, rawContent: vueRawContent } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: sfc.hash,
          ...(vueRawHash && { rawContentHash: vueRawHash }),
          ...(vueMtime && { mtime: vueMtime }),
          ...(vueRawContent && { _rawContent: vueRawContent }),
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      relationships.push({
        type: 'DEFINED_IN',
        from: vueId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      // Add directory handling
      this.ensureDirectoryNodes(relPath, directories, nodes, relationships, fileUuid, projectRoot);

      // Note: Vue script scopes would require parsing the script block content
      // This could be added later by extracting script content from vueResult.blocks
    }

    // Create SvelteComponent nodes for Svelte files
    for (const [filePath, svelteResult] of svelteFiles) {
      const relPath = path.relative(projectRoot, filePath);
      const component = svelteResult.component; // Access nested SvelteComponentInfo

      const svelteId = UniqueIDHelper.GenerateSvelteComponentUUID(filePath);
      nodes.push({
        labels: ['SvelteComponent'],
        id: svelteId,
        properties: {
          uuid: svelteId,
          file: relPath,
          absolutePath: filePath,
          componentName: component.componentName || path.basename(relPath, '.svelte'),
          hash: component.hash,
          hasScript: component.hasScript,
          hasStyle: component.hasStyle,
          scriptLang: component.scriptLang || null,
          styleLang: component.styleLang || null,
          ...(component.props && component.props.length > 0 && { props: JSON.stringify(component.props) }),
          ...(component.componentUsages && component.componentUsages.length > 0 && { componentUsages: JSON.stringify(component.componentUsages) }),
          indexedAt: getLocalTimestamp()
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: svelteId,
        to: projectId
      });

      // Create File node
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = '.svelte';
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash: svelteRawHash, mtime: svelteMtime, rawContent: svelteRawContent } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: component.hash,
          ...(svelteRawHash && { rawContentHash: svelteRawHash }),
          ...(svelteMtime && { mtime: svelteMtime }),
          ...(svelteRawContent && { _rawContent: svelteRawContent }),
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      relationships.push({
        type: 'DEFINED_IN',
        from: svelteId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      this.ensureDirectoryNodes(relPath, directories, nodes, relationships, fileUuid, projectRoot);

      // Note: Svelte script scopes would require parsing the script block content
      // This could be added later by extracting script content from svelteResult.blocks
    }

    // Create MarkdownDocument nodes for Markdown files
    if (markdownFiles.size > 0) {
      console.log(`   📝 Processing ${markdownFiles.size} markdown documents...`);
    }
    for (const [filePath, mdResult] of markdownFiles) {
      const relPath = path.relative(projectRoot, filePath);
      const doc = mdResult.document;

      // Get document metadata if this is a converted document (PDF, DOCX → markdown)
      const docMeta = documentMetadata.get(filePath);
      const isConvertedDocument = !!docMeta;

      const mdId = UniqueIDHelper.GenerateMarkdownDocumentUUID(filePath);
      nodes.push({
        labels: isConvertedDocument
          ? ['MarkdownDocument', 'ConvertedDocument']  // Add label for documents converted to markdown
          : ['MarkdownDocument'],
        id: mdId,
        properties: {
          uuid: mdId,
          file: relPath,
          absolutePath: filePath,
          type: 'markdown',
          hash: doc.hash,
          title: doc.title || null,
          sectionCount: doc.sections?.length ?? 0,
          codeBlockCount: doc.codeBlocks?.length ?? 0,
          linkCount: doc.links?.length ?? 0,
          imageCount: doc.images?.length ?? 0,
          wordCount: doc.wordCount ?? 0,
          ...(doc.frontMatter && { frontMatter: JSON.stringify(doc.frontMatter) }),
          ...(doc.sections && doc.sections.length > 0 && { sections: JSON.stringify(doc.sections.map(s => ({ title: s.title, level: s.level, slug: s.slug }))) }),
          // Add document metadata for converted files (PDF, DOCX)
          ...(docMeta?.sourceFormat && { sourceFormat: docMeta.sourceFormat }),
          ...(docMeta?.pageCount && { pageCount: docMeta.pageCount }),
          ...(docMeta?.parsedWith && { parsedWith: docMeta.parsedWith }),
          indexedAt: getLocalTimestamp()
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: mdId,
        to: projectId
      });

      // Create File node
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash: mdRawHash, mtime: mdMtime, rawContent: mdRawContent } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: doc.hash,
          ...(mdRawHash && { rawContentHash: mdRawHash }),
          ...(mdMtime && { mtime: mdMtime }),
          ...(mdRawContent && { _rawContent: mdRawContent }),
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      relationships.push({
        type: 'DEFINED_IN',
        from: mdId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      this.ensureDirectoryNodes(relPath, directories, nodes, relationships, fileUuid, projectRoot);

      // Create CodeBlock nodes for embedded code
      if (doc.codeBlocks && doc.codeBlocks.length > 0) {
        for (let i = 0; i < doc.codeBlocks.length; i++) {
          const block = doc.codeBlocks[i];
          const blockId = UniqueIDHelper.GenerateCodeBlockUUID(filePath, block.startLine);
          // Compute hash from code for incremental ingestion
          const blockHash = createHash('sha256').update(block.code || '').digest('hex').slice(0, 16);

          // Build raw props - createNodeFromRegistry normalizes to _name, _content, _description
          const codeBlockProps: Record<string, unknown> = {
            uuid: blockId,
            projectId,
            file: relPath,
            absolutePath: filePath,
            language: block.language || 'text',
            code: block.code, // Will be extracted to _content then removed
            hash: blockHash,
            startLine: block.startLine,
            endLine: block.endLine,
            index: i
          };
          nodes.push(createNodeFromRegistry('CodeBlock', blockId, codeBlockProps));

          relationships.push({
            type: 'CONTAINS_CODE',
            from: mdId,
            to: blockId
          });

          // DEFINED_IN for orphan cleanup
          relationships.push({
            type: 'DEFINED_IN',
            from: blockId,
            to: fileUuid,
            targetLabel: 'File',
            targetProps: {
              _name: fileName,
              absolutePath: filePath,
              path: relPath,
            }
          });
        }
      }

      // Create MarkdownSection nodes for each section (searchable content)
      if (doc.sections && doc.sections.length > 0) {
        // Build stable section names with duplicate handling
        // Map from section (by startLine for lookup) to its stable name
        const sectionStableNames = new Map<number, string>();
        const nameCounters = new Map<string, number>();

        for (const section of doc.sections) {
          // Build base name: title:level (or fallback for untitled sections)
          const baseName = section.title
            ? `${section.title}:${section.level}`
            : `untitled:${section.level}`;

          // Track duplicates and append index if needed
          const count = nameCounters.get(baseName) || 0;
          const stableName = count === 0 ? baseName : `${baseName}:${count}`;
          nameCounters.set(baseName, count + 1);

          sectionStableNames.set(section.startLine, stableName);
        }

        // Get pageNum mapping if this is a document file (PDF, DOCX converted to markdown)
        const pageNumMap = documentPageNumMap.get(filePath);

        for (const section of doc.sections) {
          const stableName = sectionStableNames.get(section.startLine)!;
          const sectionId = UniqueIDHelper.GenerateMarkdownSectionUUID(filePath, stableName);
          // Compute hash from content for incremental ingestion
          const sectionHash = createHash('sha256').update(section.content || '').digest('hex').slice(0, 16);

          // Look up pageNum from document mapping (for PDF/DOCX converted to markdown)
          const pageNum = pageNumMap?.get(section.startLine);

          // Build raw props - createNodeFromRegistry normalizes to _name, _content, _description
          const sectionProps: Record<string, unknown> = {
            uuid: sectionId,
            projectId,
            file: relPath,
            absolutePath: filePath,
            title: section.title,
            level: section.level,
            slug: section.slug,
            // Raw content fields - will be extracted to _content then removed
            content: section.content,
            ownContent: section.ownContent,
            hash: sectionHash,
            startLine: section.startLine,
            endLine: section.endLine,
            ...(section.parentTitle && { parentTitle: section.parentTitle }),
            // Add pageNum for document sections (PDF, DOCX)
            ...(pageNum !== undefined && { pageNum }),
            indexedAt: getLocalTimestamp()
          };
          nodes.push(createNodeFromRegistry('MarkdownSection', sectionId, sectionProps));

          relationships.push({
            type: 'HAS_SECTION',
            from: mdId,
            to: sectionId,
            targetLabel: 'MarkdownSection',
            targetProps: {
              _name: section.title || `Section ${section.startLine}`,
              absolutePath: filePath,
              file: relPath,
              startLine: section.startLine,
            }
          });

          // DEFINED_IN for orphan cleanup
          relationships.push({
            type: 'DEFINED_IN',
            from: sectionId,
            to: fileUuid,
            targetLabel: 'File',
            targetProps: {
              _name: fileName,
              absolutePath: filePath,
              path: relPath,
            }
          });

          // Link to parent section if exists
          if (section.parentTitle) {
            const parentSection = doc.sections.find(s => s.title === section.parentTitle);
            if (parentSection) {
              const parentStableName = sectionStableNames.get(parentSection.startLine)!;
              const parentSectionId = UniqueIDHelper.GenerateMarkdownSectionUUID(filePath, parentStableName);
              relationships.push({
                type: 'CHILD_OF',
                from: sectionId,
                to: parentSectionId
              });
            }
          }
        }
      }
    }

    // Create GenericFile nodes for unknown code files
    for (const [filePath, genericResult] of genericFiles) {
      const relPath = path.relative(projectRoot, filePath);

      // Generate UUID from hash since GenericFileAnalysis doesn't have uuid
      const genericId = UniqueIDHelper.GenerateGenericFileUUID(filePath);
      nodes.push({
        labels: ['GenericFile'],
        id: genericId,
        properties: {
          uuid: genericId,
          file: relPath,
          absolutePath: filePath,
          hash: genericResult.hash,
          linesOfCode: genericResult.linesOfCode,
          language: genericResult.languageHint || 'unknown',
          braceStyle: genericResult.braceStyle || 'unknown',
          ...(genericResult.imports && genericResult.imports.length > 0 && { imports: JSON.stringify(genericResult.imports) }),
          indexedAt: getLocalTimestamp()
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: genericId,
        to: projectId
      });

      // Create File node
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash: genericRawHash, mtime: genericMtime, rawContent: genericRawContent } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: genericResult.hash,
          ...(genericRawHash && { rawContentHash: genericRawHash }),
          ...(genericMtime && { mtime: genericMtime }),
          ...(genericRawContent && { _rawContent: genericRawContent }),
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      relationships.push({
        type: 'DEFINED_IN',
        from: genericId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      this.ensureDirectoryNodes(relPath, directories, nodes, relationships, fileUuid, projectRoot);
    }

    // Create DataFile nodes for data files (JSON, YAML, XML, TOML, ENV)
    // Track all file paths for cross-file reference resolution
    const allFilePaths = new Set<string>();
    for (const [filePath] of codeFiles) allFilePaths.add(path.relative(projectRoot, filePath));
    for (const [filePath] of htmlFiles) allFilePaths.add(path.relative(projectRoot, filePath));
    for (const [filePath] of cssFiles) allFilePaths.add(path.relative(projectRoot, filePath));
    for (const [filePath] of scssFiles) allFilePaths.add(path.relative(projectRoot, filePath));
    for (const [filePath] of vueFiles) allFilePaths.add(path.relative(projectRoot, filePath));
    for (const [filePath] of svelteFiles) allFilePaths.add(path.relative(projectRoot, filePath));
    for (const [filePath] of markdownFiles) allFilePaths.add(path.relative(projectRoot, filePath));
    for (const [filePath] of genericFiles) allFilePaths.add(path.relative(projectRoot, filePath));
    for (const [filePath] of dataFiles) allFilePaths.add(path.relative(projectRoot, filePath));
    for (const [filePath] of mediaFiles) allFilePaths.add(path.relative(projectRoot, filePath));

    // Track ExternalURLs for deduplication
    const externalUrls = new Map<string, string>(); // url -> uuid

    for (const [filePath, dataInfo] of dataFiles) {
      const relPath = path.relative(projectRoot, filePath);

      // Create DataFile node
      const dataFileId = UniqueIDHelper.GenerateDataFileUUID(filePath);
      nodes.push({
        labels: ['DataFile'],
        id: dataFileId,
        properties: {
          uuid: dataFileId,
          file: relPath,
          absolutePath: filePath,
          format: dataInfo.format,
          hash: dataInfo.hash,
          linesOfCode: dataInfo.linesOfCode,
          sectionCount: dataInfo.sections.length,
          referenceCount: dataInfo.references.length,
          indexedAt: getLocalTimestamp()
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: dataFileId,
        to: projectId
      });

      // Create File node
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash: dataRawHash, mtime: dataMtime, rawContent: dataRawContent } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: dataInfo.hash,
          ...(dataRawHash && { rawContentHash: dataRawHash }),
          ...(dataMtime && { mtime: dataMtime }),
          ...(dataRawContent && { _rawContent: dataRawContent }),
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      relationships.push({
        type: 'DEFINED_IN',
        from: dataFileId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      this.ensureDirectoryNodes(relPath, directories, nodes, relationships, fileUuid, projectRoot);

      // Create DataSection nodes for top-level sections
      for (const section of dataInfo.sections) {
        this.createDataSectionNodes(section, dataFileId, nodes, relationships, filePath);
      }

      // Create REFERENCES relationships for detected references
      for (const ref of dataInfo.references) {
        if (ref.type === 'url') {
          // Create or reference ExternalURL node
          let urlUuid = externalUrls.get(ref.value);
          if (!urlUuid) {
            urlUuid = UniqueIDHelper.GenerateExternalURLUUID(ref.value);
            externalUrls.set(ref.value, urlUuid);

            // Extract domain from URL
            let domain = '';
            try {
              const urlObj = new URL(ref.value);
              domain = urlObj.hostname;
            } catch {
              domain = ref.value.split('/')[2] || '';
            }

            nodes.push({
              labels: ['ExternalURL'],
              id: urlUuid,
              properties: {
                uuid: urlUuid,
                url: ref.value,
                domain
              }
            });
          }

          // Extract domain for targetProps
          let urlDomain = '';
          try {
            urlDomain = new URL(ref.value).hostname;
          } catch {
            urlDomain = ref.value.split('/')[2] || '';
          }
          relationships.push({
            type: 'LINKS_TO',
            from: dataFileId,
            to: urlUuid,
            properties: { path: ref.path, line: ref.line },
            targetLabel: 'ExternalURL',
            targetProps: {
              _name: urlDomain || ref.value,
              url: ref.value,
              domain: urlDomain,
            }
          });
        } else if (ref.type === 'code' || ref.type === 'config' || ref.type === 'file') {
          // Reference to a file - resolve relative path
          const refPath = this.resolveReferencePath(ref.value, relPath, projectRoot);
          if (refPath && allFilePaths.has(refPath)) {
            const refAbsPath = path.join(projectRoot, refPath);
            relationships.push({
              type: 'REFERENCES',
              from: dataFileId,
              to: UniqueIDHelper.GenerateFileUUID(refAbsPath),
              properties: { path: ref.path, refType: ref.type }
            });
          }
        } else if (ref.type === 'image') {
          // Reference to image - will link to MediaFile when created
          const refPath = this.resolveReferencePath(ref.value, relPath, projectRoot);
          if (refPath) {
            const refAbsPath = path.join(projectRoot, refPath);
            relationships.push({
              type: 'REFERENCES_IMAGE',
              from: dataFileId,
              to: UniqueIDHelper.GenerateFileUUID(refAbsPath),
              properties: { path: ref.path }
            });
          }
        } else if (ref.type === 'directory') {
          // Reference to directory
          const refPath = this.resolveReferencePath(ref.value, relPath, projectRoot);
          if (refPath && directories.has(refPath)) {
            const absRefPath = path.join(projectRoot, refPath);
            const dirName = refPath.includes('/') ? refPath.substring(refPath.lastIndexOf('/') + 1) : refPath;
            relationships.push({
              type: 'REFERENCES',
              from: dataFileId,
              to: UniqueIDHelper.GenerateDirectoryUUID(absRefPath),
              properties: { path: ref.path, refType: 'directory' },
              targetLabel: 'Directory',
              targetProps: {
                _name: dirName,
                absolutePath: absRefPath,
                path: refPath,
              }
            });
          }
        } else if (ref.type === 'package') {
          // Reference to npm/pip package - create ExternalLibrary node
          const pkgUuid = UniqueIDHelper.GenerateExternalLibraryUUID(ref.value);
          // Check if already created (avoid duplicates)
          if (!nodes.some(n => n.id === pkgUuid)) {
            nodes.push({
              labels: ['ExternalLibrary'],
              id: pkgUuid,
              properties: {
                uuid: pkgUuid,
                name: ref.value,
                source: 'npm' // TODO: detect pip/cargo/etc
              }
            });
          }

          relationships.push({
            type: 'USES_PACKAGE',
            from: dataFileId,
            to: pkgUuid,
            properties: { path: ref.path, line: ref.line },
            targetLabel: 'ExternalLibrary',
            targetProps: {
              _name: ref.value,
              name: ref.value,
            }
          });
        }
      }
    }

    // Create MediaFile nodes for images, 3D models, PDFs (lazy loading - metadata only)
    for (const [filePath, mediaInfo] of mediaFiles) {
      const relPath = path.relative(projectRoot, filePath);

      // Determine specific labels based on category
      const labels = ['MediaFile'];
      if (mediaInfo.category === 'image') labels.push('ImageFile');
      if (mediaInfo.category === '3d') labels.push('ThreeDFile');
      if (mediaInfo.category === 'document') labels.push('DocumentFile');

      const mediaId = `media:${mediaInfo.uuid}`;
      const properties: Record<string, unknown> = {
        uuid: mediaId,
        file: relPath,
        absolutePath: filePath,
        format: mediaInfo.format,
        category: mediaInfo.category,
        hash: mediaInfo.hash,
        sizeBytes: mediaInfo.sizeBytes,
        analyzed: mediaInfo.analyzed,
        indexedAt: getLocalTimestamp()
      };

      // Add category-specific properties
      if (mediaInfo.category === 'image') {
        const imageInfo = mediaInfo as ImageFileInfo;
        if (imageInfo.dimensions) {
          properties.width = imageInfo.dimensions.width;
          properties.height = imageInfo.dimensions.height;
        }
      }

      if (mediaInfo.category === '3d') {
        const threeDInfo = mediaInfo as ThreeDFileInfo;
        if (threeDInfo.gltfInfo) {
          if (threeDInfo.gltfInfo.version) properties.gltfVersion = threeDInfo.gltfInfo.version;
          if (threeDInfo.gltfInfo.generator) properties.gltfGenerator = threeDInfo.gltfInfo.generator;
          if (threeDInfo.gltfInfo.meshCount !== undefined) properties.meshCount = threeDInfo.gltfInfo.meshCount;
          if (threeDInfo.gltfInfo.materialCount !== undefined) properties.materialCount = threeDInfo.gltfInfo.materialCount;
          if (threeDInfo.gltfInfo.textureCount !== undefined) properties.textureCount = threeDInfo.gltfInfo.textureCount;
          if (threeDInfo.gltfInfo.animationCount !== undefined) properties.animationCount = threeDInfo.gltfInfo.animationCount;
        }
      }

      if (mediaInfo.category === 'document') {
        const pdfInfo = mediaInfo as PDFFileInfo;
        if (pdfInfo.pdfInfo?.pageCount !== undefined) properties.pageCount = pdfInfo.pdfInfo.pageCount;
        if (pdfInfo.pdfInfo?.title) properties.pdfTitle = pdfInfo.pdfInfo.title;
        if (pdfInfo.pdfInfo?.author) properties.pdfAuthor = pdfInfo.pdfInfo.author;
      }

      nodes.push({
        labels,
        id: mediaId,
        properties
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: mediaId,
        to: projectId
      });

      // Create File node for media file
      // Note: Binary files (images/audio/video) don't have _rawContent
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = path.extname(relPath);
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash: mediaRawHash, mtime: mediaMtime } = fileMetadata.get(filePath) || {};

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: mediaInfo.hash,
          ...(mediaRawHash && { rawContentHash: mediaRawHash }),
          ...(mediaMtime && { mtime: mediaMtime }),
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      relationships.push({
        type: 'DEFINED_IN',
        from: mediaId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      this.ensureDirectoryNodes(relPath, directories, nodes, relationships, fileUuid, projectRoot);
    }

    // Create DocumentFile nodes for PDFs, DOCX, XLSX (with full text extraction)
    for (const [filePath, docInfo] of documentFiles) {
      const relPath = path.relative(projectRoot, filePath);

      // Determine specific labels based on format
      const labels = ['DocumentFile'];
      if (docInfo.format === 'pdf') labels.push('PDFDocument');
      if (docInfo.format === 'docx') labels.push('WordDocument');
      if (docInfo.format === 'xlsx' || docInfo.format === 'xls') labels.push('SpreadsheetDocument');
      if (docInfo.format === 'csv') labels.push('SpreadsheetDocument');

      const docId = `doc:${docInfo.uuid}`;
      const properties: Record<string, unknown> = {
        uuid: docId,
        file: relPath,
        absolutePath: filePath,
        format: docInfo.format,
        hash: docInfo.hash,
        sizeBytes: docInfo.sizeBytes,
        pageCount: docInfo.pageCount,
        hasFullText: docInfo.hasFullText,
        needsGeminiVision: docInfo.needsGeminiVision,
        extractionMethod: docInfo.extractionMethod,
        indexedAt: getLocalTimestamp()
      };

      // Add text content if available (for search)
      if (docInfo.textContent) {
        properties.textContent = docInfo.textContent;
        properties.textLength = docInfo.textContent.length;
      }

      // Add OCR confidence if available
      if (docInfo.ocrConfidence !== undefined) {
        properties.ocrConfidence = docInfo.ocrConfidence;
      }

      // Add spreadsheet-specific properties
      if ('sheetNames' in docInfo) {
        const spreadsheet = docInfo as SpreadsheetInfo;
        if (spreadsheet.sheetNames) {
          properties.sheetNames = spreadsheet.sheetNames;
          properties.sheetCount = spreadsheet.sheetNames.length;
        }
      }

      nodes.push({
        labels,
        id: docId,
        properties
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: docId,
        to: projectId
      });

      // Create File node for document file
      // For binary documents (PDF/DOCX), use extracted text as _rawContent
      const fileName = getLastSegment(relPath);
      const directory = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '.';
      const extension = path.extname(relPath);
      const fileUuid = UniqueIDHelper.GenerateFileUUID(filePath);
      const { rawContentHash: docRawHash, mtime: docMtime } = fileMetadata.get(filePath) || {};
      const docRawContent = getRawContentProp(docInfo.textContent);

      nodes.push({
        labels: ['File'],
        id: fileUuid,
        properties: {
          uuid: fileUuid,
          path: relPath,
          absolutePath: filePath,
          name: fileName,
          directory,
          extension,
          contentHash: docInfo.hash,
          ...(docRawHash && { rawContentHash: docRawHash }),
          ...(docMtime && { mtime: docMtime }),
          ...(docRawContent && { _rawContent: docRawContent }),
        }
      });

      relationships.push({
        type: 'BELONGS_TO',
        from: fileUuid,
        to: projectId
      });

      relationships.push({
        type: 'DEFINED_IN',
        from: docId,
        to: fileUuid,
        targetLabel: 'File',
        targetProps: {
          _name: fileName,
          absolutePath: filePath,
          path: relPath,
        }
      });

      this.ensureDirectoryNodes(relPath, directories, nodes, relationships, fileUuid, projectRoot);
    }

    // Log final summary
    const totalFilesProcessed = codeFiles.size + htmlFiles.size + cssFiles.size + scssFiles.size + vueFiles.size + svelteFiles.size + markdownFiles.size + genericFiles.size + dataFiles.size + mediaFiles.size + documentFiles.size;

    // Count cross-file CONSUMES (where target node is NOT in parsed nodes)
    const consumesRels = relationships.filter(r => r.type === 'CONSUMES');
    const nodeIds = new Set(nodes.map(n => n.id));
    const crossFileConsumes = consumesRels.filter(r => !nodeIds.has(r.to));
    if (crossFileConsumes.length > 0) {
      console.log(`   🔗 ${crossFileConsumes.length} cross-file CONSUMES (target in other files)`);
    }

    console.log(`   ✅ Graph built: ${nodes.length} nodes, ${relationships.length} relationships`);

    return {
      nodes,
      relationships,
      metadata: {
        filesProcessed: totalFilesProcessed,
        nodesGenerated: nodes.length,
        relationshipsGenerated: relationships.length,
        parseTimeMs: 0 // Will be set by caller
      }
    };
  }

  /**
   * Helper to ensure directory nodes exist and create relationships
   */
  private ensureDirectoryNodes(
    relPath: string,
    directories: Set<string>,
    nodes: ParsedNode[],
    relationships: ParsedRelationship[],
    fileUuid: string,
    projectRoot: string
  ): void {
    let currentPath = relPath;
    while (true) {
      const dir = currentPath.includes('/') ? currentPath.substring(0, currentPath.lastIndexOf('/')) : '';
      if (!dir || dir === '.' || dir === '') break;

      if (!directories.has(dir)) {
        directories.add(dir);
        const absDirPath = path.join(projectRoot, dir);
        const dirUuid = UniqueIDHelper.GenerateDirectoryUUID(absDirPath);
        const depth = getPathDepth(dir);
        nodes.push({
          labels: ['Directory'],
          id: dirUuid,
          properties: {
            uuid: dirUuid,
            path: dir,
            absolutePath: absDirPath,
            depth
          }
        });
      }

      if (currentPath === relPath) {
        const absDirPath = path.join(projectRoot, dir);
        const dirName = dir.includes('/') ? dir.substring(dir.lastIndexOf('/') + 1) : dir;
        relationships.push({
          type: 'IN_DIRECTORY',
          from: fileUuid,
          to: UniqueIDHelper.GenerateDirectoryUUID(absDirPath),
          targetLabel: 'Directory',
          targetProps: {
            _name: dirName,
            absolutePath: absDirPath,
            path: dir,
          }
        });
      }

      currentPath = dir;
    }
  }

  /**
   * Recursively create DataSection nodes for nested data structures
   */
  private createDataSectionNodes(
    section: import('./data-file-parser.js').DataSection,
    parentId: string,
    nodes: ParsedNode[],
    relationships: ParsedRelationship[],
    absolutePath: string,
    isRoot: boolean = true
  ): void {
    const sectionId = UniqueIDHelper.GenerateDataSectionUUID(absolutePath, section.path);

    // Build raw props - createNodeFromRegistry normalizes to _name, _content, _description
    const dataSectionProps: Record<string, unknown> = {
      uuid: sectionId,
      path: section.path,
      key: section.key,
      // Raw content - will be extracted to _content then removed
      content: section.content.length > 10000
        ? section.content.substring(0, 10000) + '...[truncated]'
        : section.content,
      depth: section.depth,
      valueType: section.valueType,
      childCount: section.children?.length ?? 0
    };
    nodes.push(createNodeFromRegistry('DataSection', sectionId, dataSectionProps));

    // Link to parent (DataFile or parent DataSection)
    relationships.push({
      type: isRoot ? 'HAS_SECTION' : 'HAS_CHILD',
      from: parentId,
      to: sectionId,
      targetLabel: 'DataSection',
      targetProps: {
        _name: section.key || section.path,
        path: section.path,
        depth: section.depth,
      }
    });

    // Recursively create child sections (limit depth to avoid explosion)
    if (section.children && section.depth < 3) {
      for (const child of section.children) {
        this.createDataSectionNodes(child, sectionId, nodes, relationships, absolutePath, false);
      }
    }
  }

  /**
   * Resolve a reference path relative to the source file
   */
  private resolveReferencePath(
    refValue: string,
    sourceRelPath: string,
    projectRoot: string
  ): string | null {
    // Skip absolute URLs
    if (refValue.startsWith('http://') || refValue.startsWith('https://')) {
      return null;
    }

    // Handle relative paths
    if (refValue.startsWith('./') || refValue.startsWith('../')) {
      const sourceDir = sourceRelPath.includes('/')
        ? sourceRelPath.substring(0, sourceRelPath.lastIndexOf('/'))
        : '.';

      // Resolve relative to source file directory
      const parts = splitPath(sourceDir).filter(p => p !== '.');
      const refParts = splitPath(refValue);

      for (const part of refParts) {
        if (part === '..') {
          parts.pop();
        } else if (part !== '.') {
          parts.push(part);
        }
      }

      return parts.join('/');
    }

    // Absolute path from project root (starts with / or C:\)
    if (isAbsolutePath(refValue)) {
      return refValue.substring(1);
    }

    // Bare path - assume relative to source
    const sourceDir = sourceRelPath.includes('/')
      ? sourceRelPath.substring(0, sourceRelPath.lastIndexOf('/'))
      : '';

    return sourceDir ? `${sourceDir}/${refValue}` : refValue;
  }

  /**
   * Calculate signature hash for a scope (ported from buildXmlScopes.ts)
   * Hash is stable across builds if the scope signature doesn't change
   * Includes parent context to differentiate methods in different classes
   */
  private getSignatureHash(scope: ScopeInfo): string {
    // Include parent name for methods to avoid collisions
    // e.g., "MyClass.myMethod" vs "OtherClass.myMethod"
    const parentPrefix = scope.parent ? `${scope.parent}.` : '';

    // Use signature if available, otherwise just name:type
    // NEVER include content - it changes frequently and breaks UUID stability
    // The signature from codeparsers should always be non-empty
    const baseInput = scope.signature || `${scope.name}:${scope.type}`;

    let hashInput = `${parentPrefix}${baseInput}`;

    // For variables/constants: include line number to differentiate same-name vars
    // (e.g., let v = '' at line 45 and let v = ... at line 358)
    if (scope.type === 'variable' || scope.type === 'constant') {
      hashInput += `:line${scope.startLine}`;
    }

    return createHash('sha256')
      .update(hashInput)
      .digest('hex')
      .substring(0, 8); // 8-char hash like original
  }

  // Store existing UUIDs from database for re-ingestion (set by buildGraph)
  private existingUUIDMapping?: Map<string, Array<{ uuid: string; file: string; type: string }>>;

  /**
   * Get or generate UUID for a scope
   * Uses signature hash to create stable UUIDs that survive refactoring
   * Cache key format: "name:type:signatureHash"
   *
   * IMPORTANT: During re-ingestion, first checks existingUUIDMapping to preserve
   * existing UUIDs. This ensures MERGE matches existing nodes instead of creating new ones.
   */
  private generateUUID(scope: ScopeInfo, filePath: string): string {
    // Get or create cache for this file
    if (!this.uuidCache.has(filePath)) {
      this.uuidCache.set(filePath, new Map());
    }
    const fileCache = this.uuidCache.get(filePath)!;

    // Calculate signature hash
    const signatureHash = this.getSignatureHash(scope);
    const cacheKey = `${scope.name}:${scope.type}:${signatureHash}`;

    // Try to reuse existing UUID from cache
    if (fileCache.has(cacheKey)) {
      return fileCache.get(cacheKey)!;
    }

    // PRIORITY: Check existingUUIDMapping for re-ingestion scenarios
    // This preserves UUIDs from the database, ensuring MERGE matches existing nodes
    if (this.existingUUIDMapping) {
      const candidates = this.existingUUIDMapping.get(scope.name);
      if (candidates) {
        // Find exact match by file and type
        const exactMatch = candidates.find(c =>
          filePath.endsWith(c.file) && c.type === scope.type
        );
        if (exactMatch) {
          console.log(`[UUID] Reusing existing UUID for ${scope.name}: ${exactMatch.uuid} (file: ${exactMatch.file})`);
          fileCache.set(cacheKey, exactMatch.uuid);
          return exactMatch.uuid;
        } else {
          // Debug: log why no match found
          console.log(`[UUID] No match for ${scope.name} (type=${scope.type}, file=${filePath}). Candidates: ${JSON.stringify(candidates.map(cd => ({ file: cd.file, type: cd.type })))}`);
        }
      }
    }

    // Generate deterministic UUID based on file path + scope signature (NOT line number!)
    // Using signatureHash ensures the same scope gets the same UUID even if it moves lines
    const deterministicInput = `${filePath}:${scope.name}:${scope.type}:${signatureHash}`;
    const uuid = UniqueIDHelper.GenerateDeterministicUUID(deterministicInput);

    fileCache.set(cacheKey, uuid);
    return uuid;
  }

  /**
   * Hash scope content for incremental updates
   * Uses full content + docstring to detect ANY changes in the scope
   */
  private hashScope(scope: ScopeInfo): string {
    // Hash the full content to detect changes in implementation
    // Not just the signature which would miss body changes
    const content = scope.contentDedented || scope.content || '';
    const docstring = (scope as any).docstring || '';
    const parentPrefix = scope.parent ? `${scope.parent}.` : '';
    const hashInput = `${parentPrefix}${scope.name}:${scope.type}:${docstring}:${content}`;

    return createHash('sha256')
      .update(hashInput)
      .digest('hex')
      .substring(0, 8);
  }

  /**
   * Extract signature from scope
   * Returns the actual signature string, not just "type name"
   */
  private extractSignature(scope: ScopeInfo): string {
    // If scope already has a signature, use it
    if (scope.signature) {
      return scope.signature;
    }

    // Build signature based on scope type
    const parts: string[] = [];

    // Modifiers
    if (scope.modifiers && scope.modifiers.length > 0) {
      parts.push(scope.modifiers.join(' '));
    }

    // Type keyword
    parts.push(scope.type);

    // Name
    parts.push(scope.name);

    // Parameters (for functions/methods)
    if (scope.parameters && scope.parameters.length > 0) {
      const params = scope.parameters.map(p => {
        let param = p.name;
        if (p.type) param += `: ${p.type}`;
        if (p.optional) param += '?';
        return param;
      }).join(', ');
      parts.push(`(${params})`);
    } else if (scope.type === 'function' || scope.type === 'method') {
      parts.push('()');
    }

    // Return type
    if (scope.returnType) {
      parts.push(`: ${scope.returnType}`);
    }

    return parts.join(' ');
  }

  /**
   * Check if a reference is an inheritance relationship
   * Looks for "extends" keyword in context or signature
   */
  private isInheritanceReference(scope: ScopeInfo, target: ScopeInfo): boolean {
    // TypeScript/JavaScript: Check if any identifier reference to target contains "extends"
    if (scope.identifierReferences && Array.isArray(scope.identifierReferences)) {
      for (const ref of scope.identifierReferences) {
        if (ref.identifier === target.name) {
          // Check context for "extends" keyword
          if (ref.context && ref.context.includes('extends')) {
            return true;
          }
        }
      }
    }

    // TypeScript/JavaScript: Check class signature for "extends" keyword
    if (scope.signature && scope.signature.includes('extends') && scope.signature.includes(target.name)) {
      return true;
    }

    // Cross-file inheritance: Check if target is imported and signature has "extends"
    // This handles cases like: class CodeSourceAdapter extends SourceAdapter (where SourceAdapter is imported)
    if (scope.importReferences && Array.isArray(scope.importReferences)) {
      const hasImportedTarget = scope.importReferences.some(
        imp => imp.imported === target.name || imp.source === target.name
      );
      if (hasImportedTarget && scope.signature && scope.signature.includes('extends')) {
        // Check if the signature explicitly mentions the target class after "extends"
        const extendsPattern = new RegExp(`extends\\s+${target.name}\\b`);
        if (extendsPattern.test(scope.signature)) {
          return true;
        }
      }
    }

    // Python: check for parent class in class definition
    // e.g., "class MyClass(BaseClass):"
    if (scope.content) {
      const firstLine = scope.content.split('\n')[0];
      if (firstLine.includes('class') && firstLine.includes('(') && firstLine.includes(target.name)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find parent UUID for a scope
   */
  private findParentUUID(
    scope: ScopeInfo,
    filePath: string,
    globalUUIDMapping: Map<string, Array<{ uuid: string; file: string; type: string }>>
  ): string | undefined {
    if (!scope.parent) return undefined;

    const candidates = globalUUIDMapping.get(scope.parent) || [];
    // Match by file to avoid collisions
    const match = candidates.find(c => c.file === filePath);
    return match?.uuid;
  }

  /**
   * Build global UUID mapping (name -> [{uuid, file, type}])
   * Supports multiple scopes with same name (distinguished by file and type)
   * Ported from buildXmlScopes.ts:908-927
   */
  private buildGlobalUUIDMapping(
    parsedFiles: Map<string, ScopeFileAnalysis>
  ): Map<string, Array<{ uuid: string; file: string; type: string }>> {
    const mapping = new Map<string, Array<{ uuid: string; file: string; type: string }>>();

    for (const [filePath, analysis] of parsedFiles) {
      for (const scope of analysis.scopes) {
        const uuid = this.generateUUID(scope, filePath);

        if (!mapping.has(scope.name)) {
          mapping.set(scope.name, []);
        }
        mapping.get(scope.name)!.push({
          uuid,
          file: filePath,
          type: scope.type
        });
      }
    }

    return mapping;
  }

  /**
   * Build scope relationships using codeparsers' RelationshipResolver
   * Handles CONSUMES, INHERITS_FROM, IMPLEMENTS, DECORATED_BY for all languages
   *
   * Uses codeparsers' multi-language relationship resolution, then maps UUIDs
   * using ragforge's generateUUID to maintain compatibility with existingUUIDMapping.
   */
  private async buildScopeRelationshipsWithResolver(
    codeFiles: Map<string, ScopeFileAnalysis>,
    projectRoot: string,
    scopeMap: Map<string, ScopeInfo>
  ): Promise<ParsedRelationship[]> {
    const relationships: ParsedRelationship[] = [];

    if (codeFiles.size === 0) {
      return relationships;
    }

    // Create RelationshipResolver from codeparsers
    const relationshipResolver = new RelationshipResolver({
      projectRoot,
      includeContains: false, // We already handle HAS_PARENT in node creation
      includeInverse: false, // We don't need CONSUMED_BY in the graph
      includeDecorators: true,
      resolveCrossFile: true,
      debug: false,
    });

    // Resolve relationships
    const result = await relationshipResolver.resolveRelationships(codeFiles as ParsedFilesMap);

    console.log(`   📊 RelationshipResolver stats: ${result.stats.totalRelationships} relationships, ${result.stats.unresolvedCount} unresolved`);
    if (result.stats.byType) {
      const types = Object.entries(result.stats.byType)
        .map(([type, count]) => `${type}=${count}`)
        .join(', ');
      console.log(`      Types: ${types}`);
    }

    // Build scope lookup for efficient UUID mapping
    // Key: "relativePath:scopeName:scopeType" -> scope
    const scopeLookup = new Map<string, { scope: ScopeInfo; absolutePath: string }>();
    for (const [absolutePath, analysis] of codeFiles) {
      const relativePath = path.relative(projectRoot, absolutePath);
      for (const scope of analysis.scopes) {
        const key = `${relativePath}:${scope.name}:${scope.type}`;
        scopeLookup.set(key, { scope, absolutePath });
      }
    }

    // Convert ResolvedRelationship to ParsedRelationship
    // Use ragforge's generateUUID for UUID compatibility
    const seenRelationships = new Set<string>(); // Deduplicate

    for (const rel of result.relationships) {
      // Skip inverse relationships (CONSUMED_BY, HAS_PARENT, DECORATED_BY)
      // We only want the forward direction
      if (rel.type === 'CONSUMED_BY' || rel.type === 'HAS_PARENT' || rel.type === 'DECORATED_BY') {
        continue;
      }

      // Look up source and target scopes to get ragforge UUIDs
      const sourceKey = `${rel.fromFile}:${rel.fromName}:${rel.fromType}`;
      const targetKey = `${rel.toFile}:${rel.toName}:${rel.toType}`;

      const sourceInfo = scopeLookup.get(sourceKey);
      const targetInfo = scopeLookup.get(targetKey);

      if (!sourceInfo || !targetInfo) {
        // Scope not found - might be from a different file set
        continue;
      }

      // Generate UUIDs using ragforge's method (supports existingUUIDMapping)
      const fromUuid = this.generateUUID(sourceInfo.scope, sourceInfo.absolutePath);
      const toUuid = this.generateUUID(targetInfo.scope, targetInfo.absolutePath);

      // Deduplicate
      const relKey = `${rel.type}:${fromUuid}:${toUuid}`;
      if (seenRelationships.has(relKey)) {
        continue;
      }
      seenRelationships.add(relKey);

      // Map relationship type
      // Note: DECORATES from codeparsers maps to DECORATED_BY in ragforge (reversed direction)
      let relType = rel.type as string;
      let from = fromUuid;
      let to = toUuid;

      if (rel.type === 'DECORATES') {
        // Codeparsers: decorator DECORATES target
        // Ragforge: target DECORATED_BY decorator
        relType = 'DECORATED_BY';
        from = toUuid; // target
        to = fromUuid; // decorator
      }

      const parsedRel: ParsedRelationship = {
        type: relType,
        from,
        to,
      };

      // Add properties if available
      if (rel.metadata) {
        const properties: Record<string, unknown> = {};
        if (rel.metadata.context) properties.context = rel.metadata.context;
        if (rel.metadata.importPath) properties.importPath = rel.metadata.importPath;
        if (rel.metadata.clause) properties.clause = rel.metadata.clause;
        if (rel.metadata.decoratorArgs) properties.decoratorArgs = rel.metadata.decoratorArgs;
        if (rel.type === 'INHERITS_FROM' || rel.type === 'IMPLEMENTS') {
          properties.explicit = true;
        }
        if (Object.keys(properties).length > 0) {
          parsedRel.properties = properties;
        }
      }

      relationships.push(parsedRel);
    }

    return relationships;
  }

  /**
   * Build scope references from identifierReferences
   * Only processes local_scope kind (references in same file)
   * Ported from buildXmlScopes.ts:307-349
   *
   * @deprecated Use buildScopeRelationshipsWithResolver instead
   */
  private buildScopeReferences(
    scope: ScopeInfo,
    filePath: string,
    globalUUIDMapping: Map<string, Array<{ uuid: string; file: string; type: string }>>
  ): string[] {
    const references: string[] = [];

    // Handle scopes without detailed identifier references
    if (!scope.identifierReferences || !Array.isArray(scope.identifierReferences)) {
      return references;
    }

    for (const ref of scope.identifierReferences) {
      // TypeScript: explicit local_scope references
      if (ref.kind === 'local_scope' && ref.targetScope) {
        const candidates = globalUUIDMapping.get(ref.identifier) || [];
        // Match by file to avoid collisions
        const match = candidates.find(c => c.file === filePath);

        if (match && !references.includes(match.uuid)) {
          references.push(match.uuid);
        }
      }
    }

    return references;
  }

  /**
   * Build import references with resolved file paths and UUIDs
   * Ported from buildXmlScopes.ts:355-437
   */
  private async buildImportReferences(
    scope: ScopeInfo,
    currentFile: string,
    resolver: ImportResolver,
    globalUUIDMapping: Map<string, Array<{ uuid: string; file: string; type: string }>>
  ): Promise<string[]> {
    const imports: string[] = [];
    const DEBUG_SYMBOL = process.env.DEBUG_IMPORT_SYMBOL; // e.g., 'formatAsMarkdown'

    // Handle scopes without detailed references
    if (!scope.importReferences || !Array.isArray(scope.importReferences)) {
      return imports;
    }
    if (!scope.identifierReferences || !Array.isArray(scope.identifierReferences)) {
      return imports;
    }

    // Process only local imports
    for (const imp of scope.importReferences.filter(i => i.isLocal)) {
      for (const ref of scope.identifierReferences) {
        if (ref.kind === 'import' && ref.source === imp.source && ref.identifier === imp.imported) {
          // Debug logging for specific symbol
          const isDebugSymbol = DEBUG_SYMBOL && imp.imported === DEBUG_SYMBOL;
          if (isDebugSymbol) {
            console.log(`\n[DEBUG buildImportReferences] Matched import: ${imp.imported}`);
            console.log(`  scope: ${scope.name} (${scope.type}) in ${currentFile}`);
            console.log(`  import source: ${imp.source}`);
          }

          // Resolve the import to actual source file
          let resolvedPath = await resolver.resolveImport(imp.source, currentFile);
          if (isDebugSymbol) {
            console.log(`  resolveImport result: ${resolvedPath || 'null'}`);
          }

          // Follow re-exports to find the actual source file where the symbol is defined
          if (resolvedPath) {
            const beforeFollow = resolvedPath;
            resolvedPath = await resolver.followReExports(resolvedPath, imp.imported);
            if (isDebugSymbol) {
              console.log(`  followReExports: ${beforeFollow} -> ${resolvedPath}`);
            }
          }

          const resolvedFile = resolvedPath ? resolver.getRelativePath(resolvedPath) : undefined;
          if (isDebugSymbol) {
            console.log(`  resolvedFile (relative): ${resolvedFile || 'null'}`);
          }

          // Try to find UUID for the imported symbol
          let symbolUUID: string | undefined;
          const candidates = globalUUIDMapping.get(imp.imported) || [];
          if (isDebugSymbol) {
            console.log(`  candidates for "${imp.imported}": ${candidates.length}`);
            for (const c of candidates) {
              console.log(`    - ${c.uuid} (${c.type}) in ${c.file}`);
            }
          }

          if (resolvedFile && candidates.length > 0) {
            // Filter candidates by file
            const fileCandidates = candidates.filter(c => c.file === resolvedFile);
            if (isDebugSymbol) {
              console.log(`  fileCandidates (matching ${resolvedFile}): ${fileCandidates.length}`);
            }

            if (fileCandidates.length === 1) {
              // Only one match, use it
              symbolUUID = fileCandidates[0].uuid;
            } else if (fileCandidates.length > 1) {
              // Multiple scopes with same name in same file (e.g., interface Foo + function Foo)
              // Prioritize value types (function, const, class) over type-only (interface, type)
              const valueTypes = ['function', 'const', 'class', 'method'];
              const valueCandidate = fileCandidates.find(c => valueTypes.includes(c.type));
              symbolUUID = (valueCandidate || fileCandidates[0]).uuid;
            }
          } else if (candidates.length === 1) {
            // Only one scope with this name, use it
            symbolUUID = candidates[0].uuid;
            if (isDebugSymbol) {
              console.log(`  Using single candidate (no file match): ${symbolUUID}`);
            }
          }
          // If multiple candidates and no resolved file, we can't determine which one

          if (isDebugSymbol) {
            console.log(`  RESULT: symbolUUID = ${symbolUUID || 'null'}`);
          }

          if (symbolUUID && !imports.includes(symbolUUID)) {
            imports.push(symbolUUID);
          }
        }
      }
    }

    return imports;
  }

  /**
   * Build class member references
   * Finds all scopes that have this class as parent
   * Ported from buildXmlScopes.ts:496-524
   */
  private buildClassMemberReferences(
    classScope: ScopeInfo,
    filePath: string,
    allFileScopes: ScopeInfo[],
    globalUUIDMapping: Map<string, Array<{ uuid: string; file: string; type: string }>>
  ): string[] {
    const members: string[] = [];

    // Find all scopes that have this class as parent
    for (const otherScope of allFileScopes) {
      if (otherScope.parent === classScope.name && otherScope.filePath === filePath) {
        // This is a member of the class (method, attribute, nested class, etc.)
        const candidates = globalUUIDMapping.get(otherScope.name) || [];
        const match = candidates.find(c => c.file === filePath);

        if (match && !members.includes(match.uuid)) {
          members.push(match.uuid);
        }
      }
    }

    return members;
  }

  /**
   * Export parsed data to XML (for debugging)
   */
  private async exportXml(
    parsedFiles: Map<string, ScopeFileAnalysis>,
    config: CodeSourceConfig
  ): Promise<void> {
    // TODO: Implement XML export using fast-xml-parser
    console.log('XML export requested but not yet implemented');
  }

  /**
   * Enrich class/interface nodes with their members summary.
   * This helps search find classes when searching for method names.
   *
   * Adds a "Members:" section to _content with signatures and line numbers.
   */
  private enrichClassNodesWithMembers(
    nodes: ParsedNode[],
    scopes: ScopeInfo[],
    filePath: string
  ): void {
    // Build a map of UUID -> scope for quick lookup
    const scopeByUuid = new Map<string, ScopeInfo>();
    for (const scope of scopes) {
      const uuid = this.generateUUID(scope, filePath);
      scopeByUuid.set(uuid, scope);
    }

    // Find class/interface nodes
    const containerTypes = ['class', 'interface', 'enum', 'namespace', 'module'];

    for (const node of nodes) {
      if (node.labels[0] !== 'Scope') continue;

      const scopeType = node.properties.type as string;
      if (!containerTypes.includes(scopeType)) continue;

      const parentUuid = node.properties.uuid as string;

      // Find all children (nodes with this as parentUUID)
      const children = nodes.filter(n =>
        n.labels[0] === 'Scope' &&
        n.properties.parentUUID === parentUuid
      );

      if (children.length === 0) continue;

      // Build members summary
      const memberLines: string[] = [];
      for (const child of children) {
        const childScope = scopeByUuid.get(child.properties.uuid as string);
        if (!childScope) continue;

        // Get signature (from _name which is the normalized signature)
        const signature = (child.properties._name as string) || childScope.name;
        const startLine = childScope.startLine;
        const endLine = childScope.endLine;

        // Extract body preview (content without signature)
        let bodyPreview = '';
        const content = child.properties._content as string || childScope.content || '';
        const sigLength = signature.length;
        if (content.length > sigLength) {
          bodyPreview = content
            .substring(sigLength)
            .trim()
            .substring(0, 150)
            .replace(/\s+/g, ' '); // collapse whitespace
          if (bodyPreview.length >= 150) bodyPreview += '...';
        }

        memberLines.push(`  - ${signature} (L${startLine}-${endLine})${bodyPreview ? '\n    ' + bodyPreview : ''}`);
      }

      // Append to _content
      if (memberLines.length > 0) {
        const existingContent = (node.properties._content as string) || '';
        node.properties._content = `${existingContent}\n\nMembers:\n${memberLines.join('\n')}`;
      }
    }
  }
}
