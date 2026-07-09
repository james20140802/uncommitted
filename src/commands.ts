export type Command = {
  name: string;
  summary: string;
  subcommands?: string[];
};

export const commands: Command[] = [
  { name: "init", summary: "Initialize Uncommitted config." },
  { name: "doctor", summary: "Check local environment setup." },
  {
    name: "project",
    summary: "Manage registered projects.",
    subcommands: ["add", "list", "remove"]
  },
  {
    name: "note",
    summary: "Record and list manual notes.",
    subcommands: ["list"]
  },
  {
    name: "collect",
    summary: "Collect activity from local sources.",
    subcommands: ["git", "claude", "codex", "github", "all"]
  },
  {
    name: "generate",
    summary: "Generate a diary draft.",
    subcommands: ["today"]
  },
  { name: "render", summary: "Render draft cards.", subcommands: ["latest"] },
  { name: "preview", summary: "Preview a draft.", subcommands: ["latest"] },
  {
    name: "export",
    summary: "Export draft assets.",
    subcommands: ["instagram"]
  },
  {
    name: "schedule",
    summary: "Manage the macOS schedule.",
    subcommands: ["install", "status", "remove", "run-now"]
  },
  {
    name: "feedback",
    summary: "Record feedback on a draft.",
    subcommands: ["latest", "report"]
  },
  {
    name: "completion",
    summary: "Print a shell completion script.",
    subcommands: ["zsh", "bash"]
  }
];

export function isKnownCommand(name: string): boolean {
  return commands.some((command) => command.name === name);
}
