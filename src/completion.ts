import { commands, type Command } from "./commands.js";

export type CompletionShell = "zsh" | "bash";

export const COMPLETION_SHELLS: readonly CompletionShell[] = ["zsh", "bash"];

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/**
 * Wrap an arbitrary string in POSIX single quotes, escaping embedded single
 * quotes. Command/subcommand names are simple lowercased identifiers today,
 * but we quote defensively so the generated script stays valid even if the
 * registry later grows a name with shell-special characters.
 */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Escape a summary for use inside a zsh `_describe` entry (`name:description`).
 * Colons separate the completion value from its description, and backslashes
 * are the escape character, so both must be neutralised before the whole entry
 * is single-quoted.
 */
function escapeZshDescription(summary: string): string {
  return summary.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function generateZshScript(commandList: Command[]): string {
  const describeEntries = commandList
    .map((command) =>
      `    ${singleQuote(
        `${command.name}:${escapeZshDescription(command.summary)}`
      )}`
    )
    .join("\n");

  const subcommandCases = commandList
    .filter(
      (command) => command.subcommands && command.subcommands.length > 0
    )
    .map((command) => {
      const values = (command.subcommands ?? [])
        .map((subcommand) => singleQuote(subcommand))
        .join(" ");
      return `      ${singleQuote(command.name)})\n        _values 'subcommand' ${values}\n        ;;`;
    })
    .join("\n");

  return `#compdef uncommitted

_uncommitted() {
  local -a _uncommitted_commands
  _uncommitted_commands=(
${describeEntries}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'uncommitted command' _uncommitted_commands
    return
  fi

  if (( CURRENT == 3 )); then
    case "\${words[2]}" in
${subcommandCases}
    esac
  fi
}

# Dual-mode footer: when compinit autoloads this file from $fpath the function
# is invoked directly (funcstack[1] == _uncommitted); when the script is instead
# eval'd/sourced (e.g. \`eval "$(uncommitted completion zsh)"\`) the #compdef tag
# is just a comment, so bind the completer explicitly with compdef.
if [ "$funcstack[1]" = "_uncommitted" ]; then
  _uncommitted "$@"
else
  compdef _uncommitted uncommitted
fi
`;
}

function generateBashScript(commandList: Command[]): string {
  const topLevel = commandList
    .map((command) => command.name)
    .join(" ");

  const subcommandCases = commandList
    .filter(
      (command) => command.subcommands && command.subcommands.length > 0
    )
    .map((command) => {
      const values = (command.subcommands ?? []).join(" ");
      return `    ${command.name})\n      COMPREPLY=( $(compgen -W ${singleQuote(
        values
      )} -- "\${cur}") )\n      return 0\n      ;;`;
    })
    .join("\n");

  return `_uncommitted() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W ${singleQuote(topLevel)} -- "\${cur}") )
    return 0
  fi

  case "\${prev}" in
${subcommandCases}
  esac

  return 0
}

complete -F _uncommitted uncommitted
`;
}

/**
 * Generate a shell completion script for `uncommitted`, derived entirely from
 * `commandList` (defaults to the live `commands` registry). Because the output
 * is iterated from the registry — never hardcoded — adding a command in
 * `src/commands.ts` automatically extends completion.
 */
export function generateCompletionScript(
  shell: CompletionShell,
  commandList: Command[] = commands
): string {
  return shell === "zsh"
    ? generateZshScript(commandList)
    : generateBashScript(commandList);
}

/** Short human-readable install instructions for the given shell. */
export function completionInstallHint(shell: CompletionShell): string {
  if (shell === "zsh") {
    return [
      "To enable zsh completion, write the script to a user-writable dir on your $fpath:",
      "  mkdir -p ~/.zsh/completions",
      "  uncommitted completion zsh > ~/.zsh/completions/_uncommitted",
      "then add this to ~/.zshrc BEFORE `compinit`:",
      "  fpath=(~/.zsh/completions $fpath)",
      'Or eval it directly from ~/.zshrc:  eval "$(uncommitted completion zsh)"'
    ].join("\n");
  }

  return [
    "To enable bash completion, add this to ~/.bashrc (works on macOS bash 3.2 and 5.x):",
    '  eval "$(uncommitted completion bash)"',
    "Or write it to a file and source that:",
    "  uncommitted completion bash > ~/.uncommitted-completion.bash",
    "  echo 'source ~/.uncommitted-completion.bash' >> ~/.bashrc"
  ].join("\n");
}
