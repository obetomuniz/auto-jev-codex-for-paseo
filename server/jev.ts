import { readContext, type ContextEntry } from "./route-context";
import { ROUTE_QUESTIONS, parseRouteAnswers, type RouteAnswers } from "./classifier";
import { personaQuestions } from "./persona-classification";
import type { Persona, ProviderSettings } from "../shared/settings";
import { workspaceStateSchema, type WorkspaceState } from "./workspace-state";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

export function typeSafeKey(settings: Pick<ProviderSettings, "apiKey">): string {
  const apiKey = settings.apiKey.trim() || process.env.TYPESAFE_API_KEY?.trim() || "";
  if (!apiKey) throw new Error("Configure the TypeSafe key for Jev in Settings > Plugins > Auto Mode for Paseo, or set TYPESAFE_API_KEY on the daemon.");
  return apiKey;
}

export async function evaluateRoute(input: {
  apiKey: string;
  model: string;
  prompt: string;
  context?: ContextEntry[];
  personas?: readonly Persona[];
  workspace?: WorkspaceState;
}): Promise<RouteAnswers> {
  const roster = personaQuestions(input.personas);
  const body = await askTypeSafe({
    apiKey: input.apiKey,
    model: input.model,
    state: {
      request: input.prompt,
      ...(input.workspace ? { workspace: workspaceStateSchema.parse(input.workspace) } : {}),
      ...(input.context?.length ? { recentConversation: readContext(input.context).map(({ role, text }) => ({ role, text })) } : {}),
    },
    questions: { ...ROUTE_QUESTIONS, ...roster.questions },
  });
  return parseRouteAnswers(body, roster.ids);
}

/** One TypeSafe systemone call. Callers own the state and questions they send. */
export async function askTypeSafe(input: { apiKey: string; model: string; state: Record<string, unknown>; questions: Record<string, unknown> }): Promise<unknown> {
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
      body: JSON.stringify({ model: input.model, state: input.state, questions: input.questions }),
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

  return body;
}
