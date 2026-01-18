#!/bin/bash
# RagForge Quick Setup Script
# Usage: ./setup.sh [--with-gpu]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVICES_DIR="$PROJECT_DIR/services"

WITH_GPU=false
if [[ "$1" == "--with-gpu" ]]; then
    WITH_GPU=true
fi

echo "╔══════════════════════════════════════╗"
echo "║       RagForge Setup Script          ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed"
    echo "   Please install Docker: https://docs.docker.com/get-docker/"
    exit 1
fi
echo "✅ Docker installed"

# Check Docker Compose
if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose v2 is not available"
    echo "   Please install Docker Compose: https://docs.docker.com/compose/install/"
    exit 1
fi
echo "✅ Docker Compose installed"

# Check GPU support if requested
if [ "$WITH_GPU" = true ]; then
    echo ""
    echo "🔍 Checking GPU support..."

    if ! command -v nvidia-smi &> /dev/null; then
        echo "❌ NVIDIA driver not found"
        echo "   Please install NVIDIA drivers first"
        exit 1
    fi
    echo "✅ NVIDIA driver installed"

    # Check nvidia-container-toolkit
    if ! docker run --rm --gpus all nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi &> /dev/null; then
        echo "⚠️  nvidia-container-toolkit not configured"
        echo ""
        echo "Would you like to install it now? (requires sudo) [y/N]"
        read -r response
        if [[ "$response" =~ ^[Yy]$ ]]; then
            sudo "$SCRIPT_DIR/install-nvidia-toolkit.sh"
        else
            echo "Skipping GPU setup. Run with --with-gpu later."
            WITH_GPU=false
        fi
    else
        echo "✅ nvidia-container-toolkit configured"
    fi
fi

# Create .env if needed
echo ""
echo "📝 Setting up configuration..."
cd "$SERVICES_DIR"

if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Created services/.env from template"
else
    echo "✅ services/.env already exists"
fi

# Create ragforge config directory
RAGFORGE_DIR="$HOME/.ragforge"
if [ ! -d "$RAGFORGE_DIR" ]; then
    mkdir -p "$RAGFORGE_DIR"
    echo "✅ Created ~/.ragforge directory"
fi

if [ ! -f "$RAGFORGE_DIR/.env" ]; then
    cat > "$RAGFORGE_DIR/.env" << 'EOF'
# RagForge API Keys
# Uncomment and set your API keys

# Gemini (for embeddings, vision, web search)
# GEMINI_API_KEY=your-gemini-api-key

# Replicate (for 3D model generation)
# REPLICATE_API_TOKEN=your-replicate-token
EOF
    echo "✅ Created ~/.ragforge/.env template"
else
    echo "✅ ~/.ragforge/.env already exists"
fi

# Start services
echo ""
echo "🚀 Starting services..."

if [ "$WITH_GPU" = true ]; then
    echo "   Starting Neo4j + GLiNER + TEI (GPU mode)..."
    docker compose up -d
else
    echo "   Starting Neo4j only (CPU mode)..."
    docker compose up -d neo4j
fi

# Wait for Neo4j to be ready
echo ""
echo "⏳ Waiting for Neo4j to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:7474 > /dev/null 2>&1; then
        echo "✅ Neo4j is ready!"
        break
    fi
    sleep 1
done

# Summary
echo ""
echo "╔══════════════════════════════════════╗"
echo "║         Setup Complete!              ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Services running:"
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "Next steps:"
echo "  1. Set your API keys in ~/.ragforge/.env"
echo "  2. Open Neo4j Browser: http://localhost:7474"
echo "  3. Use RagForge: npx ragforge --help"
echo ""
if [ "$WITH_GPU" = false ]; then
    echo "💡 For GPU acceleration, run: ./setup.sh --with-gpu"
fi
