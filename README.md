# RagForge

An MCP (Model Context Protocol) server that gives Claude persistent memory and powerful code analysis capabilities through a Neo4j knowledge graph.

## What is RagForge?

RagForge extends Claude with:

- **Persistent Memory** - Everything Claude reads, searches, or analyzes is stored in a knowledge graph
- **Semantic Code Search** - Find code by meaning, not just text matching
- **Multi-Project Context** - Work across multiple codebases with full relationship tracking
- **Web Research** - Crawl, index, and search web documentation
- **Visual Understanding** - OCR, image analysis, 3D model generation

## Features

| Feature | Description |
|---------|-------------|
| **MCP Server** | Direct integration with Claude Code and Claude Desktop |
| **Knowledge Graph** | Neo4j-based persistent storage with relationship tracking |
| **Code Parsing** | TypeScript, JavaScript, Python, Vue, Svelte, HTML, CSS |
| **Document Processing** | PDF, DOCX, XLSX, Markdown, images (OCR) |
| **Semantic Search** | Vector embeddings for intelligent retrieval |
| **Entity Extraction** | Named entity recognition (GPU-accelerated) |
| **Web Crawling** | Index documentation and web pages |

---

## Prerequisites

### Required

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Node.js** | ≥ 18.0.0 | [Download](https://nodejs.org/) |
| **Docker** | Latest | [Install Docker](https://docs.docker.com/get-docker/) |
| **Docker Compose** | v2+ | Included with Docker Desktop |

### Optional (for GPU acceleration)

| Requirement | Notes |
|-------------|-------|
| **NVIDIA GPU** | CUDA-capable GPU (RTX 2000+ recommended) |
| **NVIDIA Driver** | ≥ 525.60.13 |
| **nvidia-container-toolkit** | Required for GPU in Docker |

---

## Quick Start

### Option A: Automated Setup

```bash
# Clone or navigate to ragforge
cd packages/ragforge-core

# Run setup script (CPU mode - Neo4j only)
chmod +x scripts/setup.sh
./scripts/setup.sh

# Or with GPU acceleration (Neo4j + GLiNER + TEI)
./scripts/setup.sh --with-gpu
```

### Option B: Manual Setup

#### 1. Install the package

```bash
npm install @luciformresearch/ragforge
```

#### 2. Start services

```bash
cd node_modules/@luciformresearch/ragforge/services

# Copy and customize configuration
cp .env.example .env

# Start all services (Neo4j required, GLiNER + TEI optional)
docker compose up -d neo4j

# Or start with GPU services for faster processing
docker compose up -d
```

#### 3. Configure API keys

Create `~/.ragforge/.env`:

```bash
# Required for embeddings (if not using local TEI/Ollama)
GEMINI_API_KEY=your-gemini-api-key

# Optional - for 3D model generation
REPLICATE_API_TOKEN=your-replicate-token
```

#### 4. Configure MCP for Claude Code

Create `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "ragforge": {
      "command": "node",
      "args": [
        "./node_modules/@luciformresearch/ragforge/dist/esm/cli/index.js",
        "mcp-server"
      ]
    }
  }
}
```

Create `.claude/settings.local.json` in your project:

```json
{
  "enableAllProjectMcpServers": true,
  "enabledMcpjsonServers": ["ragforge"]
}
```

#### 5. Configure environment

RagForge reads from `~/.ragforge/.env`:

```bash
# Neo4j connection
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=ragforge

# API keys
GEMINI_API_KEY=your-gemini-api-key
```

#### 6. Restart Claude Code

After configuration, restart Claude Code to load the MCP server. You should see "ragforge" in the MCP servers list.

---

## MCP Tools Available

Once configured, Claude has access to these tools:

### Code & File Operations
| Tool | Description |
|------|-------------|
| `read_file` | Read file with line numbers, images, PDFs |
| `write_file` | Write/overwrite file content |
| `edit_file` | Search/replace or line-based editing |
| `grep_files` | Regex search in files |
| `glob_files` | Find files by pattern |
| `analyze_files` | Extract code structure (functions, classes) |

### Knowledge Graph
| Tool | Description |
|------|-------------|
| `brain_search` | Semantic search across all ingested content |
| `ingest_directory` | Index a codebase into the knowledge graph |
| `ingest_web_page` | Crawl and index web pages |
| `explore_node` | Navigate relationships in the graph |
| `extract_dependency_hierarchy` | Get dependency trees |

### Web & Research
| Tool | Description |
|------|-------------|
| `search_web` | Google search with AI synthesis |
| `fetch_web_page` | Render and extract web page content |
| `call_research_agent` | Autonomous research agent |

### Images & 3D
| Tool | Description |
|------|-------------|
| `read_image` | OCR text extraction |
| `describe_image` | AI image description |
| `generate_image` | Create images from text |
| `generate_3d_from_text` | Create 3D models from description |

---

## Installation Details

### Neo4j Database (Required)

Neo4j stores the knowledge graph. Start it with Docker:

```bash
docker compose up -d neo4j
```

**Access Neo4j Browser**: http://localhost:7474
- Username: `neo4j`
- Password: `ragforge` (or value from `.env`)

### NVIDIA Container Toolkit (For GPU)

Required to run GLiNER and TEI with GPU acceleration.

#### Ubuntu/Debian

```bash
# Add NVIDIA package repository
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

# Install
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit

# Configure Docker
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Verify
docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
```

#### Fedora/RHEL

```bash
curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | \
  sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo

sudo dnf install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

#### Arch Linux

```bash
sudo pacman -S nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### GLiNER - Entity Extraction (Optional)

Extracts named entities (people, organizations, dates, etc.) from text.

```bash
docker compose up -d gliner
```

- **Port**: 6971
- **GPU Memory**: ~2-3 GB VRAM
- **Model**: `urchade/gliner_multi_pii-v1`

### TEI - Text Embeddings Inference (Optional)

HuggingFace's fast embedding server. Faster than Ollama for embeddings.

```bash
docker compose up -d tei
```

- **Port**: 8081
- **GPU Memory**: ~1 GB (bge-base) or ~0.5 GB (bge-small)
- **Model**: `BAAI/bge-base-en-v1.5`

For 8GB VRAM GPUs, use the smaller model:

```bash
TEI_MODEL=BAAI/bge-small-en-v1.5 docker compose up -d tei
```

---

## Embedding Providers

RagForge supports multiple embedding providers:

| Provider | Speed | Quality | GPU Required | Cost |
|----------|-------|---------|--------------|------|
| **Gemini** | Fast | Best | No | API credits |
| **TEI** | Very Fast | Good | Yes | Free (local) |
| **Ollama** | Slow | Good | Optional | Free (local) |

### Configure Provider

```bash
# Via MCP tool
switch_embedding_provider({ provider: "gemini" })
switch_embedding_provider({ provider: "ollama", model: "nomic-embed-text" })
```

### Ollama Setup (Alternative to TEI)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull embedding model
ollama pull nomic-embed-text

# Start Ollama service
ollama serve
```

---

## Services Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      RagForge Core                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  MCP Server │  │    CLI      │  │   Ingestion Engine  │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │            │
│         └────────────────┼─────────────────────┘            │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │  Neo4j   │    │  GLiNER  │    │   TEI    │
    │  :7687   │    │  :6971   │    │  :8081   │
    │          │    │  (GPU)   │    │  (GPU)   │
    └──────────┘    └──────────┘    └──────────┘
```

---

## GPU Memory Usage

Approximate VRAM requirements:

| Service | VRAM Usage | Notes |
|---------|------------|-------|
| GLiNER | ~2-3 GB | Can load/unload dynamically |
| TEI (bge-base) | ~1 GB | Persistent |
| TEI (bge-small) | ~0.5 GB | Recommended for 8GB GPUs |
| Ollama (nomic) | ~0.7 GB | Alternative to TEI |

**Tip**: GLiNER automatically unloads from GPU after entity extraction to free VRAM for embeddings.

---

## Configuration Reference

### Environment Variables

#### Services (`services/.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `NEO4J_PASSWORD` | ragforge | Neo4j database password |
| `NEO4J_BOLT_PORT` | 7687 | Neo4j Bolt protocol port |
| `NEO4J_HTTP_PORT` | 7474 | Neo4j Browser port |
| `GLINER_PORT` | 6971 | GLiNER API port |
| `GLINER_MODEL` | urchade/gliner_multi_pii-v1 | GLiNER model |
| `GLINER_CONFIDENCE` | 0.5 | Entity confidence threshold |
| `TEI_PORT` | 8081 | TEI API port |
| `TEI_MODEL` | BAAI/bge-base-en-v1.5 | Embedding model |

#### API Keys (`~/.ragforge/.env`)

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key (embeddings, vision) |
| `REPLICATE_API_TOKEN` | Replicate API token (3D generation) |

---

## Verify Installation

```bash
# Check Neo4j
curl http://localhost:7474
# Expected: Neo4j Browser HTML

# Check GLiNER
curl http://localhost:6971/health
# Expected: {"status":"healthy",...}

# Check TEI
curl http://localhost:8081/health
# Expected: {"status":"ok",...}

# Check GPU in Docker
docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
```

---

## Troubleshooting

### Docker GPU Error: "could not select device driver"

```
docker: Error response from daemon: could not select device driver "" with capabilities: [[gpu]]
```

**Solution**: Install nvidia-container-toolkit (see installation section above).

### Neo4j Won't Start

```bash
docker compose logs neo4j
```

Common issues:
- Port 7687 already in use
- Insufficient disk space

### GLiNER Slow on First Call

Normal - the model (~205M params) needs to load into GPU memory. Subsequent calls are fast.

### Out of VRAM

- Use smaller TEI model: `TEI_MODEL=BAAI/bge-small-en-v1.5`
- GLiNER and TEI share GPU memory dynamically

### Ollama Not Using GPU

Verify with:
```bash
ollama ps  # Check GPU usage
nvidia-smi  # Check VRAM allocation
```

---

## Development

```bash
# Clone repository
git clone https://github.com/LuciformResearch/ragforge-core.git
cd ragforge-core

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm run test

# Start services
cd services && docker compose up -d
```

---

## License

LRSL-1.1 - See [LICENSE](LICENSE) for details.

---

## Links

- [GitHub Repository](https://github.com/LuciformResearch/ragforge-core)
- [Issue Tracker](https://github.com/LuciformResearch/ragforge-core/issues)
- [Luciform Research](https://luciformresearch.com)
