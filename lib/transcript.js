// Extracts "the work being done" from a Claude Code session transcript:
// the last real user prompt. Hooks hand the runner transcript_path on
// stdin, and the message that started the current turn is the best
// zero-cost description of why these checks are running — no AI
// summarization, no config, just the tail of a JSONL file.
import { existsSync, readFileSync } from "node:fs";

const MAX_LENGTH = 120;

export function latestUserPrompt(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let lines;
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return null;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry.type !== "user" || entry.isMeta) continue;
    const text = messageText(entry.message);
    if (text) return truncate(text);
  }
  return null;
}

// A "user" line is only a prompt when it carries actual text — tool
// results and command wrappers ride the user role too and must not
// become work descriptions.
function messageText(message) {
  if (!message) return null;
  const { content } = message;
  let text = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join(" ");
  }
  if (!text) return null;
  text = text.trim();
  if (!text || text.startsWith("<")) return null;
  if (text.startsWith("[Request interrupted")) return null;
  return text;
}

function truncate(text) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LENGTH
    ? collapsed.slice(0, MAX_LENGTH - 1) + "…"
    : collapsed;
}
