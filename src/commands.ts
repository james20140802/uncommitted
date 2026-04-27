export type Command = {
  name: string;
  summary: string;
};

export const commands: Command[] = [
  { name: "init", summary: "Initialize Uncommitted config." },
  { name: "project", summary: "Manage registered projects." },
  { name: "note", summary: "Record and list manual notes." },
  { name: "collect", summary: "Collect activity from local sources." },
  { name: "generate", summary: "Generate a diary draft." },
  { name: "render", summary: "Render draft cards." },
  { name: "preview", summary: "Preview a draft." },
  { name: "export", summary: "Export draft assets." },
  { name: "schedule", summary: "Manage the macOS schedule." }
];

export function isKnownCommand(name: string): boolean {
  return commands.some((command) => command.name === name);
}
