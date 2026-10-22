// KS_SERVER_v10_DEMO - the guided walkthrough's progress, kept on the session so a prospect can leave and come back
// (the magic link resumes at the step they were on). Steps can be completed, skipped, or the whole tour hidden.
import { DEMO_STEPS, isDemoStep, type DemoStep } from "./fixture.js";
import type { Walkthrough } from "./repo.js";

export type WalkthroughAction = "view" | "complete" | "skip" | "skip_tour" | "resume_tour";
export const WALKTHROUGH_ACTIONS: WalkthroughAction[] = ["view", "complete", "skip", "skip_tour", "resume_tour"];

export function nextStep(step: DemoStep): DemoStep {
  const i = DEMO_STEPS.indexOf(step);
  return DEMO_STEPS[Math.min(i + 1, DEMO_STEPS.length - 1)]!;
}

export function applyWalkthrough(w: Walkthrough, action: WalkthroughAction, step?: unknown): Walkthrough | { error: string } {
  if (action === "skip_tour") return { ...w, tour_skipped: true };
  if (action === "resume_tour") return { ...w, tour_skipped: false };
  if (!isDemoStep(step)) return { error: "unknown_step" };
  if (action === "view") return { ...w, current: step };
  if (action === "complete") {
    return {
      ...w,
      completed: w.completed.includes(step) ? w.completed : [...w.completed, step],
      skipped: w.skipped.filter((s) => s !== step),
      current: nextStep(step),
    };
  }
  // skip: a step already completed stays completed.
  return {
    ...w,
    skipped: w.completed.includes(step) || w.skipped.includes(step) ? w.skipped : [...w.skipped, step],
    current: nextStep(step),
  };
}

/** Marks a step completed by doing the thing (e.g. submitting) even when the prospect never pressed "Next". */
export function completeByAction(w: Walkthrough, step: DemoStep): Walkthrough {
  if (w.completed.includes(step)) return w;
  return { ...w, completed: [...w.completed, step], skipped: w.skipped.filter((s) => s !== step) };
}
