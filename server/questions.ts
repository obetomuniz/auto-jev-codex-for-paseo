import { z } from "zod";
import type { ProviderPermissionResponse } from "@getpaseo/plugin/server/provider";

export const MAX_QUESTIONS = 10;
const questionSchema = z.object({
  id: z.string().min(1).max(100),
  header: z.string().trim().max(120).optional(),
  question: z.string().min(1).max(8_000),
  options: z.array(z.object({ label: z.string().min(1).max(400), description: z.string().max(2_000).default("") })).max(32).default([]),
  multiSelect: z.boolean().default(false),
  isOther: z.boolean().optional(),
  isSecret: z.boolean().default(false),
});

export function parseQuestions(params: unknown) {
  const { questions } = z.object({ questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS) }).parse(params);
  if (new Set(questions.map((question) => question.id)).size !== questions.length) throw new Error("Question IDs must be unique.");
  // Paseo keys submitted answers by header. Make duplicate headings unambiguous.
  const used = new Set<string>();
  return questions.map((question) => {
    let header = question.header || question.id;
    while (used.has(header)) header += ` (${question.id})`;
    used.add(header);
    return { ...question, header, allowOther: true };
  });
}
export type Questions = ReturnType<typeof parseQuestions>;

export function questionAnswers(questions: Questions, response: ProviderPermissionResponse) {
  const submitted = response.behavior === "allow"
    ? z.record(z.string(), z.string().max(16_000)).parse(response.updatedInput?.answers)
    : {};
  return { answers: Object.fromEntries(questions.map((question) => {
    const text = (Object.hasOwn(submitted, question.header) ? submitted[question.header] : "").trim();
    return [question.id, { answers: text ? question.multiSelect ? text.split(",").map((value) => value.trim()).filter(Boolean) : [text] : [] }];
  })) };
}
