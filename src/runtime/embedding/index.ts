/**
 * Embedding Module
 *
 * Provides embedding generation for semantic search.
 * Supports multiple providers:
 * - Gemini (cloud, requires API key)
 * - Ollama (local, free, private)
 */

// Provider interface and implementations
export {
  EmbeddingProviderInterface,
  GeminiEmbeddingProvider,
  GeminiProviderOptions,
  EmbeddingProvider, // Legacy alias
  EmbeddingProviderType, // Legacy alias
  EmbeddingProviderOptions, // Legacy alias
} from './embedding-provider.js';

export {
  OllamaEmbeddingProvider,
  OllamaProviderOptions,
} from './ollama-embedding-provider.js';

// Text chunking utilities
export {
  chunkText,
  needsChunking,
  splitIntoSentences,
  type TextChunk,
  type ChunkOptions,
} from './text-chunker.js';

// Types
export * from './types.js';
