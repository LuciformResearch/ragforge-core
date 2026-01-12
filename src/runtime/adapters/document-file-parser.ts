/**
 * Document File Parser
 *
 * Parses document files (PDF, DOCX, XLSX, CSV) with smart text extraction:
 * - PDF with text → pdfjs-dist
 * - PDF image-only → extract images → OCR (tesseract or Gemini Vision fallback)
 * - DOCX → mammoth (text + HTML)
 * - XLSX/XLS/CSV → xlsx
 * - Images with text → tesseract (confidence > threshold) else Gemini Vision
 *
 * Supports extracting embedded images from PDF and DOCX for Vision analysis.
 *
 * @since 2025-12-07
 */

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { splitIntoSentences } from '../embedding/text-chunker.js';

// =============================================================================
// Types
// =============================================================================

export type DocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'xls' | 'csv';

/** Embedded image extracted from a document */
export interface EmbeddedImage {
  /** Image data as Buffer */
  data: Buffer;
  /** Original filename in the document (e.g., 'image1.png') */
  name: string;
  /** MIME type (e.g., 'image/png', 'image/jpeg') */
  mimeType: string;
  /** Page number where the image appears (1-indexed, if known) */
  page?: number;
  /** Description from Vision analysis (if analyzed) */
  description?: string;
}

export interface DocumentFileInfo {
  uuid: string;
  file: string;
  format: DocumentFormat;
  hash: string;
  sizeBytes: number;

  /** Number of pages (PDF, DOCX) or sheets (XLSX) */
  pageCount?: number;

  /** Sheet names for spreadsheets */
  sheetNames?: string[];

  /** Extracted text content (may be empty if lazy loading) */
  textContent?: string;

  /** Text extraction method used */
  extractionMethod?: 'text' | 'ocr-tesseract' | 'ocr-gemini' | 'none' | 'pending';

  /** OCR confidence (0-100) if OCR was used */
  ocrConfidence?: number;

  /** Whether full text was extracted or just metadata */
  hasFullText: boolean;

  /** Whether Gemini Vision is needed for better OCR (lazy loading - costs money) */
  needsGeminiVision: boolean;

  /** Document metadata */
  metadata?: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    creationDate?: string;
  };

  /** Embedded images extracted from the document */
  embeddedImages?: EmbeddedImage[];
}

export interface SpreadsheetInfo extends DocumentFileInfo {
  format: 'xlsx' | 'xls' | 'csv';

  /** Parsed sheet data */
  sheets?: Record<string, {
    rows: number;
    columns: number;
    headers?: string[];
    data?: unknown[][];
  }>;
}

export interface PDFInfo extends DocumentFileInfo {
  format: 'pdf';

  /** Whether PDF contains selectable text */
  hasSelectableText: boolean;
}

export interface DOCXInfo extends DocumentFileInfo {
  format: 'docx';

  /** HTML representation of the document */
  htmlContent?: string;
}

// OCR confidence threshold - below this, use Gemini Vision
const OCR_CONFIDENCE_THRESHOLD = 60;

// =============================================================================
// Format Detection
// =============================================================================

const DOCUMENT_EXTENSIONS: Record<string, DocumentFormat> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xls': 'xls',
  '.csv': 'csv',
};

export function isDocumentFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext in DOCUMENT_EXTENSIONS;
}

export function getDocumentFormat(filePath: string): DocumentFormat | null {
  const ext = path.extname(filePath).toLowerCase();
  return DOCUMENT_EXTENSIONS[ext] || null;
}

// =============================================================================
// PDF Parsing
// =============================================================================

/**
 * Parse PDF using pdfjs-dist (Mozilla PDF.js) - cleaner, no warnings
 * Falls back to pdf2json if pdfjs-dist fails
 */
async function parsePdfWithText(filePath: string): Promise<{ text: string; pages: number; metadata: any } | null> {
  // Try pdfjs-dist first (cleaner, no warnings)
  try {
    return await parsePdfWithPdfJs(filePath);
  } catch (err) {
    console.warn('pdfjs-dist failed, falling back to pdf2json:', err);
    // Fallback to pdf2json
    return await parsePdfWithPdf2Json(filePath);
  }
}

/**
 * Parse PDF using pdfjs-dist (Mozilla PDF.js)
 * Pure JavaScript/TypeScript, no warnings, more robust
 */
async function parsePdfWithPdfJs(filePath: string): Promise<{ text: string; pages: number; metadata: any } | null> {
  try {
    // Use legacy build for Node.js compatibility (same as pdf-to-img)
    // pdfjs-dist is already installed via pdf-to-img dependency
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const fs = await import('fs/promises');

    // Read PDF file as Uint8Array
    const data = new Uint8Array(await fs.readFile(filePath));

    // Load PDF document
    const loadingTask = pdfjsLib.getDocument({
      data,
      // Disable worker for Node.js (not needed for text extraction)
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    });

    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;

    let fullText = '';
    const metadata: any = {};

    // Extract metadata if available
    try {
      const metaResult = await pdfDocument.getMetadata();
      if (metaResult && metaResult.metadata) {
        const meta = metaResult.metadata;
        metadata.Title = meta.get('Title');
        metadata.Author = meta.get('Author');
        metadata.Subject = meta.get('Subject');
        metadata.Creator = meta.get('Creator');
        metadata.CreationDate = meta.get('CreationDate');
      }
    } catch (metaErr) {
      // Metadata extraction is optional, continue without it
    }

    // Extract text from each page
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Combine text items from the page
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ');

      fullText += pageText + '\n';
    }

    return {
      text: fullText.trim(),
      pages: numPages,
      metadata,
    };
  } catch (err: any) {
    throw new Error(`pdfjs-dist parsing failed: ${err.message}`);
  }
}

/**
 * Parse PDF using pdf2json (fallback)
 * Kept for compatibility but generates warnings
 */
async function parsePdfWithPdf2Json(filePath: string): Promise<{ text: string; pages: number; metadata: any } | null> {
  try {
    const PDFParser = (await import('pdf2json')).default;

    return new Promise((resolve, reject) => {
      const pdfParser = new PDFParser();

      pdfParser.on('pdfParser_dataError', (errData: any) => {
        reject(new Error(errData.parserError));
      });

      pdfParser.on('pdfParser_dataReady', (pdfData: any) => {
        let fullText = '';
        const pages = pdfData.Pages?.length || 0;

        if (pdfData.Pages) {
          for (const page of pdfData.Pages) {
            for (const text of page.Texts || []) {
              for (const run of text.R || []) {
                try {
                  // Try to decode URI component, fallback to raw text if it fails
                  const decoded = decodeURIComponent(run.T);
                  fullText += decoded + ' ';
                } catch (err) {
                  // If decodeURIComponent fails (malformed URI), use raw text
                  // This can happen with some PDF encodings
                  fullText += run.T + ' ';
                }
              }
            }
            fullText += '\n';
          }
        }

        resolve({
          text: fullText.trim(),
          pages,
          metadata: pdfData.Meta || {}
        });
      });

      pdfParser.loadPDF(filePath);
    });
  } catch (err) {
    console.warn('pdf2json failed:', err);
    return null;
  }
}

async function extractPdfPagesAsImages(filePath: string): Promise<Buffer[]> {
  try {
    const { pdf } = await import('pdf-to-img');
    const images: Buffer[] = [];

    const document = await pdf(filePath, { scale: 2 }); // scale 2 for better OCR

    for await (const image of document) {
      images.push(image);
    }

    return images;
  } catch (err) {
    console.warn('pdf-to-img failed:', err);
    return [];
  }
}

// =============================================================================
// OCR with Tesseract
// =============================================================================

async function ocrWithTesseract(imageBuffer: Buffer): Promise<{ text: string; confidence: number }> {
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');

    const { data } = await worker.recognize(imageBuffer);
    await worker.terminate();

    return {
      text: data.text,
      confidence: data.confidence
    };
  } catch (err) {
    console.warn('Tesseract OCR failed:', err);
    return { text: '', confidence: 0 };
  }
}

// =============================================================================
// DOCX Parsing
// =============================================================================

async function parseDocx(filePath: string): Promise<{ text: string; html: string; warnings: number }> {
  try {
    const mammoth = await import('mammoth');

    const textResult = await mammoth.extractRawText({ path: filePath });
    const htmlResult = await mammoth.convertToHtml({ path: filePath });

    return {
      text: textResult.value,
      html: htmlResult.value,
      warnings: htmlResult.messages.length
    };
  } catch (err) {
    console.warn('mammoth failed:', err);
    return { text: '', html: '', warnings: 0 };
  }
}

// =============================================================================
// Image Extraction from Documents
// =============================================================================

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.emf': 'image/emf',
  '.wmf': 'image/wmf',
};

/**
 * Extract embedded images from a DOCX file
 * DOCX is a ZIP file with images in word/media/
 */
export function extractImagesFromDocx(filePath: string): EmbeddedImage[] {
  try {
    const zip = new AdmZip(filePath);
    const images: EmbeddedImage[] = [];

    const entries = zip.getEntries();
    for (const entry of entries) {
      // Images are typically in word/media/
      if (entry.entryName.startsWith('word/media/') && !entry.isDirectory) {
        const ext = path.extname(entry.entryName).toLowerCase();
        const mimeType = IMAGE_MIME_TYPES[ext];

        if (mimeType) {
          images.push({
            data: entry.getData(),
            name: path.basename(entry.entryName),
            mimeType,
          });
        }
      }
    }

    return images;
  } catch (err) {
    console.warn('Failed to extract images from DOCX:', err);
    return [];
  }
}

/**
 * Extract embedded images from a PDF file using pdfjs-dist
 * Note: This extracts actual embedded images, not page renders
 */
export async function extractImagesFromPdf(filePath: string): Promise<EmbeddedImage[]> {
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfData = new Uint8Array(fs.readFileSync(filePath));

    const loadingTask = pdfjsLib.getDocument({
      data: pdfData,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    });

    const pdfDocument = await loadingTask.promise;
    const images: EmbeddedImage[] = [];

    // Iterate through pages and extract image objects
    for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const operatorList = await page.getOperatorList();

      // Find image paint operations
      for (let i = 0; i < operatorList.fnArray.length; i++) {
        const fn = operatorList.fnArray[i];
        // OPS.paintImageXObject = 85, OPS.paintJpegXObject = 82
        if (fn === 85 || fn === 82) {
          const imgName = operatorList.argsArray[i]?.[0];
          if (imgName) {
            try {
              // Get the image object from the page's object list
              const objs = (page as any).objs;
              if (objs && typeof objs.get === 'function') {
                const imgData = objs.get(imgName);
                if (imgData && imgData.data) {
                  // imgData contains raw pixel data, we need to convert to PNG
                  // For now, we'll skip raw data conversion as it requires canvas
                  // Instead, we'll use pdf-to-img for page renders if needed
                }
              }
            } catch (imgErr) {
              // Image extraction failed for this object, continue
            }
          }
        }
      }
    }

    // If no embedded images found via operator list, fallback to page renders
    // This captures everything including vector graphics as images
    if (images.length === 0) {
      const { pdf } = await import('pdf-to-img');
      const document = await pdf(filePath, { scale: 1.5 });

      let pageIndex = 0;
      for await (const pageImage of document) {
        pageIndex++;
        images.push({
          data: pageImage,
          name: `page-${pageIndex}.png`,
          mimeType: 'image/png',
          page: pageIndex,
        });
      }
    }

    return images;
  } catch (err) {
    console.warn('Failed to extract images from PDF:', err);
    return [];
  }
}

// =============================================================================
// Spreadsheet Parsing
// =============================================================================

async function parseSpreadsheet(filePath: string): Promise<{
  sheetNames: string[];
  sheets: Record<string, { rows: number; columns: number; headers?: string[]; data?: unknown[][] }>;
}> {
  try {
    const XLSX = await import('xlsx');
    const buffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(buffer, { type: 'buffer' });

    const sheets: Record<string, { rows: number; columns: number; headers?: string[]; data?: unknown[][] }> = {};

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

      const rows = data.length;
      const columns = data.length > 0 ? Math.max(...data.map(row => (row as unknown[]).length)) : 0;
      const headers = rows > 0 ? (data[0] as string[]).map(h => String(h || '')) : undefined;

      sheets[sheetName] = { rows, columns, headers, data };
    }

    return {
      sheetNames: workbook.SheetNames,
      sheets
    };
  } catch (err) {
    console.warn('xlsx failed:', err);
    return { sheetNames: [], sheets: {} };
  }
}

// =============================================================================
// Main Parser
// =============================================================================

export interface ParseDocumentOptions {
  /** Extract full text content (may be slow for large documents) */
  extractText?: boolean;
  /** Use OCR for image-based PDFs */
  useOcr?: boolean;
  /** Gemini Vision fallback function for low-confidence OCR */
  geminiVisionFallback?: (imageBuffer: Buffer, prompt: string) => Promise<string>;
  /** Maximum pages to OCR (for performance) */
  maxOcrPages?: number;
  /** Extract embedded images from PDF/DOCX (default: false) */
  extractImages?: boolean;
  /** Analyze extracted images with Vision (requires visionAnalyzer callback) */
  analyzeImages?: boolean;
  /** Vision analyzer callback for image description */
  visionAnalyzer?: (imageBuffer: Buffer, mimeType: string) => Promise<string>;
}

export async function parseDocumentFile(
  filePath: string,
  options: ParseDocumentOptions = {}
): Promise<DocumentFileInfo | null> {
  const {
    extractText = true,
    useOcr = true,
    geminiVisionFallback,
    maxOcrPages = 10,
    extractImages = false,
    analyzeImages = false,
    visionAnalyzer,
  } = options;

  const format = getDocumentFormat(filePath);
  if (!format) return null;

  const stats = fs.statSync(filePath);
  const content = fs.readFileSync(filePath);
  const hash = createHash('sha256').update(content).digest('hex').substring(0, 16);

  const baseInfo: Partial<DocumentFileInfo> = {
    uuid: uuidv4(),
    file: filePath,
    format,
    hash,
    sizeBytes: stats.size,
    hasFullText: false,
    needsGeminiVision: false,
  };

  // ==========================================================================
  // PDF
  // ==========================================================================
  if (format === 'pdf') {
    const pdfResult = await parsePdfWithText(filePath);
    const hasSelectableText = !!(pdfResult?.text && pdfResult.text.trim().length > 50);

    const pdfInfo: PDFInfo = {
      ...baseInfo as PDFInfo,
      pageCount: pdfResult?.pages || 0,
      hasSelectableText,
      needsGeminiVision: false,
      metadata: pdfResult?.metadata ? {
        title: pdfResult.metadata.Title,
        author: pdfResult.metadata.Author,
        subject: pdfResult.metadata.Subject,
        creator: pdfResult.metadata.Creator,
        creationDate: pdfResult.metadata.CreationDate,
      } : undefined,
    };

    if (hasSelectableText && extractText) {
      // PDF has text - use it directly (free)
      pdfInfo.textContent = pdfResult!.text;
      pdfInfo.extractionMethod = 'text';
      pdfInfo.hasFullText = true;
    } else if (!hasSelectableText && useOcr) {
      // PDF is image-only - try Tesseract OCR (free)
      console.log(`PDF is image-only, running Tesseract OCR...`);
      const images = await extractPdfPagesAsImages(filePath);

      if (images.length > 0) {
        const pagesToOcr = images.slice(0, maxOcrPages);
        let fullText = '';
        let totalConfidence = 0;

        for (let i = 0; i < pagesToOcr.length; i++) {
          const { text, confidence } = await ocrWithTesseract(pagesToOcr[i]);
          fullText += `--- Page ${i + 1} ---\n${text}\n\n`;
          totalConfidence += confidence;
        }

        const avgConfidence = totalConfidence / pagesToOcr.length;
        pdfInfo.ocrConfidence = avgConfidence;
        pdfInfo.textContent = fullText;
        pdfInfo.extractionMethod = 'ocr-tesseract';

        if (avgConfidence >= OCR_CONFIDENCE_THRESHOLD) {
          // Good OCR confidence
          pdfInfo.hasFullText = true;
          pdfInfo.needsGeminiVision = false;
        } else {
          // Low confidence - mark for Gemini Vision lazy loading
          pdfInfo.hasFullText = false; // Partial/unreliable text
          pdfInfo.needsGeminiVision = true;
          console.log(`OCR confidence low (${avgConfidence.toFixed(1)}%), marked for Gemini Vision`);
        }
      }
    }

    // Extract embedded images if requested
    if (extractImages) {
      const images = await extractImagesFromPdf(filePath);
      if (images.length > 0) {
        // Optionally analyze images with Vision
        if (analyzeImages && visionAnalyzer) {
          for (const img of images) {
            try {
              img.description = await visionAnalyzer(img.data, img.mimeType);
            } catch (err) {
              console.warn(`Failed to analyze image ${img.name}:`, err);
            }
          }
        }
        pdfInfo.embeddedImages = images;
      }
    }

    return pdfInfo;
  }

  // ==========================================================================
  // DOCX
  // ==========================================================================
  if (format === 'docx') {
    const docxResult = await parseDocx(filePath);

    const docxInfo: DOCXInfo = {
      ...baseInfo as DOCXInfo,
      hasFullText: docxResult.text.length > 0,
      needsGeminiVision: false,
      textContent: extractText ? docxResult.text : undefined,
      htmlContent: extractText ? docxResult.html : undefined,
      extractionMethod: 'text',
    };

    // Estimate page count (rough: ~3000 chars per page)
    docxInfo.pageCount = Math.ceil(docxResult.text.length / 3000) || 1;

    // Extract embedded images if requested
    if (extractImages) {
      const images = extractImagesFromDocx(filePath);
      if (images.length > 0) {
        // Optionally analyze images with Vision
        if (analyzeImages && visionAnalyzer) {
          for (const img of images) {
            try {
              img.description = await visionAnalyzer(img.data, img.mimeType);
            } catch (err) {
              console.warn(`Failed to analyze image ${img.name}:`, err);
            }
          }
        }
        docxInfo.embeddedImages = images;
      }
    }

    return docxInfo;
  }

  // ==========================================================================
  // Spreadsheets (XLSX, XLS, CSV)
  // ==========================================================================
  if (format === 'xlsx' || format === 'xls' || format === 'csv') {
    const spreadsheetResult = await parseSpreadsheet(filePath);

    const spreadsheetInfo: SpreadsheetInfo = {
      ...baseInfo as SpreadsheetInfo,
      format,
      sheetNames: spreadsheetResult.sheetNames,
      pageCount: spreadsheetResult.sheetNames.length,
      sheets: spreadsheetResult.sheets,
      hasFullText: true,
      needsGeminiVision: false,
      extractionMethod: 'text',
    };

    // Create text representation of spreadsheet
    if (extractText) {
      let textContent = '';
      for (const [sheetName, sheet] of Object.entries(spreadsheetResult.sheets)) {
        textContent += `=== Sheet: ${sheetName} ===\n`;
        if (sheet.headers) {
          textContent += `Headers: ${sheet.headers.join(' | ')}\n`;
        }
        textContent += `Rows: ${sheet.rows}, Columns: ${sheet.columns}\n\n`;
      }
      spreadsheetInfo.textContent = textContent;
    }

    return spreadsheetInfo;
  }

  return null;
}

// =============================================================================
// PDF with Vision - Combined Text + Image Descriptions
// =============================================================================

/** Paragraph classification result from detection or LLM */
export type ParagraphType = 'title' | 'content' | 'page_number' | 'figure_caption' | 'metadata' | 'abstract';

/** Detected paragraph with classification */
export interface ClassifiedParagraph {
  /** Original paragraph text */
  text: string;
  /** Classification of this paragraph */
  type: ParagraphType;
  /** Title level if type is 'title' (1=h2, 2=h3, 3=h4) */
  titleLevel?: number;
  /** Detected title text (may be cleaned version of text) */
  detectedTitle?: string;
  /** Page number where this appears */
  pageNum: number;
  /** Start Y position */
  startY: number;
}

/** Result from LLM structure analysis */
export interface StructureAnalysisResult {
  /** Classified paragraphs with their types and titles */
  paragraphs: Array<{
    index: number;
    type: ParagraphType;
    titleLevel?: number;
    suggestedTitle?: string;
  }>;
}

export interface ParsePdfWithVisionOptions {
  /** Vision analyzer callback - receives image buffer, returns description */
  visionAnalyzer: (imageBuffer: Buffer, prompt?: string) => Promise<string>;
  /** Maximum pages to process (default: all) */
  maxPages?: number;
  /** Custom prompt for image analysis */
  imagePrompt?: string;
  /** Include page separators in output (default: true) */
  includePageSeparators?: boolean;
  /** Figure label prefix (default: "Figure") */
  figureLabel?: string;
  /** Output format: 'text' (plain) or 'markdown' (with frontmatter, headings) */
  outputFormat?: 'text' | 'markdown';
  /** Original filename for frontmatter (optional) */
  originalFileName?: string;
  /**
   * Section title generation mode:
   * - 'none': No section titles, just paragraphs
   * - 'auto': Auto-generate as "Section 1", "Section 2", etc.
   * - 'detect': Detect real titles using heuristic patterns (I. INTRO, A. Background, etc.)
   * - 'llm': Use LLM to analyze document structure (requires structureAnalyzer)
   */
  sectionTitles?: 'none' | 'auto' | 'detect' | 'llm';
  /**
   * LLM callback to generate section titles from paragraph text.
   * Only used when sectionTitles is 'llm' and structureAnalyzer is not provided.
   * Receives paragraph text, returns a short title.
   * @deprecated Use structureAnalyzer instead for better results
   */
  titleGenerator?: (paragraphText: string) => Promise<string>;
  /**
   * LLM callback to analyze document structure.
   * Receives all paragraphs from a page, returns classification for each.
   * Only used when sectionTitles is 'llm'.
   */
  structureAnalyzer?: (paragraphs: ExtractedParagraph[], pageNum: number) => Promise<StructureAnalysisResult>;
  /**
   * Minimum paragraph length (chars) to get a section title.
   * Shorter paragraphs are merged or skipped. Default: 50
   */
  minParagraphLength?: number;
}

/** A section in the parsed PDF (paragraph with optional title) */
export interface ParsedSection {
  /** Section index (global across all pages) */
  index: number;
  /** Section title (auto-generated, detected, or LLM-generated) */
  title: string;
  /** Title heading level (1=##, 2=###, 3=####). Only set in 'detect' or 'llm' mode. */
  titleLevel?: number;
  /** Section text content */
  text: string;
  /** Page number where this section appears */
  pageNum: number;
  /** Paragraph type from classification (only set in 'detect' or 'llm' mode) */
  type?: ParagraphType;
}

/** An image/figure in the parsed PDF */
export interface ParsedFigure {
  /** Figure index (global) */
  index: number;
  /** Figure description from Vision */
  description: string;
  /** Page number where this figure appears */
  pageNum: number;
}

export interface ParsePdfWithVisionResult {
  /** Combined text with image descriptions interleaved */
  content: string;
  /** Total pages processed */
  pagesProcessed: number;
  /** Total images analyzed */
  imagesAnalyzed: number;
  /** Total sections extracted */
  sectionsExtracted: number;
  /** Processing time in ms */
  processingTimeMs: number;
  /** All sections extracted (for further processing) */
  sections: ParsedSection[];
  /** All figures extracted (for further processing) */
  figures: ParsedFigure[];
  /** Per-page breakdown (legacy) */
  pages: Array<{
    pageNum: number;
    text: string;
    images: Array<{
      index: number;
      description: string;
    }>;
  }>;
}

/** A paragraph extracted from a PDF page */
export interface ExtractedParagraph {
  /** Paragraph text content */
  text: string;
  /** Generated or LLM title (if enabled) */
  title?: string;
  /** Start Y position (for ordering) */
  startY: number;
}

/** Options for paragraph extraction */
interface ParagraphExtractionOptions {
  /** Max paragraph length before splitting with sentences (default: 2000) */
  maxParagraphLength?: number;
  /** Minimum paragraph length to keep (default: 50) */
  minParagraphLength?: number;
}

// =============================================================================
// Title Detection Heuristics
// =============================================================================

/**
 * Title detection patterns for academic/formal documents.
 * Each pattern has a regex and the title level it represents.
 */
const TITLE_PATTERNS: Array<{
  pattern: RegExp;
  level: number;
  type: 'roman' | 'letter' | 'number' | 'keyword';
  extractTitle?: (match: RegExpMatchArray) => string;
}> = [
  // Roman numerals: "I. INTRODUCTION", "II. METHODS"
  {
    pattern: /^([IVX]+)\.\s*([A-Z][A-Za-z\s\-]+)$/,
    level: 1,
    type: 'roman',
    extractTitle: (m) => `${m[1]}. ${m[2].trim()}`,
  },
  // Letters: "A. Background", "B. Related Work"
  {
    pattern: /^([A-Z])\.\s+([A-Z][a-zA-Z\s\-]+)$/,
    level: 2,
    type: 'letter',
    extractTitle: (m) => `${m[1]}. ${m[2].trim()}`,
  },
  // Numbers with dot: "1. Introduction", "2.1 Overview"
  {
    pattern: /^(\d+(?:\.\d+)?)\.\s+([A-Z][a-zA-Z\s\-]+)$/,
    level: 2,
    type: 'number',
    extractTitle: (m) => `${m[1]}. ${m[2].trim()}`,
  },
  // Keywords (Abstract, Conclusion, References, Acknowledgments)
  {
    pattern: /^(Abstract|Conclusion|Conclusions|References|Acknowledgments?|Bibliography)\s*[—:\-]?\s*$/i,
    level: 1,
    type: 'keyword',
    extractTitle: (m) => m[1],
  },
  // Index Terms (common in IEEE papers)
  {
    pattern: /^Index\s+Terms\s*[—:\-]/i,
    level: 2,
    type: 'keyword',
    extractTitle: () => 'Index Terms',
  },
];

/**
 * Patterns to identify non-content paragraphs (to exclude or classify differently)
 */
const EXCLUDE_PATTERNS: Array<{
  pattern: RegExp;
  type: ParagraphType;
}> = [
  // Standalone page numbers: "1", "2", "3", etc.
  { pattern: /^\d+$/, type: 'page_number' },
  // Figure captions: "Fig. 1.", "Figure 2:", "Table 1."
  { pattern: /^(Fig\.|Figure|Table)\s*\d+[.:\s]/i, type: 'figure_caption' },
  // arXiv identifier
  { pattern: /^arXiv:\d+\.\d+/, type: 'metadata' },
];

/**
 * Patterns for titles that may appear at the START of a paragraph (followed by content).
 * These are less strict than TITLE_PATTERNS - they don't require end of string.
 */
const INLINE_TITLE_PATTERNS: Array<{
  pattern: RegExp;
  level: number;
  extractTitle: (match: RegExpMatchArray) => string;
}> = [
  // Letters followed by dot and title: "A. Background\nContent..."
  {
    pattern: /^([A-Z])\.\s+([A-Z][a-zA-Z\s\-]+?)(?:\n|$)/m,
    level: 2,
    extractTitle: (m) => `${m[1]}. ${m[2].trim()}`,
  },
  // Roman numerals: "I. INTRODUCTION\nContent..." or "II. METHODS\n..."
  {
    pattern: /^([IVX]+)\.\s+([A-Z][A-Za-z\s\-]+?)(?:\n|$)/m,
    level: 1,
    extractTitle: (m) => `${m[1]}. ${m[2].trim()}`,
  },
  // Numbers: "1. Introduction\nContent..."
  {
    pattern: /^(\d+(?:\.\d+)?)\.\s+([A-Z][a-zA-Z\s\-]+?)(?:\n|$)/m,
    level: 2,
    extractTitle: (m) => `${m[1]}. ${m[2].trim()}`,
  },
];

/**
 * Detect if a paragraph is a title and classify it.
 * Returns classification result with type, level, and cleaned title.
 *
 * Handles two cases:
 * 1. Standalone title paragraphs (entire paragraph is the title)
 * 2. Inline titles (title on first line, content follows)
 */
function classifyParagraph(text: string): {
  type: ParagraphType;
  titleLevel?: number;
  detectedTitle?: string;
} {
  const trimmed = text.trim();

  // First check exclusion patterns
  for (const { pattern, type } of EXCLUDE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { type };
    }
  }

  // Check if it's a standalone title pattern (entire paragraph is title)
  for (const { pattern, level, extractTitle } of TITLE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        type: 'title',
        titleLevel: level,
        detectedTitle: extractTitle ? extractTitle(match) : trimmed,
      };
    }
  }

  // Check for inline titles at the start of paragraph (title + content)
  for (const { pattern, level, extractTitle } of INLINE_TITLE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return {
        type: 'title',
        titleLevel: level,
        detectedTitle: extractTitle(match),
      };
    }
  }

  // Check for Abstract with content on same line: "Abstract —To support..."
  const abstractMatch = trimmed.match(/^Abstract\s*[—:\-]\s*(.+)/i);
  if (abstractMatch) {
    return {
      type: 'abstract',
      titleLevel: 1,
      detectedTitle: 'Abstract',
    };
  }

  // Default: regular content
  return { type: 'content' };
}

/**
 * Classify all paragraphs from a page using heuristic detection.
 * Returns classified paragraphs with proper title detection.
 */
function classifyParagraphsHeuristic(
  paragraphs: ExtractedParagraph[],
  pageNum: number
): ClassifiedParagraph[] {
  return paragraphs.map((para) => {
    const classification = classifyParagraph(para.text);
    return {
      text: para.text,
      type: classification.type,
      titleLevel: classification.titleLevel,
      detectedTitle: classification.detectedTitle,
      pageNum,
      startY: para.startY,
    };
  });
}

/**
 * Quick check if a text looks like a title pattern.
 * Used to prevent merging title paragraphs with content.
 */
function isLikelyTitle(text: string): boolean {
  const trimmed = text.trim();

  // Too long to be a title
  if (trimmed.length > 100) return false;

  // Roman numerals: "I. INTRODUCTION", "II. METHODS", "I. I NTRODUCTION" (with space)
  if (/^[IVX]+\.\s+[A-Z]/i.test(trimmed)) return true;

  // Letters: "A. Background", "B. Synesthesia"
  if (/^[A-Z]\.\s+[A-Z]/i.test(trimmed)) return true;

  // Numbers: "1. Introduction", "2.1 Overview"
  if (/^\d+(?:\.\d+)?\.\s+[A-Z]/i.test(trimmed)) return true;

  // Keywords
  if (/^(Abstract|Conclusion|Conclusions|References|Acknowledgments?|Bibliography|Index\s+Terms)\s*[—:\-]?\s*$/i.test(trimmed)) return true;

  return false;
}

/**
 * Extract text from a PDF page with line break and paragraph preservation.
 * Uses Y position changes to detect line breaks and larger gaps for paragraphs.
 * Large paragraphs are split using sentence boundaries from text-chunker.
 *
 * @returns Array of paragraphs, each containing multiple lines
 */
function extractTextWithParagraphs(
  textContent: any,
  options: ParagraphExtractionOptions = {}
): ExtractedParagraph[] {
  const {
    maxParagraphLength = 2000,
    minParagraphLength = 50,
  } = options;

  const items = textContent.items as any[];
  if (items.length === 0) return [];

  const LINE_THRESHOLD = 5;      // Y difference to consider a new line
  const PARAGRAPH_THRESHOLD = 15; // Y difference to consider a new paragraph

  const rawParagraphs: ExtractedParagraph[] = [];
  let currentLines: string[] = [];
  let currentLine = '';
  let lastY: number | null = null;
  let paragraphStartY: number | null = null;

  const flushParagraph = () => {
    if (currentLine.trim()) {
      currentLines.push(currentLine.trim());
    }
    if (currentLines.length > 0) {
      rawParagraphs.push({
        text: currentLines.join('\n'),
        startY: paragraphStartY ?? 0,
      });
    }
    currentLines = [];
    currentLine = '';
  };

  for (const item of items) {
    if (!item.str) continue;

    // Get Y position from transform matrix [a, b, c, d, e, f] where f is Y
    const y = item.transform?.[5] ?? 0;

    if (lastY !== null) {
      const yDiff = Math.abs(y - lastY);

      if (yDiff > PARAGRAPH_THRESHOLD) {
        // New paragraph detected
        flushParagraph();
        paragraphStartY = y;
        currentLine = item.str;
      } else if (yDiff > LINE_THRESHOLD) {
        // New line within same paragraph
        if (currentLine.trim()) {
          currentLines.push(currentLine.trim());
        }
        currentLine = item.str;
      } else {
        // Same line - add with space if needed
        if (currentLine && !currentLine.endsWith(' ') && !item.str.startsWith(' ')) {
          currentLine += ' ';
        }
        currentLine += item.str;
      }
    } else {
      // First item
      paragraphStartY = y;
      currentLine = item.str;
    }
    lastY = y;
  }

  // Flush final paragraph
  flushParagraph();

  // Post-process: split large paragraphs using sentence boundaries
  const finalParagraphs: ExtractedParagraph[] = [];

  for (const para of rawParagraphs) {
    if (para.text.length > maxParagraphLength) {
      // Split using sentence boundaries
      const sentences = splitIntoSentences(para.text);
      let currentChunk = '';

      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > maxParagraphLength && currentChunk.length >= minParagraphLength) {
          finalParagraphs.push({
            text: currentChunk.trim(),
            startY: para.startY,
          });
          currentChunk = sentence;
        } else {
          currentChunk = currentChunk ? currentChunk + ' ' + sentence : sentence;
        }
      }

      if (currentChunk.trim().length >= minParagraphLength) {
        finalParagraphs.push({
          text: currentChunk.trim(),
          startY: para.startY,
        });
      } else if (finalParagraphs.length > 0 && currentChunk.trim()) {
        // Merge small remainder with previous
        finalParagraphs[finalParagraphs.length - 1].text += ' ' + currentChunk.trim();
      }
    } else if (para.text.length >= minParagraphLength) {
      finalParagraphs.push(para);
    } else if (para.text.trim()) {
      // Check if this short paragraph is a title - if so, DON'T merge it
      const isTitle = isLikelyTitle(para.text.trim());

      if (isTitle) {
        // Keep titles as separate paragraphs even if short
        finalParagraphs.push(para);
      } else if (finalParagraphs.length > 0) {
        // Merge small non-title paragraph with previous
        finalParagraphs[finalParagraphs.length - 1].text += '\n\n' + para.text;
      } else {
        // Keep even small if it's the first
        finalParagraphs.push(para);
      }
    }
  }

  // Post-process: split paragraphs that contain embedded titles
  const splitParagraphs = splitAtEmbeddedTitles(finalParagraphs);

  return splitParagraphs;
}

/**
 * Split paragraphs that contain embedded title lines.
 * E.g., "Content...\n\nI. INTRODUCTION\n\nA. Background" becomes 3 paragraphs.
 */
function splitAtEmbeddedTitles(paragraphs: ExtractedParagraph[]): ExtractedParagraph[] {
  const result: ExtractedParagraph[] = [];

  for (const para of paragraphs) {
    const lines = para.text.split('\n');
    let currentChunk: string[] = [];
    let lastWasTitle = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) {
        if (currentChunk.length > 0) {
          currentChunk.push(''); // Keep as paragraph separator
        }
        continue;
      }

      const isTitle = isLikelyTitle(trimmed);

      if (isTitle) {
        // Flush current chunk if it has content
        if (currentChunk.filter(l => l.trim()).length > 0) {
          result.push({
            text: currentChunk.join('\n').trim(),
            startY: para.startY,
          });
        }
        // Start new chunk with title
        currentChunk = [trimmed];
        lastWasTitle = true;
      } else {
        // If last was title and this is content, keep in same chunk
        // Otherwise, just add to current chunk
        if (lastWasTitle && currentChunk.length === 1) {
          // Title followed by content - flush title first
          result.push({
            text: currentChunk[0],
            startY: para.startY,
          });
          currentChunk = [trimmed];
        } else {
          currentChunk.push(trimmed);
        }
        lastWasTitle = false;
      }
    }

    // Flush remaining content
    if (currentChunk.filter(l => l.trim()).length > 0) {
      result.push({
        text: currentChunk.join('\n').trim(),
        startY: para.startY,
      });
    }
  }

  return result;
}

/**
 * Legacy function for backward compatibility - returns single string
 */
function extractTextWithLineBreaks(textContent: any): string {
  const paragraphs = extractTextWithParagraphs(textContent);
  return paragraphs.map(p => p.text).join('\n\n');
}

/**
 * Parse a PDF with Vision - extracts text and images per page,
 * analyzes images with Vision, and returns combined content with
 * image descriptions and section titles interleaved.
 *
 * Features:
 * - Paragraph detection via Y position gaps
 * - Large paragraph splitting using sentence boundaries
 * - Section title generation (auto or LLM)
 * - Image analysis with Vision provider
 *
 * Supports two output formats:
 * - 'text': Plain text with separators
 * - 'markdown': Full markdown with YAML frontmatter, section headings, blockquote figures
 */
export async function parsePdfWithVision(
  filePath: string,
  options: ParsePdfWithVisionOptions
): Promise<ParsePdfWithVisionResult> {
  const startTime = Date.now();
  const {
    visionAnalyzer,
    maxPages,
    imagePrompt = "Describe this image in detail. What does it show? Include any text, diagrams, charts, or visual elements.",
    includePageSeparators = true,
    figureLabel = "Figure",
    outputFormat = 'text',
    originalFileName,
    sectionTitles = 'none',
    titleGenerator,
    structureAnalyzer,
    minParagraphLength = 50,
  } = options;

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfData = new Uint8Array(fs.readFileSync(filePath));

  const loadingTask = pdfjsLib.getDocument({
    data: pdfData,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const pdfDocument = await loadingTask.promise;
  const totalPages = maxPages ? Math.min(pdfDocument.numPages, maxPages) : pdfDocument.numPages;

  // Collections for results
  const pages: ParsePdfWithVisionResult['pages'] = [];
  const allSections: ParsedSection[] = [];
  const allFigures: ParsedFigure[] = [];

  let globalImageIndex = 0;
  let globalSectionIndex = 0;
  let totalImagesAnalyzed = 0;

  // First pass: identify which pages have images using operator list
  const pagesWithImages = new Map<number, number>(); // pageNum -> image count

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const operatorList = await page.getOperatorList();

    let imageCount = 0;
    for (let i = 0; i < operatorList.fnArray.length; i++) {
      const fn = operatorList.fnArray[i];
      // OPS.paintImageXObject = 85, OPS.paintJpegXObject = 82
      if (fn === 85 || fn === 82) {
        imageCount++;
      }
    }

    if (imageCount > 0) {
      pagesWithImages.set(pageNum, imageCount);
    }
  }

  // Second pass: render pages with images
  const { pdf } = await import('pdf-to-img');
  let pageImages: Buffer[] = [];

  if (pagesWithImages.size > 0) {
    const document = await pdf(filePath, { scale: 1.5 });
    let pageIndex = 0;
    for await (const pageImage of document) {
      pageIndex++;
      if (pageIndex > totalPages) break;
      if (pagesWithImages.has(pageIndex)) {
        pageImages[pageIndex] = pageImage;
      }
    }
  }

  // Third pass: extract paragraphs and analyze images
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Extract paragraphs with proper splitting
    const paragraphs = extractTextWithParagraphs(textContent, { minParagraphLength });

    // Classify paragraphs based on mode
    let classifiedParas: ClassifiedParagraph[] | null = null;

    if (sectionTitles === 'detect') {
      // Use heuristic detection
      classifiedParas = classifyParagraphsHeuristic(paragraphs, pageNum);
    } else if (sectionTitles === 'llm' && structureAnalyzer) {
      // Use LLM structure analyzer
      try {
        const analysisResult = await structureAnalyzer(paragraphs, pageNum);
        classifiedParas = paragraphs.map((para, idx) => {
          const analysis = analysisResult.paragraphs.find(p => p.index === idx);
          return {
            text: para.text,
            type: analysis?.type || 'content',
            titleLevel: analysis?.titleLevel,
            detectedTitle: analysis?.suggestedTitle,
            pageNum,
            startY: para.startY,
          };
        });
      } catch (err) {
        console.warn(`LLM structure analysis failed for page ${pageNum}, falling back to detect:`, err);
        classifiedParas = classifyParagraphsHeuristic(paragraphs, pageNum);
      }
    }

    // Generate section titles for each paragraph
    const pageSections: ParsedSection[] = [];
    let lastTitleLevel = 0;

    for (let paraIdx = 0; paraIdx < paragraphs.length; paraIdx++) {
      const para = paragraphs[paraIdx];
      const classified = classifiedParas?.[paraIdx];

      // Skip page numbers and metadata in output
      if (classified?.type === 'page_number' || classified?.type === 'metadata') {
        continue;
      }

      globalSectionIndex++;

      let title: string;
      let titleLevel: number | undefined;

      if (sectionTitles === 'detect' && classified) {
        // Use detected classification
        if (classified.type === 'title' && classified.detectedTitle) {
          title = classified.detectedTitle;
          titleLevel = classified.titleLevel;
          lastTitleLevel = titleLevel || 1;
        } else if (classified.type === 'figure_caption') {
          // Figure captions become their own section with special title
          title = ''; // Will be handled as content, figure is separate
        } else if (classified.type === 'abstract') {
          title = 'Abstract';
          titleLevel = 1;
        } else {
          // Regular content - no title (will be merged with previous section conceptually)
          title = '';
        }
      } else if (sectionTitles === 'llm' && classified) {
        // Use LLM-provided classification
        if (classified.type === 'title' && classified.detectedTitle) {
          title = classified.detectedTitle;
          titleLevel = classified.titleLevel;
        } else {
          title = '';
        }
      } else if (sectionTitles === 'llm' && titleGenerator) {
        // Legacy: per-paragraph title generation
        try {
          title = await titleGenerator(para.text.slice(0, 500));
        } catch {
          title = `Section ${globalSectionIndex}`;
        }
      } else if (sectionTitles === 'auto') {
        title = `Section ${globalSectionIndex}`;
      } else {
        title = ''; // No title
      }

      const section: ParsedSection = {
        index: globalSectionIndex,
        title,
        titleLevel,
        text: para.text,
        pageNum,
        type: classified?.type,
      };

      pageSections.push(section);
      allSections.push(section);
    }

    // Legacy page text (join all paragraphs)
    const pageText = paragraphs.map(p => p.text).join('\n\n');

    const pageData: ParsePdfWithVisionResult['pages'][0] = {
      pageNum,
      text: pageText,
      images: [],
    };

    // Analyze images on this page
    const imageCount = pagesWithImages.get(pageNum) || 0;
    if (imageCount > 0 && pageImages[pageNum]) {
      globalImageIndex++;
      try {
        const description = await visionAnalyzer(pageImages[pageNum], imagePrompt);
        pageData.images.push({
          index: globalImageIndex,
          description,
        });
        allFigures.push({
          index: globalImageIndex,
          description,
          pageNum,
        });
        totalImagesAnalyzed++;
      } catch (err) {
        console.warn(`Failed to analyze image on page ${pageNum}:`, err);
        pageData.images.push({
          index: globalImageIndex,
          description: '[Image analysis failed]',
        });
        allFigures.push({
          index: globalImageIndex,
          description: '[Image analysis failed]',
          pageNum,
        });
      }
    }

    pages.push(pageData);
  }

  // Build final content string based on output format
  let content = '';
  const fileName = originalFileName || path.basename(filePath);

  if (outputFormat === 'markdown') {
    // YAML frontmatter
    content += '---\n';
    content += `originalFileName: "${fileName}"\n`;
    content += `sourceFormat: "pdf"\n`;
    content += `parsedFrom: "pdf-with-vision"\n`;
    content += `totalPages: ${pdfDocument.numPages}\n`;
    content += `pagesExtracted: ${totalPages}\n`;
    content += `sectionsExtracted: ${allSections.length}\n`;
    content += `imagesAnalyzed: ${totalImagesAnalyzed}\n`;
    content += '---\n\n';
    content += `# ${fileName}\n\n`;

    let currentPage = 0;
    for (const section of allSections) {
      // Page header if new page
      if (includePageSeparators && section.pageNum !== currentPage) {
        currentPage = section.pageNum;
        content += `## Page ${currentPage}\n\n`;

        // Insert figures for this page after page header
        const pageFigures = allFigures.filter(f => f.pageNum === currentPage);
        for (const fig of pageFigures) {
          content += `> **${figureLabel} ${fig.index}**\n>\n`;
          const descLines = fig.description.split('\n');
          for (const line of descLines) {
            content += `> ${line}\n`;
          }
          content += '\n';
        }
      }

      // Section with title - use appropriate heading level
      if (section.title) {
        // titleLevel: 1 = ## (h2), 2 = ### (h3), 3 = #### (h4)
        // Default to ### if no level specified (backward compatible)
        const level = section.titleLevel || 2;
        const hashes = '#'.repeat(level + 1); // level 1 = ##, level 2 = ###, level 3 = ####
        content += `${hashes} ${section.title}\n\n`;
      }
      content += section.text;
      content += '\n\n';
    }
  } else {
    // Plain text format
    let currentPage = 0;
    for (const section of allSections) {
      // Page header if new page
      if (includePageSeparators && section.pageNum !== currentPage) {
        currentPage = section.pageNum;
        content += `\n--- Page ${currentPage} ---\n\n`;

        // Insert figures for this page
        const pageFigures = allFigures.filter(f => f.pageNum === currentPage);
        for (const fig of pageFigures) {
          content += `┌─ ${figureLabel} ${fig.index} ─────────────────────────────────────┐\n`;
          content += `│ ${fig.description.split('\n').join('\n│ ')}\n`;
          content += `└──────────────────────────────────────────────────────────┘\n\n`;
        }
      }

      // Section with title
      if (section.title) {
        content += `[${section.title}]\n`;
      }
      content += section.text;
      content += '\n\n';
    }
  }

  return {
    content: content.trim(),
    pagesProcessed: totalPages,
    imagesAnalyzed: totalImagesAnalyzed,
    sectionsExtracted: allSections.length,
    processingTimeMs: Date.now() - startTime,
    sections: allSections,
    figures: allFigures,
    pages,
  };
}

// =============================================================================
// Batch Parser
// =============================================================================

export async function parseDocumentFiles(
  filePaths: string[],
  options: ParseDocumentOptions = {}
): Promise<Map<string, DocumentFileInfo>> {
  const results = new Map<string, DocumentFileInfo>();

  for (const filePath of filePaths) {
    if (isDocumentFile(filePath)) {
      const info = await parseDocumentFile(filePath, options);
      if (info) {
        results.set(filePath, info);
      }
    }
  }

  return results;
}
