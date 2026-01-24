/**
 * Text Chunker for Embedding
 *
 * Simple line-based chunking optimized for code.
 * Respects both character and line limits for TEI compatibility.
 *
 * TEI model limits (BAAI/bge-base-en-v1.5):
 * - max_input_length: 512 tokens
 * - ~4 chars per token = ~2048 chars max
 * - Using 1500 chars for safe margin
 */

export interface ChunkOptions {
  /** Maximum lines per chunk (default: 30) */
  maxLines?: number;
  /** Maximum characters per chunk (default: 1500) */
  maxChars?: number;
  /** Number of lines to overlap between chunks (default: 5) */
  overlapLines?: number;
  /** Minimum chunk size in chars to keep (default: 50) */
  minChunkSize?: number;
}

export interface TextChunk {
  /** Chunk text content */
  text: string;
  /** Chunk index (0-based) */
  index: number;
  /** Start character position in original text */
  startChar: number;
  /** End character position in original text */
  endChar: number;
  /** Start line number (1-based) */
  startLine: number;
  /** End line number (1-based) */
  endLine: number;
}

const DEFAULT_MAX_LINES = 30;
const DEFAULT_MAX_CHARS = 1500;
const DEFAULT_OVERLAP_LINES = 5;
const DEFAULT_MIN_CHUNK_SIZE = 50;

/**
 * Split text into overlapping chunks respecting both line and char limits.
 * Optimized for code - uses line boundaries for clean splits.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const {
    maxLines = DEFAULT_MAX_LINES,
    maxChars = DEFAULT_MAX_CHARS,
    overlapLines = DEFAULT_OVERLAP_LINES,
    minChunkSize = DEFAULT_MIN_CHUNK_SIZE,
  } = options;

  // Split text into lines, then split any super-long lines by maxChars
  const rawLines = text.split('\n');
  const lines: string[] = [];
  for (const line of rawLines) {
    if (line.length > maxChars) {
      // Force-split long line into chunks of maxChars
      for (let pos = 0; pos < line.length; pos += maxChars) {
        lines.push(line.slice(pos, pos + maxChars));
      }
    } else {
      lines.push(line);
    }
  }
  const totalLines = lines.length;

  // If text fits in one chunk, return as-is
  if (text.length <= maxChars && totalLines <= maxLines) {
    return [{
      text,
      index: 0,
      startChar: 0,
      endChar: text.length,
      startLine: 1,
      endLine: totalLines,
    }];
  }

  // Build line start positions for char offset calculation
  const lineStartChars: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineStartChars.push(lineStartChars[i] + lines[i].length + 1); // +1 for \n
  }

  const chunks: TextChunk[] = [];
  let lineIdx = 0;

  while (lineIdx < totalLines) {
    const chunkStartLine = lineIdx;
    const chunkStartChar = lineStartChars[lineIdx];
    let chunkLines: string[] = [];
    let chunkChars = 0;

    // Add lines until we hit a limit
    while (lineIdx < totalLines && chunkLines.length < maxLines) {
      const line = lines[lineIdx];
      const lineLen = line.length + (lineIdx < totalLines - 1 ? 1 : 0); // +1 for \n except last

      // Check if adding this line would exceed char limit
      if (chunkChars + lineLen > maxChars && chunkLines.length > 0) {
        break;
      }

      chunkLines.push(line);
      chunkChars += lineLen;
      lineIdx++;
    }

    // Create chunk
    const chunkText = chunkLines.join('\n');
    if (chunkText.length >= minChunkSize || chunks.length === 0) {
      chunks.push({
        text: chunkText,
        index: chunks.length,
        startChar: chunkStartChar,
        endChar: chunkStartChar + chunkText.length,
        startLine: chunkStartLine + 1, // 1-based
        endLine: chunkStartLine + chunkLines.length, // 1-based
      });
    }

    // Apply overlap: go back N lines for next chunk
    // But don't go back if we're at the end
    if (lineIdx < totalLines) {
      lineIdx = Math.max(chunkStartLine + 1, lineIdx - overlapLines);
    }
  }

  return chunks;
}

/**
 * Check if text needs chunking based on size thresholds
 */
export function needsChunking(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
  maxLines: number = DEFAULT_MAX_LINES
): boolean {
  if (text.length > maxChars) return true;
  const lineCount = text.split('\n').length;
  return lineCount > maxLines;
}

/**
 * Estimate number of chunks for a text
 */
export function estimateChunkCount(
  text: string,
  maxLines: number = DEFAULT_MAX_LINES,
  overlapLines: number = DEFAULT_OVERLAP_LINES
): number {
  const totalLines = text.split('\n').length;
  if (totalLines <= maxLines) return 1;
  const effectiveLines = maxLines - overlapLines;
  return Math.ceil((totalLines - overlapLines) / effectiveLines);
}

/**
 * Legacy exports for backward compatibility
 */
export function splitIntoSentences(text: string): string[] {
  const sentenceRegex = /(?<=[.!?])\s+(?=[A-Z])|(?<=[.!?])\s*\n/g;
  return text.split(sentenceRegex).filter(s => s.trim());
}
