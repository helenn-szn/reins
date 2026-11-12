import OpenAI from "openai";

// SERV Reasoning: OpenServ's reasoning layer, reached through the normal OpenAI SDK.
// Docs: https://docs.openserv.ai/serv-reasoning/api
// Without SERV_API_KEY the app runs in "mock" mode with simple stand-in answers,
// so screens can be built without spending credits.

const BASE_URL = process.env.SERV_BASE_URL || "https://inference-api.openserv.ai/v1";
const MODEL = process.env.SERV_MODEL || "gpt-6-luna";

export const servConfigured = () => Boolean(process.env.SERV_API_KEY);
export const servModel = () => MODEL;

let client: OpenAI | null = null;
function getClient() {
  if (!client) client = new OpenAI({ apiKey: process.env.SERV_API_KEY, baseURL: BASE_URL });
  return client;
}

// Ask SERV for a JSON answer. Every SERV request needs a system prompt.
// Reasoning models spend part of the budget thinking, so the limit is generous.
export async function servJson<T>(system: string, user: string, maxTokens = 4000): Promise<T> {
  const res = await getClient().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: `${system}\nReply with JSON only, no other text.` },
      { role: "user", content: user },
    ],
    max_completion_tokens: maxTokens,
  });
  const text = res.choices[0]?.message?.content ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json) as T;
}
