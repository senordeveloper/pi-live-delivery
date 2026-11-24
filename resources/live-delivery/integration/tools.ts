import { z } from 'zod';
import {
  beginCd,
  currentState,
  markDone,
  publishVersion,
  statusReport,
  type PublishInput,
} from '../delivery/core.js';
import { durationSeconds } from '../delivery/timeline.js';
import { fileListing, suggestRelative } from '../delivery/listing.js';
import type { CdConfig } from '../workbench/config.js';
import { dashboardFooter, deliveryLinks } from '../workbench/browser.js';
import { TOOL_DESCRIPTIONS } from '../prompts.generated.js';
import { nextArtifactVersion } from '../delivery/engine.js';
import { reportActivity } from '../delivery/controls.js';
import { nextStep } from '../delivery/instructions.js';

const milestone = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    title: z.string().min(1).max(120),
    scope: z.string().min(1).max(1000),
    acceptance: z.array(z.string().min(1).max(500)).min(1).max(12),
    target_after: z.string().min(1),
  })
  .strict();
const planUpdate = z
  .object({
    id: z.string().min(1),
    estimated_after: z.string().min(1),
    reason: z.string().min(1).max(1000),
    scope: z.string().min(1).max(1000).optional(),
    acceptance: z.array(z.string().min(1).max(500)).min(1).max(12).optional(),
  })
  .strict();
export const TOOL_SCHEMAS = {
  ld_begin: z
    .object({
      task: z.string().min(1).max(30000),
      title: z.string().min(1).max(120).optional(),
      milestones: z.array(milestone).min(1).max(24).optional(),
      next_milestone: milestone.optional(),
      revise_milestone: milestone
        .extend({
          reason: z.string().trim().min(1).max(1000),
          feedback_ids: z.array(z.string().min(1)).min(1).max(100),
        })
        .optional(),
      plan_revision: z.number().int().positive().optional(),
      estimates: z
        .array(
          z
            .object({
              id: z.string().min(1),
              estimated_after: z.string().min(1),
              reason: z.string().trim().min(1).max(1000),
            })
            .strict(),
        )
        .min(1)
        .max(24)
        .optional(),
      time_budget: z.string().optional(),
    })
    .strict(),
  ld_publish: z
    .object({
      paths: z.array(z.string().min(1)).min(1),
      note: z.string().optional(),
      confidence: z.enum(['rough', 'draft', 'solid']).optional(),
      weakest: z.string().optional(),
      next_focus: z.string().optional(),
      preview_entry: z.string().min(1).optional(),
      milestone_id: z.string().min(1).optional(),
      plan_revision: z.number().int().positive().optional(),
      checks: z
        .array(
          z
            .object({
              label: z.string().min(1).max(500),
              result: z.enum(['passed', 'failed', 'not_run']),
              evidence: z.string().max(2000).optional(),
            })
            .strict(),
        )
        .max(40)
        .optional(),
      plan_update: z.array(planUpdate).max(24).optional(),
      feedback_ids: z.array(z.string().min(1)).max(100).optional(),
    })
    .strict(),
  ld_status: z.object({ activity: z.string().trim().min(1).max(160).optional() }).strict(),
  ld_done: z.object({ summary: z.string() }).strict(),
};
export { TOOL_DESCRIPTIONS };
export type ToolName = keyof typeof TOOL_SCHEMAS;
function toolResult(cfg: CdConfig, text: string, details: Record<string, unknown>) {
  const state = currentState(cfg);
  return {
    content: [
      {
        type: 'text' as const,
        text: state ? `${text}\n\n${dashboardFooter(cfg, state.id, true)}` : text,
      },
    ],
    structuredContent: {
      ...details,
      ...(state ? { next_action: nextStep(state) } : {}),
      ...(state ? { dashboard_urls: deliveryLinks(cfg, state.id) } : {}),
    },
    ...(details.ok === false ? { isError: true } : {}),
  };
}
export function callTool(cfg: CdConfig, name: ToolName, raw: unknown) {
  const result = (text: string, details: Record<string, unknown>) => toolResult(cfg, text, details);
  try {
    const p = TOOL_SCHEMAS[name].parse(raw) as Record<string, unknown>;
    if (name === 'ld_begin') {
      const r = beginCd(cfg, p.task as string, {
        reviseMilestone:
          p.revise_milestone as import('../delivery/core.js').BeginOptions['reviseMilestone'],
        nextMilestone: p.next_milestone as
          | import('../delivery/types.js').CdMilestoneInput
          | undefined,
        planRevision: p.plan_revision as number | undefined,
        estimates: p.estimates as import('../delivery/core.js').BeginOptions['estimates'],
        timeBudgetSec: p.time_budget ? durationSeconds(p.time_budget) : undefined,
        title: p.title as string | undefined,
        milestones: p.milestones as import('../delivery/types.js').CdMilestoneInput[] | undefined,
      });
      if (!r.ok || !r.state) return result(r.error ?? 'ld_begin failed.', { ok: false });
      return result(
        `CD session ${JSON.stringify(r.state.name)}. Next publication: V${nextArtifactVersion(r.state)}. ${statusReport(cfg)}`,
        { ok: true, state: r.state },
      );
    }
    const state = currentState(cfg);
    if (!state)
      return result('No active Live Delivery session — call ld_begin first.', { ok: false });
    if (name === 'ld_status') {
      const updated = p.activity ? reportActivity(cfg, p.activity as string) : state;
      return result(statusReport(cfg)!, { ok: true, state: updated });
    }
    if (name === 'ld_done') {
      const r = markDone(cfg, p.summary as string);
      return r.ok
        ? result(`CD mode finished. Final version v${r.state?.published?.version ?? '—'}.`, {
            ok: true,
            state: r.state,
          })
        : result(r.error ?? 'ld_done failed.', { ok: false });
    }
    const input = p as PublishInput;
    const r = publishVersion(cfg, input);
    if (r.error === 'no_files_resolved') {
      const lines = input.paths.slice(0, 25).map((given) => {
        const suggestion = suggestRelative(cfg.workspaceDir, given);
        return suggestion
          ? `  - "${given}" → pass "${suggestion}" instead`
          : `  - "${given}" → not found under the workspace root`;
      });
      return result(
        [
          `ld_publish FAILED — not one of the ${input.paths.length} path(s) resolved to a file on disk, so NO version was created (the version counter did not move).`,
          `Workspace root: ${cfg.workspaceDir}`,
          ...lines,
          'Paths are relative to the workspace root; workspace absolute paths and aliases are accepted. Check the files, then call ld_publish with the COMPLETE list.',
        ].join('\n'),
        {
          ok: false,
          error: r.error,
          version_consumed: false,
          workspace_dir: cfg.workspaceDir,
          n_files: 0,
          n_missing: fileListing(cfg.workspaceDir, input.paths).nMissing,
        },
      );
    }
    if (!r.ok)
      return result(r.error ?? 'ld_publish failed.', {
        ok: false,
        error: r.error,
        version_consumed: false,
      });
    const published = r.state!.published!;
    const files = published.files ?? [];
    const dropped = (state.published?.paths ?? []).filter((p) => !published.paths.includes(p));
    const lines = files.slice(0, 25).map((f) => `  - ${f.path} (${f.bytes} bytes)`);
    return result(
      [
        `Published v${published.version} — ${files.length} files, ${files.reduce((n, f) => n + f.bytes, 0)} bytes`,
        ...lines,
        ...(files.length > 25 ? [`  … and ${files.length - 25} more`] : []),
        `Preview entry: ${published.previewEntry ?? 'not selected; specify preview_entry for a default preview'}`,
        ...(published.excluded?.length
          ? [`Excluded private/runtime paths: ${published.excluded.join(', ')}`]
          : []),
        ...(dropped.length ? [`Paths NOT in this one: ${dropped.join(', ')}`] : []),
        'Snapshot saved; included files were copied and hashed. Acceptance checks are agent-reported. The host does not independently verify dependency completeness or artifact quality.',
        nextStep(r.state!).message,
      ].join('\n'),
      {
        ok: true,
        published,
        n_files: files.length,
        n_missing: 0,
        total_bytes: files.reduce((n, f) => n + f.bytes, 0),
        dropped_paths: dropped,
        preview_entry: published.previewEntry,
        excluded_paths: published.excluded,
      },
    );
  } catch (error) {
    return result(error instanceof Error ? error.message : String(error), { ok: false });
  }
}
