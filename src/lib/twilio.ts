import { countOutboundText } from "../plans/usage.js"; // KS_SERVER_v8_USAGE - monthly text count
import { safeImport } from "../utils/safeImport.js";
import { isUndeliverableNumber } from "./smsDeliverability.js"; // BF_SERVER_GUARD_EVERYWHERE_v136
import { smsFromFor, smsSenderFor, usTextingHold, UsTextingPendingError } from "./smsFrom.js"; // BF_SERVER_US_SMS_TOLLFREE_v755

export async function sendSMS(to: string, body: string) {
  if (process.env.NODE_ENV === "test") {
    return Promise.resolve({ sid: "test" });
  }

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio not configured");
  }

  if (!process.env.TWILIO_PHONE) {
    throw new Error("TWILIO_PHONE required outside test");
  }

  const twilioFactory: any = await safeImport("twilio");
  if (!twilioFactory) {
    throw new Error("Twilio SDK unavailable");
  }

  const client = twilioFactory(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
  );

  // BF_SERVER_GUARD_EVERYWHERE_v136 - last line of defence for helper callers.
  if (isUndeliverableNumber(to)) {
    throw new Error(`undeliverable_number:${String(to).slice(0, 6)}`);
  }
  // KS_SERVER_TEXTING_REGISTRATION - a US mobile waits until the texting registration is approved.
  const hold = usTextingHold(to);
  if (hold) {
    console.warn("[sms] US text held until texting registration is approved", String(to).slice(0, 6));
    throw new UsTextingPendingError(hold);
  }

  const sent = await client.messages.create({
    to,
    body,
    ...smsSenderFor(to, process.env.TWILIO_PHONE), // BF_SERVER_US_SMS_TOLLFREE_v755
  });
  await countOutboundText(sent as any); // KS_SERVER_v8_USAGE
  return sent;
}
