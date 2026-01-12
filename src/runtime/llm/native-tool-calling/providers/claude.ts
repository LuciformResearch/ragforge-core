/**
 * Claude Native Tool Calling Provider
 *
 * Uses Anthropic's Claude API for native tool calling.
 * Implements NativeToolCallingProvider interface.
 *
 * @since 2025-01-03
 */

import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { v4 as uuidv4 } from "uuid";
import type {
  NativeToolCallingProvider,
  ToolDefinition,
  ToolCall,
  ToolChoice,
  LLMToolResponse,
  Message,
  UsageMetadata,
} from "../types.js";

export interface ClaudeNativeToolConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export class ClaudeNativeToolProvider implements NativeToolCallingProvider {
  private client: Anthropic;
  private modelName: string;
  private defaultTemperature?: number;
  private defaultMaxTokens?: number;

  constructor(config: ClaudeNativeToolConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.modelName = config.model;
    this.defaultTemperature = config.temperature;
    this.defaultMaxTokens = config.maxOutputTokens ?? 4096;
  }

  getProviderName(): string {
    return "claude";
  }

  supportsNativeToolCalling(): boolean {
    return true;
  }

  async generateWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    options?: {
      toolChoice?: ToolChoice;
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<LLMToolResponse> {
    // Convert tools to Claude format
    const claudeTools = this.convertToolsToClaudeFormat(tools);

    // Convert messages to Claude format
    const { systemPrompt, claudeMessages } =
      this.convertMessagesToClaudeFormat(messages);

    // Convert tool choice to Claude format
    const toolChoice = this.convertToolChoice(options?.toolChoice);

    // Call Claude API
    const response = await this.client.messages.create({
      model: this.modelName,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens ?? 4096,
      temperature: options?.temperature ?? this.defaultTemperature,
      system: systemPrompt,
      messages: claudeMessages,
      tools: claudeTools,
      tool_choice: toolChoice,
    });

    return this.parseClaudeResponse(response);
  }

  async *streamWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    options?: {
      toolChoice?: ToolChoice;
      temperature?: number;
      maxTokens?: number;
    }
  ): AsyncGenerator<LLMToolResponse> {
    // Convert tools to Claude format
    const claudeTools = this.convertToolsToClaudeFormat(tools);

    // Convert messages to Claude format
    const { systemPrompt, claudeMessages } =
      this.convertMessagesToClaudeFormat(messages);

    // Convert tool choice to Claude format
    const toolChoice = this.convertToolChoice(options?.toolChoice);

    // Stream from Claude
    const stream = this.client.messages.stream({
      model: this.modelName,
      max_tokens: options?.maxTokens ?? this.defaultMaxTokens ?? 4096,
      temperature: options?.temperature ?? this.defaultTemperature,
      system: systemPrompt,
      messages: claudeMessages,
      tools: claudeTools,
      tool_choice: toolChoice,
    });

    let accumulatedText = "";
    let accumulatedToolCalls: ToolCall[] = [];
    let currentToolUse: { id: string; name: string; input: string } | null =
      null;

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          currentToolUse = {
            id: block.id,
            name: block.name,
            input: "",
          };
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta") {
          accumulatedText += delta.text;
        } else if (delta.type === "input_json_delta" && currentToolUse) {
          currentToolUse.input += delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (currentToolUse) {
          accumulatedToolCalls.push({
            id: currentToolUse.id,
            type: "function",
            function: {
              name: currentToolUse.name,
              arguments: currentToolUse.input || "{}",
            },
          });
          currentToolUse = null;
        }
      } else if (event.type === "message_delta") {
        // Final message with usage stats
        yield {
          content: accumulatedText,
          toolCalls:
            accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
          usage: event.usage
            ? {
                input_tokens: 0, // Not available in delta
                output_tokens: event.usage.output_tokens,
                total_tokens: event.usage.output_tokens,
              }
            : undefined,
          finishReason: event.delta.stop_reason ?? undefined,
        };
      }
    }

    // Final yield with accumulated content
    yield {
      content: accumulatedText,
      toolCalls:
        accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
    };
  }

  /**
   * Convert OpenAI-style tools to Claude format
   */
  private convertToolsToClaudeFormat(
    tools: ToolDefinition[]
  ): Anthropic.Tool[] {
    return tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  /**
   * Convert our Message format to Claude format
   */
  private convertMessagesToClaudeFormat(messages: Message[]): {
    systemPrompt: string;
    claudeMessages: MessageParam[];
  } {
    let systemPrompt = "";
    const claudeMessages: MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        // Claude uses system as a separate parameter
        systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
        continue;
      }

      if (msg.role === "user") {
        claudeMessages.push({
          role: "user",
          content: msg.content,
        });
        continue;
      }

      if (msg.role === "agent") {
        const content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        > = [];

        // Add text content
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }

        // Add tool use blocks
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            });
          }
        }

        claudeMessages.push({
          role: "assistant",
          content,
        });
        continue;
      }

      if (msg.role === "tool") {
        // Tool result message
        claudeMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId ?? "unknown",
              content: msg.content,
            },
          ],
        });
        continue;
      }
    }

    return { systemPrompt, claudeMessages };
  }

  /**
   * Convert tool choice to Claude format
   */
  private convertToolChoice(
    choice?: ToolChoice
  ): Anthropic.MessageCreateParams["tool_choice"] {
    if (!choice || choice === "auto") {
      return { type: "auto" };
    }
    if (choice === "any") {
      return { type: "any" };
    }
    if (choice === "none") {
      return undefined; // No tools
    }
    if (typeof choice === "object" && choice.type === "function") {
      return { type: "tool", name: choice.function.name };
    }
    return { type: "auto" };
  }

  /**
   * Parse Claude response to our LLMToolResponse format
   */
  private parseClaudeResponse(
    response: Anthropic.Message
  ): LLMToolResponse {
    let content = "";
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    const usage: UsageMetadata = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      total_tokens:
        response.usage.input_tokens + response.usage.output_tokens,
    };

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      finishReason: response.stop_reason ?? undefined,
    };
  }

  /**
   * Create from environment variables
   */
  static fromEnv(
    model: string = "claude-3-5-haiku-20241022"
  ): ClaudeNativeToolProvider {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable not set");
    }

    return new ClaudeNativeToolProvider({
      apiKey,
      model,
      temperature: 0.3,
      maxOutputTokens: 4096,
    });
  }
}
