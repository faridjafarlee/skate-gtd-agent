import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkConfigSecrets } from "../../src/governance/secrets.js";
import { loadPolicyBundle, resolvePolicy } from "../../src/security/policy.js";
import {
  isConfigLocked,
  setConfigLock,
  loadOrgRestrictions,
  applyOrgRestrictions,
  validateConfigAgainstOrg,
  _resetOrgRestrictionsCache,
} from "../../src/storage/config.js";
import { mkdir, writeFile } from "fs/promises";
import { mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("Governance parity", () => {
  let dataDir: string;
  const originalGTD_DATA_DIR = process.env.GTD_DATA_DIR;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "gtd-gov-"));
    process.env.GTD_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    await setConfigLock(false);
    _resetOrgRestrictionsCache();
    process.env.GTD_DATA_DIR = originalGTD_DATA_DIR;
    delete process.env.GTD_ORG_CONFIG;
  });
  describe("Secrets check", () => {
    it("returns ok for config without sensitive keys", () => {
      const result = checkConfigSecrets({ qualityProfile: "balanced" });
      expect(result.ok).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it("warns when config has key that looks like secret", () => {
      const result = checkConfigSecrets({ qualityProfile: "balanced", apiKey: "sk-12345678" } as never);
      expect(result.ok).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("Policy bundle", () => {
    it("loadPolicyBundle returns null for missing file", async () => {
      const policy = await loadPolicyBundle(join(tmpdir(), `nonexistent-${Date.now()}.json`));
      expect(policy).toBeNull();
    });

    it("loadPolicyBundle loads valid JSON and resolvePolicy merges bundle", async () => {
      const dir = join(tmpdir(), `policy-${Date.now()}`);
      await mkdir(dir, { recursive: true });
      const path = join(dir, "policy.json");
      await writeFile(
        path,
        JSON.stringify({ mode: "plan", deniedPaths: ["/etc/*"] }),
        "utf-8"
      );
      const bundle = await loadPolicyBundle(path);
      expect(bundle).not.toBeNull();
      expect(bundle!.mode).toBe("plan");
      expect(bundle!.deniedPaths).toContain("/etc/*");
      const policy = resolvePolicy({ mode: "dont-ask" }, bundle);
      expect(policy.mode).toBe("dont-ask");
      expect(policy.deniedPaths).toContain("/etc/*");
    });
  });

  describe("Config lock", () => {
    it("isConfigLocked false when no lock", async () => {
      const locked = await isConfigLocked();
      expect(locked).toBe(false);
    });

    it("setConfigLock and isConfigLocked roundtrip", async () => {
      await setConfigLock(true);
      expect(await isConfigLocked()).toBe(true);
      await setConfigLock(false);
      expect(await isConfigLocked()).toBe(false);
    });
  });

  describe("Org restrictions", () => {
    it("loadOrgRestrictions returns null when no org file", async () => {
      const org = await loadOrgRestrictions();
      expect(org).toBeNull();
    });

    it("applyOrgRestrictions enforces allowed lists", () => {
      const cfg = { qualityProfile: "max" as const, approvalPolicy: "auto" as const };
      const org = { allowedQualityProfiles: ["fast", "balanced"], allowedApprovalPolicies: ["hybrid"] };
      const out = applyOrgRestrictions(cfg, org);
      expect(out.qualityProfile).toBe("fast");
      expect(out.approvalPolicy).toBe("hybrid");
    });

    it("validateConfigAgainstOrg throws for disallowed value", () => {
      const org = { allowedQualityProfiles: ["fast"] };
      expect(() => validateConfigAgainstOrg({ qualityProfile: "max" }, org)).toThrow("Org restrictions");
    });
  });
});
