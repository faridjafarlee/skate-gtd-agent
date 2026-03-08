import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { normalizePermissionMode, listOrgIds, loadOrgRestrictions, _resetOrgRestrictionsCache } from "../../src/storage/config.js";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";

describe("Permission mode and org parity", () => {
  describe("Permission mode aliases (Claude parity)", () => {
    it("normalizes acceptEdits to accept-edits", () => {
      expect(normalizePermissionMode("acceptEdits")).toBe("accept-edits");
    });

    it("normalizes dontAsk to dont-ask", () => {
      expect(normalizePermissionMode("dontAsk")).toBe("dont-ask");
    });

    it("normalizes bypassPermissions to bypass", () => {
      expect(normalizePermissionMode("bypassPermissions")).toBe("bypass");
    });

    it("returns canonical modes unchanged", () => {
      expect(normalizePermissionMode("default")).toBe("default");
      expect(normalizePermissionMode("plan")).toBe("plan");
      expect(normalizePermissionMode("accept-edits")).toBe("accept-edits");
      expect(normalizePermissionMode("dont-ask")).toBe("dont-ask");
      expect(normalizePermissionMode("bypass")).toBe("bypass");
    });

    it("returns undefined for unknown mode", () => {
      expect(normalizePermissionMode("unknown")).toBeUndefined();
    });
  });

  describe("Org list / use (multi-org)", () => {
    let dataDir: string;
    const originalGTD_DATA_DIR = process.env.GTD_DATA_DIR;
    const originalGTD_ORG_CONFIG = process.env.GTD_ORG_CONFIG;

    beforeEach(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "gtd-org-"));
      process.env.GTD_DATA_DIR = dataDir;
      delete process.env.GTD_ORG_CONFIG;
    });

    afterEach(async () => {
      _resetOrgRestrictionsCache();
      process.env.GTD_DATA_DIR = originalGTD_DATA_DIR;
      process.env.GTD_ORG_CONFIG = originalGTD_ORG_CONFIG;
    });

    it("listOrgIds returns [] when no org file", async () => {
      const ids = await listOrgIds();
      expect(ids).toEqual([]);
    });

    it("listOrgIds returns [default] for legacy single-org file", async () => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        join(dataDir, "org.json"),
        JSON.stringify({ allowedQualityProfiles: ["fast"] }),
        "utf-8"
      );
      const ids = await listOrgIds();
      expect(ids).toEqual(["default"]);
    });

    it("listOrgIds returns org keys for multi-org file", async () => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        join(dataDir, "org.json"),
        JSON.stringify({
          orgs: {
            "team-a": { allowedQualityProfiles: ["fast"] },
            "team-b": { allowedQualityProfiles: ["balanced", "max"] },
          },
        }),
        "utf-8"
      );
      const ids = await listOrgIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain("team-a");
      expect(ids).toContain("team-b");
    });

    it("loadOrgRestrictions loads correct org when currentOrgId given", async () => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        join(dataDir, "org.json"),
        JSON.stringify({
          orgs: {
            "team-a": { allowedQualityProfiles: ["fast"] },
            "team-b": { allowedQualityProfiles: ["balanced", "max"] },
          },
        }),
        "utf-8"
      );
      const orgB = await loadOrgRestrictions("team-b");
      expect(orgB).not.toBeNull();
      expect(orgB!.allowedQualityProfiles).toEqual(["balanced", "max"]);
    });
  });
});
