/**
 * Entity Extraction Types
 *
 * Types for GLiNER-based entity and relation extraction.
 */

// =============================================================================
// Extracted Data Types
// =============================================================================

/**
 * An extracted entity from text.
 */
export interface ExtractedEntity {
  /** Entity text/name */
  name: string;
  /** Entity type (e.g., "person", "organization", "price") */
  type: string;
  /** Confidence score (0-1) */
  confidence?: number;
  /** Character span [start, end] in source text */
  span?: [number, number];
  /** Additional properties */
  properties?: Record<string, unknown>;
}

/**
 * An extracted relation between entities.
 */
export interface ExtractedRelation {
  /** Subject entity name */
  subject: string;
  /** Relation type (predicate) */
  predicate: string;
  /** Object entity name */
  object: string;
  /** Confidence score (0-1) */
  confidence?: number;
}

/**
 * Result of extraction for a single text.
 */
export interface ExtractionResult {
  /** Extracted entities */
  entities: ExtractedEntity[];
  /** Extracted relations */
  relations: ExtractedRelation[];
  /** Processing time in milliseconds */
  processing_time_ms: number;
}

// =============================================================================
// Request/Response Types (GLiNER API)
// =============================================================================

/**
 * Request for single text extraction.
 */
export interface ExtractionRequest {
  text: string;
  entity_types?: string[];
  relation_types?: Record<string, string>;
  include_confidence?: boolean;
  include_spans?: boolean;
}

/**
 * Request for batch extraction.
 */
export interface BatchExtractionRequest {
  texts: string[];
  entity_types?: string[];
  relation_types?: Record<string, string>;
  include_confidence?: boolean;
  include_spans?: boolean;
  batch_size?: number;
}

/**
 * Response from batch extraction.
 */
export interface BatchExtractionResponse {
  results: ExtractionResult[];
  total_processing_time_ms: number;
  texts_processed: number;
}

/**
 * Health check response.
 */
export interface HealthResponse {
  status: 'ok' | 'error';
  model_loaded: boolean;
  model_name: string;
  device: string;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for entity extraction.
 */
export interface EntityExtractionConfig {
  /** GLiNER service URL (default: http://localhost:6971) */
  serviceUrl: string;

  /** Entity types to extract (default: from service config) */
  entityTypes?: string[];

  /** Relation types with descriptions */
  relationTypes?: Record<string, string>;

  /** Enable auto domain detection (default: false) */
  autoDetectDomain?: boolean;

  /** Use ALL entity types from ALL domains - skips classification, faster (default: false) */
  useAllDomains?: boolean;

  /** Minimum confidence threshold (default: 0.5) */
  confidenceThreshold?: number;

  /** Whether entity extraction is enabled (default: true) */
  enabled?: boolean;

  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
}

/**
 * Default configuration values.
 */
export const DEFAULT_ENTITY_EXTRACTION_CONFIG: EntityExtractionConfig = {
  serviceUrl: 'http://localhost:6971',
  autoDetectDomain: false,
  confidenceThreshold: 0.5,
  enabled: true,
  timeoutMs: 30000,
};

// =============================================================================
// Domain Presets (mirrors Python service config)
// =============================================================================

/**
 * Available domain presets for entity extraction.
 */
export type DomainPreset = 'ecommerce' | 'code' | 'documentation' | 'legal' | 'default';

/**
 * Domain preset configuration.
 */
export interface DomainPresetConfig {
  entityTypes: string[];
  relationTypes: Record<string, string>;
}

/**
 * Built-in domain presets.
 * These mirror the Python service config for reference.
 */
export const DOMAIN_PRESETS: Record<DomainPreset, DomainPresetConfig> = {
  default: {
    entityTypes: [
      'person', 'organization', 'location', 'technology',
      'product', 'price', 'date', 'quantity',
    ],
    relationTypes: {
      works_for: 'person works for organization',
      located_in: 'entity is located in location',
      created_by: 'product/technology created by person/organization',
      costs: 'product has price',
      depends_on: 'technology depends on another technology',
      part_of: 'entity is part of another entity',
    },
  },
  ecommerce: {
    entityTypes: [
      'product', 'brand', 'price', 'currency', 'quantity',
      'category', 'ingredient', 'certification', 'benefit',
      'hair_type', 'skin_type', 'size', 'color', 'material',
    ],
    relationTypes: {
      compatible_with: 'product is compatible with attribute',
      contains: 'product contains ingredient',
      certified_by: 'product has certification',
      provides_benefit: 'product provides benefit',
      recommended_with: 'product is recommended with another product',
      complements: 'product complements another product',
      priced_at: 'product has price',
    },
  },
  code: {
    entityTypes: [
      'function', 'class', 'method', 'variable', 'module',
      'library', 'api', 'endpoint', 'parameter', 'return_type',
      'error', 'exception', 'configuration',
    ],
    relationTypes: {
      calls: 'function/method calls another',
      inherits_from: 'class inherits from another class',
      implements: 'class implements interface',
      imports: 'module imports another module',
      returns: 'function returns type',
      throws: 'function throws exception',
      depends_on: 'module depends on library',
    },
  },
  documentation: {
    entityTypes: [
      'concept', 'feature', 'requirement', 'specification',
      'user_story', 'use_case', 'actor', 'system', 'component',
      'version', 'release', 'milestone',
    ],
    relationTypes: {
      describes: 'section describes concept',
      requires: 'feature requires another feature',
      implements: 'feature implements requirement',
      affects: 'change affects component',
      belongs_to: 'feature belongs to release',
    },
  },
  legal: {
    entityTypes: [
      'person', 'organization', 'contract', 'clause', 'obligation',
      'right', 'party', 'date', 'duration', 'amount', 'jurisdiction',
    ],
    relationTypes: {
      party_to: 'person/organization is party to contract',
      obligated_to: 'party has obligation',
      grants_right: 'clause grants right to party',
      effective_date: 'contract has effective date',
      governed_by: 'contract governed by jurisdiction',
    },
  },
};
