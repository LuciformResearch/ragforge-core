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
    confidence_threshold: float = Field(default=0.5, ge=0.0, le=1.0)

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
    """Build DOMAIN_PRESETS from YAML config."""
    domains = yaml_config.get("domains", {})
    presets = {}

    for domain_name, domain_config in domains.items():
        if isinstance(domain_config, dict):
            presets[domain_name] = {
                "entity_types": domain_config.get("entity_types", []),
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


def get_defaults_from_yaml(yaml_config: dict[str, Any]) -> tuple[list[str], dict[str, str]]:
    """Get default entity types and relation types from YAML."""
    defaults = yaml_config.get("defaults", {})
    entity_types = defaults.get("entity_types", [
        "person", "organization", "location", "technology",
        "product", "price", "date", "quantity"
    ])
    relation_types = defaults.get("relation_types", {
        "works_for": "person works for organization",
        "located_in": "entity is located in location",
        "created_by": "product/technology created by person/organization",
        "costs": "product has price",
        "depends_on": "technology depends on another technology",
        "part_of": "entity is part of another entity"
    })
    return entity_types, relation_types


# Initialize settings
settings = Settings()

# Load YAML configuration
_yaml_config = load_yaml_config(settings.config_path)

# Build domain presets from YAML
DOMAIN_PRESETS = build_domain_presets(_yaml_config)

# Build classification schema from YAML (domain descriptions)
CLASSIFICATION_SCHEMA = build_classification_schema(_yaml_config)

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
    global DOMAIN_PRESETS, CLASSIFICATION_SCHEMA, _yaml_config

    _yaml_config = load_yaml_config(settings.config_path)
    DOMAIN_PRESETS = build_domain_presets(_yaml_config)
    CLASSIFICATION_SCHEMA = build_classification_schema(_yaml_config)

    _default_entity_types, _default_relation_types = get_defaults_from_yaml(_yaml_config)
    if settings.default_entity_types is None:
        settings.default_entity_types = _default_entity_types
    if settings.default_relation_types is None:
        settings.default_relation_types = _default_relation_types

    logger.info(f"Reloaded config: {len(DOMAIN_PRESETS)} domains")


def get_available_domains() -> list[str]:
    """Get list of available domain names."""
    return list(DOMAIN_PRESETS.keys())


def get_domain_config(domain: str) -> dict[str, Any] | None:
    """Get configuration for a specific domain."""
    return DOMAIN_PRESETS.get(domain)
