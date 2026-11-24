/**
 * pi-live-delivery — in-process live delivery.
 *
 * - The four delivery tools call the vendored engine directly (no MCP server,
 *   no hooks, no binding files).
 * - The workbench HTTP server runs inside this extension: session_start ->
 *   session_shutdown. Loopback-only, ephemeral port per session.
 * - Feedback delivery + keep-working continuation mirror the Codex hook
 *   flow via pi's before_agent_start / turn_end boundaries.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Server } from "node:http";
import { createDeliveryServer } from "../resources/live-delivery/workbench/http.js";
import { deliveryLinks, openDeliveryOnce } from "../resources/live-delivery/workbench/browser.js";
import { callTool, TOOL_DESCRIPTIONS, type ToolName } from "../resources/live-delivery/integration/tools.js";
import { currentState, runDeadlineTick } from "../resources/live-delivery/delivery/core.js";
import { confirmTurnEnd, recordHostEvent, takeFeedbackContext } from "../resources/live-delivery/delivery/controls.js";
import { keepWorkingDecision } from "../resources/live-delivery/delivery/policy.js";
import type { CdConfig } from "../resources/live-delivery/workbench/config.js";
import { ldBeginSchema, ldPublishSchema, ldStatusSchema, ldDoneSchema } from "./lib/schemas.js";

interface RunningWorkbench {
  server: Server;
  cfg: CdConfig;
}

let running: Promise<RunningWorkbench> | undefined;
let deadlineTimer: NodeJS.Timeout | undefined;

function makeCfg(ctx: ExtensionContext): CdConfig {
  return {
    workspaceDir: ctx.cwd,
    sessionKey: `pi:${ctx.sessionManager.getSessionId()}`,
    harness: "pi",
    deliverEverySec: 120,
    timeBudgetSec: 1800,
    minWorkingSec: 0,
    minReleases: 1,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown",
    channels: false,
    requirePlanApproval: false,
    planMode: "rolling",
    port: 0,
    basePath: "/live-delivery",
    bindHost: "127.0.0.1",
    accessToken: undefined,
    openBrowser: "auto",
  };
}

function startWorkbench(ctx: ExtensionContext): Promise<RunningWorkbench> {
  const cfg = makeCfg(ctx);
  const server = createDeliveryServer(cfg);
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      cfg.port = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
  return listening.then(
    () => ({ server, cfg }),
    (error) => {
      try {
        server.closeAllConnections?.();
      } catch {}
      server.close();
      throw error;
    },
  );
}

function ensureWorkbench(ctx: ExtensionContext): Promise<RunningWorkbench> {
  if (!running) {
    running = startWorkbench(ctx)
      .catch((e) => {
        running = undefined;
        throw e;
      })
      .then((wb) => {
        if (!deadlineTimer) {
          deadlineTimer = setInterval(() => {
            try {
              runDeadlineTick(wb.cfg);
            } catch {}
          }, 1000);
          deadlineTimer.unref?.();
        }
        return wb;
      });
  }
  return running;
}

async function stopWorkbench(): Promise<void> {
  const current = running;
  running = undefined;
  if (!current) return;
  let wb: RunningWorkbench;
  try {
    wb = await current;
  } catch {
    return; // startup already failed; nothing to close
  }
  if (deadlineTimer) {
    clearInterval(deadlineTimer);
    deadlineTimer = undefined;
  }
  try {
    wb.server.closeAllConnections?.();
  } catch {}
  await new Promise<void>((resolve) => wb.server.close(() => resolve()));
}

async function runTool(
  name: ToolName,
  params: unknown,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }> {
  const wb = await ensureWorkbench(ctx);
  const result = callTool(wb.cfg, name, params);
  if (ctx.mode === "tui") openDeliveryOnce(wb.cfg, () => {});
  const out: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean } = {
    content: result.content,
    details: result.structuredContent ?? {},
  };
  if (result.isError) out.isError = true;
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    // Fire-and-forget so pi's startup path never blocks on workbench I/O.
    void (async () => {
      try {
        const wb = await ensureWorkbench(ctx);
        // Browser auto-open spawns a browser: TUI-only. In RPC/print/JSON mode
        // the URL is surfaced via the widget/notify stream instead.
        if (ctx.mode === "tui") openDeliveryOnce(wb.cfg, () => {});
        const url = deliveryLinks(wb.cfg)[0];
        if (url) {
          ctx.ui.setWidget("live-delivery", [`Delivery workbench ${url}`]);
          ctx.ui.notify(`Delivery workbench: ${url}`, "info");
        }
      } catch (e) {
        ctx.ui.setWidget("live-delivery", undefined);
        ctx.ui.notify(
          `Live Delivery: workbench failed to start — ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    })();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      ctx.ui.setWidget("live-delivery", undefined);
    } catch {}
    void stopWorkbench().catch(() => {});
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const wb = await ensureWorkbench(ctx);
      runDeadlineTick(wb.cfg);
      recordHostEvent(wb.cfg, { name: "UserPromptSubmit" });
      const feedback = takeFeedbackContext(wb.cfg, "UserPromptSubmit");
      return feedback
        ? { message: { customType: "live-delivery-feedback", content: feedback, display: false } }
        : undefined;
    } catch {
      return undefined; // never block a run from this handler
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      const wb = await ensureWorkbench(ctx);
      runDeadlineTick(wb.cfg);
      recordHostEvent(wb.cfg, { name: "Stop" });
      const state = currentState(wb.cfg);
      if (!state?.stopRequest) {
        const feedback = takeFeedbackContext(wb.cfg, "Stop");
        if (feedback) {
          return {
            entries: [{ type: "custom_message", customType: "live-delivery-feedback", content: feedback, display: false }],
            continue: true,
          };
        }
      }
      const decision = keepWorkingDecision(wb.cfg);
      if (decision.block) {
        return {
          entries: [{ type: "custom_message", customType: "live-delivery-work", content: decision.reason, display: false }],
          continue: true,
        };
      }
      confirmTurnEnd(wb.cfg);
      return undefined;
    } catch {
      return undefined;
    }
  });

  const makeRegistration = (
    name: ToolName,
    schema: unknown,
    description: string,
    label: string,
    snippet: string,
    guidelines: string[],
  ) => ({
    name,
    label,
    description,
    promptSnippet: snippet,
    promptGuidelines: guidelines,
    parameters: schema,
    executionMode: "sequential",
    async execute(_toolCallId: string, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      return runTool(name, params, ctx);
    },
  });

  pi.registerTool(
    makeRegistration(
      "ld_begin",
      ldBeginSchema,
      TOOL_DESCRIPTIONS.ld_begin,
      "Live Delivery: Begin",
      "Start or attach a rolling live-delivery task",
      ["Use ld_begin to start the live delivery task for the work the user describes; do not call it twice for the same task."],
    ),
  );
  pi.registerTool(
    makeRegistration(
      "ld_publish",
      ldPublishSchema,
      TOOL_DESCRIPTIONS.ld_publish,
      "Live Delivery: Publish",
      "Publish a usable version of the current milestone",
      ["Use ld_publish to publish a usable version of the current milestone; include truthful checks."],
    ),
  );
  pi.registerTool(
    makeRegistration(
      "ld_status",
      ldStatusSchema,
      TOOL_DESCRIPTIONS.ld_status,
      "Live Delivery: Status",
      "Read the plan, remaining budget and publications",
      ["Use ld_status to read the plan, remaining budget, publications and feedback — not merely to animate progress."],
    ),
  );
  pi.registerTool(
    makeRegistration(
      "ld_done",
      ldDoneSchema,
      TOOL_DESCRIPTIONS.ld_done,
      "Live Delivery: Done",
      "Finish a rolling live-delivery task",
      ["Use ld_done to finish a rolling task after user wrap-up or budget exhaustion; check it succeeds before announcing completion."],
    ),
  );
}
