"""
GLiNER Entity Extraction Service - FastAPI Server.

Endpoints:
- POST /extract - Extract entities/relations from single text
- POST /extract/batch - Batch extraction with optional auto-domain detection
- POST /classify - Classify text domains
- GET /health - Health check
- GET /config - Current configuration
"""

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from config import settings, DOMAIN_PRESETS, SKIP_EMBEDDING_TYPES, reload_config, get_available_domains
from models import (
    ExtractionRequest,
    BatchExtractionRequest,
    ExtractionResult,
    BatchExtractionResult,
    HealthResponse,
    ConfigResponse,
)
from extractor import get_extractor, GLiNERExtractor

# Configure logging with file output
LOG_DIR = Path.home() / ".ragforge" / "logs" / "gliner-service"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "gliner.log"

# Create formatter
formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")

# Console handler
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)

# File handler with rotation
from logging.handlers import RotatingFileHandler
file_handler = RotatingFileHandler(
    LOG_FILE, maxBytes=5*1024*1024, backupCount=3
)
file_handler.setFormatter(formatter)

# Configure root logger
logging.basicConfig(
    level=logging.INFO,
    handlers=[console_handler, file_handler]
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown."""
    # Startup: preload model
    logger.info("Starting GLiNER Entity Extraction Service...")
    try:
        extractor = get_extractor()
        # Warm up the model
        _ = extractor.model
        logger.info("Model loaded successfully")
    except Exception as e:
        logger.error(f"Failed to load model: {e}")

    yield

    # Shutdown
    logger.info("Shutting down GLiNER service...")


app = FastAPI(
    title="GLiNER Entity Extraction Service",
    description="Entity and relation extraction using GLiNER2",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Check service health and model status."""
    try:
        extractor = get_extractor()
        model_loaded = extractor.is_loaded()
        return HealthResponse(
            status="ok",
            model_loaded=model_loaded,
            model_name=settings.model_name,
            device=settings.device,
        )
    except Exception as e:
        return HealthResponse(
            status="error",
            model_loaded=False,
            model_name=settings.model_name,
            device=settings.device,
        )


@app.post("/model/unload")
async def unload_model():
    """
    Unload the model from GPU to free VRAM.

    Use this before running Ollama embeddings to free up GPU memory.
    The model will be automatically reloaded on the next extraction request.
    """
    try:
        extractor = get_extractor()
        was_loaded = extractor.unload()
        return {
            "status": "ok",
            "was_loaded": was_loaded,
            "message": "Model unloaded, GPU memory freed" if was_loaded else "Model was already unloaded",
        }
    except Exception as e:
        logger.error(f"Model unload failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/model/load")
async def load_model():
    """
    Preload the model into GPU.

    Use this after Ollama embeddings are done to prepare for entity extraction.
    """
    try:
        extractor = get_extractor()
        if extractor.is_loaded():
            return {
                "status": "ok",
                "was_loaded": True,
                "message": "Model was already loaded",
            }
        # Access model property to trigger lazy loading
        _ = extractor.model
        return {
            "status": "ok",
            "was_loaded": False,
            "message": f"Model loaded on {settings.device}",
        }
    except Exception as e:
        logger.error(f"Model load failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/config", response_model=ConfigResponse)
async def get_config():
    """Get current service configuration."""
    return ConfigResponse(
        default_entity_types=settings.default_entity_types,
        default_relation_types=settings.default_relation_types,
        model_name=settings.model_name,
        batch_size=settings.default_batch_size,
        device=settings.device,
        skip_embedding_types=SKIP_EMBEDDING_TYPES,
    )


@app.get("/presets")
async def get_presets():
    """Get available domain presets."""
    return {
        "presets": DOMAIN_PRESETS,
        "available_domains": get_available_domains(),
    }


@app.post("/config/reload")
async def reload_configuration():
    """
    Reload configuration from YAML file.

    Useful for updating domain presets without restarting the service.
    """
    try:
        reload_config()
        return {
            "status": "ok",
            "message": "Configuration reloaded",
            "available_domains": get_available_domains(),
        }
    except Exception as e:
        logger.error(f"Config reload failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/domains")
async def list_domains():
    """List available domains with their entity and relation types."""
    domains_info = {}
    for domain_name in get_available_domains():
        preset = DOMAIN_PRESETS.get(domain_name, {})
        domains_info[domain_name] = {
            "entity_types": preset.get("entity_types", []),
            "relation_types": list(preset.get("relation_types", {}).keys()),
            "entity_count": len(preset.get("entity_types", [])),
            "relation_count": len(preset.get("relation_types", {})),
        }
    return {
        "domains": domains_info,
        "total_domains": len(domains_info),
    }


@app.post("/extract", response_model=ExtractionResult)
async def extract_entities(request: ExtractionRequest):
    """
    Extract entities and relations from a single text.

    Optionally specify entity_types and relation_types for custom extraction.
    """
    try:
        extractor = get_extractor()
        result = extractor.extract(
            text=request.text,
            entity_types=request.entity_types,
            relation_types=request.relation_types,
            include_confidence=request.include_confidence,
            include_spans=request.include_spans,
        )
        return result
    except Exception as e:
        logger.error(f"Extraction failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/extract/batch", response_model=BatchExtractionResult)
async def extract_batch(request: BatchExtractionRequest):
    """
    Batch extract entities and relations from multiple texts.

    More efficient than calling /extract multiple times.
    """
    import time
    start_time = time.time()

    try:
        extractor = get_extractor()
        results = extractor.batch_extract(
            texts=request.texts,
            entity_types=request.entity_types,
            relation_types=request.relation_types,
            batch_size=request.batch_size,
            include_confidence=request.include_confidence,
            include_spans=request.include_spans,
        )

        total_time = (time.time() - start_time) * 1000
        return BatchExtractionResult(
            results=results,
            total_processing_time_ms=total_time,
            texts_processed=len(request.texts),
        )
    except Exception as e:
        logger.error(f"Batch extraction failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/extract/auto")
async def extract_with_auto_domains(
    texts: list[str],
    batch_size: int = 32,
    domain_threshold: float = 0.3,
    include_confidence: bool = True,
    include_spans: bool = True,
):
    """
    Extract with automatic domain detection.

    Groups texts by detected domain for efficient batch processing.
    Uses merged presets based on detected domains.
    """
    import time
    start_time = time.time()

    try:
        extractor = get_extractor()
        results = extractor.batch_extract_with_auto_domains(
            texts=texts,
            batch_size=batch_size,
            domain_threshold=domain_threshold,
            include_confidence=include_confidence,
            include_spans=include_spans,
        )

        total_time = (time.time() - start_time) * 1000
        return {
            "results": [r.model_dump() for r in results],
            "total_processing_time_ms": total_time,
            "texts_processed": len(texts),
        }
    except Exception as e:
        logger.error(f"Auto extraction failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/extract/all")
async def extract_all_domains(
    texts: list[str],
    batch_size: int = 32,
    include_confidence: bool = True,
    include_spans: bool = True,
):
    """
    Extract using ALL entity types from ALL domains.

    Skips domain classification - faster but may have more noise.
    Use this when speed is critical or documents are mixed-domain.
    """
    import time
    start_time = time.time()

    try:
        extractor = get_extractor()
        results = extractor.batch_extract_all_domains(
            texts=texts,
            batch_size=batch_size,
            include_confidence=include_confidence,
            include_spans=include_spans,
        )

        total_time = (time.time() - start_time) * 1000
        return {
            "results": [r.model_dump() for r in results],
            "total_processing_time_ms": total_time,
            "texts_processed": len(texts),
        }
    except Exception as e:
        logger.error(f"All-domains extraction failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/classify")
async def classify_domains(
    text: str,
    threshold: float = 0.3,
):
    """
    Classify text into domains using multi-label classification.

    Returns detected domains with confidence scores.
    """
    try:
        extractor = get_extractor()
        domains = extractor.classify_domains(text, threshold=threshold)
        return {
            "text_preview": text[:100] + "..." if len(text) > 100 else text,
            "detected_domains": domains,
            "threshold": threshold,
        }
    except Exception as e:
        logger.error(f"Classification failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/classify/batch")
async def classify_domains_batch(
    texts: list[str],
    threshold: float = 0.3,
    batch_size: int = 64,
):
    """
    Batch classify texts into domains using multi-label classification.

    More efficient than calling /classify multiple times.
    Returns a list of domain classifications, one per input text.
    """
    import time
    start_time = time.time()

    try:
        extractor = get_extractor()
        classifications = extractor.classify_domains_batch(
            texts=texts,
            threshold=threshold,
            batch_size=batch_size,
        )

        total_time = (time.time() - start_time) * 1000
        return {
            "classifications": classifications,
            "total_processing_time_ms": total_time,
            "texts_processed": len(texts),
            "threshold": threshold,
        }
    except Exception as e:
        logger.error(f"Batch classification failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def main():
    """Run the server."""
    import uvicorn
    uvicorn.run(
        "gliner_service.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )


if __name__ == "__main__":
    main()
