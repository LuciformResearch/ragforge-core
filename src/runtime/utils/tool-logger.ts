/**
 * Tool Logger
 *
 * Centralized logging for all tool calls (MCP and Agent).
 * Logs tool arguments and results to files for traceability.
 *
 * @since 2025-12-16
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getFilenameTimestamp } from './timestamp.js';

// Outils qui ont leur propre logging personnalisé
const CUSTOM_LOGGER_TOOLS = new Set([
  'brain_search', // Log déjà ses résultats dans ~/.ragforge/logs/search/
]);

export interface ToolCallMetadata {
  duration: number;
  success: boolean;
  error?: string;
  source?: 'mcp' | 'agent' | 'internal';
}

export class ToolLogger {
  private static _loggingEnabled: boolean = false;
  private static _logDir: string = '';
  private static _initialized: boolean = false;

  /**
   * Initialize the logger (called at startup if RAGFORGE_LOG_TOOL_CALLS=true)
   * Also checks ~/.ragforge/.env if not set in process.env
   */
  static initialize(logDir?: string): void {
    // First check process.env
    let enabled = process.env.RAGFORGE_LOG_TOOL_CALLS === 'true';

    // If not in process.env, check ~/.ragforge/.env
    if (!enabled) {
      const ragforgeEnvPath = path.join(os.homedir(), '.ragforge', '.env');
      if (fsSync.existsSync(ragforgeEnvPath)) {
        try {
          const envContent = fsSync.readFileSync(ragforgeEnvPath, 'utf-8');
          const match = envContent.match(/^RAGFORGE_LOG_TOOL_CALLS\s*=\s*["']?true["']?\s*$/m);
          if (match) {
            enabled = true;
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    this._loggingEnabled = enabled;
    this._logDir = logDir || path.join(os.homedir(), '.ragforge', 'logs');
    this._initialized = true;

    if (this._loggingEnabled) {
      console.log(`[ToolLogger] Tool call logging enabled → ${this._logDir}/tools/`);
    }
  }

  /**
   * Check if logging is enabled
   */
  static isEnabled(): boolean {
    return this._loggingEnabled;
  }

  /**
   * Register a tool with custom logging (will be skipped by ToolLogger)
   */
  static registerCustomLogger(toolName: string): void {
    CUSTOM_LOGGER_TOOLS.add(toolName);
  }

  /**
   * Check if a tool has custom logging
   */
  static hasCustomLogger(toolName: string): boolean {
    return CUSTOM_LOGGER_TOOLS.has(toolName);
  }

  /**
   * Log a tool call
   */
  static async logToolCall(
    toolName: string,
    args: Record<string, any>,
    result: any,
    metadata: ToolCallMetadata
  ): Promise<void> {
    // Initialize if not done yet
    if (!this._initialized) {
      this.initialize();
    }

    // Skip if logging disabled
    if (!this._loggingEnabled) return;

    // Skip tools with custom logging
    if (CUSTOM_LOGGER_TOOLS.has(toolName)) return;

    try {
      const timestamp = getFilenameTimestamp();
      const callDir = path.join(this._logDir, 'tools', toolName, timestamp);

      await fs.mkdir(callDir, { recursive: true });

      // Sanitize args (hide sensitive data)
      const sanitizedArgs = this.sanitizeData(args);

      // Save arguments
      await fs.writeFile(
        path.join(callDir, 'args.json'),
        JSON.stringify(sanitizedArgs, null, 2)
      );

      // Save result (truncate if too large)
      const truncatedResult = this.truncateResult(result);
      await fs.writeFile(
        path.join(callDir, 'result.json'),
        JSON.stringify(truncatedResult, null, 2)
      );

      // Save metadata
      await fs.writeFile(
        path.join(callDir, 'metadata.json'),
        JSON.stringify(
          {
            toolName,
            timestamp: new Date().toISOString(),
            ...metadata,
          },
          null,
          2
        )
      );
    } catch (error) {
      // Don't fail the tool call if logging fails
      console.error(`[ToolLogger] Failed to log tool call: ${error}`);
    }
  }

  /**
   * Sanitize sensitive data from args/results
   */
  private static sanitizeData(
    data: any,
    maxDepth: number = 5,
    maxStringLength: number = 5000
  ): any {
    if (maxDepth <= 0) {
      return '[Max depth reached]';
    }

    if (data === null || data === undefined) {
      return data;
    }

    if (typeof data === 'string') {
      // Check for sensitive patterns
      if (/(password|api[_-]?key|token|secret|auth|credential)/i.test(data)) {
        return '[REDACTED]';
      }
      // Truncate long strings
      if (data.length > maxStringLength) {
        return data.substring(0, maxStringLength) + `... [truncated ${data.length - maxStringLength} chars]`;
      }
      return data;
    }

    if (typeof data === 'number' || typeof data === 'boolean') {
      return data;
    }

    if (Array.isArray(data)) {
      // Truncate long arrays
      if (data.length > 100) {
        return [
          ...data.slice(0, 100).map((item) => this.sanitizeData(item, maxDepth - 1, maxStringLength)),
          `[... ${data.length - 100} more items]`,
        ];
      }
      return data.map((item) => this.sanitizeData(item, maxDepth - 1, maxStringLength));
    }

    if (typeof data === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(data)) {
        // Hide sensitive keys
        if (/(password|api[_-]?key|token|secret|auth|credential|private)/i.test(key)) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = this.sanitizeData(value, maxDepth - 1, maxStringLength);
        }
      }
      return sanitized;
    }

    return String(data);
  }

  /**
   * Truncate large results to avoid huge log files
   */
  private static truncateResult(result: any): any {
    if (!result) return result;

    const json = JSON.stringify(result);
    const MAX_SIZE = 100000; // 100KB max per result

    if (json.length > MAX_SIZE) {
      return {
        _truncated: true,
        _originalSize: json.length,
        _preview: json.substring(0, 1000) + '...',
      };
    }

    return this.sanitizeData(result);
  }
}

/**
 * Wrapper function that adds logging to a tool handler
 */
export function withToolLogging(
  toolName: string,
  handler: (args: any) => Promise<any>,
  source: 'mcp' | 'agent' | 'internal' = 'mcp'
): (args: any) => Promise<any> {
  // If tool has custom logging, don't wrap it
  if (ToolLogger.hasCustomLogger(toolName)) {
    return handler;
  }

  return async (args: any) => {
    const startTime = Date.now();

    try {
      const result = await handler(args);

      await ToolLogger.logToolCall(toolName, args, result, {
        duration: Date.now() - startTime,
        success: true,
        source,
      });

      return result;
    } catch (error: any) {
      await ToolLogger.logToolCall(toolName, args, { error: error.message }, {
        duration: Date.now() - startTime,
        success: false,
        error: error.message,
        source,
      });

      throw error;
    }
  };
}
