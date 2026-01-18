# GitHub Ingestion via MCP

## Objectif

Permettre l'ingestion de repositories GitHub via un outil MCP qui:
1. Expose une interface simple au daemon MCP (`ingest_github`)
2. Implémente la logique dans un service réutilisable par community-docs
3. Utilise **UnifiedProcessor** pour le pipeline complet (parsing → entities → embeddings)
4. Supporte l'incrémentalité sur les fichiers "virtuels" (non locaux)
5. Route automatiquement vers `sync` si le projet existe déjà

---

## Architecture Actuelle

### Ce qui existe déjà

```
┌─────────────────────────────────────────────────────────────────┐
│                        community-docs                           │
├─────────────────────────────────────────────────────────────────┤
│  app/api/ingest/github/route.ts                                 │
│  └─ POST /ingest/github                                         │
│     └─ Crée Document (PENDING) → TODO: background job           │
│                                                                 │
│  lib/ragforge/api/server.ts                                     │
│  └─ cloneGitHubRepo() - clone avec git                          │
│  └─ getCodeFilesFromDir() - collecte les fichiers               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       ragforge-core                             │
├─────────────────────────────────────────────────────────────────┤
│  src/tools/brain-tools.ts                                       │
│  └─ ingest_directory - ingère un dossier local                  │
│  └─ ingest_web_page - crawl une page web                        │
│                                                                 │
│  src/runtime/adapters/                                          │
│  └─ universal-source-adapter.ts - routeur vers adapters         │
│  └─ types.ts - VirtualFile, SourceConfig                        │
│  └─ incremental-ingestion.ts - hash comparison                  │
│                                                                 │
│  src/brain/                                                     │
│  └─ file-processor.ts - pipeline de traitement                  │
│  └─ file-state-machine.ts - états d'ingestion                   │
└─────────────────────────────────────────────────────────────────┘
```

### Support des fichiers virtuels

L'architecture supporte déjà les fichiers virtuels (`type: 'virtual'`):

```typescript
interface VirtualFile {
  path: string;           // "/repo/src/index.ts"
  content: Buffer | string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

// Utilisation
await adapter.parse({
  source: {
    type: 'virtual',
    virtualFiles: [...],
    root: '/repo',
  },
  projectId: 'github-owner-repo',
});
```

---

## Architecture Cible

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           MCP Client (Claude Code)                        │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                           ingest_github(url, options)
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                        MCP Server (ragforge-core)                         │
├───────────────────────────────────────────────────────────────────────────┤
│  src/tools/brain-tools.ts                                                 │
│  └─ ingest_github                                                         │
│     └─ Check if project exists → route to sync if yes                     │
│     └─ Appelle GitHubIngestionService.ingest() ou .sync()                 │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                        GitHubIngestionService                             │
│                   (src/services/github-ingestion.ts)                      │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  1. Parse URL → owner/repo/branch/path                                    │
│  2. Clone repo (avec submodules par défaut)                               │
│  3. Collecte fichiers → VirtualFile[]                                     │
│  4. Appeler UnifiedProcessor.processVirtualFiles()                        │
│  5. Cleanup temp directory                                                │
│  6. Retourner stats                                                       │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                          UnifiedProcessor                                 │
│                   (src/ingestion/unified-processor.ts)                    │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  processVirtualFiles(files: VirtualFile[]):                               │
│    1. Parse via UniversalSourceAdapter (type: 'virtual')                  │
│    2. Create/Update File + Scope nodes                                    │
│    3. Extract entities (GLiNER)                                           │
│    4. Generate embeddings                                                 │
│    5. Track state transitions (discovered → embedded)                     │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                               Neo4j                                       │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  (Project:github-owner-repo)                                              │
│      │                                                                    │
│      └──[:HAS_FILE]──> (File {virtualPath, gitBlobSha, sourceType, ...})  │
│                            │                                              │
│                            └──[:DEFINED_IN]──< (Scope)                    │
│                                     │                                     │
│                                     └──[:MENTIONS]──> (Entity)            │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Plan d'Implémentation

### Phase 1: GitHubIngestionService

**Fichier**: `src/services/github-ingestion.ts`

```typescript
interface GitHubIngestionOptions {
  url: string;                    // https://github.com/owner/repo ou owner/repo
  branch?: string;                // default: main
  path?: string;                  // sous-dossier optionnel
  includePatterns?: string[];     // glob patterns à inclure
  excludePatterns?: string[];     // glob patterns à exclure
  includeSubmodules?: boolean;    // default: true - clone avec --recurse-submodules
  shallow?: boolean;              // default: true (--depth 1)
  generateEmbeddings?: boolean;   // default: true
}

interface GitHubIngestionResult {
  projectId: string;              // "github-owner-repo"
  wasSync: boolean;               // true si projet existait déjà (routed to sync)
  stats: {
    filesProcessed: number;
    filesSkipped: number;         // unchanged (incremental)
    filesErrored: number;
    nodesCreated: number;
    entitiesExtracted: number;
    embeddingsGenerated: number;
  };
  commitSha?: string;             // SHA du commit ingéré
}

class GitHubIngestionService {
  constructor(
    private neo4jClient: Neo4jClient,
    private unifiedProcessor: UnifiedProcessor,  // Utilise UnifiedProcessor!
    private brainManager: BrainManager,
  ) {}

  /**
   * Ingest ou sync un repo GitHub.
   * Si le projectId existe déjà, route automatiquement vers sync().
   */
  async ingest(options: GitHubIngestionOptions): Promise<GitHubIngestionResult>;

  /**
   * Sync un projet GitHub existant (mise à jour incrémentale).
   */
  async sync(projectId: string): Promise<GitHubIngestionResult>;

  /**
   * Vérifie si un projet existe dans la DB.
   */
  async projectExists(projectId: string): Promise<boolean>;
}
```

**Implémentation du clone avec submodules**:

```typescript
private async cloneRepository(
  owner: string,
  repo: string,
  branch: string,
  options: { includeSubmodules?: boolean; shallow?: boolean }
): Promise<{ tempDir: string; commitSha: string }> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ragforge-github-'));

  const args = ['clone'];

  // Shallow clone par défaut (--depth 1)
  if (options.shallow !== false) {
    args.push('--depth', '1');
  }

  // Submodules par défaut (--recurse-submodules)
  if (options.includeSubmodules !== false) {
    args.push('--recurse-submodules');
    if (options.shallow !== false) {
      args.push('--shallow-submodules');
    }
  }

  args.push('--branch', branch);
  args.push(`https://github.com/${owner}/${repo}.git`);
  args.push(tempDir);

  await execAsync(`git ${args.join(' ')}`);

  // Get commit SHA
  const { stdout: commitSha } = await execAsync('git rev-parse HEAD', { cwd: tempDir });

  return { tempDir, commitSha: commitSha.trim() };
}
```

**Auto-routing logic dans `ingest()`**:

```typescript
async ingest(options: GitHubIngestionOptions): Promise<GitHubIngestionResult> {
  const { owner, repo, branch, path } = this.parseGitHubUrl(options.url);
  const projectId = `github-${owner}-${repo}`;

  // Auto-route to sync if project exists
  if (await this.projectExists(projectId)) {
    const result = await this.sync(projectId);
    return { ...result, wasSync: true };
  }

  // First-time ingestion
  const { tempDir, commitSha } = await this.cloneRepository(owner, repo, branch ?? 'main', {
    includeSubmodules: options.includeSubmodules ?? true,
    shallow: options.shallow ?? true,
  });

  try {
    const files = await this.collectFiles(tempDir, options);
    const virtualFiles = this.convertToVirtualFiles(files, tempDir);

    // Use UnifiedProcessor for full pipeline
    const stats = await this.unifiedProcessor.processVirtualFiles(virtualFiles, {
      projectId,
      generateEmbeddings: options.generateEmbeddings ?? true,
    });

    return { projectId, wasSync: false, stats, commitSha };
  } finally {
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
```

**Tâches**:
- [ ] Créer `GitHubIngestionService`
- [ ] Implémenter `parseGitHubUrl()` - extraire owner/repo/branch/path
- [ ] Implémenter `cloneRepository()` - clone avec submodules
- [ ] Implémenter `collectFiles()` - collecte fichiers depuis clone
- [ ] Implémenter `convertToVirtualFiles()` - transformation
- [ ] Implémenter `ingest()` - orchestration avec auto-routing vers sync
- [ ] Implémenter `sync()` - mise à jour incrémentale
- [ ] Implémenter `projectExists()` - check si projet existe

---

### Phase 2: Incrémentalité pour fichiers virtuels

**Problème**: L'incrémentalité actuelle compare le hash du fichier sur disque avec celui en DB. Pour les fichiers virtuels (GitHub), il n'y a pas de fichier local.

**Solution**: Utiliser le `git blob SHA` ou le hash du contenu comme identifiant unique.

**Propriétés Neo4j à ajouter sur File**:
```
f.virtualPath: string         // /repo/src/index.ts (path virtuel)
f.sourceType: 'local' | 'github' | 'virtual'
f.gitBlobSha: string          // SHA du blob git (si GitHub)
f.remoteUrl: string           // URL source (si remote)
f.lastSyncedAt: datetime      // Dernier sync
f.remoteSha: string           // Commit SHA au moment du sync
```

**Algorithme d'incrémentalité GitHub**:

```typescript
async function syncGitHubProject(projectId: string, owner: string, repo: string) {
  // 1. Récupérer le tree du repo via GitHub API
  const tree = await fetchGitHubTree(owner, repo);

  // 2. Récupérer les fichiers existants en DB
  const existingFiles = await neo4j.query(`
    MATCH (f:File {projectId: $projectId})
    RETURN f.virtualPath, f.gitBlobSha
  `);

  // 3. Comparer
  const toAdd: string[] = [];      // nouveaux fichiers
  const toUpdate: string[] = [];   // fichiers modifiés (SHA différent)
  const toDelete: string[] = [];   // fichiers supprimés

  for (const item of tree) {
    const existing = existingFiles.find(f => f.virtualPath === item.path);
    if (!existing) {
      toAdd.push(item.path);
    } else if (existing.gitBlobSha !== item.sha) {
      toUpdate.push(item.path);
    }
  }

  for (const existing of existingFiles) {
    if (!tree.find(t => t.path === existing.virtualPath)) {
      toDelete.push(existing.virtualPath);
    }
  }

  // 4. Traiter les changements
  await deleteFiles(toDelete);
  await processFiles([...toAdd, ...toUpdate]);
}
```

**Tâches**:
- [ ] Ajouter propriétés `virtualPath`, `sourceType`, `gitBlobSha` sur File
- [ ] Modifier `FileProcessor.createNodesBatch()` pour supporter les fichiers virtuels
- [ ] Implémenter `compareWithGitHub()` dans GitHubIngestionService
- [ ] Ajouter méthode `GitHubIngestionService.sync()` pour mise à jour incrémentale

---

### Phase 3: Outil MCP

**Fichier**: `src/tools/brain-tools.ts`

**Définition**:
```typescript
{
  name: 'ingest_github',
  description: `Ingest a GitHub repository into the agent's brain.

Use this to add a GitHub repository to your knowledge base.
Supports incremental updates - if the repository was already ingested,
this will automatically sync only changed files.

Uses clone with submodules by default for complete repository ingestion.

Parameters:
- url: GitHub URL (https://github.com/owner/repo) or shorthand (owner/repo)
- branch: Branch to ingest (default: main)
- path: Subdirectory to ingest (optional, e.g., "src/lib")
- include: Glob patterns to include (e.g., ["**/*.ts", "**/*.md"])
- exclude: Glob patterns to exclude (e.g., ["**/test/**", "**/*.test.ts"])
- include_submodules: Clone with submodules (default: true)
- generate_embeddings: Generate embeddings for search (default: true)

Example: ingest_github({ url: "vercel/next.js", path: "packages/next/src" })`,

  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'GitHub URL or owner/repo' },
      branch: { type: 'string', description: 'Branch (default: main)' },
      path: { type: 'string', description: 'Subdirectory path' },
      include: { type: 'array', items: { type: 'string' } },
      exclude: { type: 'array', items: { type: 'string' } },
      include_submodules: { type: 'boolean', default: true, description: 'Clone with submodules' },
      generate_embeddings: { type: 'boolean', default: true },
    },
    required: ['url'],
  },
}
```

**Handler**:
```typescript
async function handleIngestGitHub(args: {
  url: string;
  branch?: string;
  path?: string;
  include?: string[];
  exclude?: string[];
  include_submodules?: boolean;
  generate_embeddings?: boolean;
}) {
  const service = brain.getGitHubIngestionService();

  // Auto-routes to sync if project exists
  const result = await service.ingest({
    url: args.url,
    branch: args.branch,
    path: args.path,
    includePatterns: args.include,
    excludePatterns: args.exclude,
    includeSubmodules: args.include_submodules ?? true,  // default: true
    generateEmbeddings: args.generate_embeddings ?? true,
  });

  const action = result.wasSync ? 'Synced' : 'Ingested';

  return {
    success: true,
    projectId: result.projectId,
    wasSync: result.wasSync,
    stats: result.stats,
    commitSha: result.commitSha,
    message: `${action} ${result.stats.filesProcessed} files from GitHub` +
             (result.stats.filesSkipped > 0
               ? ` (${result.stats.filesSkipped} unchanged)`
               : ''),
  };
}
```

**Tâches**:
- [ ] Ajouter définition `ingest_github` dans brain-tools.ts
- [ ] Implémenter handler avec auto-routing
- [ ] Ajouter au mapping MCP

---

### Phase 4: Outil MCP de mise à jour (optionnel)

> **Note**: Avec l'auto-routing de `ingest_github`, cet outil est optionnel.
> Il permet juste un accès direct à sync par projectId si besoin.

**Définition**:
```typescript
{
  name: 'sync_github',
  description: `Sync a previously ingested GitHub repository by project ID.

Note: You can also just call ingest_github again - it auto-routes to sync.
This tool is for when you only have the project ID.

Parameters:
- project_id: Project ID from previous ingestion (e.g., "github-owner-repo")

Example: sync_github({ project_id: "github-vercel-next.js" })`,

  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string', description: 'Project ID to sync' },
    },
    required: ['project_id'],
  },
}
```

**Tâches**:
- [ ] Ajouter définition `sync_github` dans brain-tools.ts (optionnel)
- [ ] Implémenter handler

---

### Phase 5: Intégration community-docs

**Fichier**: `lib/ragforge/github-adapter.ts`

```typescript
import { GitHubIngestionService } from '@luciformresearch/ragforge';

export class CommunityGitHubAdapter {
  constructor(
    private githubService: GitHubIngestionService,
    private prisma: PrismaClient,
  ) {}

  async ingestRepository(
    documentId: string,
    githubUrl: string,
    metadata: CommunityNodeMetadata,
  ): Promise<void> {
    // 1. Update document status to PROCESSING
    await this.prisma.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING' },
    });

    try {
      // 2. Ingest via ragforge-core service
      const result = await this.githubService.ingest({
        url: githubUrl,
        // Inject community metadata into all nodes
        nodeMetadata: metadata,
      });

      // 3. Update document with result
      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'READY',
          ragforgeProjectId: result.projectId,
          lastSyncedAt: new Date(),
          metadata: {
            commitSha: result.commitSha,
            filesCount: result.stats.filesProcessed,
          },
        },
      });
    } catch (error) {
      // 4. Mark as failed
      await this.prisma.document.update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          error: error.message,
        },
      });
      throw error;
    }
  }

  async syncRepository(documentId: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
    });

    if (!doc?.ragforgeProjectId) {
      throw new Error('Document not ingested');
    }

    const result = await this.githubService.sync(doc.ragforgeProjectId);

    await this.prisma.document.update({
      where: { id: documentId },
      data: {
        lastSyncedAt: new Date(),
        metadata: {
          ...doc.metadata,
          commitSha: result.commitSha,
        },
      },
    });
  }
}
```

**Tâches**:
- [ ] Créer `CommunityGitHubAdapter` dans community-docs
- [ ] Modifier `app/api/ingest/github/route.ts` pour utiliser l'adapter
- [ ] Ajouter job queue pour ingestion en background (Inngest/Bull)
- [ ] Ajouter endpoint de sync `/api/documents/[id]/sync`

---

## Détails Techniques

### Parsing d'URL GitHub

```typescript
function parseGitHubUrl(input: string): {
  owner: string;
  repo: string;
  branch?: string;
  path?: string;
} {
  // Formats supportés:
  // - owner/repo
  // - https://github.com/owner/repo
  // - https://github.com/owner/repo/tree/branch
  // - https://github.com/owner/repo/tree/branch/path/to/dir
  // - git@github.com:owner/repo.git

  const patterns = [
    // owner/repo (shorthand)
    /^([^\/]+)\/([^\/]+)$/,
    // https://github.com/owner/repo
    /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/,
    // https://github.com/owner/repo/tree/branch
    /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/]+)$/,
    // https://github.com/owner/repo/tree/branch/path
    /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/tree\/([^\/]+)\/(.+)$/,
    // git@github.com:owner/repo.git
    /^git@github\.com:([^\/]+)\/([^\/]+?)(?:\.git)?$/,
  ];

  // Match and extract owner/repo/branch/path...
}
```

### Clone avec submodules

L'implémentation utilise `git clone` avec les options suivantes par défaut:

```bash
git clone \
  --depth 1 \                    # Shallow clone (plus rapide)
  --recurse-submodules \         # Inclut les submodules
  --shallow-submodules \         # Submodules aussi en shallow
  --branch main \                # Branch spécifiée
  https://github.com/owner/repo.git \
  /tmp/ragforge-github-xxx
```

**Avantages du clone vs API GitHub**:
- Pas de rate limit
- Tous les fichiers d'un coup
- Supporte les gros repos
- Supporte les submodules nativement

**Note**: L'API GitHub pourra être ajoutée plus tard si besoin (serverless, repos privés avec token).

---

## Schéma Neo4j

### Modifications au modèle File

```cypher
// Nouvelles propriétés sur File
(:File {
  // ... propriétés existantes ...

  // Nouvelles propriétés pour fichiers virtuels/GitHub
  sourceType: 'local' | 'github' | 'virtual',
  virtualPath: '/path/in/repo',        // Path sans absolutePath
  remoteUrl: 'https://github.com/...',
  gitBlobSha: 'abc123...',             // SHA du blob pour incrémentalité
  gitCommitSha: 'def456...',           // SHA du commit au sync
  lastSyncedAt: datetime(),
})
```

### Nouveau nœud GitHubRepository (optionnel)

```cypher
(:GitHubRepository {
  projectId: 'github-owner-repo',
  owner: 'owner',
  repo: 'repo',
  branch: 'main',
  path: '/src',                         // Sous-dossier si spécifié
  lastCommitSha: 'abc123...',
  lastSyncedAt: datetime(),
  fileCount: 150,
  stars: 1234,                          // Metadata optionnelle
  description: '...',
})

// Relations
(:GitHubRepository)-[:HAS_FILE]->(:File)
(:Project)-[:GITHUB_REPO]->(:GitHubRepository)
```

---

## Tests

### Tests unitaires

```typescript
describe('GitHubIngestionService', () => {
  describe('parseGitHubUrl', () => {
    it('should parse owner/repo format');
    it('should parse full URL with branch');
    it('should parse URL with path');
    it('should handle git@ URLs');
  });

  describe('cloneRepository', () => {
    it('should clone with submodules by default');
    it('should clone without submodules when disabled');
    it('should use shallow clone by default');
    it('should clone specific branch');
  });

  describe('ingest', () => {
    it('should clone and ingest a public repo');
    it('should filter files by include/exclude patterns');
    it('should auto-route to sync if project exists');
    it('should return wasSync=true when syncing');
  });

  describe('sync', () => {
    it('should detect new files');
    it('should detect modified files (gitBlobSha changed)');
    it('should detect deleted files');
    it('should skip unchanged files');
  });
});
```

### Test E2E

```typescript
// scripts/test-github-ingestion-mcp.ts
async function testGitHubIngestionMCP() {
  // 1. Ingest un repo (première fois)
  const result = await callTool('ingest_github', {
    url: 'octocat/hello-world',
    include_submodules: true,  // default
  });

  assert(result.wasSync === false, 'First ingestion should not be sync');
  console.log(`Ingested ${result.stats.filesProcessed} files`);

  // 2. Vérifier les nodes créés
  const nodes = await neo4j.query(`
    MATCH (f:File {projectId: $projectId})
    RETURN count(f) as fileCount
  `, { projectId: result.projectId });

  // 3. Re-ingest (should auto-route to sync)
  const syncResult = await callTool('ingest_github', {
    url: 'octocat/hello-world',  // Same URL
  });

  assert(syncResult.wasSync === true, 'Should auto-route to sync');
  assert(syncResult.stats.filesSkipped > 0, 'Should skip unchanged files');
  console.log(`Synced: ${syncResult.stats.filesProcessed} changed, ${syncResult.stats.filesSkipped} unchanged`);
}
```

---

## Timeline Estimée

| Phase | Description | Effort |
|-------|-------------|--------|
| 1 | GitHubIngestionService (clone + submodules) | 2-3h |
| 2 | Incrémentalité fichiers virtuels (gitBlobSha) | 2-3h |
| 3 | Outil MCP `ingest_github` avec auto-routing | 1-2h |
| 4 | Outil MCP `sync_github` (optionnel) | 0.5h |
| 5 | Intégration community-docs | 2-3h |
| - | Tests | 2h |
| **Total** | | **10-14h** |

> **Scope simplifié**: Clone only (pas d'API GitHub), pas d'auto-sync/webhooks.

---

## Questions Ouvertes

1. **Gros repos**: Pour des repos comme `torvalds/linux`, le clone peut prendre du temps. Faut-il un timeout? Un progress callback?

2. **Repos privés**: Comment gérer l'authentification? Token dans les options? Credential store? (plus tard)

3. **Monorepos**: L'option `path` permet de cibler un sous-dossier (e.g., `vercel/next.js` avec `path: "packages/next"`). Est-ce suffisant?

4. **Cleanup automatique**: Faut-il supprimer le temp dir immédiatement ou le garder en cache pour accelerer les syncs?

---

## Prochaines Étapes

1. **Valider cette spec** ✓
2. **Phase 1**: Créer `GitHubIngestionService` avec clone + submodules
   - Réutiliser le code de clone de community-docs si possible
   - Intégrer avec UnifiedProcessor
3. **Phase 2**: Implémenter l'incrémentalité (gitBlobSha)
4. **Phase 3**: Outil MCP `ingest_github` avec auto-routing
5. **Tester avec un repo simple** (e.g., `octocat/hello-world`)
6. **Phase 5**: Intégrer dans community-docs pour remplacer l'ancienne logique
