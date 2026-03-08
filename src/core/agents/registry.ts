import type { AgentRoleDef, QualityProfile } from "../../types/index.js";
import type { CustomAgentDef } from "../../storage/config.js";

const BUILTIN_ROLES: AgentRoleDef[] = [
  {
    id: "scout",
    name: "Scout",
    description: "Explores context, gathers requirements, and detects constraints",
    capabilities: ["exploration", "requirement_gathering", "constraint_detection"],
  },
  {
    id: "planner",
    name: "Planner",
    description: "Architecture and implementation planning",
    capabilities: ["planning", "architecture", "task_decomposition"],
  },
  {
    id: "builder",
    name: "Builder",
    description: "Implements plans and produces deliverables",
    capabilities: ["implementation", "code_generation", "file_operations"],
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description: "Code review and quality checks",
    capabilities: ["review", "quality_checks", "linting"],
  },
  {
    id: "documenter",
    name: "Documenter",
    description: "Documentation and README generation",
    capabilities: ["documentation", "readme", "comments"],
  },
  {
    id: "red_team",
    name: "Red Team",
    description: "Security and adversarial testing",
    capabilities: ["security", "adversarial_testing", "edge_cases"],
  },
];

/**
 * Maps quality profile to role sets.
 * fast: minimal roles for speed
 * balanced: standard set
 * max: all roles including red team
 */
const DEFAULT_PROFILE_ROLES: Record<QualityProfile, string[]> = {
  fast: ["scout", "planner", "builder"],
  balanced: ["scout", "planner", "builder", "reviewer", "documenter"],
  max: ["scout", "planner", "builder", "reviewer", "documenter", "red_team"],
};

export function getRoleDef(role: string, customAgents?: CustomAgentDef[]): AgentRoleDef | { id: string; name: string; description: string } | undefined {
  const builtin = BUILTIN_ROLES.find((r) => r.id === role);
  if (builtin) return builtin;
  const custom = customAgents?.find((a) => a.id === role);
  if (custom) return { id: custom.id, name: custom.name, description: custom.description ?? custom.prompt.slice(0, 80) };
  return undefined;
}

export function getCustomPrompt(roleId: string, customAgents?: CustomAgentDef[]): string | undefined {
  return customAgents?.find((a) => a.id === roleId)?.prompt;
}

export function getAllRoles(customAgents?: CustomAgentDef[]): Array<AgentRoleDef | { id: string; name: string; description: string }> {
  const builtin = [...BUILTIN_ROLES];
  if (!customAgents?.length) return builtin;
  const custom = customAgents.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description ?? a.prompt.slice(0, 80),
  }));
  return [...builtin, ...custom];
}

export function getRolesForProfile(profile: QualityProfile, profileOverrides?: Partial<Record<string, string[]>>): string[] {
  const override = profileOverrides?.[profile];
  if (override) return [...override];
  return [...DEFAULT_PROFILE_ROLES[profile]];
}

export function selectRolesForTask(
  profile: QualityProfile,
  _taskDescription?: string,
  profileOverrides?: Partial<Record<string, string[]>>
): string[] {
  return getRolesForProfile(profile, profileOverrides);
}
