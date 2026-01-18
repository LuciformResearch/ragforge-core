"""
Configuration for GLiNER Entity Extraction Service.

Loads domain presets from entity-extraction.yaml for easy customization.
"""

import logging
from pathlib import Path
from typing import Any

import yaml
from pydantic_settings import BaseSettings
from pydantic import Field

logger = logging.getLogger(__name__)

# Path to configuration files
CONFIG_DIR = Path(__file__).parent
YAML_CONFIG_PATH = CONFIG_DIR / "entity-extraction.yaml"


class Settings(BaseSettings):
    """Service configuration (can be overridden via environment variables)."""

    # Model settings
    # GLiNER2 models: base (205M, faster but more false positives) or large (340M, better accuracy)
    model_name: str = Field(
        default="fastino/gliner2-large-v1",
        description="GLiNER2 model to use"
    )
    device: str = Field(
        default="cuda",
        description="Device for inference (cpu/cuda)"
    )

    # API settings
    host: str = Field(default="0.0.0.0")
    port: int = Field(default=6971)

    # Processing settings
    default_batch_size: int = Field(default=32, ge=1, le=128)
    confidence_threshold: float = Field(default=0.85, ge=0.0, le=1.0)

    # Path to YAML config (can be overridden)
    config_path: str = Field(
        default=str(YAML_CONFIG_PATH),
        description="Path to entity-extraction.yaml"
    )

    # These will be loaded from YAML but can be overridden via env
    default_entity_types: list[str] | None = Field(default=None)
    default_relation_types: dict[str, str] | None = Field(default=None)

    class Config:
        env_prefix = "GLINER_"
        env_file = ".env"


def load_yaml_config(path: Path | str) -> dict[str, Any]:
    """Load configuration from YAML file."""
    path = Path(path)
    if not path.exists():
        logger.warning(f"Config file not found: {path}, using defaults")
        return {}

    try:
        with open(path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f)
            logger.info(f"Loaded config from {path}")
            return config or {}
    except Exception as e:
        logger.error(f"Failed to load config from {path}: {e}")
        return {}


def build_domain_presets(yaml_config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Build DOMAIN_PRESETS from YAML config.

    Each domain can have:
    - enabled: bool (default True) - whether to run extraction for this domain
    - description: str - used for classification
    - entity_types: list or dict - types to extract
    - relation_types: dict - relations to extract
    """
    domains = yaml_config.get("domains", {})
    presets = {}

    for domain_name, domain_config in domains.items():
        if isinstance(domain_config, dict):
            presets[domain_name] = {
                "enabled": domain_config.get("enabled", True),  # Default to enabled
                "entity_types": domain_config.get("entity_types", {}),
                "relation_types": domain_config.get("relation_types", {}),
            }

    return presets


def build_classification_schema(yaml_config: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Build CLASSIFICATION_SCHEMA from YAML config (using domain descriptions)."""
    domains = yaml_config.get("domains", {})
    schema = {"domains": {}}

    for domain_name, domain_config in domains.items():
        if isinstance(domain_config, dict):
            description = domain_config.get("description", f"Content related to {domain_name}")
            schema["domains"][domain_name] = description

    return schema


def get_defaults_from_yaml(yaml_config: dict[str, Any]) -> tuple[dict[str, str] | list[str], dict[str, str]]:
    """Get default entity types and relation types from YAML.

    Entity types can be either:
    - A dict with descriptions: {"person": "A human individual..."}
    - A list of strings (legacy): ["person", "organization"]

    Returns the format as-is to preserve descriptions for GLiNER2.
    """
    defaults = yaml_config.get("defaults", {})
    entity_types = defaults.get("entity_types", {
        "person": "A human individual mentioned by their full name",
        "organization": "A company, institution, or named group",
        "location": "A geographical place, city, or country",
        "technology": "A named software, framework, or tool",
        "product": "A commercial product with a specific name",
        "date": "A specific date or time period"
    })
    relation_types = defaults.get("relation_types", {
        "works_for": "person works for organization",
        "located_in": "entity is located in location",
        "created_by": "product/technology created by person/organization",
        "uses": "organization/person uses technology"
    })
    return entity_types, relation_types


def get_skip_embedding_types(yaml_config: dict[str, Any]) -> list[str]:
    """Get entity types that should skip embedding generation from YAML.

    These are numeric/value types where embedding similarity doesn't make sense.
    """
    return yaml_config.get("skip_embedding_types", [
        "price", "date", "quantity", "amount", "currency", "size", "duration"
    ])


# Initialize settings
settings = Settings()

# Load YAML configuration
_yaml_config = load_yaml_config(settings.config_path)

# Build domain presets from YAML
DOMAIN_PRESETS = build_domain_presets(_yaml_config)

# Build classification schema from YAML (domain descriptions)
CLASSIFICATION_SCHEMA = build_classification_schema(_yaml_config)

# Load skip embedding types from YAML (single source of truth)
SKIP_EMBEDDING_TYPES = get_skip_embedding_types(_yaml_config)

# Set defaults from YAML if not overridden via env
_default_entity_types, _default_relation_types = get_defaults_from_yaml(_yaml_config)

if settings.default_entity_types is None:
    settings.default_entity_types = _default_entity_types

if settings.default_relation_types is None:
    settings.default_relation_types = _default_relation_types

# Log loaded configuration
logger.info(f"Loaded {len(DOMAIN_PRESETS)} domain presets: {list(DOMAIN_PRESETS.keys())}")
logger.info(f"Default entity types: {settings.default_entity_types}")


def reload_config() -> None:
    """Reload configuration from YAML file (useful for hot-reload)."""
    global DOMAIN_PRESETS, CLASSIFICATION_SCHEMA, SKIP_EMBEDDING_TYPES, _yaml_config

    _yaml_config = load_yaml_config(settings.config_path)
    DOMAIN_PRESETS = build_domain_presets(_yaml_config)
    CLASSIFICATION_SCHEMA = build_classification_schema(_yaml_config)
    SKIP_EMBEDDING_TYPES = get_skip_embedding_types(_yaml_config)

    _default_entity_types, _default_relation_types = get_defaults_from_yaml(_yaml_config)
    if settings.default_entity_types is None:
        settings.default_entity_types = _default_entity_types
    if settings.default_relation_types is None:
        settings.default_relation_types = _default_relation_types

    logger.info(f"Reloaded config: {len(DOMAIN_PRESETS)} domains, {len(SKIP_EMBEDDING_TYPES)} skip-embedding types")


def get_available_domains() -> list[str]:
    """Get list of available domain names."""
    return list(DOMAIN_PRESETS.keys())


def get_domain_config(domain: str) -> dict[str, Any] | None:
    """Get configuration for a specific domain."""
    return DOMAIN_PRESETS.get(domain)
