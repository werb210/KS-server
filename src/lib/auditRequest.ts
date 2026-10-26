// KS_SERVER_v20_CRM_FIELDS - one audit_events row for an admin settings change made through a request.
// Best effort: a failed audit write is logged, never turned into a failed request.
import type { Request } from "express";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { logWarnSwallowed } from "./logWarnSwallowed.js";

export function actorId(req: Request): string | null {
  const u = (req as any).user ?? {};
  const id = String(u.userId ?? u.id ?? u.sub ?? "");
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

export async function auditRequest(
  req: Request, eventType: string, action: string, targetType: string, targetId: string | null, metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await recordAuditEvent({
      actorUserId: actorId(req), targetUserId: null, targetType, targetId, action, eventType, eventAction: action,
      success: true, metadata, ip: req.ip ?? null, userAgent: String(req.headers?.["user-agent"] ?? "") || null,
    });
  } catch (err) {
    logWarnSwallowed(err, `auditRequest:${eventType}.${action}`);
  }
}
