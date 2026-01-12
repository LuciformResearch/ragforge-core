/**
 * Claude Vision OCR Provider
 *
 * Uses Anthropic's Claude Vision API for OCR and image analysis.
 * Fallback provider when Tesseract fails or for complex images.
 *
 * Features:
 * - OCR text extraction
 * - Image description/analysis
 * - 3D model rendered view description
 *
 * @since 2025-01-03
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs/promises";
import * as path from "path";
import type { OCRProvider, OCRResult, OCROptions, OCRProviderType } from "./types.js";

const DEFAULT_OCR_PROMPT = `Extract all text from this image.
Return only the extracted text, no explanations or formatting.
If the image contains no text, return an empty string.
Preserve the original text layout and structure as much as possible.`;

const DEFAULT_DESCRIBE_PROMPT = `Describe this image in detail.
Include: main subjects, colors, composition, style, and any notable features.
Be concise but thorough.`;

const DEFAULT_3D_PROMPT = `Describe this 3D model render. Include:
- What the object/character/scene represents
- Style (realistic, cartoon, low-poly, etc.)
- Colors and materials visible
- Notable features or details
- Potential use case (game asset, product visualization, etc.)
Be concise but descriptive.`;

/**
 * Claude Vision OCR Provider
 */
export class ClaudeOCRProvider implements OCRProvider {
  readonly type: OCRProviderType = "claude" as OCRProviderType;
  readonly name = "Claude Vision";

  private client: Anthropic | null = null;
  private modelName: string;

  constructor(modelName: string = "claude-3-5-haiku-20241022") {
    this.modelName = modelName;
  }

  /**
   * Check if Anthropic API key is configured
   */
  isAvailable(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  /**
   * Get or create Anthropic client
   */
  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY environment variable is not set");
      }
      this.client = new Anthropic({ apiKey });
    }
    return this.client;
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };
    return mimeTypes[ext] || "image/png";
  }

  /**
   * Extract text from an image file (OCR)
   */
  async extractText(imagePath: string, options?: OCROptions): Promise<OCRResult> {
    const startTime = Date.now();

    try {
      const imageBuffer = await fs.readFile(imagePath);
      const base64Data = imageBuffer.toString("base64");
      const mimeType = this.getMimeType(imagePath);

      return await this.extractTextFromData(base64Data, mimeType, {
        ...options,
        _originalPath: imagePath,
      } as OCROptions & { _originalPath: string });
    } catch (error) {
      return {
        imagePath,
        text: "",
        provider: this.type,
        processingTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Extract text from image data
   */
  async extractTextFromData(
    imageData: string | Buffer,
    mimeType: string,
    options?: OCROptions & { _originalPath?: string }
  ): Promise<OCRResult> {
    const startTime = Date.now();
    const imagePath = options?._originalPath || "inline-image";

    try {
      const client = this.getClient();

      const base64Data = Buffer.isBuffer(imageData)
        ? imageData.toString("base64")
        : imageData;

      const prompt = options?.prompt || DEFAULT_OCR_PROMPT;

      const response = await client.messages.create({
        model: this.modelName,
        max_tokens: 4096,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                  data: base64Data,
                },
              },
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
      });

      const textBlocks = response.content.filter((b) => b.type === "text");
      const text = textBlocks.map((b) => (b as any).text).join("\n").trim();

      return {
        imagePath,
        text,
        provider: this.type,
        processingTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        imagePath,
        text: "",
        provider: this.type,
        processingTimeMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Describe an image (not OCR, but visual description)
   */
  async describeImage(
    imagePath: string,
    prompt?: string
  ): Promise<{ description: string; error?: string }> {
    try {
      const imageBuffer = await fs.readFile(imagePath);
      const base64Data = imageBuffer.toString("base64");
      const mimeType = this.getMimeType(imagePath);

      const client = this.getClient();

      const response = await client.messages.create({
        model: this.modelName,
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: base64Data,
                },
              },
              {
                type: "text",
                text: prompt || DEFAULT_DESCRIBE_PROMPT,
              },
            ],
          },
        ],
      });

      const textBlocks = response.content.filter((b) => b.type === "text");
      const description = textBlocks.map((b) => (b as any).text).join("\n").trim();

      return { description };
    } catch (error) {
      return {
        description: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Describe a 3D model render
   */
  async describe3DRender(
    imagePath: string,
    prompt?: string
  ): Promise<{ description: string; error?: string }> {
    return this.describeImage(imagePath, prompt || DEFAULT_3D_PROMPT);
  }

  /**
   * Batch describe multiple images
   */
  async describeImagesBatch(
    imagePaths: string[],
    prompt?: string,
    concurrency: number = 3
  ): Promise<Array<{ path: string; description: string; error?: string }>> {
    const results: Array<{ path: string; description: string; error?: string }> = [];

    // Process in batches
    for (let i = 0; i < imagePaths.length; i += concurrency) {
      const batch = imagePaths.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (p) => {
          const result = await this.describeImage(p, prompt);
          return { path: p, ...result };
        })
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Synthesize a global description from multiple view descriptions
   */
  async synthesizeDescription(
    viewDescriptions: Array<{ view: string; description: string }>
  ): Promise<string> {
    const client = this.getClient();

    const prompt = `Given these descriptions of a 3D model from different viewpoints, synthesize a comprehensive overall description:

${viewDescriptions.map((v) => `**${v.view}**: ${v.description}`).join("\n\n")}

Provide a unified description that:
1. Identifies what the object/character/scene is
2. Describes its overall appearance and style
3. Notes key features visible from multiple angles
4. Mentions the level of detail and quality

Be concise but thorough. Output only the description, no headers or formatting.`;

    const response = await client.messages.create({
      model: this.modelName,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlocks = response.content.filter((b) => b.type === "text");
    return textBlocks.map((b) => (b as any).text).join("\n").trim();
  }
}
