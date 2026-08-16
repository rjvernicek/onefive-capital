import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env.js";
import { buildSystem } from "./prompt.js";
import type { Turn } from "./conversation.js";
import { toolDefinitions, runTool } from "./tools.js";

const MODEL = "claude-opus-5";

/**
 * Caps thinking and reply text together, and thinking is on by default on this
 * model. Sized well above what an SMS-length answer needs so a question that
 * pulls several tool results can't spend the whole budget reasoning and leave
 * no text behind. Reply length is bounded by the prompt, not by this.
 */
const MAX_TOKENS = 12000;

/**
 * Ceiling on tool round-trips per message. A lookup is 2-3 calls; a message
 * that logs several notes might reach 6. Past this the turn returns whatever
 * text exists rather than looping forever on a confused tool chain.
 */
const MAX_TOOL_ROUNDS = 8;

export interface Reply {
  text: string;
  /** True when safety classifiers declined rather than the model answering. */
  refused: boolean;
}

/**
 * One conversational turn against the contact database. Unlike healthspan-sms,
 * the tools here are client-side — the database is a D1 binding in this same
 * Worker — so this module runs the tool loop itself: send, execute any
 * tool_use blocks against D1, append results, repeat until the model stops.
 */
export async function ask(
  env: Env,
  history: Turn[],
  message: string,
): Promise<Reply> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const messages: Anthropic.MessageParam[] = [
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: "user" as const, content: message },
  ];

  let response!: Anthropic.Message;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystem(env.TIMEZONE),
      output_config: { effort: "medium" },
      tools: toolDefinitions,
      messages,
    });

    if (response.stop_reason !== "tool_use") break;

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      try {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: await runTool(
            env,
            block.name,
            (block.input ?? {}) as Record<string, unknown>,
          ),
        });
      } catch (error) {
        // Surface the failure to the model rather than aborting the turn —
        // a bad id or malformed input is usually recoverable in-loop.
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: error instanceof Error ? error.message : String(error),
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  if (response.stop_reason === "refusal") {
    return {
      text: "I can't answer that one. If it's contact info you're after, try asking a different way.",
      refused: true,
    };
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    // Reached only if the turn ended with no text — e.g. the tool-round
    // ceiling hit mid-chain, or max_tokens consumed by thinking and calls.
    return {
      text: "I looked but couldn't put together an answer. Try asking a narrower question.",
      refused: false,
    };
  }

  return { text, refused: false };
}
