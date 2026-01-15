# Plan de Normalisation des Propriétés de Nodes

## Objectif

Normaliser toutes les propriétés de contenu vers 3 champs standardisés:
- `_name` - Nom/titre/signature (searchable)
- `_content` - Contenu principal (code, texte, etc.)
- `_description` - Description/documentation

Plus de `content`, `text`, `body`, `source`, `rawText`, `rawContent`, `textContent`, `ownContent`, `code`, `description`, `docstring`, `templateSource`.

**Ajout:** `_rawContent` sur les File nodes pour permettre aux agents de lire les fichiers virtuels.

---

## Infrastructure Créée

### Fichier: `src/ingestion/parser-types.ts`

- **`NormalizedNodeProps`** (interface) - Types pour les 3 champs normalisés
- **`RAW_CONTENT_PROPERTIES`** (const) - Liste des propriétés brutes à supprimer
- **`createContentNode()`** - Builder qui normalise automatiquement
- **`createStructuralNode()`** - Builder pour nodes sans contenu (File, Directory, Project)
- **`createNodeFromRegistry()`** - Builder qui utilise le parserRegistry pour les extractors

---

## Changements à Faire

### 1. NODE CREATION - code-source-adapter.ts

| Ligne | Type de Node | Status | Action |
|-------|--------------|--------|--------|
| 996 | Project | ✅ OK | Structural node, pas de contenu |
| 1016 | PackageJson | ✅ OK | Structural node |
| 1051 | File | 🔄 À FAIRE | Ajouter `_rawContent` avec contenu du fichier |
| 1191 | Scope | ✅ FAIT | Utilise `createNodeFromRegistry()` |
| 1222 | File | 🔄 À FAIRE | Ajouter `_rawContent` |
| 1295 | Directory | ✅ OK | Structural node |
| 1365 | ExternalLibrary | ✅ OK | Pas de contenu |
| 1387 | WebDocument | ✅ OK | Container node |
| 1422 | File | 🔄 À FAIRE | Ajouter `_rawContent` |
| 1455 | Image | ✅ OK | Pas de contenu textuel |
| 1516 | Scope | ✅ FAIT | Utilise `createNodeFromRegistry()` |
| 1571 | Stylesheet | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()` |
| 1606 | File | 🔄 À FAIRE | Ajouter `_rawContent` |
| 1712 | Stylesheet | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()` |
| 1747 | File | 🔄 À FAIRE | Ajouter `_rawContent` |
| 1785 | VueSFC | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()` |
| 1821 | File | 🔄 À FAIRE | Ajouter `_rawContent` |
| 1862 | SvelteComponent | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()` |
| 1894 | File | 🔄 À FAIRE | Ajouter `_rawContent` |
| 1937 | MarkdownDocument | ✅ OK | Container node |
| 1971 | File | 🔄 À FAIRE | Ajouter `_rawContent` |
| 2009 | CodeBlock | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()`, `rawText: block.code` |
| 2042 | MarkdownSection | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()`, `content: section.content` |
| 2094 | GenericFile | ✅ OK | Container node |
| 2123 | File | 🔄 À FAIRE | Ajouter `_rawContent` |
| 2176 | DataFile | 🔄 À FAIRE | Container, mais a `rawContent` |
| 2205 | File | 🔄 À FAIRE | Ajouter `_rawContent` |

### 2. NODE CREATION - web-adapter.ts

| Ligne | Type de Node | Status | Action |
|-------|--------------|--------|--------|
| 272 | Website | ✅ OK | Container node |
| 297 | WebPage | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()`, `textContent` |

### 3. NODE CREATION - document-parser.ts

| Ligne | Type de Node | Status | Action |
|-------|--------------|--------|--------|
| 534 | File | ✅ OK | Pas de contenu |
| 556 | MarkdownDocument | ✅ OK | Container |
| 591 | MarkdownSection | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()`, `content: section.text` |

### 4. NODE CREATION - code-source-adapter.ts (DataSection)

| Ligne | Type de Node | Status | Action |
|-------|--------------|--------|--------|
| 2618 | DataSection | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()`, `content: section.content` |

### 5. NODE CREATION - media-file-parser.ts

| Ligne | Type de Node | Status | Action |
|-------|--------------|--------|--------|
| ~150 | ImageFile | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()` si `description` |
| ~200 | ThreeDFile | 🔄 À FAIRE | Utiliser `createNodeFromRegistry()` si `description` |

---

## Property Reading - À Mettre à Jour

Ces fichiers lisent les anciennes propriétés et doivent être mis à jour pour utiliser `_content`, `_name`, `_description`:

### 1. search-post-processor.ts

```typescript
// Ligne 535-536 - AVANT
const code = node.source || node.content || '';
const docstring = node.docstring || node.description || '';

// APRÈS
const code = node._content || '';
const docstring = node._description || '';
```

### 2. brain-tools.ts

```typescript
// Ligne 1539-1540 - AVANT
const code = node.source || node.content || '';
const docstring = node.docstring || node.description || '';

// APRÈS
const code = node._content || '';
const docstring = node._description || '';
```

### 3. storage.ts

```typescript
// Ligne 1728 - AVANT
const content = node.source || '';

// APRÈS
const content = node._content || '';

// Ligne 3314 - AVANT
const content = node.source || node.content || '';

// APRÈS
const content = node._content || '';
```

### 4. node-schema.ts

```typescript
// Ligne 763 - AVANT
const content = node.source || node.content || node.textContent || node.code;

// APRÈS
const content = node._content;

// Ligne 776 - AVANT
const desc = node.docstring || node.description || node.metaDescription;

// APRÈS
const desc = node._description;
```

### 5. parser-registry.ts (fallbacks)

```typescript
// Ligne 558-562 - AVANT (fallbacks pour types inconnus)
content: (node) => node.source || node.content || node.textContent || null,
description: (node) => node.docstring || node.description || null,

// APRÈS
content: (node) => node._content || null,
description: (node) => node._description || null,
```

---

## EmbeddingChunk - Changement de `text` vers `_content`

### embedding-service.ts

```typescript
// Ligne 1026-1036 - AVANT
CREATE (c:EmbeddingChunk {
  uuid: chunk.uuid,
  ...
  text: chunk.text,  // <-- ICI
  ...
})

// APRÈS
CREATE (c:EmbeddingChunk {
  uuid: chunk.uuid,
  ...
  _content: chunk.text,  // <-- Normalisé
  ...
})
```

### entity-extraction/transform.ts

```typescript
// Ligne ~337 - getNodeTextContent()
// AVANT
const content = props._content || props.content || props.text || props.body || props.description;

// APRÈS
const content = props._content;  // Plus de fallbacks
```

---

## extractUnifiedFields - À Supprimer

Une fois tous les nodes normalisés à la création, ces fonctions deviennent inutiles:

1. `src/runtime/adapters/incremental-ingestion.ts:45-76` - Supprimer la fonction
2. `src/runtime/adapters/incremental-ingestion.ts:669` - Supprimer l'appel
3. `src/ingestion/graph-merger.ts:457-492` - Supprimer la méthode
4. `src/ingestion/graph-merger.ts:214` - Supprimer l'appel

---

## File Nodes - Ajouter `_rawContent`

Pour permettre aux agents de lire les fichiers virtuels:

```typescript
// AVANT
nodes.push({
  labels: ['File'],
  id: fileUuid,
  properties: {
    uuid: fileUuid,
    path: relPath,
    name: fileName,
    extension,
    ...
  }
});

// APRÈS
nodes.push(createStructuralNode('File', fileUuid, {
  uuid: fileUuid,
  path: relPath,
  name: fileName,
  extension,
  _rawContent: fileContent,  // Contenu brut du fichier
  ...
}));
```

**Limitation de taille recommandée:** Ne pas stocker `_rawContent` pour les fichiers > 100KB ou binaires.

---

## Ordre d'Exécution Recommandé

1. ✅ Créer `createContentNode()` et `createNodeFromRegistry()` - FAIT
2. ✅ Migrer Scope nodes - FAIT
3. 🔄 Migrer autres content nodes (MarkdownSection, CodeBlock, etc.)
4. 🔄 Ajouter `_rawContent` aux File nodes
5. 🔄 Mettre à jour les lecteurs de propriétés (search, storage, tools)
6. 🔄 Mettre à jour EmbeddingChunk (`text` -> `_content`)
7. 🔄 Supprimer `extractUnifiedFields()`
8. 🔄 Rebuild et test complet

---

## Tests à Effectuer

1. Build ragforge-core
2. Ré-ingérer un projet test
3. Vérifier que les nodes ont `_name`, `_content`, `_description`
4. Vérifier que `source`, `content`, `text`, etc. sont absents
5. Tester la recherche sémantique
6. Tester l'extraction d'entités
7. Tester la lecture de fichiers virtuels via `_rawContent`
