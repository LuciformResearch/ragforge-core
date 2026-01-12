/**
 * Schema Version Management
 *
 * Computes schema hashes from NODE_SCHEMAS (the single source of truth).
 * This ensures all nodes of the same type get the same schemaVersion,
 * regardless of which optional properties they have.
 *
 * When NODE_SCHEMAS changes (properties added/removed for a type),
 * the hash changes and existing nodes are detected as outdated.
 */

import { createHash } from 'crypto';
import { CONTENT_NODE_LABELS, getRequiredProperties } from './node-schema.js';

/**
 * Compute a schema hash for a node type.
 *
 * Uses the REQUIRED properties from NODE_SCHEMAS as the source of truth.
 * This ensures all nodes of the same type have the same schemaVersion.
 *
 * If the node type is not defined in NODE_SCHEMAS, falls back to
 * computing from actual properties (for backwards compatibility).
 *
 * @param nodeType - The node type/label (e.g., 'Scope', 'MarkdownSection')
 * @param properties - The actual properties (only used as fallback)
 * @returns A 12-character hash representing the schema
 */
export function computeSchemaHash(nodeType: string, properties?: Record<string, unknown>): string {
  // Try to get required properties from NODE_SCHEMAS (source of truth)
  const requiredProps = getRequiredProperties(nodeType);

  let schemaKeys: string[];

  if (requiredProps) {
    // Use the defined required properties (sorted for consistency)
    schemaKeys = [...requiredProps].sort();
  } else if (properties) {
    // Fallback: compute from actual properties (for unknown types)
    // Exclude metadata fields that vary between nodes
    const metadataFields = new Set([
      'indexedAt', 'projectId', 'uuid', 'hash', 'schemaVersion', 'schemaDirty',
      'embeddingsDirty', 'embedding', 'embedding_hash', 'embedding_name',
      'embedding_name_hash', 'embedding_description', 'embedding_description_hash',
      'embedding_content', 'embedding_content_hash', 'parent', 'parentUUID',
      'returnType', 'docstring', 'description',
    ]);
    schemaKeys = Object.keys(properties)
      .filter(k => !metadataFields.has(k))
      .sort();
  } else {
    // No properties and no schema - use empty schema
    schemaKeys = [];
  }

  // Include node type in hash so different types with same props have different hashes
  const schemaString = `${nodeType}:${schemaKeys.join(',')}`;

  return createHash('sha256').update(schemaString).digest('hex').slice(0, 12);
}

/**
 * Check if a node should have schema versioning based on its labels
 */
export function shouldHaveSchemaVersion(labels: string[]): boolean {
  return labels.some(label => CONTENT_NODE_LABELS.has(label));
}

/**
 * Add schemaVersion to node properties if it's a content node
 *
 * @param labels - Node labels
 * @param properties - Node properties (will be mutated to add schemaVersion)
 * @returns The properties with schemaVersion added (if applicable)
 */
export function addSchemaVersion(
  labels: string[],
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (shouldHaveSchemaVersion(labels)) {
    // Use the LAST content label (most specific) for the hash
    // e.g., for [MediaFile, ImageFile], use ImageFile not MediaFile
    const contentLabels = labels.filter(l => CONTENT_NODE_LABELS.has(l));
    const contentLabel = contentLabels[contentLabels.length - 1] || labels[0];
    properties.schemaVersion = computeSchemaHash(contentLabel, properties);
  }
  return properties;
}
