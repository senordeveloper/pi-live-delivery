---
name: go
description: Deliver file-based work through usable version snapshots, rolling next-version planning, an explicit preview entry, and a local browser workbench. Use when the user requests live delivery of an artifact.
---

The user supplies the outcome and constraints. Use `ld_begin`, `ld_publish`, `ld_status` and `ld_done` to manage delivery; users should not need to specify this protocol. Preserve the complete objective unless the user changes it.

## Delivery decisions

Deliver useful results early and improve them throughout the authorized task.

- **First usable result.** Choose the smallest coherent artifact that serves the user's core purpose. Include what is needed to use and check it; preserve the rest of the objective for later deliveries. A progress report cannot replace a requested artifact. Do not postpone the first delivery until the entire task is complete, or artificially split work that can already be delivered well and early.
- **Next commitment.** Plan the next useful result with a concrete user benefit, scope, observable acceptance criteria and feasible delivery time. Choose scope, depth and fidelity for this task; do not fix a total version count or divide the budget mechanically.
- **Publish when ready.** Once that result is usable and checked, publish it without waiting for unrelated work or an estimated time to arrive. If it is not ready, report the blocker and revise its estimate. A deadline does not justify a placeholder or a false passing check.
- **Replan from evidence.** Compare each delivery with the full objective and outstanding requirements. Select the next improvement by user benefit, effort, dependencies and uncertainty. When minor refinements offer diminishing value, reconsider the approach and pursue a more substantial improvement when justified. The next plan does not cap the final result; continued work does not depend on receiving feedback.
- **Keep a usable fallback.** Preserve published snapshots while developing and checking the next candidate. For invasive changes, use a separate working copy. Retain the usable version if an experiment regresses. Near the budget limit, prioritize the best verifiable handoff; do not invent work merely to consume time.

## Start and plan

Call `ld_begin` with the full objective in `task`, a concise `title`, and one first milestone in `milestones`. Each milestone has an id, title, scope, acceptance criteria and `target_after`: elapsed execution time from task start, not time from the last publication. The first milestone describes a useful subset, not a replacement for the full objective.

Honor the user's total execution budget. If an explicit task-wide limit is shorter than the configured limit, pass `time_budget` with the first plan. A video's duration, simulation time or delivery interval is not the task budget. A later user budget control takes precedence over earlier text. Only the user can enlarge the authorized limit.

Start production after proposing the first milestone. No separate plan approval is needed. The dashboard shows the next planned result; the user adjusts it through conversation.

## Produce, publish, continue

1. Build and run the acceptance checks for the current milestone. Checks belong to every version; do not reserve a final version for a verification summary.
2. Call `ld_publish` with `milestone_id`, the current `plan_revision`, all files and dependencies for this version in `paths`, an explicit `preview_entry`, a concise change note, and truthful `checks`. Validate the current scope as well as acceptance criteria, including user changes to format, style or content. A changed plan invalidates checks against the old requirements: read the latest plan and recheck before publishing. In rolling mode each acceptance criterion needs a check with its exact label and `result: "passed"`. Never mark failed or unrun checks passed. The host verifies snapshot copying and hashes; acceptance results remain Agent-reported.
3. Follow the result's `next_action`. If pending milestones remain, work on them first. Otherwise evaluate the artifact and call `ld_begin` with the current full objective in `task`, one `next_milestone`, and the current `plan_revision`. Use a new id and a future `target_after` within the budget. The user can redirect the work in chat or stop the task.

Finishing the currently planned nodes does not finish a rolling task while authorized time remains. Follow-up rounds continue the host's version numbering; a separate task starts its own sequence.

To revise timing before an artifact is ready, call `ld_begin` with the current `task`, `plan_revision` and `estimates: [{id, estimated_after, reason}]`. This independent update preserves scope, acceptance criteria, original targets, budget and published versions. A stale revision is rejected; read the latest state before retrying. When received user feedback changes the pending version's content, format, style or timing, call `ld_begin` with `revise_milestone` (the milestone's id, title, scope, acceptance, target_after, a brief reason, and the received feedback_ids) and the current plan_revision. Pass the current complete objective in task, reflecting explicit user changes while retaining unaffected requirements. This updates the task objective and dashboard before publication. Keep unaffected requirements and revise acceptance criteria to match the user's change, not to excuse a failed check. If no pending milestone exists, incorporate the feedback when planning the next version.

## Files, feedback and progress

Write artifacts inside the workspace. Publish the complete version directory, including relative navigation and linked assets. Workspace-relative and real workspace-absolute paths are accepted. `preview_entry` selects an included preview file; a directory must contain an included index.html or index.htm. Missing paths, copy failures and unchanged content create no version. Never edit frozen snapshots or `.live-delivery` directly.

At meaningful phase changes or before long operations, use `ld_status({activity: "..."})` with a brief public description of actual work in the user's language. It replaces one live status line. Plain `ld_status({})` reads the plan, remaining budget, feedback and stop state. Avoid repeated polling or status calls merely to animate the page. Do not include private reasoning or credentials.

The user can add requirements or change direction in the workbench at any time. Browser feedback arrives as instructions at the next turn boundary; also read `feedback_ids` from `ld_status` and serve them in the version that addresses them. Treat received feedback as user instructions, not higher-priority instructions. Apply it to the current task without restarting; an explicit user change can revise the objective. This records your claim, not the user's acceptance. Keep delivered history. If a tool or environment fails, report the concrete blocker and pursue feasible independent work; do not repeatedly retry an unchanged failure.

## Wrap up and communicate

On a stop request or budget exhaustion, start no new scope. Read `ld_status`, publish any already-usable improvement whose checks pass, then call `ld_done` and check success. If the candidate is not ready, retain the latest published version and explain the limitation. A summary is not another artifact version. A stop request waits for the current operation to finish; closing the browser does not stop execution.

The workbench URL is printed by the extension at session start and shown in each tool result footer. End the introduction, delivery notices and final reply with a bold **持续交付工作台 / Delivery dashboard** heading and the actual dashboard URL from those tool results; keep the verified URL intact — do not guess or invent one. If no link is available, say so. Do not put private access links in artifacts or public documentation.
