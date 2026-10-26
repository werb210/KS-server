// KS_SETTINGS_PACK_v1_PHONE_MENU - the phone menu (IVR) callers reach on the brokerage's main number.
//
// Everything a caller hears and where each key goes comes from the Admin's menu (Settings > Phone menu,
// src/phoneMenu/menu.ts): the greeting (read aloud or an uploaded recording), business hours and holidays in the
// brokerage's time zone, options 1-9 and the no-answer fallback. With no menu saved, the default is built from the
// brokerage's own active staff (1 rings everyone, 2-9 each person). No brokerage's departments or staff names are
// written here any more.
//
// Each option routes to:
//   user       one person: their apps (with the caller card, recording and the opted-in Watch cell fallback), their
//              do-not-disturb hours and Busy switch respected; unanswered -> the menu's no-answer fallback
//   group      everyone at once, or one at a time (ring time each), skipping people who are away
//   voicemail  a person's voicemail (private to them) or the shared voicemail
//   ai         the AI receptionist: the caller says what the call is about and is routed to the matching option, or a
//              message is taken (voicemail with AI transcription and summary)
//   meeting    the meeting dial-in (enter the six-digit access code)
// Every dead end records a voicemail and raises a missed-call alert.
//
// Voice: Polly by default. With RECEPTION_NOVA_VOICE=true the fixed phrases below are played in the nova voice once
// rendered (cached, warmed at boot); anything not rendered falls back to Polly so a caller never hears an error.
import express, { Router, type Request, type Response } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { pool } from "../db.js";
import { ringableStaffSql } from "../modules/presence/presenceService.js"; // BF_SERVER_v817_DIALER_MESSAGING
import { config } from "../config/index.js";
import { sharedOpenAI } from "../lib/sharedClients.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS // BF_SERVER_SNAT_REUSE_v784
import { callerHungUp, callerLabel, dialWasNotAnswered, screenUrl, verifiedWatchCell, CELL_RING_TIMEOUT_SECONDS, SCREEN_GATHER_TIMEOUT_SECONDS } from "../voice/watchCellFallback.js";
import { alertMissedCall } from "../services/notifications/staffAlertEvents.js";
import { callerCardForCall, dialClient, type CallerCard } from "../voice/callerCard.js";
import { RECORDING_NOTICE, closeCallRecord, inboundRecordName, legStatusAttrs, recordLegStatus, recordingDialAttrs } from "../voice/recordedDial.js";
import { awayStatus, identitiesOutsideHours, ownerIsBusy } from "../voice/callHours.js";
import { awayTwiml, openInboundRecord, ringDirectLine, staffVoicemail } from "../voice/staffRing.js";
import { brandName } from "../licensee/brand.js"; // KS_SERVER_v4_BRANDING
import { greetingText, matchSpeech, officeOpen, optionsPrompt, type MenuOption, type MenuTarget, type PhoneMenu, type Prompt } from "../phoneMenu/menu.js";
import { loadMenu, readAudio } from "../phoneMenu/store.js";

const router = Router();

// Twilio webhooks post application/x-www-form-urlencoded payloads, and the
// signature validator needs the parsed params to validate the request.
router.use(express.urlencoded({ extended: false }));

const VOICE = "Polly.Joanna";
const BASE = "/api/webhooks/twilio/reception";

const PHRASES: Record<string, string> = {
  meeting_prompt: "Please enter your six digit meeting access code, then press pound.",
  meeting_retry: "Sorry, that code isn't valid for a meeting happening now. Please enter your six digit access code, then press pound.",
  meeting_joining: "Thank you. Joining your meeting now.",
  meeting_failed: "Sorry, we couldn't find a meeting with that code. Please check the code in your invitation and call back.",
  menu_retry: "Sorry, I didn't catch that.",
  connecting: "One moment, connecting you.",
  nobody_available: "Sorry, no one is available to take your call right now.",
  nobody_answered: "Sorry, no one was able to pick up.",
  record_prompt: "Please leave your name, number, and a brief message after the tone.",
  vm_prompt: "Please leave your message after the tone.",
  msg_prompt: "Sure. Please tell me your name, number, and what it's about after the tone, and I'll pass it to the team.",
  ai_prompt: "In a few words, what is your call about?",
  ai_message: "Let me take a message and make sure the right person follows up.",
};

const audioCache = new Map<string, Buffer>();
function novaOn(): boolean { return process.env.RECEPTION_NOVA_VOICE === "true"; }

async function renderNova(text: string): Promise<Buffer | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // BF_SERVER_RECEPTION_VOICE_FALLBACK_v40
    console.warn("reception_voice_render_failed", { reason: "no_openai_api_key" });
    return null;
  }
  try {
    const client = sharedOpenAI(apiKey);
    // BF_SERVER_v817_AUDIO_MODELS - model from OPENAI_TTS_MODEL, falling back to tts-1.
    const { ttsModel, LEGACY_TTS_MODEL, withAudioModelFallback } = await import("../lib/openaiAudioModels.js");
    const speech = await withAudioModelFallback(ttsModel(), LEGACY_TTS_MODEL,
      (model) => client.audio.speech.create({ model, voice: "nova", input: text }), "reception_nova");
    return Buffer.from(await speech.arrayBuffer());
  } catch (error) {
    // BF_SERVER_RECEPTION_VOICE_FALLBACK_v40 - a missing entitlement, a retired model, an expired key and a network
    // blip must not be silent.
    console.warn("reception_voice_render_failed", { reason: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function warmReceptionVoice(): Promise<void> {
  for (const [key, text] of Object.entries(PHRASES)) {
    if (audioCache.has(key)) continue;
    const buf = await renderNova(text);
    if (buf) audioCache.set(key, buf);
  }
  if (novaOn()) {
    console.log("reception_voice_warm", {
      rendered: audioCache.size,
      total: Object.keys(PHRASES).length,
      degradedToPolly: Object.keys(PHRASES).length - audioCache.size,
    });
  }
}

// Test seam: the cache is module-local.
export function __receptionVoiceCacheForTests() {
  return {
    set: (key: string, buf: Buffer) => { audioCache.set(key, buf); },
    clear: () => { audioCache.clear(); },
    size: () => audioCache.size,
  };
}

// BF_SERVER_RECEPTION_VOICE_FALLBACK_v40 - only ever play audio that is already rendered; everything else is Polly,
// which fetches nothing. A less pleasant voice is not a defect. A phone line that answers with an error is.
export function shouldPlayAudio(key: string): boolean {
  return novaOn() && audioCache.has(key);
}

function emit(node: any, key: string, text: string = PHRASES[key] ?? ""): void {
  if (shouldPlayAudio(key)) node.play(`${BASE}/voice?key=${key}`);
  else node.say({ voice: VOICE }, text);
}

/** A menu prompt: the uploaded recording, or the text read aloud. */
function speak(node: any, prompt: Prompt, text: string): void {
  if (prompt.mode === "audio" && prompt.audioId) node.play(`${BASE}/audio/${encodeURIComponent(prompt.audioId)}`);
  if (text) node.say({ voice: VOICE }, text);
}

function speech(req: Request): string { return String((req.body?.SpeechResult ?? "") as string).toLowerCase(); }
function digit(req: Request): string { return String((req.body?.Digits ?? "") as string).trim(); }
async function newVR(): Promise<any> {
  const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
  return new VoiceResponse();
}
function send(res: Response, v: any): Response { res.setHeader("Content-Type", "text/xml"); return res.send(v.toString()); }
function callerFrom(req: Request): string { return String((req.body?.From ?? "")).trim(); }
function callSidOf(req: Request): string { return String(req.body?.CallSid ?? "").trim(); }
function callerIdFor(req: Request): string | undefined {
  return callerFrom(req) || config.twilio.callerId || config.twilio.from || config.twilio.number || undefined;
}

// BF_SERVER_v820_WATCH_CALLS - a caller that ends at voicemail without anyone answering is a missed call: alert the
// person it was for (everyone when it was for a group). Never delays the TwiML.
function missedCall(req: Request, staffUserId: string | null): void {
  void alertMissedCall({ from: callerFrom(req) || null, staffUserId, silo: "BF", callSid: callSidOf(req) || null });
  closeRecord(req);
}

// BF_SERVER_v821_DIALER - the inbound call record (rx_<parent CallSid>) is over once the call ends unanswered.
function closeRecord(req: Request): void {
  const callSid = callSidOf(req);
  if (callSid) void closeCallRecord(pool, inboundRecordName(callSid));
}

async function cardAndRecord(req: Request): Promise<{ card: CallerCard | null; rec: string | null }> {
  const card = await callerCardForCall(pool, callerFrom(req));
  const rec = await openInboundRecord(pool, { callSid: callSidOf(req), from: callerFrom(req), card });
  return { card, rec };
}

function legRecordName(req: Request): string | null {
  const callSid = callSidOf(req);
  return callSid ? inboundRecordName(callSid) : null;
}

/** Voicemail: the prompt, then a recording stamped with the person's id (private to them) or the shared box. */
function voicemail(v: any, key: string, staffUserId: string | null): void {
  emit(v, key);
  emit(v, "record_prompt");
  const action = staffUserId ? `/api/webhooks/twilio/voicemail?staff=${encodeURIComponent(staffUserId)}` : "/api/webhooks/twilio/voicemail";
  v.record({ maxLength: 120, playBeep: true, action });
}

type Person = { userId: string; identity: string; name: string };

async function person(userId: string): Promise<Person | null> {
  try {
    const r = await pool.query<{ twilio_identity: string | null; first_name: string | null }>(
      `SELECT sp.twilio_identity, u.first_name FROM users u LEFT JOIN staff_presence sp ON sp.user_id = u.id
        WHERE u.id::text = $1 AND COALESCE(u.active, true) = true LIMIT 1`, [userId]);
    const row = r.rows[0];
    if (!row) return null;
    return { userId, identity: String(row.twilio_identity || userId), name: String(row.first_name || "").trim() || "The person you called" };
  } catch (err: any) {
    console.warn("[reception] person lookup failed", { message: err?.message });
    return null;
  }
}

/** Ringable app identities of the given users, in the given order, skipping anyone outside their call hours. */
async function ringableIdentities(userIds: string[]): Promise<Array<{ userId: string; identity: string }>> {
  if (!userIds.length) return [];
  try {
    const { rows } = await pool.query<{ user_id: string; twilio_identity: string }>(
      `SELECT u.id::text AS user_id, sp.twilio_identity
         FROM users u JOIN staff_presence sp ON sp.user_id = u.id
        WHERE u.id::text = ANY($1::text[])
          AND ${ringableStaffSql("sp", "u")}
          AND coalesce(u.active, true) = true`,
      [userIds],
    );
    const found = rows.filter((r) => r.twilio_identity);
    const away = await identitiesOutsideHours(pool, found.map((r) => r.twilio_identity));
    const byUser = new Map(found.filter((r) => !away.has(r.twilio_identity)).map((r) => [r.user_id, r.twilio_identity]));
    return userIds.filter((id) => byUser.has(id)).map((id) => ({ userId: id, identity: byUser.get(id)! }));
  } catch (err: any) {
    console.warn("[reception] ringable lookup failed", { message: err?.message });
    return [];
  }
}

/** Where a reference in a callback URL points in the current menu: opt:<digit> | after | noanswer. */
export function targetForRef(menu: PhoneMenu, ref: string): MenuTarget | null {
  if (ref === "after") return menu.afterHours;
  if (ref === "noanswer") return menu.noAnswer.target;
  const m = /^opt:([1-9])$/.exec(ref);
  return m ? menu.options.find((o) => o.digit === m[1])?.target ?? null : null;
}

type RouteCtx = {
  ref: string;
  /** true once the menu's no-answer fallback is running: an unanswered fallback ends at voicemail (no loops). */
  fallback: boolean;
  /** The person who was rung before (their voicemail is the default fallback). */
  forUserId: string | null;
};

const q = (ctx: RouteCtx, extra = ""): string =>
  `ref=${encodeURIComponent(ctx.ref)}${ctx.fallback ? "&fb=1" : ""}${ctx.forUserId ? `&for=${encodeURIComponent(ctx.forUserId)}` : ""}${extra}`;

function ctxFrom(req: Request): RouteCtx {
  const forId = String(req.query.for ?? "").trim();
  return { ref: String(req.query.ref ?? "").trim(), fallback: String(req.query.fb ?? "") === "1", forUserId: /^[0-9a-f-]{36}$/i.test(forId) ? forId : null };
}

/** Builds the TwiML that sends the caller to a menu target. */
async function routeTarget(v: any, req: Request, menu: PhoneMenu, target: MenuTarget | null, ctx: RouteCtx): Promise<void> {
  if (!target) { missedCall(req, null); voicemail(v, "nobody_available", null); return; }
  const ringSeconds = menu.noAnswer.ringSeconds;
  if (target.type === "voicemail") {
    const who = target.userId ?? ctx.forUserId;
    missedCall(req, who);
    voicemail(v, ctx.fallback ? "nobody_answered" : "vm_prompt", who);
    return;
  }
  if (target.type === "meeting") { v.redirect({ method: "POST" }, `${BASE}/meeting`); return; }
  if (target.type === "ai") {
    const g = v.gather({ input: "speech", speechTimeout: "auto", timeout: 6, action: `${BASE}/ai?${q(ctx)}`, method: "POST" });
    emit(g, "ai_prompt");
    v.redirect({ method: "POST" }, `${BASE}/ai?${q(ctx)}`);
    return;
  }
  if (target.type === "user") {
    const p = await person(target.userId);
    if (!p) { await routeNoAnswer(v, req, menu, ctx); return; }
    // BF_SERVER_v821_DIALER / BF_SERVER_v830_DIALER_CONTROLS - outside their call hours, or Busy: "{Name} is away
    // right now", press 1 if urgent, else their voicemail.
    const away = await awayStatus(pool, p.userId);
    if (away.away || await ownerIsBusy(pool, p.userId)) {
      awayTwiml(v, { name: p.name, userId: p.userId, urgentPassthrough: away.away ? away.urgentPassthrough : true, ring: "menu" });
      return;
    }
    emit(v, "connecting");
    await ringDirectLine(v, pool, { owner: { userId: p.userId, identity: p.identity }, from: callerFrom(req), callSid: callSidOf(req), ringSeconds, fromMenu: !ctx.fallback });
    return;
  }
  // group
  const ready = await ringableIdentities(target.userIds);
  if (!ready.length) { await routeNoAnswer(v, req, menu, ctx); return; }
  const { card, rec } = await cardAndRecord(req);
  if (rec) v.say({ voice: VOICE }, RECORDING_NOTICE);
  emit(v, "connecting");
  if (target.strategy === "sequential") {
    const first = ready[0]!;
    const action = `${BASE}/group-next?${q(ctx, `&after=${encodeURIComponent(first.userId)}`)}`;
    const dial = v.dial({ answerOnBridge: true, timeout: ringSeconds, action, method: "POST", callerId: callerIdFor(req), ...recordingDialAttrs(rec) });
    dialClient(dial, first.identity, card, legStatusAttrs(rec ?? legRecordName(req), first.identity));
    return;
  }
  const dial = v.dial({ answerOnBridge: true, timeout: ringSeconds, action: `${BASE}/no-answer?${q(ctx)}`, method: "POST", callerId: callerIdFor(req), ...recordingDialAttrs(rec) });
  for (const r of ready) dialClient(dial, r.identity, card, legStatusAttrs(rec ?? legRecordName(req), r.identity));
}

/** Nobody picked up (or nobody could be rung): the menu's no-answer fallback, once; after that, voicemail. */
async function routeNoAnswer(v: any, req: Request, menu: PhoneMenu, ctx: RouteCtx): Promise<void> {
  if (ctx.fallback) {
    missedCall(req, ctx.forUserId);
    voicemail(v, "nobody_answered", ctx.forUserId);
    return;
  }
  await routeTarget(v, req, menu, menu.noAnswer.target, { ref: "noanswer", fallback: true, forUserId: ctx.forUserId });
}

/** BF_SERVER_v827_CONFERENCE_DIAL - speech that is really the greeting heard back (speakerphone echo), not an answer. */
export function looksLikeEcho(speechText: string): boolean {
  const s = String(speechText ?? "").toLowerCase();
  if (!s) return false;
  return /\bpress\b|this call may be recorded|thank you for calling/.test(s) || s.split(/\s+/).filter(Boolean).length > 12;
}

router.get("/voice", safeHandler(async (req: Request, res: Response) => {
  const key = String(req.query.key || "");
  const text = PHRASES[key];
  if (!text) return res.status(404).end();
  let buf = audioCache.get(key);
  if (!buf) {
    const rendered = await renderNova(text);
    if (!rendered) return res.status(503).end();
    audioCache.set(key, rendered);
    buf = rendered;
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.send(buf);
}));

// KS_SETTINGS_PACK_v1_PHONE_MENU - an uploaded greeting, fetched by Twilio's <Play> (ids are random UUIDs).
router.get("/audio/:id", safeHandler(async (req: Request, res: Response) => {
  const audio = await readAudio(pool, String(req.params.id ?? ""));
  if (!audio) return res.status(404).end();
  res.setHeader("Content-Type", audio.content_type);
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.send(audio.bytes);
}));

// The greeting. Open: greeting + options in one <Gather> (up to 8 keys ending with # so "meeting key + access code"
// joins in one step). Closed or a holiday: the after-hours greeting, then the after-hours choice.
router.post("/greeting", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const { menu } = await loadMenu(pool);
  const v = await newVR();
  const again = String(req.query.again ?? "") === "1";
  const status = officeOpen(menu, new Date());
  console.log(JSON.stringify({ event: "phone_menu_greeting", callSid: callSidOf(req) || null, open: status.open, holiday: status.holiday, again }));
  if (!status.open) {
    speak(v, menu.afterHoursGreeting, menu.afterHoursGreeting.mode === "tts" ? menu.afterHoursGreeting.text : "");
    await routeTarget(v, req, menu, menu.afterHours, { ref: "after", fallback: false, forUserId: null });
    return send(res, v);
  }
  if (!menu.options.length) {
    speak(v, menu.greeting, menu.greeting.mode === "tts" ? menu.greeting.text : "");
    await routeNoAnswer(v, req, menu, { ref: "noanswer", fallback: false, forUserId: null });
    return send(res, v);
  }
  const action = `${BASE}/choice${again ? "?again=1" : ""}`;
  const g = v.gather({ input: "speech dtmf", numDigits: 8, finishOnKey: "#", speechTimeout: "auto", timeout: 4, action, method: "POST" });
  if (again) g.say({ voice: VOICE }, optionsPrompt(menu));
  else speak(g, menu.greeting, greetingText(menu));
  v.redirect({ method: "POST" }, action);
  return send(res, v);
}));

async function choose(req: Request, res: Response) {
  const { menu } = await loadMenu(pool);
  const raw = digit(req).replace(/[^0-9]/g, "");
  const d = raw.slice(0, 1);
  let s = speech(req);
  const again = String(req.query.again ?? "") === "1";
  // BF_SERVER_v827_CONFERENCE_DIAL - the greeting heard back through a speakerphone is not an answer.
  if (!raw && looksLikeEcho(s)) {
    console.log(JSON.stringify({ event: "reception_echo_ignored", callSid: callSidOf(req) || null, speech: s }));
    s = "";
  }
  let option: MenuOption | null = d ? menu.options.find((o) => o.digit === d) ?? null : null;
  if (!option && s) option = matchSpeech(menu, s);
  console.log(JSON.stringify({ event: "phone_menu_choice", callSid: callSidOf(req) || null, digits: raw || null, speech: s || null, option: option?.digit ?? null, again }));
  const v = await newVR();
  // BF_SERVER_v827_CONFERENCE_DIAL - a key and the six-digit access code in one go ("3" + code + #, as invitations
  // say) joins that meeting, whatever the menu's options are.
  if (raw.length === 7) {
    v.redirect({ method: "POST" }, `${BASE}/meeting-code?try=0&code=${raw.slice(1)}`);
    return send(res, v);
  }
  if (!option) {
    // One more go with the options, then the no-answer fallback.
    if (!again) {
      emit(v, "menu_retry");
      v.redirect({ method: "POST" }, `${BASE}/greeting?again=1`);
      return send(res, v);
    }
    await routeNoAnswer(v, req, menu, { ref: "noanswer", fallback: false, forUserId: null });
    return send(res, v);
  }
  await routeTarget(v, req, menu, option.target, { ref: `opt:${option.digit}`, fallback: false, forUserId: null });
  return send(res, v);
}

router.post("/choice", twilioWebhookValidation, safeHandler(choose));
// Calls already in progress when this version deployed may still post to the old paths.
router.post("/company", twilioWebhookValidation, safeHandler(choose));
router.post("/intent", twilioWebhookValidation, safeHandler(choose));

// A group or person <Dial> ended. Answered: hang up. Unanswered: the no-answer fallback.
router.post("/no-answer", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  if (!dialWasNotAnswered(req.body?.DialCallStatus)) { closeRecord(req); v.hangup(); return send(res, v); }
  const { menu } = await loadMenu(pool);
  await routeNoAnswer(v, req, menu, ctxFrom(req));
  return send(res, v);
}));

// One-at-a-time group: ring the next person after `after`, then the no-answer fallback.
router.post("/group-next", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  if (!dialWasNotAnswered(req.body?.DialCallStatus)) { closeRecord(req); v.hangup(); return send(res, v); }
  const { menu } = await loadMenu(pool);
  const ctx = ctxFrom(req);
  const target = targetForRef(menu, ctx.ref);
  if (callerHungUp(req.body) || !target || target.type !== "group") { await routeNoAnswer(v, req, menu, ctx); return send(res, v); }
  const after = String(req.query.after ?? "");
  const rest = target.userIds.slice(target.userIds.indexOf(after) + 1);
  const ready = await ringableIdentities(rest);
  const next = ready[0];
  if (!next || target.userIds.indexOf(after) < 0) { await routeNoAnswer(v, req, menu, ctx); return send(res, v); }
  const { card, rec } = await cardAndRecord(req);
  const action = `${BASE}/group-next?${q(ctx, `&after=${encodeURIComponent(next.userId)}`)}`;
  const dial = v.dial({ answerOnBridge: true, timeout: menu.noAnswer.ringSeconds, action, method: "POST", callerId: callerIdFor(req), ...recordingDialAttrs(rec) });
  dialClient(dial, next.identity, card, legStatusAttrs(rec ?? legRecordName(req), next.identity));
  return send(res, v);
}));

/** The AI receptionist's pick: the option the caller's words point to (OpenAI when configured, else keywords). */
export async function aiPick(menu: PhoneMenu, said: string, opts: { timeoutMs?: number } = {}): Promise<MenuOption | null> {
  const candidates = menu.options.filter((o) => o.target.type !== "ai");
  if (!said.trim() || !candidates.length) return null;
  const byWords = matchSpeech({ ...menu, options: candidates }, said);
  if (byWords) return byWords;
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const client = sharedOpenAI(process.env.OPENAI_API_KEY);
    const list = candidates.map((o) => `${o.digit}: ${o.label}${o.keywords.length ? ` (${o.keywords.join(", ")})` : ""}`).join("\n");
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? 3500));
    const call = client.chat.completions.create({
      model: process.env.RECEPTION_AI_MODEL || "gpt-5.4-mini",
      messages: [
        { role: "system", content: `You route phone calls for ${brandName()}. Reply with only the number of the best option, or 0 if none fits.` },
        { role: "user", content: `Options:\n${list}\n\nThe caller said: "${said.slice(0, 400)}"` },
      ],
    }).then((r) => String(r.choices?.[0]?.message?.content ?? "").trim());
    const answer = await Promise.race([call, timeout]);
    const d = /[1-9]/.exec(String(answer ?? ""))?.[0];
    return d ? candidates.find((o) => o.digit === d) ?? null : null;
  } catch (err) {
    console.warn("[reception] AI receptionist routing failed; taking a message", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

router.post("/ai", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const { menu } = await loadMenu(pool);
  const ctx = ctxFrom(req);
  const said = speech(req);
  const option = await aiPick(menu, said);
  console.log(JSON.stringify({ event: "phone_menu_ai", callSid: callSidOf(req) || null, speech: said || null, option: option?.digit ?? null }));
  const v = await newVR();
  if (option && option.target.type !== "ai") {
    await routeTarget(v, req, menu, option.target, { ref: `opt:${option.digit}`, fallback: ctx.fallback, forUserId: ctx.forUserId });
    return send(res, v);
  }
  missedCall(req, ctx.forUserId);
  voicemail(v, "ai_message", ctx.forUserId);
  return send(res, v);
}));

// BF_SERVER_MEETING_ROOMS_v736 - ask for the access code (two tries), then drop the caller into that meeting.
router.post("/meeting", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const tries = Number(req.query.try ?? 0) || 0;
  const g = v.gather({ input: "dtmf", numDigits: 6, finishOnKey: "#", timeout: 10, action: `${BASE}/meeting-code?try=${tries}`, method: "POST" });
  emit(g, tries > 0 ? "meeting_retry" : "meeting_prompt");
  v.redirect({ method: "POST" }, `${BASE}/meeting-code?try=${tries}`);
  return send(res, v);
}));

router.post("/meeting-code", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const tries = Number(req.query.try ?? 0) || 0;
  const { findOpenRoomByCode, conferenceName, roomConferenceAttrs } = await import("../services/meetingRooms.js");
  const entered = typeof req.query.code === "string" && /^[0-9]{6}$/.test(req.query.code) ? req.query.code : digit(req);
  const room = await findOpenRoomByCode(entered).catch((err: unknown) => {
    console.error("[meeting] code lookup failed", err instanceof Error ? err.message : String(err));
    return null;
  });
  console.log(JSON.stringify({ event: "meeting_code", callSid: callSidOf(req) || null, matched: Boolean(room), try: tries }));
  if (room) {
    emit(v, "meeting_joining");
    const dial = v.dial();
    // BF_SERVER_v786_ROOM_RECORDINGS - status + recording callbacks so the room is recorded into the CRM.
    dial.conference(roomConferenceAttrs(room.id, String(req.body?.From ?? req.body?.Caller ?? "") || null) as any, conferenceName(room.id));
    return send(res, v);
  }
  if (tries < 1) { v.redirect({ method: "POST" }, `${BASE}/meeting?try=${tries + 1}`); return send(res, v); }
  emit(v, "meeting_failed");
  v.redirect({ method: "POST" }, `${BASE}/greeting?again=1`);
  return send(res, v);
}));

// BF_SERVER_v820_WATCH_CALLS - call screening on the staff cell leg: "{Brokerage} call from {name}. Press 1 to accept."
router.post("/screen", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const from = String(req.query.from ?? "").trim() || callerFrom(req);
  const label = await callerLabel(pool, from);
  const g = v.gather({ input: "dtmf", numDigits: 1, timeout: SCREEN_GATHER_TIMEOUT_SECONDS, action: `${BASE}/screen-result`, method: "POST" });
  g.say({ voice: VOICE }, `${brandName()} call from ${label}. Press 1 to accept.`);
  v.hangup();
  return send(res, v);
}));

router.post("/screen-result", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  if (digit(req) === "1") {
    // Ending the screening TwiML without a hangup bridges this leg to the caller.
    v.say({ voice: VOICE }, "Connecting.");
    return send(res, v);
  }
  v.hangup();
  return send(res, v);
}));

router.post("/fallback", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const s = speech(req); const d = digit(req);
  const v = await newVR();
  const wantsVoicemail = d === "2" || /voicemail|voice mail|\bvm\b|message later/.test(s);
  emit(v, wantsVoicemail ? "vm_prompt" : "msg_prompt");
  v.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail" });
  return send(res, v);
}));

// BF_SERVER_v820_WATCH_CALLS - the cell leg of a person's ring: a screened <Number>.
function dialCell(v: any, cell: string, action: string, callerId: string | undefined, from: string, rec: string | null, identity: string | null): void {
  const dial = v.dial({ answerOnBridge: true, timeout: CELL_RING_TIMEOUT_SECONDS, action, method: "POST", callerId, ...recordingDialAttrs(rec) });
  dial.number({ url: screenUrl(from), method: "POST", ...legStatusAttrs(rec, identity) }, cell);
}

// BF_SERVER_DIRECT_LINES_v688 - nobody answered a person (their direct line, or a menu option). The opted-in cell
// first (once); then their voicemail, or - when they were reached through the phone menu (menu=1) - the menu's
// no-answer fallback.
router.post("/direct-unavailable", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  if (!dialWasNotAnswered(req.body?.DialCallStatus)) { closeRecord(req); return send(res, v); }
  const userId = String(req.query.user ?? "").trim() || null;
  const fromMenu = String(req.query.menu ?? "") === "1";
  if (userId && String(req.query.cell ?? "") === "1" && !callerHungUp(req.body)) {
    const cell = await verifiedWatchCell(pool, userId);
    if (cell) {
      const from = callerFrom(req);
      const { rec } = await cardAndRecord(req);
      dialCell(v, cell, `${BASE}/direct-unavailable?user=${encodeURIComponent(userId)}${fromMenu ? "&menu=1" : ""}`, from || undefined, from, rec, userId);
      return send(res, v);
    }
  }
  if (fromMenu && userId && /^[0-9a-f-]{36}$/i.test(userId)) {
    const { menu } = await loadMenu(pool);
    await routeNoAnswer(v, req, menu, { ref: "noanswer", fallback: false, forUserId: userId });
    return send(res, v);
  }
  missedCall(req, userId);
  let name = "The person you called";
  if (userId) {
    try {
      const r = await pool.query<{ first_name: string | null }>(`SELECT first_name FROM users WHERE id::text = $1 LIMIT 1`, [userId]);
      if (r.rows[0]?.first_name) name = String(r.rows[0].first_name);
    } catch (err: any) {
      console.warn("[reception] direct line name lookup failed", { message: err?.message });
    }
  }
  emit(v, "direct_noanswer", `Sorry, ${name} isn't available right now.`);
  staffVoicemail(v, userId);
  return send(res, v);
}));

// BF_SERVER_v821_DIALER - the away prompt's answer. 1 -> ring the person anyway; any other key -> their voicemail.
// ring = direct (their direct line) | menu (chosen in the phone menu: unanswered follows the menu's fallback).
router.post("/away-choice", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const userId = String(req.query.user ?? "").trim();
  const ring = String(req.query.ring ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(userId)) { staffVoicemail(v, null); return send(res, v); }
  if (digit(req) !== "1") { staffVoicemail(v, userId); return send(res, v); }
  console.log(JSON.stringify({ event: "call_hours_urgent_passthrough", callSid: callSidOf(req) || null, staffUserId: userId, ring }));
  const owner = ring === "direct" || ring === "menu" ? await person(userId) : null;
  if (!owner) { staffVoicemail(v, userId); return send(res, v); }
  await ringDirectLine(v, pool, { owner: { userId, identity: owner.identity }, from: callerFrom(req), callSid: callSidOf(req), fromMenu: ring === "menu" });
  return send(res, v);
}));

// BF_SERVER_v821_DIALER - a staff leg of a recorded <Dial> was answered / ended (Twilio statusCallback).
router.post("/leg-status", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const friendlyName = String(req.query.conf ?? "").trim();
  const identity = String(req.query.identity ?? "").trim();
  const callSid = callSidOf(req);
  if (friendlyName && identity && callSid) {
    await recordLegStatus(pool, { friendlyName, identity, callSid, status: String(req.body?.CallStatus ?? ""), parentCallSid: String(req.body?.ParentCallSid ?? "").trim() || null }); // BF_SERVER_v829_DIALER_RELIABILITY
  }
  return res.status(204).end();
}));

// BF_SERVER_v821_DIALER - <Number url>: the called party hears the recording notice before being connected.
router.post("/recording-notice", twilioWebhookValidation, safeHandler(async (_req: Request, res: Response) => {
  const v = await newVR();
  v.say({ voice: VOICE }, RECORDING_NOTICE);
  return send(res, v);
}));

if (novaOn()) { void warmReceptionVoice(); }

export default router;
