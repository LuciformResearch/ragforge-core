# Intégration codeparsers RelationshipResolver

**Date**: 2026-01-17
**Statut**: Proposition
**Contexte**: Optimiser l'intégration entre ragforge et codeparsers pour la résolution de relations cross-file

---

## État actuel

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    code-source-adapter.ts                        │
│                                                                  │
│  1. Parse files → ScopeFileAnalysis[]                           │
│  2. Call codeparsers RelationshipResolver                        │
│       ↓                                                          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  codeparsers/RelationshipResolver                         │   │
│  │                                                           │   │
│  │  - Build global scope mapping (name → [entries])          │   │
│  │  - Resolve imports via language-specific resolvers        │   │
│  │  - Match identifier references to scopes                  │   │
│  │  - Generate UUIDs (thrown away by ragforge!)              │   │
│  │  - Return ResolvedRelationship[]                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│       ↓                                                          │
│  3. Lookup scopes by "file:name:type" key                        │
│  4. Re-generate UUIDs with ragforge's generateUUID()             │
│     (supports existingUUIDMapping for re-ingestion)              │
│  5. Create ParsedRelationship[]                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Problème: Double génération d'UUIDs

codeparsers génère des UUIDs que ragforge jette immédiatement :

```typescript
// codeparsers/RelationshipResolver.ts
private generateUuid(scope: ScopeInfo, filePath: string): string {
  const input = `${relativePath}:${scope.name}:${scope.type}:${signatureHash}`;
  // ... SHA-256 hash
}

// ragforge/code-source-adapter.ts
for (const rel of result.relationships) {
  // ❌ rel.fromUuid et rel.toUuid sont ignorés!
  const sourceKey = `${rel.fromFile}:${rel.fromName}:${rel.fromType}`;
  const sourceInfo = scopeLookup.get(sourceKey);

  // ✅ On régénère avec notre méthode (existingUUIDMapping support)
  const fromUuid = this.generateUUID(sourceInfo.scope, sourceInfo.absolutePath);
}
```

### Pourquoi ragforge doit régénérer les UUIDs

| Raison | Détail |
|--------|--------|
| **Path format différent** | codeparsers: relatif, ragforge: absolu |
| **existingUUIDMapping** | ragforge préserve les UUIDs existants en DB lors de re-ingestion |
| **Compatibilité Neo4j** | Les UUIDs doivent matcher les nodes existants pour MERGE |

---

## Proposition 1: Mode "references" dans codeparsers

### Objectif

Éviter la génération inutile d'UUIDs quand le consommateur va les régénérer.

### API proposée

```typescript
// Nouvelle option
interface RelationshipResolverOptions {
  // ... existing options

  /**
   * Output mode for relationships:
   * - 'uuid': Generate UUIDs for from/to (default, current behavior)
   * - 'reference': Return scope references instead of UUIDs
   */
  outputMode?: 'uuid' | 'reference';
}

// Nouveau type pour mode reference
interface ScopeReference {
  file: string;      // Relative path
  name: string;      // Scope name
  type: string;      // Scope type (function, class, etc.)
  parent?: string;   // Parent scope name (for disambiguation)
  startLine?: number; // For variables/constants disambiguation
}

interface ResolvedRelationshipRef {
  type: RelationshipType;
  from: ScopeReference;
  to: ScopeReference;
  metadata?: {
    context?: string;
    importPath?: string;
    viaImport?: boolean;
    fallbackResolution?: boolean;
  };
}

// Result type for reference mode
interface RelationshipResolutionResultRef {
  relationships: ResolvedRelationshipRef[];
  stats: ResolutionStats;
  unresolvedReferences: UnresolvedReference[];
}
```

### Implémentation dans codeparsers

```typescript
// RelationshipResolver.ts

async resolveRelationships(
  parsedFiles: ParsedFilesMap
): Promise<RelationshipResolutionResult | RelationshipResolutionResultRef> {
  // ... existing logic

  if (this.options.outputMode === 'reference') {
    return this.buildReferenceResult(relationships, unresolvedReferences, stats);
  }

  return this.buildUuidResult(relationships, unresolvedReferences, stats);
}

private buildReferenceResult(
  internalRels: InternalRelationship[],
  unresolved: UnresolvedReference[],
  stats: ResolutionStats
): RelationshipResolutionResultRef {
  const relationships: ResolvedRelationshipRef[] = [];

  for (const rel of internalRels) {
    relationships.push({
      type: rel.type,
      from: {
        file: rel.fromFile,
        name: rel.fromName,
        type: rel.fromType,
        parent: rel.fromParent,
      },
      to: {
        file: rel.toFile,
        name: rel.toName,
        type: rel.toType,
        parent: rel.toParent,
      },
      metadata: rel.metadata,
    });
  }

  return { relationships, stats, unresolvedReferences: unresolved };
}
```

### Utilisation dans ragforge

```typescript
// code-source-adapter.ts

private async buildScopeRelationshipsWithResolver(
  codeFiles: Map<string, ScopeFileAnalysis>,
  projectRoot: string,
  scopeMap: Map<string, ScopeInfo>
): Promise<ParsedRelationship[]> {
  const relationshipResolver = new RelationshipResolver({
    projectRoot,
    includeContains: false,
    includeInverse: false,
    includeDecorators: true,
    resolveCrossFile: true,
    outputMode: 'reference', // ← NEW: Don't generate UUIDs
  });

  const result = await relationshipResolver.resolveRelationships(codeFiles);

  // Direct mapping without UUID lookup
  for (const rel of result.relationships) {
    const sourceInfo = scopeLookup.get(`${rel.from.file}:${rel.from.name}:${rel.from.type}`);
    const targetInfo = scopeLookup.get(`${rel.to.file}:${rel.to.name}:${rel.to.type}`);

    if (!sourceInfo || !targetInfo) continue;

    const fromUuid = this.generateUUID(sourceInfo.scope, sourceInfo.absolutePath);
    const toUuid = this.generateUUID(targetInfo.scope, targetInfo.absolutePath);

    // ... rest unchanged
  }
}
```

### Gains

| Métrique | Avant | Après |
|----------|-------|-------|
| Appels SHA-256 | 2N (codeparsers) + 2N (ragforge) | 2N (ragforge only) |
| Allocations string UUID | 2N inutiles | 0 |
| Complexité lookup | O(1) Map lookup | O(1) identique |

---

## Proposition 2: Exposer unresolvedReferences

### Objectif

Permettre le debugging des relations manquantes et améliorer la qualité de l'ingestion.

### Données disponibles dans codeparsers

```typescript
interface UnresolvedReference {
  fromScope: string;     // Nom du scope source
  fromType: string;      // Type du scope source
  fromFile: string;      // Fichier source
  identifier: string;    // Identifiant non résolu
  kind: 'import' | 'local_scope' | 'unknown';
  reason: string;        // Pourquoi non résolu
  candidates: Array<{ file: string; type: string }>; // Candidats trouvés mais non matchés
}
```

### Utilisation dans ragforge

#### 1. Logging lors de l'ingestion

```typescript
// code-source-adapter.ts

const result = await relationshipResolver.resolveRelationships(codeFiles);

// Log unresolved for debugging
if (result.unresolvedReferences.length > 0) {
  console.log(`   ⚠️ ${result.unresolvedReferences.length} unresolved references:`);

  // Group by reason
  const byReason = new Map<string, number>();
  for (const unres of result.unresolvedReferences) {
    const count = byReason.get(unres.reason) || 0;
    byReason.set(unres.reason, count + 1);
  }

  for (const [reason, count] of byReason) {
    console.log(`      - ${reason}: ${count}`);
  }
}
```

#### 2. Stocker dans Neo4j pour analyse

```typescript
// Créer des nodes UnresolvedReference pour debugging
interface UnresolvedReferenceNode {
  labels: ['UnresolvedReference'];
  properties: {
    uuid: string;
    fromScope: string;
    fromFile: string;
    identifier: string;
    kind: string;
    reason: string;
    candidateCount: number;
    projectId: string;
  };
}

// Relation: (Scope)-[:HAS_UNRESOLVED]->(UnresolvedReference)
```

#### 3. Tool MCP pour diagnostics

```typescript
// Nouveau tool: diagnose_relationships
{
  name: 'diagnose_relationships',
  description: 'Analyze unresolved references in the codebase',
  parameters: {
    projectId: string,
    groupBy: 'reason' | 'file' | 'identifier',
    limit: number,
  },
  returns: {
    totalUnresolved: number,
    groups: Array<{ key: string; count: number; examples: UnresolvedReference[] }>,
    suggestions: string[], // Auto-generated suggestions
  }
}
```

### Suggestions automatiques

```typescript
function generateSuggestions(unresolved: UnresolvedReference[]): string[] {
  const suggestions: string[] = [];

  // Pattern: Many "No scope found" for same identifier
  const noScopeFound = unresolved.filter(u => u.reason.includes('No scope found'));
  const identifierCounts = new Map<string, number>();
  for (const u of noScopeFound) {
    identifierCounts.set(u.identifier, (identifierCounts.get(u.identifier) || 0) + 1);
  }

  for (const [id, count] of identifierCounts) {
    if (count > 5) {
      suggestions.push(
        `"${id}" referenced ${count} times but not found. ` +
        `Check if it's from an external library or needs to be included in parsing.`
      );
    }
  }

  // Pattern: Many candidates but no file match
  const multipleCandidates = unresolved.filter(u =>
    u.reason.includes('Multiple candidates') && u.candidates.length > 0
  );
  if (multipleCandidates.length > 10) {
    suggestions.push(
      `${multipleCandidates.length} references have multiple candidates. ` +
      `Consider adding tsconfig.json paths or import aliases configuration.`
    );
  }

  return suggestions;
}
```

---

## Plan d'implémentation

### Phase 1: Mode reference dans codeparsers

1. [ ] Ajouter `outputMode: 'uuid' | 'reference'` aux options
2. [ ] Créer types `ScopeReference` et `ResolvedRelationshipRef`
3. [ ] Implémenter `buildReferenceResult()`
4. [ ] Mettre à jour les tests
5. [ ] Publier nouvelle version codeparsers

### Phase 2: Intégration ragforge

1. [ ] Utiliser `outputMode: 'reference'` dans code-source-adapter
2. [ ] Simplifier le code de mapping (plus de lookup UUID)
3. [ ] Ajouter logging des unresolvedReferences

### Phase 3: Diagnostics avancés (optionnel)

1. [ ] Stocker UnresolvedReference nodes en Neo4j
2. [ ] Créer tool MCP `diagnose_relationships`
3. [ ] Implémenter suggestions automatiques

---

## Métriques de succès

```
# Avant
[RelationshipResolver] Built mapping for 5079 scopes
[RelationshipResolver] Generated 10158 UUIDs (thrown away)
[code-source-adapter] Re-generated 8234 UUIDs

# Après
[RelationshipResolver] Built mapping for 5079 scopes (reference mode)
[code-source-adapter] Generated 8234 UUIDs
[code-source-adapter] ⚠️ 127 unresolved references:
   - No scope found with this name: 89
   - Multiple candidates but no file match: 38
```

---

## Annexe: Comparaison UUID generation

### codeparsers (actuel)

```typescript
private generateUuid(scope: ScopeInfo, filePath: string): string {
  const signatureHash = this.getSignatureHash(scope);
  const input = `${filePath}:${scope.name}:${scope.type}:${signatureHash}`;
  const hash = createHash('sha256').update(input).digest('hex').substring(0, 32);
  return formatAsUuid(hash);
}
```

### ragforge (actuel)

```typescript
private generateUUID(scope: ScopeInfo, filePath: string): string {
  // 1. Check cache
  // 2. Check existingUUIDMapping (re-ingestion support!)
  // 3. Generate deterministic UUID
  const signatureHash = this.getSignatureHash(scope);
  const input = `${filePath}:${scope.name}:${scope.type}:${signatureHash}`;
  return UniqueIDHelper.GenerateDeterministicUUID(input);
}
```

**Différence clé**: ragforge supporte `existingUUIDMapping` pour préserver les UUIDs lors de re-ingestion. C'est pourquoi on ne peut pas utiliser directement les UUIDs de codeparsers.
