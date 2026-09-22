import { readContext, type ContextEntry } from "./route-context";
import { ROUTE_QUESTIONS, parseRouteAnswers, type RouteAnswers } from "./classifier";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export async function evaluateRoute(input: {
  apiKey: string;
  model: string;
  prompt: string;
  context?: ContextEntry[];
}): Promise<RouteAnswers> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        state: {
          request: input.prompt,
          ...(input.context?.length ? { recentConversation: readContext(input.context).map(({ role, text }) => ({ role, text })) } : {}),
        },
        questions: ROUTE_QUESTIONS,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("TypeSafe timed out after 20s.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`TypeSafe returned non-JSON (${response.status}).`);
  }

  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : text.slice(0, 200);
    if (response.status === 401) {
      throw new Error("TypeSafe API key rejected. Set it in plugin settings or TYPESAFE_API_KEY.");
    }
    throw new Error(`TypeSafe ${response.status}: ${detail || "request failed"}`);
  }

  return parseRouteAnswers(body);
}
