// KS_SERVER_PHONE_PROVISIONING - the few Twilio REST calls number provisioning needs, behind one small interface so
// the service can be tested with a fake. Uses this copy's own Twilio account (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN,
// which may be a subaccount of Keystone's): the numbers must live in the account whose auth token signs the webhooks.
import { getTwilioClient } from "../voice/twilioClient.js";

export type Capabilities = { voice: boolean; sms: boolean };

export type AvailableNumber = {
  phone_number: string;
  friendly_name: string;
  locality: string | null;
  region: string | null;
  iso_country: string;
  /** Twilio's addressRequirements: none | any | local | foreign. Anything but none needs an address on the account. */
  address_requirements: string;
  capabilities: Capabilities;
};

export type LocalSearch = { country: string; areaCode?: string; inRegion?: string; contains?: string; limit: number };
export type TollFreeSearch = { country: string; contains?: string; limit: number };

export type PurchaseParams = {
  phoneNumber: string;
  friendlyName: string;
  voiceUrl: string;
  statusCallback: string;
  smsUrl: string;
  addressSid?: string;
  bundleSid?: string;
};

export type WebhookParams = Pick<PurchaseParams, "voiceUrl" | "statusCallback" | "smsUrl">;

export interface TwilioNumbersApi {
  searchLocal(q: LocalSearch): Promise<AvailableNumber[]>;
  searchTollFree(q: TollFreeSearch): Promise<AvailableNumber[]>;
  purchase(p: PurchaseParams): Promise<{ sid: string; phone_number: string }>;
  setWebhooks(sid: string, p: WebhookParams): Promise<void>;
  release(sid: string): Promise<void>;
}

/** A Twilio failure, kept with its numeric code (e.g. 21631 = an address is required). */
export class TwilioNumberError extends Error {
  constructor(message: string, readonly code: number | null, readonly status: number | null) {
    super(message);
    this.name = "TwilioNumberError";
  }
}

function wrap(err: unknown): TwilioNumberError {
  const e = err as { message?: string; code?: unknown; status?: unknown } | null;
  const code = Number(e?.code);
  const status = Number(e?.status);
  return new TwilioNumberError(
    String(e?.message ?? err ?? "twilio_error"),
    Number.isFinite(code) && code > 0 ? code : null,
    Number.isFinite(status) && status > 0 ? status : null,
  );
}

function toAvailable(n: any): AvailableNumber {
  const caps = n?.capabilities ?? {};
  return {
    phone_number: String(n?.phoneNumber ?? ""),
    friendly_name: String(n?.friendlyName ?? n?.phoneNumber ?? ""),
    locality: n?.locality ? String(n.locality) : null,
    region: n?.region ? String(n.region) : null,
    iso_country: String(n?.isoCountry ?? ""),
    address_requirements: String(n?.addressRequirements ?? "none"),
    capabilities: { voice: caps.voice === true, sms: caps.SMS === true || caps.sms === true },
  };
}

export function twilioConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(String(env.TWILIO_ACCOUNT_SID ?? "").trim() && String(env.TWILIO_AUTH_TOKEN ?? "").trim());
}

/** The real client. Every call that fails is rethrown as a TwilioNumberError (the service logs it). */
export function liveTwilioNumbersApi(clientFactory: () => any = getTwilioClient): TwilioNumbersApi {
  const client = () => clientFactory();
  return {
    async searchLocal(q) {
      try {
        const opts: Record<string, unknown> = { voiceEnabled: true, smsEnabled: true, limit: q.limit };
        if (q.areaCode) opts.areaCode = Number(q.areaCode);
        if (q.inRegion) opts.inRegion = q.inRegion;
        if (q.contains) opts.contains = q.contains;
        const rows = await client().availablePhoneNumbers(q.country).local.list(opts);
        return (rows ?? []).map(toAvailable);
      } catch (err) { throw wrap(err); }
    },
    async searchTollFree(q) {
      try {
        const opts: Record<string, unknown> = { voiceEnabled: true, limit: q.limit };
        if (q.contains) opts.contains = q.contains;
        const rows = await client().availablePhoneNumbers(q.country).tollFree.list(opts);
        return (rows ?? []).map(toAvailable);
      } catch (err) { throw wrap(err); }
    },
    async purchase(p) {
      try {
        const body: Record<string, unknown> = {
          phoneNumber: p.phoneNumber,
          friendlyName: p.friendlyName,
          voiceUrl: p.voiceUrl,
          voiceMethod: "POST",
          statusCallback: p.statusCallback,
          statusCallbackMethod: "POST",
          smsUrl: p.smsUrl,
          smsMethod: "POST",
        };
        if (p.addressSid) body.addressSid = p.addressSid;
        if (p.bundleSid) body.bundleSid = p.bundleSid;
        const n = await client().incomingPhoneNumbers.create(body);
        return { sid: String(n.sid), phone_number: String(n.phoneNumber ?? p.phoneNumber) };
      } catch (err) { throw wrap(err); }
    },
    async setWebhooks(sid, p) {
      try {
        await client().incomingPhoneNumbers(sid).update({
          voiceUrl: p.voiceUrl, voiceMethod: "POST",
          statusCallback: p.statusCallback, statusCallbackMethod: "POST",
          smsUrl: p.smsUrl, smsMethod: "POST",
        });
      } catch (err) { throw wrap(err); }
    },
    async release(sid) {
      try {
        await client().incomingPhoneNumbers(sid).remove();
      } catch (err) { throw wrap(err); }
    },
  };
}
