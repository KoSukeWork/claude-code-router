import { ChatCompletion } from "openai/resources";
import {
  LLMProvider,
  UnifiedChatRequest,
  UnifiedMessage,
  UnifiedTool,
} from "@/types/llm";
import {
  Transformer,
  TransformerContext,
  TransformerOptions,
} from "@/types/transformer";
import { v4 as uuidv4 } from "uuid";
import { getThinkLevel } from "@/utils/thinking";
import { createApiError } from "@/api/middleware";
import { formatBase64 } from "@/utils/image";

export class AnthropicTransformer implements Transformer {
  name = "Anthropic";
  endPoint = "/v1/messages";
  private useBearer: boolean;
  logger?: any;

  constructor(private readonly options?: TransformerOptions) {
    this.useBearer = this.options?.UseBearer ?? false;
  }

  async auth(request: any, provider: LLMProvider): Promise<any> {
    const headers: Record<string, string | undefined> = {};

    if (this.useBearer) {
      headers["authorization"] = `Bearer ${provider.apiKey}`;
      headers["x-api-key"] = undefined;
    } else {
      headers["x-api-key"] = provider.apiKey;
      headers["authorization"] = undefined;
    }

    return {
      body: request,
      config: {
        headers,
      },
    };
  }

  async transformRequestOut(
    request: Record<string, any>
  ): Promise<UnifiedChatRequest> {
    const messages: UnifiedMessage[] = [];

    if (request.system) {
      if (typeof request.system === "string") {
        messages.push({
          role: "system",
          content: request.system,
        });
      } else if (Array.isArray(request.system) && request.system.length) {
        const textParts = request.system
          .filter((item: any) => item.type === "text" && item.text)
          .map((item: any) => ({
            type: "text" as const,
            text: item.text,
            cache_control: item.cache_control,
          }));
        messages.push({
          role: "system",
          content: textParts,
        });
      }
    }

    const requestMessages = JSON.parse(JSON.stringify(request.messages || []));

    requestMessages?.forEach((msg: any) => {
      if (msg.role === "user" || msg.role === "assistant") {
        if (typeof msg.content === "string") {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
          return;
        }

        if (Array.isArray(msg.content)) {
          if (msg.role === "user") {
            const toolParts = msg.content.filter(
              (c: any) => c.type === "tool_result" && c.tool_use_id
            );
            if (toolParts.length) {
              toolParts.forEach((tool: any) => {
                const toolMessage: UnifiedMessage = {
                  role: "tool",
                  content:
                    typeof tool.content === "string"
                      ? tool.content
                      : JSON.stringify(tool.content),
                  tool_call_id: tool.tool_use_id,
                  cache_control: tool.cache_control,
                };
                messages.push(toolMessage);
              });
            }

            const textAndMediaParts = msg.content.filter(
              (c: any) =>
                (c.type === "text" && c.text) ||
                (c.type === "image" && c.source)
            );
            if (textAndMediaParts.length) {
              messages.push({
                role: "user",
                content: textAndMediaParts.map((part: any) => {
                  if (part?.type === "image") {
                    return {
                      type: "image_url",
                      image_url: {
                        url:
                          part.source?.type === "base64"
                            ? formatBase64(
                                part.source.data,
                                part.source.media_type
                              )
                            : part.source.url,
                      },
                      media_type: part.source.media_type,
                    };
                  }
                  return part;
                }),
              });
            }
          } else if (msg.role === "assistant") {
            const assistantMessage: UnifiedMessage = {
              role: "assistant",
              content: "",
            };
            const textParts = msg.content.filter(
              (c: any) => c.type === "text" && c.text
            );
            if (textParts.length) {
              assistantMessage.content = textParts
                .map((text: any) => text.text)
                .join("\n");
            }

            const toolCallParts = msg.content.filter(
              (c: any) => c.type === "tool_use" && c.id
            );
            if (toolCallParts.length) {
              assistantMessage.tool_calls = toolCallParts.map((tool: any) => {
                return {
                  id: tool.id,
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    arguments: JSON.stringify(tool.input || {}),
                  },
                };
              });
            }

            const thinkingPart = msg.content.find(
              (c: any) => c.type === "thinking" && c.signature
            );
            if (thinkingPart) {
              assistantMessage.thinking = {
                content: thinkingPart.thinking,
                signature: thinkingPart.signature,
              };
            }

            messages.push(assistantMessage);
          }
          return;
        }
      }
    });

    const result: UnifiedChatRequest = {
      messages,
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream: request.stream,
      tools: request.tools?.length
        ? this.convertAnthropicToolsToUnified(request.tools)
        : undefined,
      tool_choice: request.tool_choice,
    };
    if (request.thinking) {
      result.reasoning = {
        effort: getThinkLevel(request.thinking.budget_tokens),
        // max_tokens: request.thinking.budget_tokens,
        enabled: request.thinking.type === "enabled",
      };
    }
    if (request.tool_choice) {
      if (request.tool_choice.type === "tool") {
        result.tool_choice = {
          type: "function",
          function: { name: request.tool_choice.name },
        };
      } else {
        result.tool_choice = request.tool_choice.type;
      }
    }
    return result;
  }

  async transformResponseIn(
    response: Response,
    context?: TransformerContext
  ): Promise<Response> {
    const isStream = response.headers
      .get("Content-Type")
      ?.includes("text/event-stream");
    if (isStream) {
      if (!response.body) {
        throw new Error("Stream response body is null");
      }
      const convertedStream = await this.convertOpenAIStreamToAnthropic(
        response.body,
        context!
      );
      return new Response(convertedStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } else {
      const data = (await response.json()) as any;
      const anthropicResponse = this.convertOpenAIResponseToAnthropic(
        data,
        context!
      );
      return new Response(JSON.stringify(anthropicResponse), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private convertAnthropicToolsToUnified(tools: any[]): UnifiedTool[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema,
      },
    }));
  }

  private async convertOpenAIStreamToAnthropic(
    openaiStream: ReadableStream,
    context: TransformerContext
  ): Promise<ReadableStream> {
    const readable = new ReadableStream({
      start: async (controller) => {
        const encoder = new TextEncoder();
        const messageId = `msg_${Date.now()}`;
        let stopReasonMessageDelta: null | Record<string, any> = null;
        let model = "unknown";
        let hasStarted = false;
        let hasFinished = false;
        const toolCalls = new Map<
          number,
          {
            id: string;
            name: string;
            arguments: string;
          }
        >();
        let totalChunks = 0;
        let contentChunks = 0;
        let toolCallChunks = 0;
        let isClosed = false;
        let contentIndex = 0;
        let currentContentBlock:
          | {
              index: number;
              type: "text" | "thinking";
            }
          | undefined;

        const assignContentBlockIndex = (): number => {
          const currentIndex = contentIndex;
          contentIndex++;
          return currentIndex;
        };

        const enqueueEvent = (event: string, data: Record<string, any>) => {
          safeEnqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        };

        const closeCurrentContentBlock = () => {
          if (!currentContentBlock) {
            return;
          }

          enqueueEvent("content_block_stop", {
            type: "content_block_stop",
            index: currentContentBlock.index,
          });
          currentContentBlock = undefined;
        };

        const ensureContentBlock = (
          type: "text" | "thinking",
          contentBlock: Record<string, any>
        ) => {
          if (currentContentBlock?.type === type) {
            return currentContentBlock.index;
          }

          closeCurrentContentBlock();

          const index = assignContentBlockIndex();
          enqueueEvent("content_block_start", {
            type: "content_block_start",
            index,
            content_block: contentBlock,
          });
          currentContentBlock = { index, type };
          return index;
        };

        const flushPendingToolCalls = () => {
          if (!toolCalls.size) {
            return;
          }

          closeCurrentContentBlock();

          Array.from(toolCalls.entries())
            .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
            .forEach(([, toolCall]) => {
              const toolBlockIndex = assignContentBlockIndex();

              enqueueEvent("content_block_start", {
                type: "content_block_start",
                index: toolBlockIndex,
                content_block: {
                  type: "tool_use",
                  id: toolCall.id,
                  name: toolCall.name,
                  input: {},
                },
              });

              if (toolCall.arguments) {
                enqueueEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: toolBlockIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: toolCall.arguments,
                  },
                });
              }

              enqueueEvent("content_block_stop", {
                type: "content_block_stop",
                index: toolBlockIndex,
              });
            });

          toolCalls.clear();
        };

        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) {
            try {
              controller.enqueue(data);
              const dataStr = new TextDecoder().decode(data);
              this.logger.debug({
                reqId: context.req.id,
                data: dataStr,
                type: "send data",
              });
            } catch (error) {
              if (
                error instanceof TypeError &&
                error.message.includes("Controller is already closed")
              ) {
                isClosed = true;
              } else {
                this.logger.debug({
                  reqId: context.req.id,
                  error: error instanceof Error ? error.message : String(error),
                  type: "send data error",
                });
                throw error;
              }
            }
          }
        };

        const safeClose = () => {
          if (!isClosed) {
            try {
              const hasPendingToolCalls = toolCalls.size > 0;
              flushPendingToolCalls();
              closeCurrentContentBlock();

              if (stopReasonMessageDelta) {
                enqueueEvent("message_delta", stopReasonMessageDelta);
                stopReasonMessageDelta = null;
              } else {
                enqueueEvent("message_delta", {
                  type: "message_delta",
                  delta: {
                    stop_reason: hasPendingToolCalls ? "tool_use" : "end_turn",
                    stop_sequence: null,
                  },
                  usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_input_tokens: 0,
                  },
                });
              }
              enqueueEvent("message_stop", {
                type: "message_stop",
              });
              controller.close();
              isClosed = true;
            } catch (error) {
              if (
                error instanceof TypeError &&
                error.message.includes("Controller is already closed")
              ) {
                isClosed = true;
              } else {
                throw error;
              }
            }
          }
        };

        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

        try {
          reader = openaiStream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            if (isClosed) {
              break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (isClosed || hasFinished) break;

              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              this.logger.debug({
                reqId: context.req.id,
                type: "recieved data",
                data,
              });

              if (data === "[DONE]") {
                continue;
              }

              try {
                const chunk = JSON.parse(data);
                totalChunks++;
                this.logger.debug({
                  reqId: context.req.id,
                  response: chunk,
                  tppe: "Original Response",
                });
                if (chunk.error) {
                  const errorMessage = {
                    type: "error",
                    message: {
                      type: "api_error",
                      message: JSON.stringify(chunk.error),
                    },
                  };

                  safeEnqueue(
                    encoder.encode(
                      `event: error\ndata: ${JSON.stringify(errorMessage)}\n\n`
                    )
                  );
                  continue;
                }

                model = chunk.model || model;

                if (!hasStarted && !isClosed && !hasFinished) {
                  hasStarted = true;

                  const messageStart = {
                    type: "message_start",
                    message: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      content: [],
                      model: model,
                      stop_reason: null,
                      stop_sequence: null,
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                      },
                    },
                  };

                  safeEnqueue(
                    encoder.encode(
                      `event: message_start\ndata: ${JSON.stringify(
                        messageStart
                      )}\n\n`
                    )
                  );
                }

                const choice = chunk.choices?.[0];
                if (chunk.usage) {
                  if (!stopReasonMessageDelta) {
                    stopReasonMessageDelta = {
                      type: "message_delta",
                      delta: {
                        stop_reason: "end_turn",
                        stop_sequence: null,
                      },
                      usage: {
                        input_tokens:
                          (chunk.usage?.prompt_tokens || 0) -
                          (chunk.usage?.prompt_tokens_details?.cached_tokens ||
                            0),
                        output_tokens: chunk.usage?.completion_tokens || 0,
                        cache_read_input_tokens:
                          chunk.usage?.prompt_tokens_details?.cached_tokens ||
                          0,
                      },
                    };
                  } else {
                    stopReasonMessageDelta.usage = {
                      input_tokens:
                        (chunk.usage?.prompt_tokens || 0) -
                        (chunk.usage?.prompt_tokens_details?.cached_tokens ||
                          0),
                      output_tokens: chunk.usage?.completion_tokens || 0,
                      cache_read_input_tokens:
                        chunk.usage?.prompt_tokens_details?.cached_tokens || 0,
                    };
                  }
                }
                if (!choice) {
                  continue;
                }

                if (choice?.delta?.thinking && !isClosed && !hasFinished) {
                  const thinkingBlockIndex = ensureContentBlock("thinking", {
                    type: "thinking",
                    thinking: "",
                  });
                  if (choice.delta.thinking.signature) {
                    enqueueEvent("content_block_delta", {
                      type: "content_block_delta",
                      index: thinkingBlockIndex,
                      delta: {
                        type: "signature_delta",
                        signature: choice.delta.thinking.signature,
                      },
                    });
                    closeCurrentContentBlock();
                  } else if (choice.delta.thinking.content) {
                    enqueueEvent("content_block_delta", {
                      type: "content_block_delta",
                      index: thinkingBlockIndex,
                      delta: {
                        type: "thinking_delta",
                        thinking: choice.delta.thinking.content || "",
                      },
                    });
                  }
                }

                if (choice?.delta?.content && !isClosed && !hasFinished) {
                  contentChunks++;

                  const textBlockIndex = ensureContentBlock("text", {
                    type: "text",
                    text: "",
                  });

                  if (!isClosed && !hasFinished) {
                    enqueueEvent("content_block_delta", {
                      type: "content_block_delta",
                      index: textBlockIndex,
                      delta: {
                        type: "text_delta",
                        text: choice.delta.content,
                      },
                    });
                  }
                }

                if (
                  choice?.delta?.annotations?.length &&
                  !isClosed &&
                  !hasFinished
                ) {
                  closeCurrentContentBlock();

                  choice?.delta?.annotations.forEach((annotation: any) => {
                    const annotationBlockIndex = assignContentBlockIndex();
                    enqueueEvent("content_block_start", {
                      type: "content_block_start",
                      index: annotationBlockIndex,
                      content_block: {
                        type: "web_search_tool_result",
                        tool_use_id: `srvtoolu_${uuidv4()}`,
                        content: [
                          {
                            type: "web_search_result",
                            title: annotation.url_citation.title,
                            url: annotation.url_citation.url,
                          },
                        ],
                      },
                    });

                    enqueueEvent("content_block_stop", {
                      type: "content_block_stop",
                      index: annotationBlockIndex,
                    });
                  });
                }

                if (choice?.delta?.tool_calls && !isClosed && !hasFinished) {
                  toolCallChunks++;

                  for (const toolCall of choice.delta.tool_calls) {
                    if (isClosed) break;
                    const toolCallIndex = toolCall.index ?? 0;
                    const currentToolCall = toolCalls.get(toolCallIndex) || {
                      id: toolCall.id || `call_${Date.now()}_${toolCallIndex}`,
                      name: toolCall.function?.name || `tool_${toolCallIndex}`,
                      arguments: "",
                    };

                    if (toolCall.id) {
                      currentToolCall.id = toolCall.id;
                    }
                    if (toolCall.function?.name) {
                      currentToolCall.name = toolCall.function.name;
                    }

                    if (
                      toolCall.function?.arguments &&
                      !isClosed &&
                      !hasFinished
                    ) {
                      currentToolCall.arguments += toolCall.function.arguments;
                    }

                    toolCalls.set(toolCallIndex, currentToolCall);
                  }
                }

                if (choice?.finish_reason && !isClosed && !hasFinished) {
                  if (contentChunks === 0 && toolCallChunks === 0) {
                    console.error(
                      "Warning: No content in the stream response!"
                    );
                  }

                  const hasPendingToolCalls = toolCalls.size > 0;
                  flushPendingToolCalls();
                  closeCurrentContentBlock();

                  if (!isClosed) {
                    const stopReasonMapping: Record<string, string> = {
                      stop: "end_turn",
                      length: "max_tokens",
                      tool_calls: "tool_use",
                      content_filter: "stop_sequence",
                    };

                    const anthropicStopReason =
                      hasPendingToolCalls
                        ? "tool_use"
                        : stopReasonMapping[choice.finish_reason] || "end_turn";

                    stopReasonMessageDelta = {
                      type: "message_delta",
                      delta: {
                        stop_reason: anthropicStopReason,
                        stop_sequence: null,
                      },
                      usage: {
                        input_tokens:
                          (chunk.usage?.prompt_tokens || 0) -
                          (chunk.usage?.prompt_tokens_details?.cached_tokens ||
                            0),
                        output_tokens: chunk.usage?.completion_tokens || 0,
                        cache_read_input_tokens:
                          chunk.usage?.prompt_tokens_details?.cached_tokens ||
                          0,
                      },
                    };
                  }

                  hasFinished = true;
                  break;
                }
              } catch (parseError: any) {
                this.logger?.error(
                  `parseError: ${parseError.name} message: ${parseError.message} stack: ${parseError.stack} data: ${data}`
                );
              }
            }
          }
          safeClose();
        } catch (error) {
          if (!isClosed) {
            try {
              controller.error(error);
            } catch (controllerError) {
              console.error(controllerError);
            }
          }
        } finally {
          if (reader) {
            try {
              reader.releaseLock();
            } catch (releaseError) {
              console.error(releaseError);
            }
          }
        }
      },
      cancel: (reason) => {
        this.logger.debug(
          {
            reqId: context.req.id,
          },
          `cancle stream: ${reason}`
        );
      },
    });

    return readable;
  }

  private convertOpenAIResponseToAnthropic(
    openaiResponse: ChatCompletion,
    context: TransformerContext
  ): any {
    this.logger.debug(
      {
        reqId: context.req.id,
        response: openaiResponse,
      },
      `Original OpenAI response`
    );
    try {
      const choice = openaiResponse.choices[0];
      if (!choice) {
        throw new Error("No choices found in OpenAI response");
      }
      const content: any[] = [];
      if (choice.message.annotations) {
        const id = `srvtoolu_${uuidv4()}`;
        content.push({
          type: "server_tool_use",
          id,
          name: "web_search",
          input: {
            query: "",
          },
        });
        content.push({
          type: "web_search_tool_result",
          tool_use_id: id,
          content: choice.message.annotations.map((item) => {
            return {
              type: "web_search_result",
              url: item.url_citation.url,
              title: item.url_citation.title,
            };
          }),
        });
      }
      if (choice.message.content) {
        content.push({
          type: "text",
          text: choice.message.content,
        });
      }
      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        choice.message.tool_calls.forEach((toolCall) => {
          let parsedInput = {};
          try {
            const argumentsStr = toolCall.function.arguments || "{}";

            if (typeof argumentsStr === "object") {
              parsedInput = argumentsStr;
            } else if (typeof argumentsStr === "string") {
              parsedInput = JSON.parse(argumentsStr);
            }
          } catch {
            parsedInput = { text: toolCall.function.arguments || "" };
          }

          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: parsedInput,
          });
        });
      }
      if ((choice.message as any)?.thinking?.content) {
        content.push({
          type: "thinking",
          thinking: (choice.message as any).thinking.content,
          signature: (choice.message as any).thinking.signature,
        });
      }
      const result = {
        id: openaiResponse.id,
        type: "message",
        role: "assistant",
        model: openaiResponse.model,
        content: content,
        stop_reason:
          choice.finish_reason === "stop"
            ? "end_turn"
            : choice.finish_reason === "length"
            ? "max_tokens"
            : choice.finish_reason === "tool_calls"
            ? "tool_use"
            : choice.finish_reason === "content_filter"
            ? "stop_sequence"
            : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens:
            (openaiResponse.usage?.prompt_tokens || 0) -
            (openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0),
          output_tokens: openaiResponse.usage?.completion_tokens || 0,
          cache_read_input_tokens:
            openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0,
        },
      };
      this.logger.debug(
        {
          reqId: context.req.id,
          result,
        },
        `Conversion complete, final Anthropic response`
      );
      return result;
    } catch {
      throw createApiError(
        `Provider error: ${JSON.stringify(openaiResponse)}`,
        500,
        "provider_error"
      );
    }
  }
}
