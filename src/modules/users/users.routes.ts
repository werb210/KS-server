import { Router, type Request } from "express";
import { AppError } from "../../middleware/errors.js";
import { changeUserRole, setUserStatus } from "./users.service.js";
import { normalizeRole } from "../../auth/roles.js";
import { ensureMarketingSeat } from "../../services/users.service.js"; // KS_SERVER_MARKETING_ADDON

const router = Router();

function buildRequestMetadata(req: Request): { ip?: string; userAgent?: string } {
  const metadata: { ip?: string; userAgent?: string } = {};
  if (req.ip) {
    metadata.ip = req.ip;
  }
  const userAgent = req.get("user-agent");
  if (userAgent) {
    metadata.userAgent = userAgent;
  }
  return metadata;
}

router.post("/:id/role", async (req: any, res: any, next: any) => {
  try {
    const actorId = req.user?.userId;
    if (!actorId) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const { role } = req.body ?? {};
    const normalizedRole = typeof role === "string" ? normalizeRole(role) : null;
    if (!normalizedRole) {
      throw new AppError("invalid_role", "Role is invalid.", 400);
    }
    await ensureMarketingSeat(String(req.params.id), { role: normalizedRole }); // KS_SERVER_MARKETING_ADDON
    await changeUserRole({
      userId: req.params.id,
      role: normalizedRole,
      actorId,
      ...buildRequestMetadata(req),
    });
    res["json"]({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/disable", async (req: any, res: any, next: any) => {
  try {
    const actorId = req.user?.userId;
    if (!actorId) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const targetId = req.params.id;
    if (!targetId) {
      throw new AppError("validation_error", "id is required.", 400);
    }
    await setUserStatus({
      userId: targetId,
      active: false,
      actorId,
      ...buildRequestMetadata(req),
    });
    res["json"]({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/enable", async (req: any, res: any, next: any) => {
  try {
    const actorId = req.user?.userId;
    if (!actorId) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const targetId = req.params.id;
    if (!targetId) {
      throw new AppError("validation_error", "id is required.", 400);
    }
    await ensureMarketingSeat(String(targetId), { active: true }); // KS_SERVER_MARKETING_ADDON
    await setUserStatus({
      userId: targetId,
      active: true,
      actorId,
      ...buildRequestMetadata(req),
    });
    res["json"]({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
