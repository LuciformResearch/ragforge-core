# Rapport: Problèmes d'ingestion identifiés

**Date**: 2026-01-17
**Contexte**: Investigation des performances du pipeline d'ingestion après unification

---

## Résumé exécutif

L'ingestion est **2-3x plus lente** que l'ancienne version. Plusieurs problèmes ont été identifiés:

1. **Nodes manquants** (Directory, ExternalLibrary) - Relations créées vers des nodes inexistants
2. **Deadlocks Neo4j** - Causés par l'exécution parallèle des MERGE
3. **Queries unlabeled** - 27% des relations utilisent des MATCH sans label (lent)
4. **Pre-query lente** - La pré-requête pour les labels est elle-même unlabeled

---

## Problème 1: Nodes structurels manquants

### Symptôme
```
[FileProcessor] ⚠️  UNLABELED: 4277 BELONGS_TO (Scope→_)
[FileProcessor] ⚠️  UNLABELED: 1625 USES_LIBRARY (Scope→_)
```

### Cause
Le parser (`codeparsers`) produit des relations vers:
- `Directory` nodes (via `BELONGS_TO`, `IN_DIRECTORY`)
- `ExternalLibrary` nodes (via `USES_LIBRARY`)

Mais **ces nodes ne sont jamais créés** par `FileProcessor`.

### Impact
- Les relations MATCH échouent silencieusement
- Les relations `BELONGS_TO` vers Directory ne sont pas créées
- Les relations `USES_LIBRARY` vers ExternalLibrary ne sont pas créées

### Vérification
```cypher
MATCH (n:Directory) RETURN count(n) -- Résultat: 0
MATCH (n:ExternalLibrary) RETURN count(n) -- Résultat: 0
```

### Solution proposée
Avant de créer les relations, `FileProcessor` doit:
1. Extraire les UUIDs cibles uniques des relations
2. Créer les nodes `Directory` et `ExternalLibrary` manquants via MERGE
3. Puis créer les relations

L'ancien code avait `ensureDirectoryHierarchy()` dans `brain-manager.ts:2020-2036` qui faisait ce travail.

---

## Problème 2: Deadlocks Neo4j avec exécution parallèle

### Symptôme
```
[ERROR] [FileProcessor] ❌ Relationship creation failed:
ForsetiClient[transactionId=120626] can't acquire ExclusiveLock...
Wait list:ExclusiveLock[Client[120625] waits for [ForsetiClient[transactionId=120626]]]
```

### Cause
L'optimisation parallèle avec `pLimit(5)` cause des deadlocks quand plusieurs transactions essaient de modifier le même node simultanément.

Exemple: Si deux batches de relations pointent vers le même node cible, Neo4j crée un verrou circulaire.

### Solution appliquée
Retour à l'exécution **séquentielle** comme l'ancien code (`incremental-ingestion.ts:727-752`).

### Code corrigé
```typescript
// AVANT (deadlocks)
const results = await Promise.all(queryTasks.map(task => task()));

// APRÈS (stable)
for (const [key, rels] of relsByTypeAndLabels) {
  for (let i = 0; i < rels.length; i += batchSize) {
    await this.neo4jClient.run(...);
  }
}
```

---

## Problème 3: Queries unlabeled (lentes)

### Symptôme
```
[FileProcessor] 📊 Relationships: 33606 labeled (fast), 12773 unlabeled (slow)
```

27% des relations utilisent un MATCH sans label:
```cypher
-- LENT (full scan)
MATCH (source {uuid: relData.from})

-- RAPIDE (index)
MATCH (source:Scope {uuid: relData.from})
```

### Cause
Les relations cross-file pointent vers des nodes dont le label n'est pas connu au moment du batch:
- `DEFINED_IN (Scope→File)` - 4277 relations
- `BELONGS_TO (Scope→Directory)` - 4277 relations
- `USES_LIBRARY (Scope→ExternalLibrary)` - 1625 relations

### Solution partielle implémentée
Pré-requête pour récupérer les labels des UUIDs inconnus:
```typescript
// Step 2: Pre-query labels for unknown UUIDs from Neo4j
const result = await this.neo4jClient.run(`
  UNWIND $uuids AS uuid
  MATCH (n {uuid: uuid})
  RETURN n.uuid AS uuid, labels(n)[0] AS label
`, { uuids: batch });
```

### Problème résiduel
La pré-requête elle-même utilise un MATCH unlabeled! Elle est donc aussi lente.

### Solution proposée
Requêter chaque type de label séparément:
```typescript
// Query File nodes
await neo4j.run('MATCH (n:File) WHERE n.uuid IN $uuids RETURN n.uuid, "File"');
// Query Directory nodes
await neo4j.run('MATCH (n:Directory) WHERE n.uuid IN $uuids RETURN n.uuid, "Directory"');
// etc.
```

---

## Problème 4: File nodes non créés avant parsing

### Symptôme
Après `MATCH (n) DETACH DELETE n`, les File nodes ne sont pas recréés car le watcher ne détecte pas de changement.

### Cause
Le `FileStateMachine.markDiscoveredBatch()` vérifie si les fichiers ont changé avant de les marquer. Si le hash est identique, il skip.

### Impact
Après une suppression manuelle de la DB, l'ingestion ne se relance pas automatiquement.

### Solution
Utiliser `forget_path` puis `ingest_directory` pour forcer une réingestion complète.

---

## Comparaison ancien vs nouveau code

| Aspect | Ancien (`IncrementalIngestionManager`) | Nouveau (`FileProcessor`) |
|--------|----------------------------------------|---------------------------|
| Directory nodes | Créés via `ensureDirectoryHierarchy()` | **Non créés** |
| ExternalLibrary | Créés quelque part | **Non créés** |
| Exécution | Séquentielle | Séquentielle (après fix) |
| Pre-query labels | Non | Oui (mais unlabeled) |
| Chemin d'appel | `orchestrator-adapter → ingestGraph()` | `unified-processor → processBatchFiles()` |

---

## Recommandations

### Court terme (quick fixes)
1. ✅ Revenir à l'exécution séquentielle (fait)
2. ⬜ Ajouter création des Directory/ExternalLibrary nodes avant les relations
3. ⬜ Optimiser la pré-requête avec des MATCH labelés

### Moyen terme
4. ⬜ Unifier le chemin d'ingestion (FileProcessor vs IncrementalIngestionManager)
5. ⬜ Benchmark comparatif ancien vs nouveau

### Long terme
6. ⬜ Considérer `CALL { } IN TRANSACTIONS` pour les gros batches
7. ⬜ Index composite sur `(label, uuid)` si Neo4j le supporte

---

## Fichiers concernés

- `/packages/ragforge-core/src/brain/file-processor.ts` - Création relations
- `/packages/ragforge-core/src/brain/file-state-machine.ts` - Gestion état fichiers
- `/packages/ragforge-core/src/ingestion/unified-processor.ts` - Orchestration
- `/packages/ragforge-core/src/runtime/adapters/incremental-ingestion.ts` - Ancien code (référence)

---

## Logs de diagnostic ajoutés

```typescript
// Dans file-processor.ts, méthode createRelationshipsBatchWithLabels()
console.log(`[FileProcessor] ⚠️  UNLABELED: ${count} ${relType} (${fromLabel}→${toLabel})`);
console.log(`[FileProcessor] 📊 Relationships: ${labeled} labeled (fast), ${unlabeled} unlabeled (slow)`);
```

Ces logs permettent d'identifier immédiatement les relations problématiques.


Note lucie: rien a voir mais faudrait qu'on ait par défaut une entité extraite en plus des documents: "link" et décrire que c'est un lien vers n'importe quoi fichier/site web / endpoint etc...