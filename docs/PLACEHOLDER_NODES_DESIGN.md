# Design: Placeholder Nodes pour les références cross-file

**Date**: 2026-01-17
**Statut**: ✅ Implémenté
**Contexte**: Résoudre le problème des MATCH unlabeled lors de la création de relations

---

## Problème actuel

Lors de la création de relations cross-file, les nodes cibles peuvent ne pas encore exister dans la DB:

```typescript
// Relation créée par le parser
{
  type: 'USES_LIBRARY',
  from: 'scope:abc123',      // Scope qui existe
  to: 'extlib:lodash',       // ExternalLibrary qui n'existe peut-être pas encore
}
```

**Conséquences:**
1. On doit faire un MATCH sans label (lent, full scan)
2. Si le node n'existe pas, la relation échoue silencieusement
3. 27% des relations sont affectées (~12k sur 46k)

---

## Solution proposée: Placeholder Nodes

### Concept

Au lieu de chercher si le node existe, on le **crée s'il n'existe pas** avec les infos qu'on a déjà:

```cypher
-- Au lieu de (lent, peut échouer):
MATCH (target {uuid: 'extlib:lodash'})

-- On fait (rapide, toujours réussit):
MERGE (target:ExternalLibrary {uuid: 'extlib:lodash'})
ON CREATE SET
  target._name = 'lodash',
  target._pending = true,
  target.projectId = $projectId
```

### Pourquoi ça marche

1. **MERGE** crée le node seulement s'il n'existe pas
2. **ON CREATE** ne s'exécute que si le node est nouveau
3. Quand le "vrai" node est parsé plus tard, MERGE fusionne les propriétés
4. Le flag `_pending` permet de tracker les nodes non résolus

---

## Données nécessaires

On connaît déjà toutes les infos au moment du parsing! Il suffit de les propager.

### Mapping relation → label cible

| Type de relation | Label cible | Source de `_name` |
|------------------|-------------|-------------------|
| `USES_LIBRARY` | `ExternalLibrary` | Nom du package (lodash, react) |
| `IN_DIRECTORY` | `Directory` | Path du directory |
| `DEFINED_IN` | `File` | Path du fichier |
| `BELONGS_TO` | `Directory` | Path du directory |
| `PARENT_OF` | `Directory` | Path du directory enfant |
| `INHERITS_FROM` | `Scope` | Nom de la classe parente |
| `IMPLEMENTS` | `Scope` | Nom de l'interface |

### Structure enrichie des relations

**Avant:**
```typescript
interface ParsedRelationship {
  type: string;
  from: string;      // UUID source
  to: string;        // UUID cible
  properties?: Record<string, unknown>;
}
```

**Après:**
```typescript
interface ParsedRelationship {
  type: string;
  from: string;
  to: string;
  properties?: Record<string, unknown>;

  // NOUVEAU: infos pour créer le placeholder si nécessaire
  targetLabel?: string;
  targetProps?: {
    _name: string;
    [key: string]: unknown;
  };
}
```

---

## Implémentation

### 1. Modifier le parser (`code-source-adapter.ts`)

Enrichir les relations avec `targetLabel` et `targetProps`:

```typescript
// USES_LIBRARY
relationships.push({
  type: 'USES_LIBRARY',
  from: sourceUuid,
  to: UniqueIDHelper.GenerateExternalLibraryUUID(imp.source),
  targetLabel: 'ExternalLibrary',
  targetProps: {
    _name: imp.source,
    name: imp.source,
  },
  properties: { symbol: imp.imported }
});

// IN_DIRECTORY
relationships.push({
  type: 'IN_DIRECTORY',
  from: fileUuid,
  to: UniqueIDHelper.GenerateDirectoryUUID(absDirPath),
  targetLabel: 'Directory',
  targetProps: {
    _name: dirName,
    absolutePath: absDirPath,
    path: relativeDirPath,
  },
});
```

### 2. Modifier FileProcessor (`file-processor.ts`)

Dans `createRelationshipsBatchWithLabels()`, créer les placeholders avant les relations:

```typescript
async createRelationshipsBatchWithLabels(relationships: ParsedRelationship[]): Promise<number> {
  // Step 1: Collecter les targets avec leurs infos
  const targetsToEnsure = new Map<string, { label: string; props: Record<string, unknown> }>();

  for (const rel of relationships) {
    if (rel.targetLabel && rel.targetProps) {
      targetsToEnsure.set(rel.to, {
        label: rel.targetLabel,
        props: rel.targetProps,
      });
    }
  }

  // Step 2: Créer les placeholders par label (un UNWIND par label type)
  const targetsByLabel = groupBy(targetsToEnsure, t => t.label);

  for (const [label, targets] of targetsByLabel) {
    await this.neo4jClient.run(`
      UNWIND $targets AS t
      MERGE (n:${label} {uuid: t.uuid})
      ON CREATE SET
        n += t.props,
        n._pending = true,
        n.projectId = $projectId,
        n._state = 'linked'
    `, { targets, projectId: this.projectId });
  }

  // Step 3: Maintenant créer les relations (tous les targets existent!)
  // On peut utiliser des MATCH labelés car on connaît le label
  for (const rel of relationships) {
    const toLabel = rel.targetLabel || this.inferLabelFromRelType(rel.type);
    // MATCH (target:${toLabel} {uuid: rel.to}) ← RAPIDE car labelé!
  }
}
```

### 3. Inférence de label par type de relation

Pour les relations qui n'ont pas `targetLabel` explicite:

```typescript
private inferTargetLabel(relationType: string): string | null {
  const mapping: Record<string, string> = {
    'USES_LIBRARY': 'ExternalLibrary',
    'IN_DIRECTORY': 'Directory',
    'DEFINED_IN': 'File',
    'BELONGS_TO': 'Directory',
    'PARENT_OF': 'Directory',
  };
  return mapping[relationType] || null;
}
```

---

## Gestion des placeholders

### Résolution automatique

**4 cas de figure gérés:**

| Cas | Scénario | Résolution |
|-----|----------|------------|
| 1 | Placeholder créé → Vrai node parsé plus tard | `createNodesBatchGlobal()` fait MERGE + SET `_pending = null` |
| 2 | Vrai node existe → Placeholder essaie de créer | ON MATCH dans Step 1b → `_pending = null` |
| 3 | ExternalLibrary (jamais de vrai node) | Reste avec `_pending = true` (voulu - trackable) |
| 4 | Directory parsé + placeholder même batch | UUIDs identiques → MERGE fusionne → `_pending = null` |

**Code dans `createNodesBatchGlobal()`:**
```cypher
MERGE (n:${label} {uuid: nodeData.uuid})
...
SET n = nodeData.props,
    n._state = 'linked',
    n._pending = null  // Clear placeholder flag when real node arrives
```

**Code dans Step 1b (placeholder creation):**
```cypher
MERGE (n:${label} {uuid: nodeData.uuid})
ON CREATE SET n._pending = true, ...
ON MATCH SET n._pending = null  // Already exists, not a placeholder
```

### Nettoyage des orphelins

Après une ingestion complète, on peut vérifier les placeholders non résolus:

```cypher
-- Lister les placeholders non résolus
MATCH (n {_pending: true})
RETURN labels(n)[0] AS label, n._name AS name, count(*) AS count
ORDER BY count DESC

-- Optionnel: supprimer les orphelins (libs non utilisées, etc.)
MATCH (n:ExternalLibrary {_pending: true})
WHERE NOT (n)<-[:USES_LIBRARY]-()
DELETE n
```

---

## Avantages

| Aspect | Avant | Après |
|--------|-------|-------|
| Performance MATCH | Unlabeled (full scan) | Labeled (index) |
| Relations échouées | ~27% silencieusement | 0% |
| Traçabilité | Aucune | `_pending = true` |
| Complexité pre-query | Multiple queries par label | Aucune pre-query |

---

## Risques et mitigations

### Risque 1: Placeholders jamais résolus
- **Cause**: Lib externe jamais importée directement
- **Mitigation**: C'est OK! `ExternalLibrary` avec `_pending=true` = lib tierce

### Risque 2: Props incorrectes sur placeholder
- **Cause**: Le parser a des infos partielles
- **Mitigation**: ON MATCH écrase avec les vraies props

### Risque 3: Duplication si UUID différent
- **Cause**: Génération UUID inconsistante
- **Mitigation**: UniqueIDHelper assure la consistance

---

## Fichiers à modifier

1. **`src/runtime/adapters/code-source-adapter.ts`**
   - Enrichir les relations avec `targetLabel` et `targetProps`
   - ~10 endroits où les relations sont créées

2. **`src/brain/file-processor.ts`**
   - Modifier `createRelationshipsBatchWithLabels()`
   - Ajouter création des placeholders avant les relations
   - Ajouter `inferTargetLabel()`

3. **`src/types/parser.ts`** (ou équivalent)
   - Étendre `ParsedRelationship` avec les nouveaux champs

---

## Plan d'implémentation

1. [x] Étendre le type `ParsedRelationship` - `src/runtime/adapters/types.ts`
2. [x] Modifier `code-source-adapter.ts` - ajouter `targetLabel`/`targetProps` aux relations
3. [x] Modifier `file-processor.ts` - créer placeholders avant relations (Step 1b)
4. [ ] Ajouter méthode `inferTargetLabel()` pour fallback (optionnel - pas nécessaire si toutes les relations ont targetLabel)
5. [ ] Tester avec community-docs
6. [ ] Vérifier: 0 relations unlabeled dans les logs

---

## Métriques de succès

```
# Avant
[FileProcessor] 📊 Relationships: 33606 labeled (fast), 12773 unlabeled (slow)

# Après
[FileProcessor] 📊 Relationships: 46379 labeled (fast), 0 unlabeled (slow)
[FileProcessor] 📦 Created 127 placeholder nodes (ExternalLibrary: 89, Directory: 38)
```
