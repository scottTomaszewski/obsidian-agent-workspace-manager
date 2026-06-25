import type { DesiredStatus, AgentState } from "./types";

export type ReconcileAction =
  | "launch"
  | "markFailed"
  | "killAndIdle"
  | "offerMerge"
  | "none";

export function decide(input: {
  desired: DesiredStatus;
  actual: AgentState;
  sessionAlive: boolean;
}): ReconcileAction {
  const { desired, actual, sessionAlive } = input;

  if (desired === "Pending") return "none";
  if (desired === "Completed") return "offerMerge";
  if (desired === "Cancelled") return sessionAlive ? "killAndIdle" : "none";

  // desired === "Running"
  if (sessionAlive) return "none";
  switch (actual) {
    case "Running":
    case "Waiting":
      return "markFailed"; // session vanished mid-flight
    case "NeedsReview":
    case "Failed":
      return "none"; // terminal until user intervenes
    default:
      return "launch"; // "" or "Idle"
  }
}
