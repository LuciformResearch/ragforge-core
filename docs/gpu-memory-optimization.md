# Optimisation Mémoire GPU - GLiNER + TEI

## Problème observé

Lors de l'ingestion de 48 fichiers markdown, la mémoire GPU est saturée:
```
Total:   8192 MiB (RTX 2070 Super)
TEI:      366 MiB
GLiNER:  6258 MiB  ← pic pendant batch extraction
Libre:    102 MiB  ⚠️
```

GLiNER consomme ~6GB pendant les gros batches d'extraction d'entités.

---

## Solutions possibles

### 1. Limiter la taille des textes envoyés (truncation)

**Idée:** Tronquer chaque texte à ~500 caractères avant extraction d'entités.
Les entités importantes sont généralement au début du texte (noms, titres, etc.)

**Exception:** La détection de domaine a besoin de plus de contexte pour classifier correctement → garder le texte complet pour `/classify`.

**Fichier:** `src/ingestion/entity-extraction/client.ts`

```typescript
const MAX_TEXT_LENGTH = 500;  // caractères

async extract(text: string): Promise<ExtractionResult> {
  const truncatedText = text.slice(0, MAX_TEXT_LENGTH);
  // ... extraction sur texte tronqué
}

// MAIS pour la classification de domaine, garder le texte complet
async classifyDomain(text: string): Promise<string> {
  // Pas de truncation ici - besoin du contexte complet
}
```

**Impact:** Réduction drastique de la mémoire GPU (textes 5-10x plus courts)

---

### 2. Réduire le nombre de textes par batch (chunk size)

**Fichier:** `src/ingestion/entity-extraction/client.ts`

```typescript
// Actuellement
const CLIENT_CHUNK_SIZE = 100;

// Réduire à
const CLIENT_CHUNK_SIZE = 20;  // ou même 10
```

**Impact:** Moins de textes traités en parallèle → moins de mémoire GPU

---

### 3. Limiter la mémoire GPU via PyTorch

**Fichier:** `services/gliner_service/main.py` ou `extractor.py`

```python
import torch

# Limiter à 50% de la VRAM disponible
torch.cuda.set_per_process_memory_fraction(0.5)

# Ou limiter à une valeur absolue (4GB)
torch.cuda.set_per_process_memory_fraction(4096 / torch.cuda.get_device_properties(0).total_memory * 1024**2)
```

**Impact:** GLiNER ne pourra pas dépasser la limite, forcera des batches plus petits

---

### 4. Configurer batch_size côté service GLiNER

**Fichier:** `services/gliner_service/config/settings.yaml` ou variables d'env

```yaml
# Réduire le batch size interne de GLiNER
batch_size: 4  # au lieu de 8 ou 16
```

**Docker-compose:**
```yaml
environment:
  GLINER_BATCH_SIZE: 4
```

---

### 5. Limiter via Docker deploy resources

**Fichier:** `services/docker-compose.yml`

```yaml
gliner:
  deploy:
    resources:
      limits:
        memory: 6g  # RAM limite
      reservations:
        devices:
          - driver: nvidia
            count: 1
            capabilities: [gpu]
            # Note: Docker ne supporte pas directement la limite VRAM
            # Il faut utiliser NVIDIA_VISIBLE_DEVICES ou torch.cuda
```

---

### 6. Utiliser un modèle GLiNER plus léger

Modèles disponibles:
- `urchade/gliner_multi_pii-v1` (actuel) - ~2GB base
- `urchade/gliner_small` - plus léger
- `urchade/gliner_base` - compromis

**Docker-compose:**
```yaml
environment:
  GLINER_MODEL: urchade/gliner_small
```

---

### 7. Traitement séquentiel TEI/GLiNER (non parallèle)

Modifier le pipeline pour:
1. D'abord faire toutes les embeddings (TEI)
2. Puis faire toute l'extraction d'entités (GLiNER)

Au lieu de les faire en parallèle, ce qui double l'usage mémoire.

**Fichier:** `src/ingestion/unified-processor.ts`

---

### 8. Décharger GLiNER quand inactif

Ajouter un endpoint `/unload` au service GLiNER qui libère le modèle de la VRAM:

```python
@app.post("/unload")
async def unload_model():
    global model
    del model
    torch.cuda.empty_cache()
    return {"status": "unloaded"}
```

Et l'appeler après chaque batch d'extraction.

---

## Recommandations

Pour RTX 2070 Super (8GB):

| Priorité | Solution | Effort | Impact |
|----------|----------|--------|--------|
| 1 | Tronquer textes à 500 chars (sauf classify) | Faible | **Très fort** |
| 2 | Réduire CLIENT_CHUNK_SIZE à 20 | Faible | Moyen |
| 3 | torch.cuda.set_per_process_memory_fraction(0.5) | Faible | Fort |
| 4 | Traitement séquentiel TEI→GLiNER | Moyen | Fort |
| 5 | Modèle plus léger | Faible | Moyen |

---

## Monitoring

```bash
# Surveiller en temps réel
watch -n 1 nvidia-smi

# Ou
nvidia-smi --query-gpu=memory.used,memory.free --format=csv -l 1
```
