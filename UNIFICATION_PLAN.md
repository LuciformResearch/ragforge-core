# Plan d'Unification: UnifiedProcessor

## Objectif

Remplacer les 5 chemins d'ingestion actuels par **un seul processeur unifié** avec:
- **2 entry points** au lieu de 3 (binary + virtual)
- State machines pour audit/recovery
- Vision/OCR intégrés dans ragforge-core

---

## État Actuel (2026-01-16)

### ✅ Phase 1 Complète - UnifiedProcessor Créé

| Fichier | Statut |
|---------|--------|
| `src/ingestion/unified-processor.ts` | ✅ Créé |
| `src/ingestion/processing-loop.ts` | ✅ Créé |
| `src/ingestion/state-types.ts` | ✅ Modifié (état 'entities') |
| `src/brain/file-state-machine.ts` | ✅ Modifié (état 'entities' + markDiscovered) |
| `src/ingestion/node-state-machine.ts` | ✅ Modifié (entitiesAt) |

### ✅ Phase 3 Complète - Intégration BrainManager

| Changement | Statut |
|------------|--------|
| Imports UnifiedProcessor/ProcessingLoop | ✅ |
| Propriétés per-project Maps | ✅ |
| `getOrCreateUnifiedProcessor(projectId)` | ✅ |
| `getOrCreateProcessingLoop(projectId)` | ✅ |
| `getOrCreateFileStateMachine()` | ✅ |
| `getProjectIdForPath()` | ✅ |
| `waitForProcessingComplete()` | ✅ |
| Méthodes lifecycle start/stop | ✅ |
| `startWatching()` utilise ProcessingLoop | ✅ |
| Build réussi | ✅ |

### ✅ Phase 4 Complète - Détecteurs

| Changement | Statut |
|------------|--------|
| FileWatcher réécrit en mode détecteur | ✅ |
| `FileStateMachine.markDiscovered()` ajouté | ✅ |
| `FileStateMachine.markDiscoveredBatch()` ajouté | ✅ |
| `brain-tools.ts` mis à jour | ✅ |
| TouchedFilesWatcher déjà compatible | ✅ |

---

## Problème: 3 Chemins Séparés dans Community-Docs

```
CommunityIngestionService (community-docs)
│
├── ingestBinaryDocument()  → documentParser (PDF, DOCX, XLSX)
│   └── Vision optionnelle pour OCR
│
├── ingestMedia()           → mediaParser (images, 3D)
│   └── Vision optionnelle pour description
│   └── Écrit en fichier temp (hack)
│
└── ingestVirtual()         → orchestrator (text/code)
    └── Pas de vision
```

**Observations**:
1. `ingestBinaryDocument` et `ingestMedia` font **exactement la même chose**
2. La seule différence est le parser utilisé (basé sur extension)
3. Le ParserRegistry de ragforge-core sait déjà router vers le bon parser
4. Community-docs duplique la logique de routing

---

## Solution: 2 Entry Points Unifiés

### Architecture Cible

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ragforge-core                                    │
│                      UnifiedProcessor                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  processBinaryFile(buffer, filePath, options)                           │
│  ├── Auto-détecte via ParserRegistry:                                   │
│  │   - .pdf, .docx, .xlsx → documentParser                              │
│  │   - .png, .jpg, .gif   → mediaParser (ImageFile)                     │
│  │   - .glb, .gltf        → mediaParser (ThreeDFile)                    │
│  │                                                                       │
│  └── Options unifiées:                                                  │
│      - enableVision: boolean                                            │
│      - visionAnalyzer: (buffer, prompt?) => Promise<string>             │
│      - render3D: (path) => Promise<{view, buffer}[]>                    │
│      - sectionTitles: 'detect' | 'llm' | 'none'                         │
│      - maxPages: number                                                 │
│      - titleGenerator: callback                                         │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  processVirtualFiles(files: VirtualFile[], options)                     │
│  ├── Auto-détecte via ParserRegistry:                                   │
│  │   - .ts, .js, .py      → codeParser                                  │
│  │   - .md                → markdownParser                              │
│  │   - .json, .yaml       → dataParser                                  │
│  │                                                                       │
│  └── Options:                                                           │
│      - transformGraph: hook pour metadata custom                        │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  State Machine Pipeline (via ProcessingLoop):                           │
│  discovered → parsing → parsed → linking → linked →                     │
│  entities → embedding → embedded                                         │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Détecteurs (FileWatcher, TouchedFilesWatcher):                         │
│  - Détectent les changements de fichiers                                │
│  - Appellent fileStateMachine.markDiscovered()                          │
│  - Ne font PAS le processing (délégué à ProcessingLoop)                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         community-docs                                   │
│                    (Simplifié - juste un wrapper)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  CommunityIngestionService                                              │
│  │                                                                       │
│  ├── ingest(files)                                                      │
│  │   └── Route automatiquement:                                         │
│  │       - Binary → ragforge.processBinaryFile()                        │
│  │       - Text   → ragforge.processVirtualFiles()                      │
│  │                                                                       │
│  └── Injecte metadata community via transformGraph hook                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## API Proposée: ragforge-core

### 1. processBinaryFile()

```typescript
interface BinaryProcessOptions {
  /** Project ID for Neo4j */
  projectId: string;

  /** Enable Vision/OCR analysis (default: false) */
  enableVision?: boolean;

  /** Vision analyzer callback (required if enableVision=true) */
  visionAnalyzer?: (imageBuffer: Buffer, prompt?: string) => Promise<string>;

  /** 3D model renderer callback (for .glb/.gltf files) */
  render3D?: (modelBuffer: Buffer) => Promise<Array<{ view: string; buffer: Buffer }>>;

  /** Section title detection mode (for documents, default: 'detect') */
  sectionTitles?: 'none' | 'detect' | 'llm';

  /** Maximum pages to process (for documents) */
  maxPages?: number;

  /** Generate titles for untitled sections via LLM */
  generateTitles?: boolean;

  /** Custom title generator callback */
  titleGenerator?: (sections: Array<{ index: number; content: string }>) => Promise<Array<{ index: number; title: string }>>;

  /** Hook called after parsing, before saving - for injecting custom metadata */
  transformGraph?: (graph: ParsedGraph) => ParsedGraph | Promise<ParsedGraph>;
}

interface ProcessResult {
  nodesCreated: number;
  relationshipsCreated: number;
  warnings?: string[];
  /** File state after processing */
  finalState: 'ready' | 'error';
}

class UnifiedProcessor {
  /**
   * Process a binary file (PDF, DOCX, images, 3D models, etc.)
   * Auto-detects file type and uses appropriate parser.
   */
  async processBinaryFile(
    buffer: Buffer,
    filePath: string,
    options: BinaryProcessOptions
  ): Promise<ProcessResult>;
}
```

### 2. processVirtualFiles()

```typescript
interface VirtualFile {
  path: string;
  content: string; // Text content (UTF-8)
}

interface VirtualProcessOptions {
  /** Project ID for Neo4j */
  projectId: string;

  /** Hook called after parsing, before saving */
  transformGraph?: (graph: ParsedGraph) => ParsedGraph | Promise<ParsedGraph>;

  /** Generate embeddings after ingestion (default: true) */
  generateEmbeddings?: boolean;
}

class UnifiedProcessor {
  /**
   * Process virtual files (text/code content in memory).
   * Auto-detects file type and uses appropriate parser.
   */
  async processVirtualFiles(
    files: VirtualFile[],
    options: VirtualProcessOptions
  ): Promise<ProcessResult>;
}
```

---

## Mapping des Extensions

Le `ParserRegistry` gère déjà tout:

| Extension | Parser | Node Type |
|-----------|--------|-----------|
| `.pdf` | documentParser | MarkdownDocument + MarkdownSection |
| `.docx`, `.doc` | documentParser | MarkdownDocument + MarkdownSection |
| `.xlsx`, `.xls` | documentParser | SpreadsheetDocument |
| `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.svg` | mediaParser | ImageFile |
| `.glb`, `.gltf` | mediaParser | ThreeDFile |
| `.ts`, `.tsx`, `.js`, `.jsx` | codeParser | Scope |
| `.py` | codeParser | Scope |
| `.md` | markdownParser | MarkdownDocument + MarkdownSection |
| `.json`, `.yaml` | dataParser | DataFile |

---

## ⚠️ RÈGLE ABSOLUE: Normalisation des Propriétés

Tous les nodes DOIVENT avoir:

| Propriété | Semantic Search | Fulltext Lucene | Exemple |
|-----------|-----------------|-----------------|---------|
| `_name` | ✅ embedding_name | ✅ index_name | `"AuthService"` |
| `_content` | ✅ embedding_content | ✅ index_content | Code source |
| `_description` | ✅ embedding_description | ✅ index_description | Docstring |

**Chunking pour gros contenus**:
Quand `_content` > 3000 chars → créer `EmbeddingChunk` avec `HAS_EMBEDDING_CHUNK`.

---

## Plan de Migration

### ✅ Phase 1: Créer UnifiedProcessor (COMPLÈTE)

- [x] `src/ingestion/unified-processor.ts` créé
- [x] `src/ingestion/processing-loop.ts` créé
- [x] État 'entities' ajouté aux state machines
- [x] Exports ajoutés

### Phase 2: Ajouter processBinaryFile() et processVirtualFiles()

- [ ] Auto-détection via `parserRegistry.getParserForFile()`
- [ ] Passer options selon type (document vs media)
- [ ] Appeler `transformGraph` hook si fourni
- [ ] Modifier mediaParser pour accepter buffers directement

### ✅ Phase 3: Intégrer dans BrainManager (COMPLÈTE)

- [x] Maps per-project: `_unifiedProcessors`, `_processingLoops`
- [x] Factory methods
- [x] Lifecycle methods
- [x] `startWatching()` utilise ProcessingLoop
- [x] `waitForProcessingComplete()` ajouté

### ✅ Phase 4: Adapter les Détecteurs (COMPLÈTE)

#### ✅ FileWatcher
- [x] Réécrit en mode détecteur only
- [x] Supprimé dépendances à IngestionQueue/IncrementalIngestionManager
- [x] Utilise `FileStateMachine.markDiscoveredBatch()`
- [x] Émet événements: 'ready', 'batch', 'error', etc.

#### ✅ TouchedFilesWatcher (Déjà Compatible)
- [x] **Évaluation complète**: Utilise déjà FileStateMachine et FileProcessor
- [x] **Conclusion**: Aucune modification nécessaire
- N'est pas un "détecteur" mais un processeur pour fichiers orphelins
- Gère son propre projectId ('touched-files') sans conflit avec ProcessingLoop
- Pipeline identique: discovered → linked → embedded

### ✅ Phase 5: Unification des Indexes (COMPLÈTE)

#### ✅ ragforge-core: `src/brain/ensure-indexes.ts` créé

```typescript
// Fonctions exportées:
ensureBaseIndexes(neo4jClient)      // UUID, projectId, absolutePath, state
ensureFulltextIndexes(neo4jClient)  // unified_fulltext
ensureVectorIndexes(neo4jClient)    // MULTI_EMBED_CONFIGS based
ensureConversationIndexes(neo4jClient) // Conversation/Message/Summary
ensureAllIndexes(neo4jClient)       // All-in-one

// Labels indexés:
UUID_INDEXED_LABELS  // 26 labels (Scope, File, Entity, EmbeddingChunk, ExternalLibrary, etc.)
FULLTEXT_LABELS      // 22 labels pour unified_fulltext
ABSOLUTE_PATH_LABELS // 9 labels
```

#### ✅ BrainManager mis à jour
- [x] Import `ensureBaseIndexes`, `ensureFulltextIndexes`, `ensureVectorIndexesCentralized`
- [x] `ensureIndexes()` simplifié - appelle les fonctions centralisées
- [x] Supprimé ~100 lignes de code dupliqué

#### ✅ community-docs mis à jour
- [x] Import `ensureBaseIndexes`, `ensureFulltextIndexes` depuis ragforge-core
- [x] `ensureIndexes()` simplifié - appelle les fonctions centralisées + indexes spécifiques
- [x] Indexes spécifiques conservés: `documentId`, `userId`, `categorySlug`, `categoryId`
- [x] Supprimé indexes CanonicalEntity/Tag (non utilisés)

### Phase 6: Cleanup

- [ ] Supprimer `IncrementalIngestionManager`
- [ ] Supprimer `IngestionOrchestrator`
- [ ] Supprimer `IngestionQueue`
- [ ] Supprimer dirty flags
- [ ] Documenter la nouvelle architecture

### ✅ Phase 7: Extraction des Relations entre Entités (COMPLÈTE)

**Problème résolu**: On extrait maintenant les relations entre entités via GLiNER2.

#### ✅ Ce qui existait déjà
- [x] `DOMAIN_PRESETS` avec `relationTypes` pour chaque domaine
- [x] `EntityExtractionClient` envoie `relation_types` à l'API GLiNER
- [x] `ExtractionResult` contient `relations: ExtractedRelation[]`

#### ✅ Ce qui a été ajouté
- [x] `ProcessingStats.relationsCreated` - compteur de relations créées
- [x] `extractEntitiesForFile()` traite maintenant les relations:
  - Crée une map `entityName -> entityId` pendant la création des entités
  - Après les entités, crée les relations `RELATED_TO` dans Neo4j
  - MERGE pour éviter les doublons
  - Met à jour la confidence si relation existe avec confidence plus faible

#### Structure Neo4j
```cypher
(subject:Entity)-[:RELATED_TO {
  type: "works_for",           // Le prédicat
  confidence: 0.85,            // Score de confiance
  sourceNodeUuid: "...",       // Noeud source (MarkdownSection, etc.)
  createdAt: datetime()
}]->(object:Entity)
```

#### Types de relations par domaine
- **default**: works_for, located_in, created_by, costs, depends_on, part_of
- **ecommerce**: compatible_with, contains, certified_by, provides_benefit, recommended_with, complements, priced_at
- **code**: calls, inherits_from, implements, imports, returns, throws, depends_on
- **documentation**: describes, requires, implements, affects, belongs_to
- **legal**: party_to, obligated_to, grants_right, effective_date, governed_by

---

### 🔮 Phase Finale: Migration Community-Docs (FUTURE)

- [ ] Remplacer `CommunityOrchestratorAdapter` par appels directs à `UnifiedProcessor`
- [ ] Supprimer `ingestBinaryDocument()` et `ingestMedia()` (fusionnés dans `processBinaryFile()`)
- [ ] Simplifier `CommunityIngestionService`

---

## Fichiers Modifiés (Résumé)

### Créés
- ✅ `src/ingestion/unified-processor.ts`
- ✅ `src/ingestion/processing-loop.ts`
- ✅ `src/brain/ensure-indexes.ts`

### Modifiés
- ✅ `src/ingestion/state-types.ts` - état 'entities'
- ✅ `src/brain/file-state-machine.ts` - état 'entities' + markDiscovered + markDiscoveredBatch
- ✅ `src/ingestion/node-state-machine.ts` - état 'entities'
- ✅ `src/ingestion/index.ts` - exports
- ✅ `src/brain/brain-manager.ts` - intégration complète
- ✅ `src/runtime/adapters/file-watcher.ts` - mode détecteur
- ✅ `src/tools/brain-tools.ts` - ensureProjectSynced mis à jour
- ✅ `src/ingestion/unified-processor.ts` - ajouté extraction relations (Phase 7)

### À supprimer (Phase 6)
- `src/runtime/adapters/incremental-ingestion.ts`
- `src/runtime/adapters/ingestion-queue.ts`
- `src/ingestion/orchestrator.ts`

---

## Avantages de la Nouvelle Architecture

1. **2 entry points au lieu de 3** - Plus simple à maintenir
2. **Auto-détection du type** - ParserRegistry gère tout
3. **Vision/OCR unifié** - Même API pour documents et images
4. **transformGraph hook** - Injection de metadata sans duplication
5. **State machines** - Audit trail, recovery, monitoring
6. **Détecteurs découplés** - FileWatcher ne fait que détecter, ProcessingLoop traite
7. **Pas de fichiers temp** - Buffer passé directement aux parsers

---

## Résumé des Phases

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Créer UnifiedProcessor + ProcessingLoop | ✅ Complète |
| 2 | Ajouter processBinaryFile() + processVirtualFiles() | ⏳ À faire |
| 3 | Intégrer dans BrainManager | ✅ Complète |
| 4 | Adapter FileWatcher/TouchedFilesWatcher en détecteurs | ✅ Complète |
| 5 | Centraliser indexes | ✅ Complète |
| 6 | Cleanup (supprimer anciens chemins) | ⏳ À faire |
| 7 | Extraction relations entre entités (GLiNER2 RE) | ✅ Complète |
| Finale | Migration community-docs | 🔮 Future |
