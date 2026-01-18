# RagForge Services

Docker Compose setup for RagForge backend services with GPU acceleration.

## Services

| Service | Port | Description | Required |
|---------|------|-------------|----------|
| **Neo4j** | 7687 (Bolt), 7474 (HTTP) | Knowledge graph database | ✅ Yes |
| **GLiNER** | 6971 | Entity extraction (GPU) | ❌ Optional |
| **TEI** | 8081 | Text embeddings inference (GPU) | ❌ Optional |

## Prerequisites

- Docker & Docker Compose
- NVIDIA GPU with CUDA support
- [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

## Quick Start

```bash
# Navigate to services directory
cd packages/ragforge-core/services

# Copy and customize configuration
cp .env.example .env

# Start all services
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f
```

## Start Individual Services

```bash
# Just Neo4j (minimal setup)
docker compose up -d neo4j

# Neo4j + TEI (embeddings only)
docker compose up -d neo4j tei

# Neo4j + GLiNER (entity extraction only)
docker compose up -d neo4j gliner

# All services
docker compose up -d
```

## GPU Memory Usage

Approximate VRAM usage per service:

| Service | VRAM |
|---------|------|
| GLiNER | ~2-3 GB |
| TEI (bge-base) | ~1 GB |
| TEI (bge-small) | ~0.5 GB |

For 8GB VRAM GPUs, use `bge-small-en-v1.5`:

```bash
TEI_MODEL=BAAI/bge-small-en-v1.5 docker compose up -d
```

## Configuration

See `.env.example` for all configuration options.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEO4J_PASSWORD` | ragforge | Neo4j password |
| `NEO4J_BOLT_PORT` | 7687 | Neo4j Bolt port |
| `NEO4J_HTTP_PORT` | 7474 | Neo4j Browser port |
| `GLINER_PORT` | 6971 | GLiNER API port |
| `GLINER_MODEL` | urchade/gliner_multi_pii-v1 | GLiNER model |
| `TEI_PORT` | 8081 | TEI API port |
| `TEI_MODEL` | BAAI/bge-base-en-v1.5 | Embedding model |

## Verify Services

```bash
# Neo4j
curl http://localhost:7474

# GLiNER
curl http://localhost:6971/health

# TEI
curl http://localhost:8081/health
```

## Rebuild GLiNER (after code changes)

```bash
docker compose build gliner
docker compose up -d gliner
```

## Data Persistence

Data is persisted in Docker volumes:
- `ragforge_neo4j_data` - Neo4j database
- `ragforge_neo4j_logs` - Neo4j logs
- `ragforge_hf_cache` - HuggingFace model cache (GLiNER)
- `ragforge_tei_cache` - TEI model cache

To reset all data:
```bash
docker compose down -v
```

## Architecture

```
services/
├── docker-compose.yml      # Service orchestration
├── .env.example            # Configuration template
├── README.md               # This file
└── gliner_service/         # GLiNER entity extraction
    ├── Dockerfile          # CPU version
    ├── Dockerfile.gpu      # GPU version (default)
    ├── main.py             # FastAPI server
    ├── extractor.py        # GLiNER wrapper
    └── config/             # Domain configurations
```

## Troubleshooting

### Neo4j won't start
```bash
docker compose logs neo4j
```

### GLiNER slow on first call
Normal - model (~205M params) needs to load. Subsequent calls are fast.

### Out of VRAM
- Use smaller TEI model: `TEI_MODEL=BAAI/bge-small-en-v1.5`
- GLiNER and TEI share GPU - they load/unload dynamically
