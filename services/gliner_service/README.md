# GLiNER Entity Extraction Service

Microservice Python pour l'extraction d'entités et de relations avec GLiNER2.

## Fonctionnalités

- **Extraction d'entités** : Personnes, organisations, produits, etc.
- **Extraction de relations** : works_for, contains, inherits_from, etc.
- **Classification multi-label** : Détection automatique du domaine
- **Batch processing** : Groupement par domaine pour efficacité
- **Configuration YAML** : Domaines personnalisables sans modifier le code

## Installation

```bash
cd packages/ragforge-core/services/gliner-service
pip install -r requirements.txt
```

## Lancement

```bash
# Via uvicorn
uvicorn gliner_service.main:app --host 0.0.0.0 --port 6971 --reload

# Ou directement
python -m gliner_service.main
```

## Installation en tant que Service Systemd

Pour un fonctionnement permanent sur un serveur Linux:

```bash
# 1. Éditer le fichier service pour adapter User et WorkingDirectory
nano gliner-service.service

# 2. Copier vers systemd
sudo cp gliner-service.service /etc/systemd/system/

# 3. Recharger systemd
sudo systemctl daemon-reload

# 4. Activer au démarrage
sudo systemctl enable gliner-service

# 5. Démarrer le service
sudo systemctl start gliner-service

# 6. Vérifier le status
sudo systemctl status gliner-service

# Commandes utiles
sudo systemctl restart gliner-service
sudo journalctl -u gliner-service -f  # Voir les logs
```

## Configuration

### Variables d'environnement

| Variable | Default | Description |
|----------|---------|-------------|
| `GLINER_MODEL_NAME` | `gliner-community/gliner-large-v2` | Modèle GLiNER2 |
| `GLINER_DEVICE` | `cpu` | Device (cpu/cuda) |
| `GLINER_HOST` | `0.0.0.0` | Host API |
| `GLINER_PORT` | `6971` | Port API |
| `GLINER_DEFAULT_BATCH_SIZE` | `8` | Taille batch |
| `GLINER_CONFIDENCE_THRESHOLD` | `0.5` | Seuil de confiance |
| `GLINER_CONFIG_PATH` | `./entity-extraction.yaml` | Chemin config YAML |

### Configuration YAML (`entity-extraction.yaml`)

Le fichier YAML permet de configurer :
- **defaults** : Types d'entités et relations par défaut
- **domains** : Presets par domaine (entités, relations, description)

```yaml
defaults:
  entity_types:
    - person
    - organization
  relation_types:
    works_for: "person works for organization"

domains:
  ecommerce:
    description: "Text about products, shopping"
    entity_types:
      - product
      - brand
      - price
    relation_types:
      contains: "product contains ingredient"

  # Ajouter vos propres domaines
  medical:
    description: "Medical content"
    entity_types:
      - symptom
      - diagnosis
    relation_types:
      treats: "medication treats condition"
```

### Hot-reload de la configuration

```bash
# Modifier entity-extraction.yaml puis :
curl -X POST http://localhost:6971/config/reload
```

## API Endpoints

### Extraction

```bash
# Single text
POST /extract
{
  "text": "Tim Cook is the CEO of Apple Inc.",
  "entity_types": ["person", "organization"],
  "relation_types": {"works_for": "person works for org"}
}

# Batch extraction
POST /extract/batch
{
  "texts": ["text1", "text2"],
  "batch_size": 8
}

# Auto-domain detection
POST /extract/auto
["text1", "text2", "text3"]
```

### Classification

```bash
POST /classify?text=This product contains vitamin E&threshold=0.3
```

### Configuration

```bash
# List domains with entity/relation counts
GET /domains

# Get full presets
GET /presets

# Reload config (hot-reload YAML)
POST /config/reload

# Current config
GET /config

# Health check
GET /health
```

## Réponse type

```json
{
  "entities": [
    {
      "name": "Tim Cook",
      "type": "person",
      "confidence": 0.95,
      "span": [0, 8]
    },
    {
      "name": "Apple Inc.",
      "type": "organization",
      "confidence": 0.92,
      "span": [24, 34]
    }
  ],
  "relations": [
    {
      "subject": "Tim Cook",
      "predicate": "works_for",
      "object": "Apple Inc.",
      "confidence": 0.88
    }
  ],
  "processing_time_ms": 45.2
}
```

## Domain Presets (par défaut)

| Domain | Entités | Relations |
|--------|---------|-----------|
| **ecommerce** | product, brand, price, ingredient, certification... | compatible_with, contains, certified_by... |
| **code** | function, class, method, variable, module, library... | calls, inherits_from, implements, imports... |
| **documentation** | concept, feature, requirement, specification... | describes, requires, implements, affects... |
| **legal** | person, organization, contract, clause, obligation... | party_to, obligated_to, grants_right... |

## Docker

```bash
# Build
docker build -t gliner-service .

# Run
docker run -p 6971:6971 gliner-service

# Avec GPU
docker run --gpus all -e GLINER_DEVICE=cuda -p 6971:6971 gliner-service

# Avec config custom
docker run -p 6971:6971 -v /path/to/config.yaml:/app/entity-extraction.yaml gliner-service
```

## Architecture

```
ragforge-core/
└── services/
    └── gliner-service/
        ├── __init__.py
        ├── config.py                # Chargement YAML + settings
        ├── entity-extraction.yaml   # Configuration des domaines
        ├── extractor.py             # GLiNER2 wrapper
        ├── main.py                  # FastAPI server
        ├── models.py                # Pydantic models
        ├── requirements.txt
        ├── Dockerfile
        ├── gliner-service.service   # Systemd service file
        └── README.md
```

## Intégration avec RagForge

Le service est appelé par `ragforge-core/src/ingestion/entity-extraction/client.ts` :

```typescript
const client = new EntityExtractionClient({
  serviceUrl: 'http://localhost:6971',
  autoDetectDomain: true,
});

const result = await client.extractBatch(texts);
```

## Ajouter un nouveau domaine

1. Éditer `entity-extraction.yaml`
2. Appeler `POST /config/reload` (ou redémarrer le service)
3. Le nouveau domaine est disponible immédiatement

```yaml
domains:
  finance:
    description: "Financial documents, transactions, markets"
    entity_types:
      - company
      - stock
      - currency
      - amount
    relation_types:
      trades_on: "stock trades on market"
      acquired_by: "company acquired by another"
```

## Notes

- GLiNER2 (~205M params) fonctionne efficacement sur CPU
- Premier appel plus lent (chargement du modèle)
- La classification utilise GLiNER2 native avec fallback heuristique
