/**
 * Orchestration engine - state machine with risk-based approval gates.
 * Placeholder for full implementation.
 */

import type { Task, Plan, OrchestratorPhase } from "../types/index.js";
import { selectRolesForTask } from "../core/agents/registry.js";

export type OrchestratorState = {
  phase: OrchestratorPhase;
  task: Task;
  plan?: Plan;
};

export function createOrchestratorState(task: Task): OrchestratorState {
  return {
    phase: "ingest",
    task,
  };
}

export function advancePhase(state: OrchestratorState): OrchestratorState {
  const phases: OrchestratorPhase[] = [
    "ingest",
    "classify",
    "select_roles",
    "draft_plan",
    "approval_gate",
    "execute",
    "verify",
    "report",
  ];
  const idx = phases.indexOf(state.phase);
  const next = phases[Math.min(idx + 1, phases.length - 1)];
  return { ...state, phase: next };
}

export function selectRoles(state: OrchestratorState): string[] {
  return selectRolesForTask(state.task.qualityProfile, state.task.description);
}

