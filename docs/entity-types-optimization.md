# Optimisation des Entity Types GLiNER

## Contexte

L'extraction d'entités GLiNER est lente (~3-4 min pour 50 fichiers). Une des causes est le nombre élevé de types d'entités par domaine.

## État actuel

| Domaine | Nb entity_types | Nb relation_types |
|---------|----------------|-------------------|
| defaults | 12 | 8 |
| ecommerce | 14 | 7 |
| code | 16 | 10 |
| documentation | 14 | 8 |
| legal | 11 | 5 |

## Suggestions de réduction/merge

### Domain `code` (16 → 10)

**Avant (16 types):**
```yaml
- function, class, method, variable, module, library
- api, endpoint, parameter, return_type
- error, exception, configuration
- file_path, url, git_ref, package_name
```

**Après (10 types) - merges suggérés:**
```yaml
entity_types:
  - code_element      # function, class, method, variable (le parser TS fait déjà ça)
  - module            # module, library, package_name
  - api_element       # api, endpoint
  - type_info         # parameter, return_type
  - error             # error, exception
  - configuration
  - reference         # file_path, url, git_ref
```

**Rationale:**
- Le parser TypeScript extrait déjà les fonctions, classes, méthodes comme Scope nodes
- `api` et `endpoint` sont souvent la même chose
- `parameter` et `return_type` sont des infos de type

### Domain `documentation` (14 → 8)

**Avant (14 types):**
```yaml
- concept, feature, requirement, specification, user_story, use_case
- actor, system, component, version, release, milestone
- file_path, url, endpoint, section_ref
```

**Après (8 types):**
```yaml
entity_types:
  - concept           # concept, specification
  - feature           # feature, requirement, user_story, use_case
  - component         # actor, system, component
  - version           # version, release, milestone
  - reference         # file_path, url, endpoint, section_ref
```

**Rationale:**
- `feature`, `requirement`, `user_story`, `use_case` sont très similaires
- `version`, `release`, `milestone` sont tous des concepts de versioning

### Domain `ecommerce` (14 → 8)

**Avant (14 types):**
```yaml
- product, brand, price, currency, quantity, category
- ingredient, certification, benefit
- hair_type, skin_type, size, color, material
```

**Après (8 types):**
```yaml
entity_types:
  - product
  - brand
  - category
  - price             # price, currency, amount → un seul type
  - attribute         # size, color, material, hair_type, skin_type
  - ingredient
  - certification
  - benefit
```

**Rationale:**
- `hair_type`, `skin_type`, `size`, `color`, `material` sont tous des attributs produit
- `price` et `currency` vont ensemble

## Impact attendu

- **Moins de types = moins de passes GLiNER** (le modèle traite chaque type)
- **Moins de bruit** dans les entités extraites
- **Temps estimé** : réduction de 30-50% du temps d'extraction

## Notes

- Le parser TypeScript extrait déjà les Scope (functions, classes, etc.)
- GLiNER devrait se concentrer sur les entités **sémantiques** (concepts, features, etc.)
- Les entités de code extraites par GLiNER font doublon avec les Scope

## Bugs corrigés (2026-01-18)

### Boucle infinie sur skip_embedding_types

**Problème:** Les Entity de type `price`, `date`, `quantity`, `amount`, `currency`, `size`, `duration` restaient bloquées en `_state='linked'` causant une boucle infinie.

**Cause:** Le code marquait ces types comme `embedded` APRÈS avoir vérifié s'il y avait des nodes à traiter. La loop re-trouvait les mêmes nodes avant qu'ils soient marqués.

**Fix:** Marquer les skip types AVANT de vérifier les nodes linked.

```typescript
// AVANT: mark après check → boucle infinie
const nodes = await checkLinkedNodes();
if (nodes.length > 0) {
  await generateEmbeddings();
  await markSkipTypes();  // trop tard, la loop a déjà re-trouvé les nodes
}

// APRÈS: mark avant check → OK
await markSkipTypes();  // marque d'abord
const nodes = await checkLinkedNodes();  // maintenant ils sont plus là
if (nodes.length > 0) {
  await generateEmbeddings();
}
```
