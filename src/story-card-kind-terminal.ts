import { escapeHtml } from "./html-escape.js";
import { renderStoryCardDocument, type StoryCardChrome } from "./story-card-chrome.js";
import {
  readSlotLines,
  readSlotText,
  type StoryCardDefinition,
  type StoryCardSlots
} from "./story-card-slots.js";

const terminalStyles = `
    .terminal {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
      padding: 1.1em 1.2em;
      border-radius: 0.4em;
      background: #0f172a;
      color: #e2e8f0;
      font-family: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.92em;
      line-height: 1.45;
      overflow: hidden;
    }

    .terminal-bar {
      display: flex;
      gap: 0.45em;
      margin-bottom: 0.35em;
    }

    .terminal-dot {
      width: 0.62em;
      height: 0.62em;
      border-radius: 999px;
      background: #475569;
    }

    .terminal-command {
      color: #f8fafc;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .terminal-prompt { color: #5eead4; margin-right: 0.5em; }

    .terminal-output {
      margin: 0;
      color: #94a3b8;
      overflow-wrap: anywhere;
    }
`;

export const terminalStoryCard: StoryCardDefinition = {
  id: "terminal",
  requires: (summary) => summary.commitSignals.totalCommits > 0,
  slots: {
    prompt: { type: "text", required: true },
    command: { type: "text", required: true },
    output: { type: "lines", required: false }
  },
  render(slots: StoryCardSlots, chrome: StoryCardChrome): string {
    const prompt = escapeHtml(readSlotText(slots, "prompt").trim());
    const command = escapeHtml(readSlotText(slots, "command").trim());
    const outputHtml = readSlotLines(slots, "output")
      .map((line) => `        <p class="terminal-output">${escapeHtml(line)}</p>`)
      .join("\n");

    return renderStoryCardDocument({
      kindId: "terminal",
      title: readSlotText(slots, "command").trim(),
      stageStyles: terminalStyles,
      stageHtml: `    <div class="terminal">
      <div class="terminal-bar">
        <span class="terminal-dot"></span>
        <span class="terminal-dot"></span>
        <span class="terminal-dot"></span>
      </div>
      <div class="terminal-command"><span class="terminal-prompt">${prompt}</span>${command}</div>
${outputHtml}
    </div>`,
      chrome
    });
  }
};
