import { z } from "zod";

export type Audience = "internal" | "stakeholder";
export const AUDIENCES: Audience[] = ["internal", "stakeholder"];

export type TaskName = "analyze" | "summarize";

/**
 * What the pipeline hands to a provider. A real LLM provider uses `system` + `user`;
 * the mock provider ignores the prompt text and computes its answer from `input`.
 */
export interface LlmRequest {
  task: TaskName;
  system: string;
  user: string;
  input: unknown;
}

export interface LlmProvider {
  name: string;
  /** Must resolve to parsed JSON. The pipeline validates the shape; a provider is never trusted. */
  completeJson(req: LlmRequest): Promise<unknown>;
}

export const impactClasses = ["breaking", "user_visible", "internal"] as const;
export const statementSections = ["change", "risk", "limitation", "migration"] as const;
export type StatementSection = (typeof statementSections)[number];

export const analysisOutputSchema = z.object({
  classifications: z.array(z.object({ itemId: z.string(), impact: z.enum(impactClasses), rationale: z.string().min(1) })),
  gaps: z.array(z.object({ message: z.string().min(1), relatedItemIds: z.array(z.string()).default([]) })),
  unsupportedClaims: z.array(z.object({ itemId: z.string(), reason: z.string().min(1), evidenceIds: z.array(z.string()).default([]) })),
});
export type AnalysisOutput = z.infer<typeof analysisOutputSchema>;

export const statementsOutputSchema = z.object({
  statements: z
    .array(
      z.object({
        section: z.enum(statementSections),
        text: z.string().trim().min(1),
        citations: z.array(z.string()).min(1, "every statement must cite at least one item"),
      }),
    )
    .min(1),
});
export type StatementsOutput = z.infer<typeof statementsOutputSchema>;
