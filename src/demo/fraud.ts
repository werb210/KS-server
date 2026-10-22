// KS_SERVER_v10_DEMO - runs the real fraud checks on an uploaded demo document: check 1 (tamper scan: file metadata,
// fonts, page images, editing software) and, for bank statements, check 2 (statement math: every running balance and
// the opening/closing totals). Same functions the live fraud worker calls (src/fraud/documents.ts), without its tables.
import { classifyDocKind, extractPdfMeta } from "../services/documents/fraudSignals.js";
import { analyzePdfStructure } from "../fraud/pdfStructure.js";
import { classifyKindPlus, evaluateDocumentTamper } from "../fraud/checks/documentTamper.js";
import { checkStatementArithmetic } from "../fraud/checks/statementMath.js";
import { isJpeg, isPng, jpegInfo, pngInfo } from "../fraud/imageHash.js";
import { worse, type CheckResult, type FraudStatus } from "../fraud/types.js";
import { pdfTextLines, statementRowsFromLines } from "./pdfText.js";

export type DemoFraudResult = {
  kind: string;
  tamper: CheckResult;
  statement_math: CheckResult | null;
  /** The worse of the two (red > amber > green); a check that could not run never makes a file green. */
  status: FraudStatus;
  /** For the credit summary: deposits and withdrawals read from a statement, when it is one. */
  totals: { deposits: number; withdrawals: number; transactions: number } | null;
};

export async function scanDemoDocument(buffer: Buffer, category: string): Promise<DemoFraudResult> {
  const kind = classifyKindPlus(category, classifyDocKind);
  const isPdf = buffer.subarray(0, 5).toString("latin1").startsWith("%PDF-");
  const fileType = isPdf ? "pdf" : isJpeg(buffer) ? "jpeg" : isPng(buffer) ? "png" : "other";
  const meta = isPdf ? await extractPdfMeta(buffer) : null;
  const structure = isPdf ? await analyzePdfStructure(buffer) : null;
  const jinfo = fileType === "jpeg" ? jpegInfo(buffer) : null;
  const pinfo = fileType === "png" ? pngInfo(buffer) : null;
  const tamper = evaluateDocumentTamper({ kind, fileType, meta, structure, jpeg: jinfo, pngSoftware: pinfo?.software ?? null });

  let math: CheckResult | null = null;
  let totals: DemoFraudResult["totals"] = null;
  if (kind === "bank_statement" && isPdf) {
    const rows = statementRowsFromLines(await pdfTextLines(buffer));
    math = checkStatementArithmetic(rows);
    const tx = rows.filter((r) => typeof r.amount === "number") as Array<{ amount: number }>;
    totals = {
      deposits: Math.round(tx.filter((r) => r.amount > 0).reduce((a, r) => a + r.amount, 0) * 100) / 100,
      withdrawals: Math.round(tx.filter((r) => r.amount < 0).reduce((a, r) => a - r.amount, 0) * 100) / 100,
      transactions: tx.length,
    };
  }
  const actionable = (s: FraudStatus) => s === "green" || s === "amber" || s === "red";
  let status: FraudStatus = tamper.status;
  if (math && actionable(math.status)) status = actionable(status) ? worse(status, math.status) : math.status;
  return { kind, tamper, statement_math: math, status, totals };
}
