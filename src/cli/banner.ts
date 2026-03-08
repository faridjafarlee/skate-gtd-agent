import chalk from "chalk";

const BOX = chalk.hex("#2ecc71");
const TITLE = chalk.hex("#2ecc71").bold;
const SUBTITLE = chalk.hex("#7bed9f");
const SKATE = chalk.hex("#7bed9f");
const SKATE_ACCENT = chalk.hex("#2ecc71");
const STATUS = chalk.hex("#2ecc71").bold;
const LABEL = chalk.hex("#3498db");
const VALUE = chalk.hex("#ecf0f1");

/**
 * Renders the Skate (manta ray / skate fish) ASCII banner with color.
 * Falls back to plain text when stdout is not a TTY or NO_COLOR is set.
 */
export function renderBanner(options?: {
  mode?: string;
  router?: string;
  agentsActive?: number;
  model?: string;
  /** Active profile name (e.g. work, quick). */
  profile?: string;
  /** Active persona (minimal, professional, poetic). */
  persona?: string;
}): string {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = useColor
    ? {
        box: BOX,
        title: TITLE,
        subtitle: SUBTITLE,
        skate: SKATE,
        accent: SKATE_ACCENT,
        status: STATUS,
        label: LABEL,
        value: VALUE,
      }
    : {
        box: (s: string) => s,
        title: (s: string) => s,
        subtitle: (s: string) => s,
        skate: (s: string) => s,
        accent: (s: string) => s,
        status: (s: string) => s,
        label: (s: string) => s,
        value: (s: string) => s,
      };

  const mode = options?.mode ?? "Hybrid";
  const router = options?.router ?? "Balanced";
  const agents = options?.agentsActive ?? 6;
  const model = options?.model ?? "—";
  const profilePersona: string[] = [];
  if (options?.profile) profilePersona.push(c.label("Profile:") + " " + c.value(options.profile));
  if (options?.persona) profilePersona.push(c.label("Persona:") + " " + c.value(options.persona));
  const profilePersonaLine = profilePersona.length > 0 ? profilePersona.join("  " + c.label("|") + "  ") : "";

  const lines = [
    "",
    c.box("╔══════════════════════════════════════════════════════╗"),
    c.box("║") + "                     " + c.title("SKATE") + "                      " + c.box("║"),
    c.box("║") + "             " + c.subtitle("GTD. Agent Orchestration") + "              " + c.box("║"),
    c.box("╚══════════════════════════════════════════════════════╝"),
    "",
    "            " + c.skate("___"),
    "         " + c.accent("__/     \\__"),
    "        " + c.skate("/    •     \\"),
    "        " + c.skate("\\___________/"),
    "          " + c.accent("\\   ___   /"),
    "             " + c.accent("\\_/   \\_/"),
    "",
    c.status("[Skate]") + " Ready",
    c.label("Mode:") + " " + c.value(mode) + "  " + c.label("|") + "  " +
    c.label("Router:") + " " + c.value(router) + "  " + c.label("|") + "  " +
    c.label("Agents:") + " " + c.value(String(agents) + " active"),
    model !== "—" ? c.label("Model:") + " " + c.value(model) : "",
    profilePersonaLine,
    "",
  ];

  return lines.filter(Boolean).join("\n");
}
