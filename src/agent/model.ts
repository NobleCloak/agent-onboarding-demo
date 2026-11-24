import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

/** Replays a fixed script, one AI message per turn. The agent is fake; the governance around it is not. */
export class ScriptedModel extends BaseChatModel {
  constructor(private readonly script: AIMessage[]) {
    super({});
  }
  _llmType() {
    return "scripted";
  }
  override bindTools(): this {
    return this;
  }
  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const turn = messages.filter((m) => AIMessage.isInstance(m)).length;
    const message = this.script[turn] ?? new AIMessage("Done.");
    const text = typeof message.content === "string" ? message.content : "";
    return Promise.resolve({ generations: [{ text, message }] });
  }
}
