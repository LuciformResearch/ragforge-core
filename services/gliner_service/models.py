"""
Pydantic models for GLiNER Entity Extraction Service.
"""

from pydantic import BaseModel, Field
from typing import Any


# ===== REQUEST MODELS =====

class ExtractionRequest(BaseModel):
    """Request for entity/relation extraction."""
    text: str = Field(..., description="Text to extract from")
    entity_types: list[str] = Field(
        default=["person", "organization", "location", "technology", "product", "price"],
        description="Entity types to extract"
    )
    relation_types: dict[str, str] | None = Field(
        default=None,
        description="Relation types with descriptions (key=type, value=description)"
    )
    include_confidence: bool = Field(default=True, description="Include confidence scores")
    include_spans: bool = Field(default=True, description="Include character spans")


class BatchExtractionRequest(BaseModel):
    """Request for batch entity/relation extraction."""
    texts: list[str] = Field(..., description="List of texts to extract from")
    entity_types: list[str] = Field(
        default=["person", "organization", "location", "technology", "product", "price"],
        description="Entity types to extract"
    )
    relation_types: dict[str, str] | None = Field(
        default=None,
        description="Relation types with descriptions"
    )
    include_confidence: bool = Field(default=True, description="Include confidence scores")
    include_spans: bool = Field(default=True, description="Include character spans")
    batch_size: int = Field(default=32, ge=1, le=128, description="Batch size for processing")


# ===== RESPONSE MODELS =====

class ExtractedEntity(BaseModel):
    """An extracted entity."""
    name: str = Field(..., description="Entity text")
    type: str = Field(..., description="Entity type")
    confidence: float | None = Field(None, ge=0, le=1, description="Confidence score")
    span: tuple[int, int] | None = Field(None, description="Character span [start, end]")
    properties: dict[str, Any] | None = Field(None, description="Additional properties")


class ExtractedRelation(BaseModel):
    """An extracted relation between entities."""
    subject: str = Field(..., description="Subject entity name")
    predicate: str = Field(..., description="Relation type")
    object: str = Field(..., description="Object entity name")
    confidence: float | None = Field(None, ge=0, le=1, description="Confidence score")


class ExtractionResult(BaseModel):
    """Result of extraction for a single text."""
    entities: list[ExtractedEntity] = Field(default_factory=list)
    relations: list[ExtractedRelation] = Field(default_factory=list)
    processing_time_ms: float = Field(..., description="Processing time in milliseconds")


class BatchExtractionResult(BaseModel):
    """Result of batch extraction."""
    results: list[ExtractionResult] = Field(..., description="Results for each input text")
    total_processing_time_ms: float = Field(..., description="Total processing time")
    texts_processed: int = Field(..., description="Number of texts processed")


class HealthResponse(BaseModel):
    """Health check response."""
    status: str = Field(default="ok")
    model_loaded: bool = Field(..., description="Whether GLiNER model is loaded")
    model_name: str = Field(..., description="Model name/path")
    device: str = Field(..., description="Device (cpu/cuda)")


class ConfigResponse(BaseModel):
    """Configuration response."""
    default_entity_types: list[str]
    default_relation_types: dict[str, str]
    model_name: str
    batch_size: int
    device: str
