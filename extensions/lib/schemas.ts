/**
 * Hand-written typebox schemas for the four Live Delivery tools.
 *
 * These are the model's contract; callTool's zod schema remains the
 * authoritative runtime gate inside the vendored engine. Strictness mirrors
 * the zod schemas (additionalProperties: false), except where the engine's
 * zod deliberately trims (reason/activity) — the engine rejects those.
 */
import { Type } from "typebox";

const MILESTONE_ID = { minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]{1,64}$" } as const;

const milestoneShape = {
  id: Type.String(MILESTONE_ID),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  scope: Type.String({ minLength: 1, maxLength: 1000 }),
  acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    minItems: 1,
    maxItems: 12,
  }),
  target_after: Type.String({ minLength: 1 }),
};

const estimateShape = {
  id: Type.String({ minLength: 1 }),
  estimated_after: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
};

export const ldBeginSchema = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 30000 }),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    milestones: Type.Optional(Type.Array(Type.Object(milestoneShape), { minItems: 1, maxItems: 24 })),
    next_milestone: Type.Optional(Type.Object(milestoneShape)),
    revise_milestone: Type.Optional(
      Type.Object({
        ...milestoneShape,
        reason: Type.String({ minLength: 1, maxLength: 1000 }),
        feedback_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }),
      }),
    ),
    plan_revision: Type.Optional(Type.Integer({ minimum: 1 })),
    estimates: Type.Optional(
      Type.Array(Type.Object(estimateShape), { minItems: 1, maxItems: 24 }),
    ),
    time_budget: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const planUpdateShape = {
  id: Type.String({ minLength: 1 }),
  estimated_after: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  acceptance: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12 }),
  ),
};

export const ldPublishSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    note: Type.Optional(Type.String()),
    confidence: Type.Optional(Type.Enum(["rough", "draft", "solid"])),
    weakest: Type.Optional(Type.String()),
    next_focus: Type.Optional(Type.String()),
    preview_entry: Type.Optional(Type.String({ minLength: 1 })),
    milestone_id: Type.Optional(Type.String({ minLength: 1 })),
    plan_revision: Type.Optional(Type.Integer({ minimum: 1 })),
    checks: Type.Optional(
      Type.Array(
        Type.Object({
          label: Type.String({ minLength: 1, maxLength: 500 }),
          result: Type.Enum(["passed", "failed", "not_run"]),
          evidence: Type.Optional(Type.String({ maxLength: 2000 })),
        }),
        { maxItems: 40 },
      ),
    ),
    plan_update: Type.Optional(Type.Array(Type.Object(planUpdateShape), { maxItems: 24 })),
    feedback_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
  },
  { additionalProperties: false },
);

export const ldStatusSchema = Type.Object(
  {
    activity: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  },
  { additionalProperties: false },
);

export const ldDoneSchema = Type.Object(
  {
    summary: Type.String(),
  },
  { additionalProperties: false },
);
