import { describe, it, expect } from "vitest";
import {
  getRoleDef,
  getAllRoles,
  getRolesForProfile,
  selectRolesForTask,
} from "../../src/core/agents/registry.js";

describe("Agent Registry", () => {
  it("returns all role definitions", () => {
    const roles = getAllRoles();
    expect(roles).toHaveLength(6);
    expect(roles.map((r) => r.id)).toContain("scout");
    expect(roles.map((r) => r.id)).toContain("red_team");
  });

  it("returns role def by id", () => {
    const scout = getRoleDef("scout");
    expect(scout).toBeDefined();
    expect(scout?.name).toBe("Scout");
    expect(scout?.capabilities).toContain("exploration");
  });

  it("maps quality profiles to role sets", () => {
    expect(getRolesForProfile("fast")).toHaveLength(3);
    expect(getRolesForProfile("balanced")).toHaveLength(5);
    expect(getRolesForProfile("max")).toHaveLength(6);
    expect(getRolesForProfile("max")).toContain("red_team");
  });

  it("selectRolesForTask returns roles for profile", () => {
    const roles = selectRolesForTask("balanced", "Write a function");
    expect(roles).toHaveLength(5);
    expect(roles).toContain("builder");
  });
});
