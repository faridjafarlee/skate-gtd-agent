import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, saveConfig, getConfigForChannel, _resetConfigCache } from "../../src/storage/config.js";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("Config", () => {
  const originalGTD_ENV = process.env.GTD_ENV;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "gtd-config-"));
    process.env.GTD_DATA_DIR = dir;
    delete process.env.GTD_ENV;
    _resetConfigCache();
  });

  afterEach(() => {
    process.env.GTD_ENV = originalGTD_ENV;
  });

  it("returns defaults when config file does not exist and creates file", async () => {
    const cfg = await loadConfig();
    expect(cfg.qualityProfile).toBe("balanced");
    expect(cfg.approvalPolicy).toBe("hybrid");
    expect(cfg.defaultModel).toBeUndefined();

    const dir = process.env.GTD_DATA_DIR!;
    const raw = await readFile(join(dir, "config.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.qualityProfile).toBe("balanced");
    expect(data.approvalPolicy).toBe("hybrid");
  });

  it("loads saved config", async () => {
    await saveConfig({ qualityProfile: "max", approvalPolicy: "auto" });
    _resetConfigCache();

    const cfg = await loadConfig();
    expect(cfg.qualityProfile).toBe("max");
    expect(cfg.approvalPolicy).toBe("auto");
  });

  it("merge partial config on save", async () => {
    await saveConfig({ qualityProfile: "fast" });
    _resetConfigCache();
    await saveConfig({ defaultModel: "gpt-4o" });

    const cfg = await loadConfig();
    expect(cfg.qualityProfile).toBe("fast");
    expect(cfg.approvalPolicy).toBe("hybrid");
    expect(cfg.defaultModel).toBe("gpt-4o");
  });

  it("getConfigForChannel merges channel overrides", async () => {
    await saveConfig({
      qualityProfile: "balanced",
      approvalPolicy: "hybrid",
      channels: {
        telegram: { qualityProfile: "fast", approvalPolicy: "auto" },
        cli: { qualityProfile: "max" },
      },
    });
    _resetConfigCache();

    const cfg = await loadConfig();
    const telegramCfg = getConfigForChannel(cfg, "telegram");
    const cliCfg = getConfigForChannel(cfg, "cli");
    const slackCfg = getConfigForChannel(cfg, "slack");

    expect(telegramCfg.qualityProfile).toBe("fast");
    expect(telegramCfg.approvalPolicy).toBe("auto");
    expect(cliCfg.qualityProfile).toBe("max");
    expect(cliCfg.approvalPolicy).toBe("hybrid");
    expect(slackCfg.qualityProfile).toBe("balanced");
    expect(slackCfg.approvalPolicy).toBe("hybrid");
  });

  it("loads config.${GTD_ENV}.json when GTD_ENV is set", async () => {
    const dir = process.env.GTD_DATA_DIR!;
    await writeFile(join(dir, "config.json"), JSON.stringify({ qualityProfile: "balanced" }), "utf-8");
    await writeFile(join(dir, "config.production.json"), JSON.stringify({ qualityProfile: "max", approvalPolicy: "auto" }), "utf-8");
    _resetConfigCache();

    process.env.GTD_ENV = "production";
    _resetConfigCache();
    const cfg = await loadConfig();
    expect(cfg.qualityProfile).toBe("max");
    expect(cfg.approvalPolicy).toBe("auto");
  });

  it("falls back to config.json when config.${GTD_ENV}.json does not exist", async () => {
    const dir = process.env.GTD_DATA_DIR!;
    await writeFile(join(dir, "config.json"), JSON.stringify({ qualityProfile: "fast" }), "utf-8");
    _resetConfigCache();

    process.env.GTD_ENV = "staging";
    _resetConfigCache();
    const cfg = await loadConfig();
    expect(cfg.qualityProfile).toBe("fast");
  });

  it("saveConfig writes to config.${GTD_ENV}.json when GTD_ENV is set", async () => {
    process.env.GTD_ENV = "production";
    _resetConfigCache();
    await saveConfig({ qualityProfile: "max" });
    _resetConfigCache();

    const dir = process.env.GTD_DATA_DIR!;
    const raw = await readFile(join(dir, "config.production.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.qualityProfile).toBe("max");
  });
});
