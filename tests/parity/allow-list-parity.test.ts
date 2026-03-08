import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getSessionAllow,
  addToSessionAllow,
  loadProjectAllow,
  addToProjectAllow,
  allowListKey,
  isInSessionAllow,
  isInProjectAllow,
} from "../../src/security/allow-list.js";
import { checkToolPermission } from "../../src/security/policy.js";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";

describe("Allow list parity (don't ask again)", () => {
  beforeEach(() => {
    getSessionAllow().clear();
  });

  afterEach(() => {
    getSessionAllow().clear();
  });

  describe("allowListKey", () => {
    it("formats tool:category", () => {
      expect(allowListKey("run_command", "command")).toBe("run_command:command");
    });
  });

  describe("session allow", () => {
    it("addToSessionAllow and isInSessionAllow", () => {
      expect(isInSessionAllow("run_command", "command")).toBe(false);
      addToSessionAllow("run_command", "command");
      expect(isInSessionAllow("run_command", "command")).toBe(true);
    });
  });

  describe("project allow", () => {
    let cwd: string;

    beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), "gtd-allow-"));
    });

    it("loadProjectAllow returns empty set when no file", async () => {
      const set = await loadProjectAllow(cwd);
      expect(set.size).toBe(0);
    });

    it("addToProjectAllow creates .gtd/allow.json and loadProjectAllow reads it", async () => {
      await addToProjectAllow(cwd, "write_file", "write");
      const set = await loadProjectAllow(cwd);
      expect(set.has(allowListKey("write_file", "write"))).toBe(true);
    });

    it("isInProjectAllow returns true when key in set", () => {
      const set = new Set([allowListKey("run_command", "command")]);
      expect(isInProjectAllow(set, "run_command", "command")).toBe(true);
      expect(isInProjectAllow(set, "write_file", "write")).toBe(false);
    });
  });

  describe("policy check with allowList", () => {
    it("returns allow when tool:category is in session allowList", () => {
      const session = new Set<string>();
      const project = new Set<string>();
      session.add(allowListKey("run_command", "command"));
      const result = checkToolPermission("run_command", "command", {
        mode: "default",
        allowList: { session, project },
      });
      expect(result).toBe("allow");
    });

    it("returns allow when tool:category is in project allowList", () => {
      const session = new Set<string>();
      const project = new Set<string>();
      project.add(allowListKey("web_fetch", "network"));
      const result = checkToolPermission("web_fetch", "network", {
        mode: "default",
        allowList: { session, project },
      });
      expect(result).toBe("allow");
    });
  });
});
