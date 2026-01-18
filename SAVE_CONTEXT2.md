# Contexte: Unification des chemins d'ingestion

## Problème actuel

Il y a **trop de chemins d'ingestion différents** à maintenir :

1. **IngestionOrchestrator** (community-docs) - `lib/ragforge/ingestion-service.ts`
2. **IncrementalIngestionManager** (ragforge-core) - `src/runtime/adapters/incremental-ingestion.ts`
3. **Initial sync** dans `BrainManager.startWatching()` - chemin direct vers `ingestFromPaths()`
4. **FileWatcher** avec callback `afterIngestion` - chemin séparé pour les changements de fichiers
5. **TouchedFilesWatcher** - `src/brain/touched-files-watcher.ts` - pour fichiers orphelins (touchés par tools mais pas dans un projet)

---

## Analyse des deux architectures principales

### 1. IngestionOrchestrator (community-docs)

**Fichier**: `packages/ragforge-core/src/ingestion/orchestrator.ts`

**Flow**:
```
reingest(changes) →
  1. Capture metadata (UUIDs, embeddings) AVANT suppression
  2. Supprime les nodes pour fichiers modifiés/supprimés
  3. Parse les fichiers (avec UUID mapping)
  4. Applique transformGraph hook (entity extraction ICI - synchrone)
  5. Ingest graph dans Neo4j
  6. Restore metadata capturée
  7. Génère embeddings
```

**Points forts**:
- ✅ API simple: `reingest()` unique
- ✅ `MetadataPreserver` explicite et testable
- ✅ Entity extraction intégrée dans le hook (synchrone, garantit l'extraction)
- ✅ Préservation UUID/embeddings élégante

**Points faibles**:
- ❌ Pas de hash pre-parsing (parse tout, même fichiers inchangés)
- ❌ Granularité fichier seulement (pas scope)
- ❌ Pas de change tracking intégré

---

### 2. IncrementalIngestionManager (ragforge-core)

**Fichier**: `packages/ragforge-core/src/runtime/adapters/incremental-ingestion.ts`

**Flow**:
```
ingestFromPaths(config) →
  1. OPTIONNEL: Hash pre-parsing (filterChangedFiles)
     - Skip fichiers inchangés AVANT le parse (perf 10x)
  2. Si mode 'content': capture scopes existants avec embeddings
  3. Parse fichiers (seulement ceux modifiés si step 1)
  4. [DÉSACTIVÉ] transformGraph hook
  5. ingestIncremental():
     a. Fetch hashes existants de la DB
     b. Classifie: unchanged, modified, created, deleted
     c. Supprime nodes orphelins
     d. Upsert nodes modifiés + structurels
     e. Marque nodes avec:
        - state = 'linked'
        - entitiesDirty = true
        - embeddingsDirty = true
  6. Update file hashes APRÈS ingestion (atomicité)
```

**Points forts**:
- ✅ Hash pre-parsing (skip fichiers inchangés = 10x plus rapide)
- ✅ Granularité scope (pas juste fichier)
- ✅ Change tracking intégré
- ✅ Flags dirty pour post-processing différé
- ✅ Atomicité (hash mis à jour APRÈS succès)

**Points faibles**:
- ❌ API complexe (multiple modes: 'both'/'files'/'content'/false)
- ❌ Entity extraction déférée via flag (doit être appelée séparément)
- ❌ Plus de code à maintenir

---

### 3. TouchedFilesWatcher (ragforge-core)

**Fichier**: `packages/ragforge-core/src/brain/touched-files-watcher.ts`

**Purpose**: Traite les fichiers "orphelins" - fichiers touchés par les tools (`read_file`, `grep_files`, etc.) mais pas dans un projet ingéré.

**Flow**:
```
touch_file tool →
  1. Crée File node en state 'discovered'
  2. TouchedFilesWatcher.processFiles():
     a. discovered → parsing (FileStateMachine)
     b. Parse fichier via FileProcessor
     c. parsing → parsed → linked
     d. linked → embedding → embedded
  3. Chaque transition via FileStateMachine.transition()
```

**Points forts**:
- ✅ **State machine pour Files** (`FileStateMachine`) - états explicites, transitions validées
- ✅ **State machine pour Nodes** (`NodeStateMachine`) - même pattern unifié
- ✅ Recovery après crash (état persisté en DB)
- ✅ Retry logic avec `retryCount`
- ✅ Progress tracking (`getStateStats()`)
- ✅ Timestamps pour chaque étape (`parsedAt`, `linkedAt`, `embeddedAt`)

**Points faibles**:
- ❌ Seulement pour fichiers orphelins (pas les projets)
- ❌ Pas encore intégré avec les autres chemins d'ingestion

**State machines disponibles**:

| Machine | Fichier | États |
|---------|---------|-------|
| FileStateMachine | `src/brain/file-state-machine.ts` | `mentioned → discovered → parsing → parsed → relations → linked → embedding → embedded` |
| NodeStateMachine | `src/ingestion/node-state-machine.ts` | `pending → parsing → parsed → linking → linked → embedding → ready` |

---

## Problème spécifique découvert

### Entity extraction ne fonctionne pas dans ragforge-core

**Cause**: 5 chemins différents, entity extraction manquante dans certains :

| Chemin | Entity extraction | Embeddings | State Machine |
|--------|-------------------|------------|---------------|
| IngestionOrchestrator (community-docs) | ✅ Dans transformGraph hook | ✅ Après ingestGraph | ❌ Dirty flags |
| Initial sync (BrainManager) | ✅ processEntityExtraction() | ✅ Après ingestFromPaths | ❌ Dirty flags |
| FileWatcher afterIngestion | ✅ processEntityExtraction() | ✅ generateMultiEmbeddings() | ❌ Dirty flags |
| TouchedFilesWatcher | ❌ PAS IMPLÉMENTÉ | ✅ EmbeddingCoordinator | ✅ FileStateMachine |
| IncrementalIngestionManager | ❌ entitiesDirty flag | ✅ embeddingsDirty flag | ❌ Dirty flags |

**Fix appliqué**: Ajouté `processEntityExtraction()` à l'initial sync (ligne 4815-4825 brain-manager.ts)

---

## Recommandation: Architecture unifiée

### SmartIngestionManager (proposition)

```
┌─────────────────────────────────────────────────────────────┐
│         SmartIngestionManager (Unified)                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Entry Points:                                              │
│  - ingestFromChanges(changes)     // FileChange[] (watchers)│
│  - ingestFromPaths(config)        // SourceConfig (batch)   │
│  - ingestFiles(buffers[])         // In-memory (uploads)    │
│                                                              │
│  Pipeline unifié:                                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 1. DETECTION (optionnel)                            │   │
│  │    - Hash pre-parsing (from Incremental) = perf     │   │
│  │    - Skip fichiers inchangés                        │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 2. METADATA CAPTURE (avant suppression)            │   │
│  │    - UUIDs, embeddings (from Orchestrator)         │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 3. SUPPRESSION                                      │   │
│  │    - Nodes des fichiers modifiés                   │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 4. PARSING                                          │   │
│  │    - Seulement fichiers modifiés                   │   │
│  │    - UUID mapping pour préservation                │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 5. INGESTION                                        │   │
│  │    - ingestGraph() unique                          │   │
│  │    - Marque entitiesDirty=true, state='linked'     │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 6. RESTORATION                                      │   │
│  │    - Restore embeddings                            │   │
│  │    - Update file hashes (ATOMIC)                   │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 7. POST-PROCESSING                                  │   │
│  │    - Entity extraction (getDirtyEntityNodes)       │   │
│  │    - Embeddings (getDirtyScopes)                   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Ce qu'il faut garder de chaque

### De IngestionOrchestrator:
- `MetadataPreserver` - API propre pour UUID/embedding
- `FileChange` interface - sémantique claire
- Méthode simple `reingest()`

### De IncrementalIngestionManager:
- Hash pre-parsing avec `filterChangedFiles()` - **CRITIQUE pour perf**
- Flags dirty (`entitiesDirty`, `embeddingsDirty`)
- `ChangeTracker` - audit trail
- `updateFileHashes()` APRÈS ingestion - atomicité
- Granularité scope (pas juste fichier)

### De TouchedFilesWatcher:
- **FileStateMachine** - états explicites pour Files, transitions validées
- **NodeStateMachine** - pattern unifié pour tous les nodes
- Recovery après crash (état persisté)
- Retry logic avec `retryCount` et `maxRetries`
- Timestamps audit trail (`_detectedAt`, `_parsedAt`, `_linkedAt`, `_embeddedAt`)
- `getStateStats()` pour monitoring
- Properties préfixées `_` pour éviter conflits (`_state`, `_stateChangedAt`, etc.)

---

## Migration suggérée

### Phase 1: Court terme (maintenant)
- Garder les deux, documenter quand utiliser lequel
- Fix entity extraction dans tous les chemins ✅ (fait)

### Phase 2: Moyen terme
- Créer `SmartIngestionManager` qui combine les deux
- Faire que IngestionOrchestrator utilise IncrementalIngestionManager en interne

### Phase 3: Long terme
- Déprécier anciennes APIs
- Un seul chemin d'ingestion unifié

---

## Fichiers clés à modifier pour unification

1. `src/ingestion/orchestrator.ts` - IngestionOrchestrator
2. `src/runtime/adapters/incremental-ingestion.ts` - IncrementalIngestionManager
3. `src/brain/brain-manager.ts` - BrainManager (initial sync, watchers)
4. `src/runtime/adapters/file-watcher.ts` - FileWatcher
5. `src/brain/touched-files-watcher.ts` - TouchedFilesWatcher (state machine)
6. `src/brain/file-state-machine.ts` - FileStateMachine
7. `src/ingestion/node-state-machine.ts` - NodeStateMachine
8. `src/ingestion/state-types.ts` - Types et constantes state machine
9. `lib/ragforge/ingestion-service.ts` (community-docs) - Service d'ingestion

---

## État actuel du fix entity extraction

### Changements effectués:

1. **`src/ingestion/entity-extraction/transform.ts`**:
   - Ajouté `hash` aux Entity nodes (nécessaire pour ingestIncremental)

2. **`src/runtime/adapters/incremental-ingestion.ts`**:
   - Ajouté `entitiesDirty = true` pour MarkdownSection, WebPage, etc.
   - Ajouté `getDirtyEntityNodes()`, `countDirtyEntityNodes()`, `markEntitiesClean()`
   - Supprimé appel transformGraph (entity extraction maintenant post-ingestion)

3. **`src/brain/brain-manager.ts`**:
   - Ajouté `processEntityExtraction()` méthode
   - Ajouté appel dans `afterIngestion` callback du FileWatcher
   - Ajouté appel dans initial sync path

### À tester:
- [ ] Rebuild et test complet
- [ ] Vérifier que entities sont créées
- [ ] Vérifier que l'incrémental fonctionne (modifier un fichier, vérifier que seules les nouvelles entities sont créées)
