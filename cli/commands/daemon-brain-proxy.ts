/**
 * Daemon Brain Proxy
 *
 * A proxy that implements the BrainManager interface but delegates all calls
 * to the daemon via HTTP. This ensures:
 * - Single point of access to the database (daemon process only)
 * - Watchers always run in daemon process
 * - No duplicate BrainManager instances
 *
 * @since 2025-12-09
 */

import { ensureDaemonRunning, callToolViaDaemon, isDaemonRunning } from './daemon-client.js';
import type {
  RegisteredProject,
  QuickIngestOptions,
  QuickIngestResult,
  BrainSearchOptions,
  UnifiedSearchResult,
  IngestionStatus,
} from '@luciformresearch/ragforge';

const DAEMON_URL = 'http://127.0.0.1:6969';

/**
 * Interface for the proxy - subset of BrainManager methods needed by tools
 */
export interface BrainProxy {
  // Project management
  listProjects(): RegisteredProject[];
  listProjectsWithCounts(): Promise<RegisteredProject[]>;
  quickIngest(dirPath: string, options?: QuickIngestOptions): Promise<QuickIngestResult>;
  forgetPath(path: string): Promise<void>;
  excludeProject(projectId: string): Promise<boolean>;
  includeProject(projectId: string): Promise<boolean>;
  unregisterProject(projectId: string): Promise<boolean>;
  clearProjectsRegistry(): Promise<void>;

  // Search
  search(query: string, options?: BrainSearchOptions): Promise<UnifiedSearchResult>;
  runCypher(query: string, params?: Record<string, unknown>): Promise<{
    success: boolean;
    records?: Array<Record<string, unknown>>;
    summary?: { counters: Record<string, number> };
    error?: string;
  }>;

  // File watching
  startWatching(projectPath: string, options?: { verbose?: boolean }): Promise<void>;
  stopWatching(projectPath: string): Promise<void>;
  isWatching(projectPath: string): boolean;
  getWatchedProjects(): string[];

  // Lock status (read-only for proxy)
  getIngestionLockStatus(): IngestionStatus;
  waitForIngestionLock(timeoutMs?: number): Promise<boolean>;

  // Pending edits
  hasPendingEdits(): boolean;
  waitForPendingEdits(timeoutMs?: number): Promise<boolean>;
  queueFileChange(filePath: string, changeType: 'created' | 'updated' | 'deleted'): void;
  getPendingEditCount(): number;

  // Web ingestion
  ingestWebPage(params: {
    url: string;
    title?: string;
    textContent?: string;
    rawHtml?: string;
    projectName?: string;
    depth?: number;
    maxPages?: number;
    includePatterns?: string[];
    excludePatterns?: string[];
    generateEmbeddings?: boolean;
    force?: boolean;
  }): Promise<any>;

  // Media content update
  updateMediaContent(params: {
    filePath: string;
    textContent?: string;
    description?: string;
    ocrConfidence?: number;
    extractionMethod?: string;
    generateEmbeddings?: boolean;
    sourceFiles?: string[];
  }): Promise<{ updated: boolean }>;

  // Config
  getBrainPath(): string;
  getConfig(): any;
  getGeminiKey(): string | undefined;
}

/**
 * Cached state from daemon (refreshed periodically)
 */
interface CachedState {
  projects: RegisteredProject[];
  watchedProjects: string[];
  ingestionStatus: IngestionStatus;
  embeddingStatus?: IngestionStatus; // Embedding lock status
  pendingEditCount: number;
  brainPath: string;
  config: any;
  lastRefresh: number;
}

const CACHE_TTL_MS = 1000; // 1 second cache

/**
 * DaemonBrainProxy - HTTP proxy to BrainManager running in daemon
 */
export class DaemonBrainProxy implements BrainProxy {
  private cache: CachedState | null = null;
  private initialized = false;

  /**
   * Initialize the proxy (ensures daemon is running)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const ready = await ensureDaemonRunning(false);
    if (!ready) {
      throw new Error('Failed to start daemon');
    }

    // Initial state fetch
    await this.refreshCache();
    this.initialized = true;
  }

  /**
   * Check if proxy is ready
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Refresh cached state from daemon
   */
  private async refreshCache(): Promise<void> {
    try {
      const response = await fetch(`${DAEMON_URL}/status`);
      if (!response.ok) {
        throw new Error(`Daemon status failed: ${response.status}`);
      }

      const status = await response.json() as any;

      this.cache = {
        projects: status.brain?.projects || [],
        watchedProjects: status.brain?.watchers || [],
        ingestionStatus: status.brain?.ingestion_status || { isLocked: false, operationCount: 0, operations: [] },
        embeddingStatus: status.brain?.embedding_status || { isLocked: false, operationCount: 0, operations: [] },
        pendingEditCount: status.brain?.pending_edits || 0,
        brainPath: status.brain?.brain_path || '',
        config: status.brain?.config || {},
        lastRefresh: Date.now(),
      };
    } catch (err) {
      console.error('[DaemonBrainProxy] Failed to refresh cache:', err);
    }
  }

  /**
   * Get cached state, refreshing if stale
   */
  private async getCache(): Promise<CachedState> {
    if (!this.cache || Date.now() - this.cache.lastRefresh > CACHE_TTL_MS) {
      await this.refreshCache();
    }
    return this.cache!;
  }

  /**
   * Ensure daemon is running before making a request
   */
  private async ensureDaemon(): Promise<void> {
    const ready = await ensureDaemonRunning(false);
    if (!ready) {
      throw new Error('Failed to start daemon');
    }
  }

  /**
   * Call a tool via the daemon
   */
  private async callTool<T>(toolName: string, params: Record<string, any> = {}): Promise<T> {
    const result = await callToolViaDaemon(toolName, params);
    if (!result.success) {
      throw new Error(result.error || `Tool ${toolName} failed`);
    }
    return result.result as T;
  }

  // ============================================
  // Project Management
  // ============================================

  listProjects(): RegisteredProject[] {
    // Return cached value (sync method)
    return this.cache?.projects || [];
  }

  async listProjectsWithCounts(): Promise<RegisteredProject[]> {
    return this.callTool<RegisteredProject[]>('list_brain_projects', {});
  }

  async quickIngest(dirPath: string, options: QuickIngestOptions = {}): Promise<QuickIngestResult> {
    const result = await this.callTool<QuickIngestResult>('ingest_directory', {
      path: dirPath,
      project_name: options.projectName,
      include: options.include,
      exclude: options.exclude,
    });

    // Refresh cache after ingestion
    await this.refreshCache();

    return result;
  }

  async forgetPath(pathToForget: string): Promise<void> {
    await this.callTool('forget_path', { path: pathToForget });
    await this.refreshCache();
  }

  async excludeProject(projectId: string): Promise<boolean> {
    const result = await this.callTool<{ success: boolean }>('exclude_project', { project_id: projectId });
    await this.refreshCache();
    return result.success;
  }

  async includeProject(projectId: string): Promise<boolean> {
    const result = await this.callTool<{ success: boolean }>('include_project', { project_id: projectId });
    await this.refreshCache();
    return result.success;
  }

  async unregisterProject(projectId: string): Promise<boolean> {
    // Use cleanup_brain with project mode
    const result = await this.callTool<{ success: boolean }>('cleanup_brain', {
      mode: 'project',
      project_id: projectId,
      confirm: true,
    });
    await this.refreshCache();
    return result.success;
  }

  async clearProjectsRegistry(): Promise<void> {
    await this.callTool('cleanup_brain', {
      mode: 'data_only',
      confirm: true,
    });
    await this.refreshCache();
  }

  // ============================================
  // Search
  // ============================================

  async search(query: string, options: BrainSearchOptions = {}): Promise<UnifiedSearchResult> {
    return this.callTool<UnifiedSearchResult>('brain_search', {
      query,
      projects: options.projects,
      types: options.nodeTypes,
      semantic: options.semantic,
      embedding_type: options.embeddingType,
      glob: options.glob,
      limit: options.limit,
    });
  }

  async runCypher(query: string, params: Record<string, unknown> = {}): Promise<{
    success: boolean;
    records?: Array<Record<string, unknown>>;
    summary?: { counters: Record<string, number> };
    error?: string;
  }> {
    return this.callTool('run_cypher', { query, params });
  }

  // ============================================
  // File Watching
  // ============================================

  async startWatching(projectPath: string, options: { verbose?: boolean } = {}): Promise<void> {
    await this.callTool('start_watcher', {
      project_path: projectPath,
      verbose: options.verbose,
    });
    await this.refreshCache();
  }

  async stopWatching(projectPath: string): Promise<void> {
    await this.callTool('stop_watcher', { project_path: projectPath });
    await this.refreshCache();
  }

  isWatching(projectPath: string): boolean {
    // Check cached watchers
    const watchedIds = this.cache?.watchedProjects || [];
    // Generate project ID from path (simplified)
    const projectId = projectPath.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    return watchedIds.some(id => id.includes(projectId) || projectPath.includes(id));
  }

  getWatchedProjects(): string[] {
    return this.cache?.watchedProjects || [];
  }

  // ============================================
  // Ingestion Lock
  // ============================================

  getIngestionLockStatus(): IngestionStatus {
    return this.cache?.ingestionStatus || { isLocked: false, operationCount: 0, operations: [] };
  }

  /**
   * Get embedding lock status
   * Returns lock status for checking if embeddings are being generated
   */
  getEmbeddingLockStatus(): IngestionStatus {
    return this.cache?.embeddingStatus || { isLocked: false, operationCount: 0, operations: [] };
  }

  /**
   * Get lock objects compatible with ConversationStorage
   * Returns objects with isLocked() method for checking lock availability
   */
  async getLocks(): Promise<{
    embeddingLock: { isLocked: () => boolean; getDescription?: () => string };
    ingestionLock: { isLocked: () => boolean; getDescription?: () => string };
  }> {
    await this.refreshCache();
    const ingestionStatus = this.getIngestionLockStatus();
    const embeddingStatus = this.getEmbeddingLockStatus();

    return {
      embeddingLock: {
        isLocked: () => embeddingStatus.isLocked,
        getDescription: () => embeddingStatus.operations.length > 0 
          ? embeddingStatus.operations[0].description || 'Embedding generation in progress'
          : 'No embedding operations'
      },
      ingestionLock: {
        isLocked: () => ingestionStatus.isLocked,
        getDescription: () => ingestionStatus.operations.length > 0
          ? ingestionStatus.operations[0].description || 'Ingestion in progress'
          : 'No ingestion operations'
      }
    };
  }

  async waitForIngestionLock(timeoutMs: number = 300000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await this.refreshCache();
      if (!this.cache?.ingestionStatus.isLocked) {
        return true;
      }
      // Wait 500ms before checking again
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return false;
  }

  // ============================================
  // Pending Edits
  // ============================================

  hasPendingEdits(): boolean {
    return (this.cache?.pendingEditCount || 0) > 0;
  }

  async waitForPendingEdits(timeoutMs: number = 300000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await this.refreshCache();
      if ((this.cache?.pendingEditCount || 0) === 0) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return false;
  }

  queueFileChange(filePath: string, changeType: 'created' | 'updated' | 'deleted'): void {
    // Fire and forget - call dedicated endpoint (not a tool)
    fetch(`${DAEMON_URL}/queue-file-change`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, change_type: changeType }),
    }).catch(err => console.error('[DaemonBrainProxy] queueFileChange failed:', err));
  }

  getPendingEditCount(): number {
    return this.cache?.pendingEditCount || 0;
  }

  // ============================================
  // Web Ingestion
  // ============================================

  async ingestWebPage(params: {
    url: string;
    title?: string;
    textContent?: string;
    rawHtml?: string;
    projectName?: string;
    depth?: number;
    maxPages?: number;
    includePatterns?: string[];
    excludePatterns?: string[];
    generateEmbeddings?: boolean;
    force?: boolean;
  }): Promise<any> {
    // If we have pre-extracted content (from web tools), use direct endpoint
    if (params.textContent || params.rawHtml) {
      await this.ensureDaemon();
      const response = await fetch(`${DAEMON_URL}/brain/ingest-web-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: params.url,
          title: params.title,
          textContent: params.textContent,
          rawHtml: params.rawHtml,
          projectName: params.projectName,
          generateEmbeddings: params.generateEmbeddings ?? true,
        }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || `Failed to ingest web page: ${response.status}`);
      }
      return response.json();
    }

    // Otherwise use the tool (which fetches the page)
    return this.callTool('ingest_web_page', {
      url: params.url,
      project_name: params.projectName,
      depth: params.depth,
      max_pages: params.maxPages,
      include_patterns: params.includePatterns,
      exclude_patterns: params.excludePatterns,
      generate_embeddings: params.generateEmbeddings,
      force: params.force,
    });
  }

  // ============================================
  // Media Content
  // ============================================

  async updateMediaContent(params: {
    filePath: string;
    textContent?: string;
    description?: string;
    ocrConfidence?: number;
    extractionMethod?: string;
    generateEmbeddings?: boolean;
    sourceFiles?: string[];
  }): Promise<{ updated: boolean }> {
    await this.ensureDaemon();
    const response = await fetch(`${DAEMON_URL}/brain/update-media-content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      const data = await response.json() as { error?: string };
      throw new Error(data.error || `Failed to update media content: ${response.status}`);
    }
    return response.json() as Promise<{ updated: boolean }>;
  }

  // ============================================
  // Config
  // ============================================

  getBrainPath(): string {
    return this.cache?.brainPath || '';
  }

  getConfig(): any {
    return this.cache?.config || {};
  }

  getGeminiKey(): string | undefined {
    return this.cache?.config?.geminiApiKey;
  }

  // ============================================
  // Persona Management
  // ============================================

  async getActivePersona(): Promise<{
    id: string;
    name: string;
    color: string;
    language: string;
    persona: string;
    description: string;
    isDefault: boolean;
  }> {
    await this.ensureDaemon();
    const response = await fetch(`${DAEMON_URL}/persona/active`);
    if (!response.ok) {
      throw new Error(`Failed to get active persona: ${response.status}`);
    }
    return response.json() as Promise<{
      id: string;
      name: string;
      color: string;
      language: string;
      persona: string;
      description: string;
      isDefault: boolean;
    }>;
  }

  async listPersonas(): Promise<Array<{
    id: string;
    name: string;
    color: string;
    language: string;
    persona: string;
    description: string;
    isDefault: boolean;
  }>> {
    await this.ensureDaemon();
    const response = await fetch(`${DAEMON_URL}/persona/list`);
    if (!response.ok) {
      throw new Error(`Failed to list personas: ${response.status}`);
    }
    const data = await response.json() as { personas: any[] };
    return data.personas;
  }

  async setActivePersona(idOrNameOrIndex: string | number): Promise<{
    id: string;
    name: string;
    color: string;
    language: string;
    persona: string;
    description: string;
    isDefault: boolean;
  }> {
    await this.ensureDaemon();
    const response = await fetch(`${DAEMON_URL}/persona/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: idOrNameOrIndex }),
    });
    if (!response.ok) {
      const data = await response.json() as { error?: string };
      throw new Error(data.error || `Failed to set persona: ${response.status}`);
    }
    return response.json() as Promise<{
      id: string;
      name: string;
      color: string;
      language: string;
      persona: string;
      description: string;
      isDefault: boolean;
    }>;
  }

  async createEnhancedPersona(params: {
    name: string;
    color: string;
    language: string;
    description: string;
  }): Promise<{
    id: string;
    name: string;
    color: string;
    language: string;
    persona: string;
    description: string;
    isDefault: boolean;
  }> {
    await this.ensureDaemon();
    const response = await fetch(`${DAEMON_URL}/persona/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      const data = await response.json() as { error?: string };
      throw new Error(data.error || `Failed to create persona: ${response.status}`);
    }
    return response.json() as Promise<{
      id: string;
      name: string;
      color: string;
      language: string;
      persona: string;
      description: string;
      isDefault: boolean;
    }>;
  }

  async deletePersona(name: string): Promise<void> {
    await this.ensureDaemon();
    const response = await fetch(`${DAEMON_URL}/persona/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) {
      const data = await response.json() as { error?: string };
      throw new Error(data.error || `Failed to delete persona: ${response.status}`);
    }
  }

  // ============================================
  // Proxy-specific methods
  // ============================================

  /**
   * Get the underlying IngestionLock - NOT AVAILABLE via proxy
   * Tools should use getIngestionLockStatus() instead
   */
  getIngestionLock(): never {
    throw new Error(
      'getIngestionLock() is not available via proxy. ' +
      'Use getIngestionLockStatus() or waitForIngestionLock() instead.'
    );
  }

  /**
   * Get watcher for a project - NOT AVAILABLE via proxy
   * Watchers only exist in daemon process
   */
  getWatcher(_projectPath: string): never {
    throw new Error(
      'getWatcher() is not available via proxy. ' +
      'Watchers run in daemon process only.'
    );
  }

  /**
   * Get Neo4j client - NOT AVAILABLE via proxy
   * Use runCypher() instead
   */
  getNeo4jClient(): never {
    throw new Error(
      'getNeo4jClient() is not available via proxy. ' +
      'Use runCypher() for database queries.'
    );
  }
}

/**
 * Singleton instance
 */
let proxyInstance: DaemonBrainProxy | null = null;

/**
 * Get the singleton DaemonBrainProxy instance
 */
export async function getDaemonBrainProxy(): Promise<DaemonBrainProxy> {
  if (!proxyInstance) {
    proxyInstance = new DaemonBrainProxy();
    await proxyInstance.initialize();
  }
  return proxyInstance;
}

/**
 * Check if we should use the daemon proxy
 * Returns true if daemon is running or can be started
 */
export async function shouldUseDaemonProxy(): Promise<boolean> {
  // Always prefer daemon if it's running or we can start it
  return true;
}
