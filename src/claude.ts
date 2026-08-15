import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env.js";
import { buildSystem } from "./prompt.js";
import type { Turn } from "./conversation.js";

const MODEL = "claude-opus-5";

/**
 * Caps thinking and reply text together, and thinking is on by default on this
 * model. Sized well above what an SMS-length answer needs so a question that
 * pulls a lot of tool results can't spend the whole budget reasoning and leave
 * no text behind. Reply length is bounded by the prompt, not by this.
 */
const MAX_TOKENS = 12000;

/** A server-side tool loop can pause; each resume costs one iteration. */
const MAX_CONTINUATIONS = 4;

export interface Reply {
  text: string;
  /** True when safety classifiers declined rather than the model answering. */
  refused: boolean;
}

export async function ask(
  env: Env,
  history: Turn[],
  message: string,
): Promise<Reply> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // The MCP connector makes the Healthspan connection server-side, so Claude
  // gets every tool the server exposes without this worker wrapping any of
  // them — and tool execution needs no client-side loop.
  const mcpServer: Anthropic.Beta.BetaRequestMCPServerURLDefinition = {
    type: "url",
    url: env.HEALTHSPAN_MCP_URL,
    name: "healthspan",
    ...(env.HEALTHSPAN_MCP_TOKEN
      ? { authorization_token: env.HEALTHSPAN_MCP_TOKEN }
      : {}),
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user" as const, content: message },
  ];

  const send = () =>
    client.beta.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: ["mcp-client-2025-11-20"],
      system: buildSystem(env.TIMEZONE),
      output_config: { effort: "medium" },
      mcp_servers: [mcpServer],
      tools: [{ type: "mcp_toolset", mcp_server_name: "healthspan" }],
      messages,
    });

  let response = await send();

  // A long server-side tool run can stop with pause_turn. Re-send with the
  // paused assistant turn appended and the server picks up where it left off.
  for (let i = 0; i < MAX_CONTINUATIONS && response.stop_reason === "pause_turn"; i++) {
    messages.push({ role: "assistant", content: response.content });
    response = await send();
  }

  if (response.stop_reason === "refusal") {
    return {
      text: "I can't answer that one. If it's health data you're after, try asking a different way.",
      refused: true,
    };
  }

  const text = response.content
    .filter(
      (block): block is Anthropic.Beta.BetaTextBlock => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    // Reached only if the turn ended with no text — e.g. max_tokens consumed
    // entirely by thinking and tool calls.
    return {
      text: "I looked but couldn't put together an answer. Try asking a narrower question.",
      refused: false,
    };
  }

  return { text, refused: false };
}
