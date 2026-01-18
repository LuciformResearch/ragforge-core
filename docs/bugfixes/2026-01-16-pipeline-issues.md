# Pipeline Issues - 2026-01-16

## Contexte
Travail sur la parallélisation du pipeline d'ingestion et le nettoyage des EmbeddingChunks.

## Problèmes résolus

### 1. Normalisation `state` vs `_state`
- **Problème**: Incohérence entre `f.state` (FileStateMachine) et `n._state` (NodeStateMachine)
- **Solution**: Normalisé vers `_state` partout dans les requêtes Cypher
- **Fichiers modifiés**:
  - `src/brain/file-state-machine.ts`
  - `src/brain/brain-manager.ts`
  - `src/brain/touched-files-watcher.ts`
  - `src/brain/file-processor.ts`
  - `src/runtime/adapters/incremental-ingestion.ts`

### 2. ProcessingLoop ne trouvait pas les fichiers re-parsés
- **Problème**: Quand un fichier est modifié et re-parsé, les nodes enfants passent à `_state='linked'` mais le File reste `_state='embedded'`. ProcessingLoop cherchait les Files, pas les nodes.
- **Solution**: Ajouté `processLinkedNodes()` dans UnifiedProcessor qui cherche directement les nodes avec `_state='linked'`
- **Fichiers modifiés**:
  - `src/ingestion/unified-processor.ts` - nouvelle méthode `processLinkedNodes()`
  - `src/ingestion/processing-loop.ts` - ajout Phase 3

### 3. Double virgule dans la requête usesChunks
- **Problème**: Le regex pour ajouter `usesChunks` à la clause RETURN créait `,,`
- **Solution**: Modifié le regex pour insérer avant `.uuid` au lieu d'après la clause complète
- **Fichier modifié**: `src/brain/embedding-service.ts`

### 4. Watchers non lancés au démarrage du daemon
- **Problème**: Les watchers créés lors de `ingest_directory` n'étaient pas relancés au redémarrage du daemon
- **Symptôme**: `list_watchers()` retournait `[]` après redémarrage
- **Impact**: Le ProcessingLoop ne tournait pas, les fichiers modifiés n'étaient pas traités
- **Cause**: `initialize()` chargeait les projets via `refreshProjectsCache()` mais ne redémarrait pas leurs watchers
- **Solution**: Ajouté méthode `restoreWatchers()` appelée à l'étape 12 de `initialize()`:
  1. Itère sur `registeredProjects`
  2. Filtre les projets de type 'quick-ingest' avec un `path` valide existant sur disque
  3. Appelle `startWatching()` pour chaque projet (skipInitialSync auto-géré via nodeCount)
- **Fichier modifié**: `src/brain/brain-manager.ts`

### 5. ProcessingLoop en boucle infinie - nodes skipped non marqués 'ready'
- **Problème**: Quand un node est skipped (hash match = déjà embedded), son `_state` n'était pas mis à jour vers 'ready'
- **Symptôme**: Logs spammés "Starting iteration #N" toutes les 100ms, Phase 3 trouve toujours les mêmes nodes
- **Cause**: Dans `collectEmbeddingTasks()`, quand `needsEmbed=false`, on faisait `skippedCount++; continue;` sans ajouter le node à `nodeNeedsMarking`
- **Solution**: Ajouté le marking même pour les nodes skippés (car ils ont déjà des embeddings valides)
- **Fichier modifié**: `src/brain/embedding-service.ts` (2 endroits: chunked content ~L1350 et small content ~L1430)

### 6. ProcessingLoop en boucle infinie - nodes avec texte vide non marqués 'ready'
- **Problème**: Quand un node a un texte vide ou < 5 chars (ex: MarkdownDocument sans `_name`), il n'était jamais marqué 'ready'
- **Symptôme**: Phase 3 trouve toujours le même node (ex: MarkdownDocument avec `_name=null`)
- **Cause**: Dans `collectEmbeddingTasks()`, quand `rawText.length < 5`, on faisait `continue;` sans incrémenter `skippedCount` ni ajouter à `nodeNeedsMarking`
- **Solution**: Ajouté le marking pour les nodes avec texte vide (rien à embedder mais doit passer en 'ready')
- **Fichier modifié**: `src/brain/embedding-service.ts` (~L1333)

### 7. Project nodes non créés lors de l'ingestion
- **Problème**: `ingest_directory` ne créait pas de Project node dans Neo4j
- **Cause**: `updateProjectMetadataInDb()` utilisait `MATCH` au lieu de `MERGE`
- **Solution**: Changé `MATCH` en `MERGE` pour créer le Project s'il n'existe pas
- **Fichier modifié**: `src/brain/brain-manager.ts` (~L1570)

### 8. Préservation de `usesChunks` lors du re-parsing
- **Problème**: Quand un fichier est modifié, le MERGE dans `createNodesBatch()` écrasait `usesChunks` avec `null`
- **Cause**: `SET n = nodeData.props` écrasait TOUTES les propriétés, y compris `usesChunks`
- **Solution**: Capturer `usesChunks` dans une variable Cypher AVANT le SET, puis la restaurer après
- **Fichier modifié**: `src/brain/file-processor.ts` (~L839-844)
```cypher
WITH n, nodeData, n.usesChunks AS preservedUsesChunks
WHERE n._wasCreated = true OR n._wasUpdated = true
SET n = nodeData.props,
    n._state = 'linked',
    n.usesChunks = preservedUsesChunks
```

### 9. Chunk cleanup skippé quand `allTasks.length === 0`
- **Problème**: Quand le contenu rétrécit, les chunks n'étaient pas supprimés
- **Cause**: Phase 2 (chunk deletion) était après le early return quand `allTasks.length === 0`
- **Symptôme**: `usesChunks` passait à `null` mais les chunks restaient dans la DB
- **Solution**: Déplacé Phase 2 AVANT le early return pour que le cleanup s'exécute toujours
- **Fichier modifié**: `src/brain/embedding-service.ts` (~L885-946)

---

## Tests validés

### Cycle de vie des EmbeddingChunks
1. **Test 1**: Section petite → grande (> 3k chars)
   - ✅ Chunks créés
   - ✅ `usesChunks = true`
   - ✅ Embedding direct supprimé

2. **Test 2**: Section grande → petite (< 3k chars)
   - ✅ Chunks supprimés
   - ✅ `usesChunks = null`
   - ✅ Embedding direct restauré

---

## Notes techniques

### Architecture des states
```
FileStateMachine (Files):
  discovered → parsing → parsed → relations → linked → entities → embedding → embedded

NodeStateMachine (Scope, MarkdownSection, etc.):
  pending → parsing → linked → entities → embedding → ready
```

### Propriétés Neo4j
- Files: `_state`, `stateUpdatedAt`
- Nodes: `_state`, `_stateChangedAt`, `usesChunks`, `embeddingsDirty`

### ProcessingLoop phases
1. Phase 1: `processDiscovered()` - parse les fichiers discovered
2. Phase 2: `processLinked()` - entities + embeddings pour Files linked
3. Phase 3: `processLinkedNodes()` - embeddings pour nodes linked (nouveau)
