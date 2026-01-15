"""
GLiNER2 Entity and Relation Extractor.

Uses schema builder for combined entity + relation extraction.
Supports multi-label classification for domain auto-detection.
"""

import logging
import time
from typing import Any
from collections import defaultdict

from gliner2 import GLiNER2

from .config import settings, DOMAIN_PRESETS, CLASSIFICATION_SCHEMA
from .models import ExtractedEntity, ExtractedRelation, ExtractionResult

logger = logging.getLogger(__name__)


class GLiNERExtractor:
    """
    GLiNER2-based entity and relation extractor.

    Features:
    - Schema builder for entities + relations in one call
    - Multi-label classification for domain detection
    - Batch processing with domain grouping
    """

    def __init__(
        self,
        model_name: str = settings.model_name,
        device: str = settings.device,
    ):
        self.model_name = model_name
        self.device = device
        self._model: GLiNER2 | None = None

    @property
    def model(self) -> GLiNER2:
        """Lazy load the model."""
        if self._model is None:
            logger.info(f"Loading GLiNER2 model: {self.model_name}")
            self._model = GLiNER2.from_pretrained(self.model_name)
            self._model = self._model.to(self.device)
            logger.info(f"Model loaded on {self.device}")
        return self._model

    def extract(
        self,
        text: str,
        entity_types: list[str] | None = None,
        relation_types: dict[str, str] | None = None,
        include_confidence: bool = True,
        include_spans: bool = True,
    ) -> ExtractionResult:
        """
        Extract entities and relations from a single text using GLiNER2 schema builder.

        Args:
            text: Text to extract from
            entity_types: Entity types to extract (default: from settings)
            relation_types: Relation types with descriptions (default: from settings)
            include_confidence: Include confidence scores
            include_spans: Include character spans

        Returns:
            ExtractionResult with entities and relations
        """
        start_time = time.time()

        # Use defaults if not provided
        if entity_types is None:
            entity_types = settings.default_entity_types
        if relation_types is None:
            relation_types = settings.default_relation_types

        # Build schema using GLiNER2 schema builder
        schema_builder = self.model.create_schema().entities(entity_types)

        # Add relations if provided
        if relation_types:
            schema_builder = schema_builder.relations(relation_types)

        schema = schema_builder

        # Extract with GLiNER2
        try:
            raw_result = self.model.extract(text, schema, include_confidence=include_confidence)
            logger.info(f"GLiNER2 raw_result: {raw_result}")
        except Exception as e:
            logger.error(f"Extraction failed: {e}")
            raw_result = {"entities": {}, "relation_extraction": {}}

        # Parse entities from GLiNER2 format
        # GLiNER2 returns: {'entities': {'person': [...], 'organization': [...]}, ...}
        entities = []
        entities_dict = raw_result.get("entities", {})

        for entity_type, entity_list in entities_dict.items():
            if isinstance(entity_list, list):
                for item in entity_list:
                    # Handle both dict format and string format
                    if isinstance(item, dict):
                        entity = ExtractedEntity(
                            name=item.get("text", item.get("name", str(item))),
                            type=entity_type,
                            confidence=item.get("score", item.get("confidence")) if include_confidence else None,
                            span=(item.get("start"), item.get("end")) if include_spans and "start" in item else None,
                        )
                    else:
                        # Simple string entity
                        entity = ExtractedEntity(
                            name=str(item),
                            type=entity_type,
                            confidence=None,
                            span=None,
                        )
                    entities.append(entity)

        # Parse relations from GLiNER2 format
        # GLiNER2 returns: {'relation_extraction': {'works_for': [('subject', 'object'), ...], ...}}
        # With include_confidence=True, subject/object can be dicts: {'text': '...', 'confidence': ...}
        relations = []
        relations_dict = raw_result.get("relation_extraction", {})

        def extract_entity_text(entity) -> str:
            """Extract text from entity (can be string or dict with 'text' key)."""
            if isinstance(entity, dict):
                return entity.get("text", entity.get("name", str(entity)))
            return str(entity)

        def extract_entity_confidence(entity) -> float | None:
            """Extract confidence from entity dict if available."""
            if isinstance(entity, dict):
                return entity.get("confidence", entity.get("score"))
            return None

        for relation_type, relation_list in relations_dict.items():
            if isinstance(relation_list, list):
                for item in relation_list:
                    if isinstance(item, tuple) and len(item) >= 2:
                        # With include_confidence, tuple items can be dicts
                        subj_text = extract_entity_text(item[0])
                        obj_text = extract_entity_text(item[1])
                        # Get confidence from entities or tuple[2] if available
                        rel_confidence = None
                        if include_confidence:
                            subj_conf = extract_entity_confidence(item[0])
                            obj_conf = extract_entity_confidence(item[1])
                            # Use average of subject/object confidence, or tuple[2] if present
                            if len(item) > 2 and item[2] is not None:
                                rel_confidence = item[2]
                            elif subj_conf is not None and obj_conf is not None:
                                rel_confidence = (subj_conf + obj_conf) / 2
                        relation = ExtractedRelation(
                            subject=subj_text,
                            predicate=relation_type,
                            object=obj_text,
                            confidence=rel_confidence,
                        )
                        relations.append(relation)
                    elif isinstance(item, dict):
                        relation = ExtractedRelation(
                            subject=extract_entity_text(item.get("subject", item.get("head", ""))),
                            predicate=relation_type,
                            object=extract_entity_text(item.get("object", item.get("tail", ""))),
                            confidence=item.get("score", item.get("confidence")) if include_confidence else None,
                        )
                        relations.append(relation)

        processing_time = (time.time() - start_time) * 1000
        return ExtractionResult(
            entities=entities,
            relations=relations,
            processing_time_ms=processing_time,
        )

    def classify_domains(
        self,
        text: str,
        threshold: float = 0.3,
    ) -> list[dict[str, Any]]:
        """
        Classify text into domains using GLiNER2 multi-label classification.

        Args:
            text: Text to classify
            threshold: Minimum confidence for domain

        Returns:
            List of detected domains with confidence
        """
        domain_labels = list(CLASSIFICATION_SCHEMA["domains"].keys())
        domain_descriptions = CLASSIFICATION_SCHEMA["domains"]

        try:
            # Use GLiNER2 native multi-label classification
            schema = self.model.create_schema().classification(
                "domains",
                domain_labels,
                multi_label=True,
                cls_threshold=threshold
            )

            result = self.model.extract(text, schema)

            # Parse classification results
            # GLiNER2 returns: {'domains': [{'label': 'tech', 'confidence': 0.92}, ...]}
            detected = []
            domains_result = result.get("domains", [])

            if isinstance(domains_result, list):
                for item in domains_result:
                    if isinstance(item, dict):
                        detected.append({
                            "label": item.get("label"),
                            "confidence": item.get("confidence", item.get("score", 0.0)),
                        })
                    elif isinstance(item, str):
                        detected.append({
                            "label": item,
                            "confidence": threshold,  # Default confidence
                        })

            return sorted(detected, key=lambda x: -x.get("confidence", 0))

        except Exception as e:
            logger.warning(f"Domain classification failed: {e}, falling back to heuristic")
            return self._classify_domains_heuristic(text, threshold)

    def classify_domains_batch(
        self,
        texts: list[str],
        threshold: float = 0.3,
        batch_size: int = 64,
    ) -> list[list[dict[str, Any]]]:
        """
        Batch classify texts into domains using GLiNER2 multi-label classification.

        Args:
            texts: List of texts to classify
            threshold: Minimum confidence for domain
            batch_size: Number of texts to classify at once (default 64, classification is lighter than extraction)

        Returns:
            List of domain lists, one per input text
        """
        if not texts:
            return []

        domain_labels = list(CLASSIFICATION_SCHEMA["domains"].keys())

        try:
            # Use GLiNER2 native multi-label classification
            schema = self.model.create_schema().classification(
                "domains",
                domain_labels,
                multi_label=True,
                cls_threshold=threshold
            )

            # Process in batches to avoid OOM with large document sets
            all_batch_results = []
            for i in range(0, len(texts), batch_size):
                batch = texts[i:i + batch_size]
                batch_results = self.model.batch_extract(batch, schema)
                all_batch_results.extend(batch_results)

            batch_results = all_batch_results

            # Parse classification results for each text
            all_classifications = []
            for result in batch_results:
                detected = []
                domains_result = result.get("domains", [])

                if isinstance(domains_result, list):
                    for item in domains_result:
                        if isinstance(item, dict):
                            detected.append({
                                "label": item.get("label"),
                                "confidence": item.get("confidence", item.get("score", 0.0)),
                            })
                        elif isinstance(item, str):
                            detected.append({
                                "label": item,
                                "confidence": threshold,
                            })

                all_classifications.append(sorted(detected, key=lambda x: -x.get("confidence", 0)))

            return all_classifications

        except Exception as e:
            logger.warning(f"Batch domain classification failed: {e}, falling back to sequential")
            # Fallback to sequential classification
            return [self.classify_domains(text, threshold) for text in texts]

    def _classify_domains_heuristic(
        self,
        text: str,
        threshold: float = 0.3,
    ) -> list[dict[str, Any]]:
        """
        Fallback heuristic-based domain classification.

        Uses keyword matching when GLiNER2 classification is unavailable.
        """
        CLASSIFICATION_KEYWORDS = {
            "ecommerce": ["price", "product", "shop", "buy", "cart", "order", "brand",
                         "ingredient", "shampoo", "cream", "hair", "skin", "beauty"],
            "code": ["function", "class", "import", "def", "return", "const", "let",
                    "var", "async", "await", "export", "module", "api", "endpoint"],
            "documentation": ["feature", "requirement", "specification", "user story",
                             "use case", "milestone", "release", "version", "component"],
            "legal": ["contract", "clause", "obligation", "party", "jurisdiction",
                     "agreement", "terms", "conditions", "liability", "warrant"]
        }

        text_lower = text.lower()
        detected = []

        for domain, keywords in CLASSIFICATION_KEYWORDS.items():
            hits = sum(1 for kw in keywords if kw in text_lower)
            score = hits / len(keywords) if keywords else 0

            if score > threshold:
                detected.append({
                    "label": domain,
                    "confidence": min(score * 2, 1.0),  # Scale up but cap at 1.0
                })

        return sorted(detected, key=lambda x: -x.get("confidence", 0))

    def get_preset_schema(self, domains: list[str]) -> tuple[list[str], dict[str, str]]:
        """
        Merge presets for multiple domains.

        Args:
            domains: List of domain names

        Returns:
            Tuple of (entity_types, relation_types)
        """
        entity_types = set()
        relation_types = {}

        for domain in domains:
            if domain in DOMAIN_PRESETS:
                preset = DOMAIN_PRESETS[domain]
                entity_types.update(preset["entity_types"])
                relation_types.update(preset["relation_types"])

        # Add defaults if no domains matched
        if not entity_types:
            entity_types = set(settings.default_entity_types)
            relation_types = settings.default_relation_types

        return list(entity_types), relation_types

    def batch_extract(
        self,
        texts: list[str],
        entity_types: list[str] | None = None,
        relation_types: dict[str, str] | None = None,
        batch_size: int = 32,
        include_confidence: bool = True,
        include_spans: bool = True,
    ) -> list[ExtractionResult]:
        """
        Batch extract entities and relations from multiple texts.

        Args:
            texts: List of texts to extract from
            entity_types: Entity types to extract
            relation_types: Relation types with descriptions
            batch_size: Processing batch size
            include_confidence: Include confidence scores
            include_spans: Include character spans

        Returns:
            List of ExtractionResult, one per text
        """
        start_time = time.time()

        # Use defaults if not provided
        if entity_types is None:
            entity_types = settings.default_entity_types
        if relation_types is None:
            relation_types = settings.default_relation_types

        # Build schema once for the batch
        schema_builder = self.model.create_schema().entities(entity_types)
        if relation_types:
            schema_builder = schema_builder.relations(relation_types)
        schema = schema_builder

        results = []

        # Process in batches
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]

            try:
                # Use GLiNER2 batch extraction
                batch_results = self.model.batch_extract(batch, schema, include_confidence=include_confidence)

                for raw_result in batch_results:
                    # Parse each result
                    result = self._parse_extraction_result(
                        raw_result,
                        include_confidence,
                        include_spans
                    )
                    results.append(result)

            except Exception as e:
                logger.warning(f"Batch extraction failed, falling back to sequential: {e}")
                # Fallback to sequential extraction
                for text in batch:
                    result = self.extract(
                        text,
                        entity_types=entity_types,
                        relation_types=relation_types,
                        include_confidence=include_confidence,
                        include_spans=include_spans,
                    )
                    results.append(result)

        total_time = (time.time() - start_time) * 1000
        logger.debug(f"Batch extracted {len(texts)} texts in {total_time:.0f}ms")

        return results

    def _parse_extraction_result(
        self,
        raw_result: dict[str, Any],
        include_confidence: bool = True,
        include_spans: bool = True,
    ) -> ExtractionResult:
        """Parse raw GLiNER2 result into ExtractionResult."""
        start_time = time.time()

        # Parse entities
        entities = []
        entities_dict = raw_result.get("entities", {})

        for entity_type, entity_list in entities_dict.items():
            if isinstance(entity_list, list):
                for item in entity_list:
                    if isinstance(item, dict):
                        entity = ExtractedEntity(
                            name=item.get("text", item.get("name", str(item))),
                            type=entity_type,
                            confidence=item.get("score", item.get("confidence")) if include_confidence else None,
                            span=(item.get("start"), item.get("end")) if include_spans and "start" in item else None,
                        )
                    else:
                        entity = ExtractedEntity(
                            name=str(item),
                            type=entity_type,
                            confidence=None,
                            span=None,
                        )
                    entities.append(entity)

        # Parse relations
        # With include_confidence=True, subject/object can be dicts: {'text': '...', 'confidence': ...}
        relations = []
        relations_dict = raw_result.get("relation_extraction", {})

        def extract_entity_text(entity) -> str:
            """Extract text from entity (can be string or dict with 'text' key)."""
            if isinstance(entity, dict):
                return entity.get("text", entity.get("name", str(entity)))
            return str(entity)

        def extract_entity_confidence(entity) -> float | None:
            """Extract confidence from entity dict if available."""
            if isinstance(entity, dict):
                return entity.get("confidence", entity.get("score"))
            return None

        for relation_type, relation_list in relations_dict.items():
            if isinstance(relation_list, list):
                for item in relation_list:
                    if isinstance(item, tuple) and len(item) >= 2:
                        # With include_confidence, tuple items can be dicts
                        subj_text = extract_entity_text(item[0])
                        obj_text = extract_entity_text(item[1])
                        # Get confidence from entities or tuple[2] if available
                        rel_confidence = None
                        if include_confidence:
                            subj_conf = extract_entity_confidence(item[0])
                            obj_conf = extract_entity_confidence(item[1])
                            if len(item) > 2 and item[2] is not None:
                                rel_confidence = item[2]
                            elif subj_conf is not None and obj_conf is not None:
                                rel_confidence = (subj_conf + obj_conf) / 2
                        relation = ExtractedRelation(
                            subject=subj_text,
                            predicate=relation_type,
                            object=obj_text,
                            confidence=rel_confidence,
                        )
                        relations.append(relation)
                    elif isinstance(item, dict):
                        relation = ExtractedRelation(
                            subject=extract_entity_text(item.get("subject", item.get("head", ""))),
                            predicate=relation_type,
                            object=extract_entity_text(item.get("object", item.get("tail", ""))),
                            confidence=item.get("score", item.get("confidence")) if include_confidence else None,
                        )
                        relations.append(relation)

        processing_time = (time.time() - start_time) * 1000
        return ExtractionResult(
            entities=entities,
            relations=relations,
            processing_time_ms=processing_time,
        )

    def get_all_domains_schema(self) -> tuple[list[str], dict[str, str]]:
        """
        Merge ALL domain presets into a single schema.
        Skips classification step entirely - faster but less precise.
        """
        entity_types = set()
        relation_types = {}

        for domain, preset in DOMAIN_PRESETS.items():
            entity_types.update(preset["entity_types"])
            relation_types.update(preset["relation_types"])

        # Add defaults too
        entity_types.update(settings.default_entity_types or [])
        if settings.default_relation_types:
            relation_types.update(settings.default_relation_types)

        return list(entity_types), relation_types

    def batch_extract_all_domains(
        self,
        texts: list[str],
        batch_size: int = 32,
        include_confidence: bool = True,
        include_spans: bool = True,
    ) -> list[ExtractionResult]:
        """
        Batch extract using ALL entity types from ALL domains.
        Skips domain classification - faster but may have more noise.

        Use this when:
        - Speed is critical
        - Documents are mixed-domain
        - You prefer recall over precision
        """
        start_time = time.time()

        # Get merged schema from all domains
        entity_types, relation_types = self.get_all_domains_schema()
        logger.info(f"Extracting with ALL domains: {len(entity_types)} entity types, {len(relation_types)} relation types")

        # Single batch extraction call
        results = self.batch_extract(
            texts,
            entity_types=entity_types,
            relation_types=relation_types,
            batch_size=batch_size,
            include_confidence=include_confidence,
            include_spans=include_spans,
        )

        total_time = (time.time() - start_time) * 1000
        logger.info(f"All-domains batch extraction completed in {total_time:.0f}ms")

        return results

    def batch_extract_with_auto_domains(
        self,
        texts: list[str],
        batch_size: int = 32,
        domain_threshold: float = 0.3,
        max_domains: int = 3,
        include_confidence: bool = True,
        include_spans: bool = True,
    ) -> list[ExtractionResult]:
        """
        Batch extract with automatic domain detection and grouping.

        Groups texts by detected domain combination for efficient batch processing.
        This is the optimal method for processing mixed-domain documents.

        Args:
            texts: List of texts to extract from
            batch_size: Processing batch size
            domain_threshold: Minimum confidence for domain detection
            max_domains: Maximum domains to merge per text
            include_confidence: Include confidence scores
            include_spans: Include character spans

        Returns:
            List of ExtractionResult (in original order)
        """
        start_time = time.time()

        # Step 1: Batch classify all texts (classification is lighter, use 2x batch_size)
        logger.info(f"Classifying {len(texts)} texts for domain detection...")
        all_domains = self.classify_domains_batch(texts, threshold=domain_threshold, batch_size=batch_size * 2)
        classifications = [domains[:max_domains] for domains in all_domains]  # Limit domains

        # Step 2: Group by domain combination (sorted for consistency)
        batches: dict[tuple[str, ...], list[tuple[int, str]]] = defaultdict(list)
        for idx, (text, domains) in enumerate(zip(texts, classifications)):
            domain_labels = [d["label"] for d in domains if d.get("label")]
            # Sort domains for consistent grouping (same combo = same key)
            domain_key = tuple(sorted(domain_labels)) if domain_labels else ("default",)
            batches[domain_key].append((idx, text))

        logger.info(f"Grouped into {len(batches)} domain batches: {list(batches.keys())}")

        # Step 3: Process each group with merged preset
        results: dict[int, ExtractionResult] = {}

        for domain_key, indexed_texts in batches.items():
            # Get merged schema for this domain combination
            if domain_key == ("default",):
                entity_types = settings.default_entity_types
                relation_types = settings.default_relation_types
            else:
                entity_types, relation_types = self.get_preset_schema(list(domain_key))

            # Extract for this batch
            batch_texts = [text for _, text in indexed_texts]
            batch_results = self.batch_extract(
                batch_texts,
                entity_types=entity_types,
                relation_types=relation_types,
                batch_size=batch_size,
                include_confidence=include_confidence,
                include_spans=include_spans,
            )

            # Map results back to original indices
            for (orig_idx, _), result in zip(indexed_texts, batch_results):
                results[orig_idx] = result

        # Return in original order
        total_time = (time.time() - start_time) * 1000
        logger.info(f"Auto-domain batch extraction completed in {total_time:.0f}ms")

        return [results[i] for i in range(len(texts))]


# Singleton instance
_extractor: GLiNERExtractor | None = None


def get_extractor() -> GLiNERExtractor:
    """Get or create the singleton extractor."""
    global _extractor
    if _extractor is None:
        _extractor = GLiNERExtractor()
    return _extractor


def reset_extractor() -> None:
    """Reset the singleton extractor (for testing)."""
    global _extractor
    _extractor = None
