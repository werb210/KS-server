# Beta programme (KS-server)

Keystone operations (KS-Ops) owns the beta catalogue and who is in each beta; see KS-Ops `docs/BETA_PROGRAMME.md`.
This copy stores its own view of it and gates code with it. Code marker: `KS_SERVER_BETA_v1`.

## Gating code

```ts
import { isEnabled, requireBeta } from "../beta/flags.js";

if (await isEnabled("ai_call_notes")) { /* new path */ }
router.post("/notes/ai", requireBeta("ai_call_notes"), handler); // 404 while off
```

Flags are cached for 30 seconds. A read failure is logged and means "off". The portal and client read the same flags.

## Where the flags come from

- `PUT /api/plan { beta_features: [...] }` from KS-Ops (`X-KS-Ops-Key`), with the plan push. The list replaces what was
  stored (`licensee_plan.beta_features`, migration `2026_10_28_ks_beta_features.sql`). An empty list switches all off.
- The answer to a join or leave (below), stored at once.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/beta/flags` | anyone | `{ enabled: [keys] }` for the client and portal |
| `GET /api/beta/features` | signed-in staff | `{ features, enabled }` for the Labs page |
| `POST /api/beta/features/:key/join` | Admin | Forwarded to KS-Ops; an open public beta is approved at once |
| `POST /api/beta/features/:key/leave` | Admin | Forwarded to KS-Ops |
| `POST /api/beta/features/:key/feedback` | staff | `{ message, rating? }` forwarded to KS-Ops |

Forwarding uses the existing ops link (`KS_OPS_URL`, `KS_LICENSEE_ID`, `KS_OPS_KEY`). Without it, join, leave and
feedback answer 503 and nothing changes.
