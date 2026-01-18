# Investigation: Entity Search et Class Embedding

## Problème observé

Recherche "embedding service generate embeddings" avec semantic=true:
- Entity "embedding service" → score 0.94
- Mais la **classe EmbeddingService** elle-même n'apparaît pas dans les top résultats

## Hypothèses

### 1. Classes sans embedding_content?

Les classes ont-elles un `_content` rempli?
- Si `_content` est null/vide, pas d'embedding_content généré
- Donc pas de match sémantique sur le contenu de la classe

### 2. _name des classes

Que contient `_name` pour une classe?
- Juste "EmbeddingService"?
- Ou "class EmbeddingService"?
- Ou la signature complète?

### 3. BM25 devrait matcher

Si on cherche "embedding service":
- BM25 sur `_name` devrait matcher "EmbeddingService"
- Mais peut-être que le tokenizer ne split pas le camelCase?
- Ou le score BM25 est dilué par le score sémantique faible?

### 4. RRF Fusion

Le search utilise RRF (Reciprocal Rank Fusion) pour combiner:
- Scores sémantiques (vector similarity)
- Scores BM25 (fulltext)

Si une classe n'a pas d'embedding_content:
- Score sémantique sur content = 0 ou très bas
- Score BM25 peut être bon
- Mais RRF combine les deux...

## Questions à vérifier

1. Quel est le `_content` d'une classe comme EmbeddingService?
2. Est-ce que embedding_content est généré pour les classes?
3. Comment le BM25 tokenize "EmbeddingService" vs "embedding service"?

## Solution potentielle pour Entity

Les Entity ne devraient pas apparaître dans les résultats de recherche normaux:
1. **Filtrer Entity par défaut** - sauf si `types: ['Entity']` explicite
2. **Boost via MENTIONS** - utiliser les Entity matchées pour booster les nodes qui les mentionnent

## Découverte: Relations HAS_PARENT

Les méthodes ont une relation `HAS_PARENT` vers leur classe:
```
(method:Scope {name: 'generateEmbeddings'})-[:HAS_PARENT]->(class:Scope {name: 'EmbeddingService'})
```

**Problème actuel**:
- La classe a `_content` = "export class EmbeddingService {" (juste la déclaration)
- Les méthodes ont leur contenu complet
- Quand on cherche "generate embeddings", la méthode matche mais pas la classe
- On ne traverse pas HAS_PARENT pour booster la classe

**Solutions possibles**:

### Option A: Boost via HAS_PARENT au search time
Quand un Scope matche, booster aussi:
- Son parent (classe contenant la méthode)
- Ses enfants (méthodes de la classe)

### Option B: Enrichir _content des classes (RETENU)

**Au parsing**: Inclure les noms des méthodes dans `_content` de la classe:
```typescript
// Avant
_content: "export class EmbeddingService {"

// Après
_content: `export class EmbeddingService {
  // Methods: constructor, setProvider, generateEmbeddings, embedBatch, embedSingleNode...
}`
```

**Au search time (formatting)**: Quand une classe est retournée, afficher les lignes des méthodes:
```
### EmbeddingService (class) ★ 0.92
📍 /src/brain/embedding-service.ts:37-1900

Methods:
  - constructor (L45-89)
  - generateEmbeddings (L120-250)
  - embedBatch (L300-350)
```

**Implémentation**:
1. Dans le parser (codeparsers), quand on crée un Scope de type class/interface:
   - Collecter les noms des enfants (méthodes, propriétés)
   - Les ajouter au `_content` ou `_description`
2. Dans le formatter de search results:
   - Détecter si c'est une classe
   - Query les enfants via HAS_PARENT
   - Afficher leurs lignes

### Option C: Agréger les embeddings
Créer un embedding "agrégé" pour les classes basé sur leurs méthodes.
(Plus complexe, à considérer plus tard)

## Décision: Filtrage par défaut pour brain_search

### Contexte

`brain_search` est l'outil principal utilisé par Claude pour explorer le code.
Son usage principal est de **trouver du code** (fonctions, classes, méthodes).

### Problème actuel

Par défaut, brain_search retourne TOUS les types de nodes:
- Scope (code) ✅ - ce qu'on veut
- MarkdownSection ❌ - bruit
- Entity ❌ - bruit (ex: "embedding service" entity vs EmbeddingService class)
- File, Directory, etc. ❌ - rarement utile

### Décision

**brain_search doit chercher UNIQUEMENT les Scopes par défaut.**

Raisons:
1. Claude cherche du code, pas de la documentation
2. Les Entity polluent les résultats (score élevé mais pas de code)
3. Les MarkdownSection sont rarement ce que Claude cherche
4. Réduire le bruit = meilleure pertinence

### Implémentation

```typescript
// Dans brain-tools.ts, generateBrainSearchHandler()

// Par défaut: que du code (Scope)
const DEFAULT_CODE_TYPES = ['function', 'method', 'class', 'interface', 'variable', 'module', 'type', 'enum'];

// Si l'utilisateur veut tout chercher, il utilise include_all_types: true
const effectiveTypes = params.include_all_types 
  ? params.types  // null = tous les types
  : (params.types || DEFAULT_CODE_TYPES);
```

### Nouveau paramètre: `include_all_types`

| Paramètre | Default | Description |
|-----------|---------|-------------|
| `types` | `['function', 'method', 'class', ...]` | Types à chercher |
| `include_all_types` | `false` | Si `true`, cherche dans tous les types (markdown, entities, etc.) |

### Exemples d'usage

```typescript
// Recherche code (défaut) - ce que Claude utilise 99% du temps
brain_search({ query: "authentication logic" })

// Recherche dans markdown aussi (quand Claude a besoin de docs)
brain_search({ query: "API documentation", include_all_types: true })

// Recherche spécifique entities (rare)
brain_search({ query: "John Smith", types: ["entity"] })
```

## TODO

- [x] Vérifier _content et _name des classes dans Neo4j ✅
- [x] Vérifier si embedding_content existe pour les classes ✅ (oui mais contenu pauvre)
- [ ] Tester BM25 seul sur "embedding service"
- [x] Implémenter filtrage Entity par défaut → **Décision: filtrer Scope par défaut**
- [ ] Implémenter boost via HAS_PARENT relationships
- [ ] Considérer enrichissement _description des classes
