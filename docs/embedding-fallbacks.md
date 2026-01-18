# Embedding Fallbacks

Ce document décrit les fallbacks implémentés pour éviter que des nodes restent bloqués en état `_state='linked'` quand ils n'ont pas de contenu valide pour les embeddings.

## Problème

Certains types de nodes peuvent être créés sans `_content` ou `_description` valide :
- Fichiers media/3D non analysés par vision
- Documents dont l'OCR a échoué
- Images non analysées

Ces nodes restaient bloqués en `_state='linked'` car les queries d'embedding avaient des conditions `WHERE _content IS NOT NULL`.

## Fallbacks implémentés

### MediaFile
```cypher
coalesce(m._name, m.file) AS _name,
coalesce(m._content, 'Media file: ' + coalesce(m.file, 'unknown')) AS _content
```
**À améliorer** : Analyser avec vision quand disponible.

### ThreeDFile
```cypher
coalesce(t._name, t.file) AS _name,
coalesce(t._content, '3D model: ' + coalesce(t.file, 'unknown')) AS _content
```
**À améliorer** : Render + vision analysis.

### DocumentFile
```cypher
coalesce(d._name, d.file) AS _name,
coalesce(d._content, 'Document: ' + coalesce(d.file, 'unknown')) AS _content
```
**À améliorer** : Retry OCR ou fallback Gemini Vision.

### ImageFile
```cypher
coalesce(i._name, i.file) AS _name,
coalesce(i._description, 'Image: ' + coalesce(i.file, 'unknown')) AS _content
```
**À améliorer** : Vision analysis automatique.

## Types ajoutés (manquaient complètement)

- **DataSection** : Sections dans les fichiers JSON/YAML
- **ImageFile** : Images (PNG, JPG, etc.)
- **VueSFC** : Composants Vue
- **SvelteComponent** : Composants Svelte

## Comment retrouver les nodes avec fallback

Pour identifier les nodes qui utilisent le fallback :

```cypher
// MediaFile sans vrai contenu
MATCH (m:MediaFile)
WHERE m._content IS NULL AND m._description IS NULL
RETURN m.file, m.uuid

// DocumentFile sans OCR
MATCH (d:DocumentFile)
WHERE d._content IS NULL
RETURN d.file, d.uuid

// ImageFile sans vision analysis
MATCH (i:ImageFile)
WHERE i._description IS NULL
RETURN i.file, i.uuid
```

## Types découverts sans config d'embedding

Ces types de nodes n'ont pas de config dans `MULTI_EMBED_CONFIGS` et restent bloqués en `_state='linked'` :

| Type | Count observé | Quoi embedder | Status |
|------|---------------|---------------|--------|
| `ExternalURL` | 1134 | L'URL elle-même | ✅ Config ajoutée |
| `Directory` | 133 | Le chemin du dossier | ✅ Config ajoutée |
| `CSSVariable` | 17 | Le nom + valeur | ✅ Config ajoutée |
| `DataSection` | 9 | path + content | ✅ Config ajoutée |
| `MediaFile` | 1 | filename (fallback) | ✅ Config ajoutée |
| `ImageFile` | - | filename (fallback) | ✅ Config ajoutée |
| `VueSFC` | - | componentName + template | ✅ Config ajoutée |
| `SvelteComponent` | - | componentName + template | ✅ Config ajoutée |

### Configs à ajouter

Note: On utilise seulement `_name` (pas `_content`) pour économiser des embeddings sur les types simples.

```typescript
// ExternalURL - embed l'URL pour recherche
{
  label: 'ExternalURL',
  query: `MATCH (u:ExternalURL {projectId: $projectId})
          RETURN u.uuid AS uuid, u.url AS _name,
                 u.embedding_name_hash AS embedding_name_hash,
                 u.embedding_provider AS embedding_provider,
                 u.embedding_model AS embedding_model,
                 u._state AS _state`,
  embeddings: [{ field: 'name', property: '_name', indexName: 'externalurl_name_embeddings' }],
}

// Directory - embed le chemin
{
  label: 'Directory',
  query: `MATCH (d:Directory {projectId: $projectId})
          RETURN d.uuid AS uuid, d.path AS _name,
                 d.embedding_name_hash AS embedding_name_hash,
                 d.embedding_provider AS embedding_provider,
                 d.embedding_model AS embedding_model,
                 d._state AS _state`,
  embeddings: [{ field: 'name', property: '_name', indexName: 'directory_name_embeddings' }],
}

// CSSVariable - embed nom + valeur
{
  label: 'CSSVariable',
  query: `MATCH (v:CSSVariable {projectId: $projectId})
          RETURN v.uuid AS uuid, v.name AS _name, v.value AS _content,
                 v.embedding_name_hash AS embedding_name_hash,
                 v.embedding_content_hash AS embedding_content_hash,
                 v.embedding_provider AS embedding_provider,
                 v.embedding_model AS embedding_model,
                 v._state AS _state`,
  embeddings: buildEmbeddingConfigs('CSSVariable', false),
}
```

## Types sans embeddings (voulu ou à améliorer)

| Type | Total | Name Emb | Content Emb | Status | Raison |
|------|-------|----------|-------------|--------|--------|
| `File` | 461 | 0 | 0 | ⚠️ | Query filtre `WHERE _rawContent IS NOT NULL` - les fichiers sans contenu brut sont exclus |
| `MarkdownDocument` | 53 | 0 | 0 | ✅ | Normal - ce sont les `MarkdownSection` qui ont les embeddings, pas le document parent |
| `DataFile` | 24 | 0 | 0 | ⚠️ | Pas de `_content` rempli - à investiguer |
| `Entity` | 457 | 296 | 0 | ✅ | Normal - types numériques (price, date, amount, duration, quantity, currency, size) sont volontairement exclus via `DEFAULT_SKIP_EMBEDDING_TYPES` |

### Entity types exclus des embeddings

Ces types sont volontairement exclus car embedder des valeurs numériques n'a pas de sens sémantique:

```typescript
const DEFAULT_SKIP_EMBEDDING_TYPES = [
  'price',
  'date',
  'quantity',
  'amount',
  'currency',
  'size',
  'duration',
];
```

## TODO

### Priorité haute (bloque l'ingestion)
- [x] Ajouter config embedding pour `ExternalURL` ✅
- [x] Ajouter config embedding pour `Directory` ✅
- [x] Ajouter config embedding pour `CSSVariable` ✅
- [x] Fix File "tailwindcss" - CSS parser créait des File pour les packages npm ✅

### Priorité moyenne (amélioration qualité)
- [ ] Investiguer pourquoi `File` nodes n'ont pas de `_rawContent`
- [ ] Investiguer pourquoi `DataFile` nodes n'ont pas de `_content`
- [ ] Ajouter un job de background pour analyser les fichiers avec fallback
- [ ] Intégrer vision analysis dans le pipeline d'ingestion
- [ ] Ajouter retry OCR avec Gemini Vision pour les documents échoués
