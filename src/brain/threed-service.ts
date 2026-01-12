/**
 * 3D Model Service
 *
 * Handles the workflow for 3D model analysis:
 * 1. Render 3D model to images (multiple views)
 * 2. Create ImageFile nodes with RENDERED_AS relationships
 * 3. Generate descriptions for each view (via Gemini Vision)
 * 4. Synthesize global description for the ThreeDFile
 * 5. Generate embeddings
 *
 * @since 2025-12-07
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Neo4jClient } from '../runtime/client/neo4j-client.js';
import { EmbeddingService } from './embedding-service.js';
import { ChangeTracker } from '../runtime/adapters/change-tracker.js';
import { getLocalTimestamp } from '../runtime/utils/timestamp.js';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

export interface ThreeDServiceConfig {
  neo4jClient: Neo4jClient;
  embeddingService?: EmbeddingService | null;
  geminiApiKey?: string;
  projectRoot: string;
}

export interface RenderAndAnalyzeOptions {
  /** Path to the 3D model file */
  modelPath: string;
  /** Project ID for Neo4j nodes */
  projectId: string;
  /** Output directory for rendered images */
  outputDir?: string;
  /** Views to render (default: front, right, back, perspective) */
  views?: string[];
  /** Image dimensions */
  width?: number;
  height?: number;
  /** Generate descriptions using Gemini Vision */
  generateDescriptions?: boolean;
  /** Synthesize global description from views */
  synthesizeDescription?: boolean;
  /** Generate embeddings after analysis */
  generateEmbeddings?: boolean;
}

export interface RenderAndAnalyzeResult {
  threeDFileUuid: string;
  renderedViews: Array<{
    view: string;
    imagePath: string;
    imageUuid: string;
    description?: string;
  }>;
  globalDescription?: string;
  embeddingsGenerated: number;
}

/**
 * 3D Model Service
 */
export class ThreeDService {
  private neo4jClient: Neo4jClient;
  private embeddingService: EmbeddingService | null;
  private geminiApiKey?: string;
  private projectRoot: string;

  constructor(config: ThreeDServiceConfig) {
    this.neo4jClient = config.neo4jClient;
    this.embeddingService = config.embeddingService || null;
    this.geminiApiKey = config.geminiApiKey;
    this.projectRoot = config.projectRoot;
  }

  /**
   * Register rendered views for a 3D model
   *
   * Creates ImageFile nodes and RENDERED_AS relationships.
   * Call this after render_3d_asset tool execution.
   */
  async registerRenderedViews(
    modelPath: string,
    projectId: string,
    renders: Array<{ view: string; path: string }>
  ): Promise<{ threeDFileUuid: string; imageUuids: string[] }> {
    const absoluteModelPath = path.resolve(this.projectRoot, modelPath);
    const relModelPath = path.relative(this.projectRoot, absoluteModelPath);

    // Find the ThreeDFile node
    const findResult = await this.neo4jClient.run(
      `MATCH (t:ThreeDFile {projectId: $projectId})
       WHERE t.file = $relPath
       RETURN t.uuid AS uuid`,
      { projectId, relPath: relModelPath }
    );

    let threeDFileUuid: string;

    if (findResult.records.length === 0) {
      // ThreeDFile doesn't exist yet, create it
      threeDFileUuid = `media:${uuidv4()}`;
      const fileName = path.basename(relModelPath);
      const extension = path.extname(relModelPath);

      await this.neo4jClient.run(
        `CREATE (t:MediaFile:ThreeDFile {
          uuid: $uuid,
          file: $relPath,
          format: $format,
          category: '3d',
          analyzed: false,
          projectId: $projectId,
          indexedAt: $indexedAt
        })`,
        {
          uuid: threeDFileUuid,
          relPath: relModelPath,
          format: extension.replace('.', ''),
          projectId,
          indexedAt: getLocalTimestamp(),
        }
      );
    } else {
      threeDFileUuid = findResult.records[0].get('uuid');
    }

    const imageUuids: string[] = [];

    // Create ImageFile nodes and RENDERED_AS relationships
    for (const render of renders) {
      const absoluteImagePath = path.resolve(this.projectRoot, render.path);
      const relImagePath = path.relative(this.projectRoot, absoluteImagePath);
      const imageUuid = `media:${uuidv4()}`;
      imageUuids.push(imageUuid);

      // Get file size
      let sizeBytes = 0;
      try {
        const stat = await fs.stat(absoluteImagePath);
        sizeBytes = stat.size;
      } catch {
        // Ignore stat errors
      }

      // Create ImageFile node
      await this.neo4jClient.run(
        `CREATE (i:MediaFile:ImageFile {
          uuid: $uuid,
          file: $relPath,
          format: 'png',
          category: 'image',
          analyzed: false,
          isRenderedView: true,
          viewAngle: $viewAngle,
          sourceModel: $sourceModel,
          sizeBytes: $sizeBytes,
          projectId: $projectId,
          indexedAt: $indexedAt
        })`,
        {
          uuid: imageUuid,
          relPath: relImagePath,
          viewAngle: render.view,
          sourceModel: relModelPath,
          sizeBytes,
          projectId,
          indexedAt: getLocalTimestamp(),
        }
      );

      // Create RENDERED_AS relationship
      await this.neo4jClient.run(
        `MATCH (t:ThreeDFile {uuid: $threeDUuid})
         MATCH (i:ImageFile {uuid: $imageUuid})
         MERGE (t)-[r:RENDERED_AS {viewAngle: $viewAngle}]->(i)`,
        {
          threeDUuid: threeDFileUuid,
          imageUuid,
          viewAngle: render.view,
        }
      );
    }

    return { threeDFileUuid, imageUuids };
  }

  /**
   * Generate descriptions for rendered views using Gemini Vision
   */
  async describeRenderedViews(
    threeDFileUuid: string,
    projectId: string
  ): Promise<Array<{ imageUuid: string; view: string; description: string }>> {
    if (!this.geminiApiKey) {
      console.warn('[ThreeDService] No Gemini API key, skipping descriptions');
      return [];
    }

    // Get all rendered views for this model
    const result = await this.neo4jClient.run(
      `MATCH (t:ThreeDFile {uuid: $threeDUuid})-[r:RENDERED_AS]->(i:ImageFile)
       WHERE i.description IS NULL
       RETURN i.uuid AS uuid, i.file AS file, r.viewAngle AS viewAngle`,
      { threeDUuid: threeDFileUuid }
    );

    if (result.records.length === 0) {
      return [];
    }

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(this.geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const descriptions: Array<{ imageUuid: string; view: string; description: string }> = [];

    for (const record of result.records) {
      const imageUuid = record.get('uuid');
      const imagePath = record.get('file');
      const viewAngle = record.get('viewAngle');

      const absolutePath = path.join(this.projectRoot, imagePath);

      try {
        // Read image and convert to base64
        const imageBuffer = await fs.readFile(absolutePath);
        const base64Image = imageBuffer.toString('base64');

        // Generate description
        const prompt = `Describe this ${viewAngle} view of a 3D model. Focus on:
- The overall shape and form visible from this angle
- Notable features, details, or textures
- Materials and colors
- Any distinctive elements

Keep the description concise (2-3 sentences) but informative.`;

        const response = await model.generateContent([
          { text: prompt },
          {
            inlineData: {
              mimeType: 'image/png',
              data: base64Image,
            },
          },
        ]);

        const description = response.response.text();

        // Store description on ImageFile
        await this.neo4jClient.run(
          `MATCH (i:ImageFile {uuid: $uuid})
           SET i.description = $description, i.analyzed = true`,
          { uuid: imageUuid, description }
        );

        descriptions.push({ imageUuid, view: viewAngle, description });
      } catch (err: any) {
        console.warn(`[ThreeDService] Failed to describe ${viewAngle} view: ${err.message}`);
      }
    }

    return descriptions;
  }

  /**
   * Synthesize a global description for a 3D model from its rendered views
   */
  async synthesizeGlobalDescription(
    threeDFileUuid: string
  ): Promise<string | null> {
    if (!this.geminiApiKey) {
      console.warn('[ThreeDService] No Gemini API key, skipping synthesis');
      return null;
    }

    // Get all view descriptions
    const result = await this.neo4jClient.run(
      `MATCH (t:ThreeDFile {uuid: $threeDUuid})-[r:RENDERED_AS]->(i:ImageFile)
       WHERE i.description IS NOT NULL
       RETURN r.viewAngle AS viewAngle, i.description AS description
       ORDER BY r.viewAngle`,
      { threeDUuid: threeDFileUuid }
    );

    if (result.records.length === 0) {
      return null;
    }

    const viewDescriptions = result.records.map(r => ({
      view: r.get('viewAngle'),
      description: r.get('description'),
    }));

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(this.geminiApiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const prompt = `Based on these descriptions from different views of a 3D model, create a comprehensive description of the entire model.

View descriptions:
${viewDescriptions.map(v => `- ${v.view}: ${v.description}`).join('\n')}

Synthesize these into a single, cohesive description (3-5 sentences) that captures:
- The overall form and shape of the model
- Key features visible from multiple angles
- Materials, colors, and textures
- The style or purpose of the model (if apparent)

Do not simply list what each view shows - create an integrated description.`;

    try {
      const response = await model.generateContent(prompt);
      const globalDescription = response.response.text();

      // Store on ThreeDFile
      await this.neo4jClient.run(
        `MATCH (t:ThreeDFile {uuid: $uuid})
         SET t.description = $description, t.analyzed = true`,
        { uuid: threeDFileUuid, description: globalDescription }
      );

      return globalDescription;
    } catch (err: any) {
      console.warn(`[ThreeDService] Failed to synthesize description: ${err.message}`);
      return null;
    }
  }

  /**
   * Full workflow: render, describe, synthesize, embed
   */
  async analyzeModel(options: RenderAndAnalyzeOptions): Promise<RenderAndAnalyzeResult> {
    const {
      modelPath,
      projectId,
      views = ['front', 'right', 'back', 'perspective'],
      generateDescriptions = true,
      synthesizeDescription = true,
      generateEmbeddings = true,
    } = options;

    // Step 1: Render the model (assumes already done by render_3d_asset tool)
    // This method is called after rendering, so we just need to register the views

    // For now, this is a placeholder - in practice, the tool handler calls
    // registerRenderedViews directly after rendering

    const result: RenderAndAnalyzeResult = {
      threeDFileUuid: '',
      renderedViews: [],
      embeddingsGenerated: 0,
    };

    // If we have rendered views registered, continue with analysis
    const findResult = await this.neo4jClient.run(
      `MATCH (t:ThreeDFile {projectId: $projectId})
       WHERE t.file ENDS WITH $fileName
       RETURN t.uuid AS uuid`,
      { projectId, fileName: path.basename(modelPath) }
    );

    if (findResult.records.length === 0) {
      console.warn(`[ThreeDService] ThreeDFile not found for ${modelPath}`);
      return result;
    }

    result.threeDFileUuid = findResult.records[0].get('uuid');

    // Step 2: Generate descriptions for views
    if (generateDescriptions) {
      const descriptions = await this.describeRenderedViews(result.threeDFileUuid, projectId);
      result.renderedViews = descriptions.map(d => ({
        view: d.view,
        imagePath: '', // Not tracked here
        imageUuid: d.imageUuid,
        description: d.description,
      }));
    }

    // Step 3: Synthesize global description
    if (synthesizeDescription) {
      result.globalDescription = await this.synthesizeGlobalDescription(result.threeDFileUuid) || undefined;
    }

    // Step 4: Generate embeddings
    if (generateEmbeddings && this.embeddingService?.canGenerateEmbeddings()) {
      const embeddingResult = await this.embeddingService.generateMultiEmbeddings({
        projectId,
        incrementalOnly: true,
        verbose: false,
      });
      result.embeddingsGenerated = embeddingResult.totalEmbedded;
    }

    return result;
  }
}
