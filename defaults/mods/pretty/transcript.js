// Claude Code transcripts (~/.claude/projects/<slug>/<session>.jsonl) as rows to draw.
// Pure: no host calls here, so tests can feed it text and check what comes out.

/** Claude's project folder name for a working directory: every character that isn't a
 *  letter or digit becomes "-" (/home/a/.x_y -> -home-a--x-y). */
export const projectSlug = (cwd) => String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-");

/** UTF-8 byte length of a JS string (offsets into the file are bytes). */
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// Lines the view never shows and that are big: dropped on the reading machine.
export const SKIP_LINE = '^\\{"type":"(api-request|file-history)';

/** Reads a transcript's lines from byte `off` to its end (or to `end`), at most `max` bytes
 *  (the last ones), on any Unix. Prints the kept lines, then
 *  "\u0001OK <end> <start> <partial> <first>": where the read stopped and began, the bytes of an
 *  unfinished last line left for next time, and the bytes of a cut first line it dropped.
 *  "MISSING" when there's no file. Arguments: slug session off max end|- path|-. */
export const READ_SCRIPT = `
slug=$1 sess=$2 off=$3 max=$4 end=$5 f=$6
if [ "$f" = - ]; then
  base=\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects
  f=$base/$slug/$sess.jsonl
  if [ ! -f "$f" ]; then
    for g in "$base"/*/"$sess".jsonl; do [ -f "$g" ] && f=$g && break; done
  fi
fi
[ -f "$f" ] || { echo MISSING; exit 0; }
s=$(wc -c < "$f" | tr -d ' ')
part=0
if [ "$end" = - ]; then
  [ "$s" -gt 0 ] && [ "$(tail -c +"$s" "$f" | head -c 1 | od -An -c | tr -d ' ')" != '\\n' ] && part=1
else
  [ "$end" -lt "$s" ] && s=$end
fi
[ "$off" -gt "$s" ] && off=0
start=$off
[ $((s - off)) -gt "$max" ] && start=$((s - max))
skip=0
[ "$start" -gt 0 ] && [ "$start" -gt "$off" ] && skip=1
[ "$end" != - ] && [ "$start" -gt 0 ] && skip=1
tail -c +$((start + 1)) "$f" | head -c $((s - start)) | LC_ALL=C awk -v skip="$skip" -v part="$part" -v s="$s" -v start="$start" '
  { if (held != "") print held; held = ""; L = length($0) + 1
    if (NR == 1 && skip) first = L
    else if (L < 4000000 && $0 !~ /${SKIP_LINE}/) held = $0 }
  END { if (held != "" && !part) print held
        printf "\\001OK %s %s %s %s\\n", s, start, (part ? L - 1 : 0), first + 0 }'
`;

/** Splits the script's output: { missing } or { text, start, end, next, first }.
 *  `next`: where the next read starts; `start + first`: where this one's whole lines begin. */
export function parseRead(stdout) {
  if (/^MISSING/.test(stdout)) return { missing: true };
  const at = stdout.lastIndexOf("\u0001OK ");
  if (at < 0) return { error: "unreadable transcript" };
  const [end, start, partial, first] = stdout.slice(at + 4).trim().split(/\s+/).map(Number);
  return { text: stdout.slice(0, at), start, end, next: end - partial, first, from: start + first };
}

// ---- text helpers -----------------------------------------------------------

const stripReminders = (s) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
const tag = (s, name) => {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
};
const clip = (s, n) => (s.length > n ? s.slice(0, n) : s);
const RESULT_KEEP = 6000;

/** Text of a tool_result's content: a string or [{type:"text"},{type:"image"}...]. */
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
}

const home = (p) => String(p ?? "").replace(/^\/(home|Users)\/[^/]+/, "~");
const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";
const oneLine = (s, n = 120) => {
  const line = String(s ?? "").replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

/** What a tool call is about, in one line: the command, the file, the pattern. */
export function toolSummary(name, input) {
  const i = input ?? {};
  switch (name) {
    case "Bash": return oneLine(i.description && !i.command ? i.description : i.command);
    case "BashOutput": case "KillShell": case "KillBash": return oneLine(i.bash_id ?? i.shell_id);
    case "Read": {
      const range = i.offset || i.limit ? ` :${i.offset ?? 1}${i.limit ? `+${i.limit}` : ""}` : "";
      return home(i.file_path) + range;
    }
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return home(i.file_path ?? i.notebook_path);
    case "Grep": return oneLine(`${i.pattern ?? ""}${i.path ? `  in ${home(i.path)}` : ""}${i.glob ? `  (${i.glob})` : ""}`);
    case "Glob": return oneLine(`${i.pattern ?? ""}${i.path ? `  in ${home(i.path)}` : ""}`);
    case "WebFetch": return oneLine(i.url);
    case "WebSearch": return oneLine(i.query);
    case "Task": case "Agent": return oneLine(i.description ?? i.prompt);
    case "TodoWrite": {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const done = todos.filter((t) => t.status === "completed").length;
      return `${done}/${todos.length} done`;
    }
    case "TaskCreate": return oneLine(i.subject ?? i.description);
    case "TaskUpdate": return oneLine(`#${i.taskId ?? "?"} ${i.status ?? ""}`);
    case "Skill": return oneLine(i.skill ?? i.name);
    case "ToolSearch": return oneLine(i.query);
    case "SendMessage": return oneLine(i.to ?? i.message);
    default: {
      const first = Object.values(i).find((v) => typeof v === "string" && v.trim());
      return oneLine(first ?? "");
    }
  }
}

/** A tool's display name: mcp__server__tool -> "server · tool". */
export function toolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name ?? "");
  return m ? `${m[1]} · ${m[2]}` : name ?? "tool";
}

/** Which icon a tool gets (a file in icons/). */
export function toolIcon(name) {
  if (/^(Bash|BashOutput|KillShell|KillBash|Monitor)$/.test(name)) return "terminal";
  if (/^(Read|NotebookRead)$/.test(name)) return "file";
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)) return "pen";
  if (/^(Grep|Glob|ToolSearch|WebSearch)$/.test(name)) return "search";
  if (/^(WebFetch)$/.test(name)) return "globe";
  if (/^(Task|Agent|SendMessage)$/.test(name)) return "bot";
  if (/^(TodoWrite|TaskCreate|TaskUpdate|TaskList)$/.test(name)) return "list";
  if (/^Skill$/.test(name)) return "sparkles";
  return "wrench";
}

/** A small line diff of an edit: unchanged head and tail trimmed, the middle as -/+ lines.
 *  Returns [{ sign: " " | "-" | "+", text }]. */
export function editDiff(oldText, newText, context = 2) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out = [];
  for (let i = Math.max(0, head - context); i < head; i++) out.push({ sign: " ", text: a[i] });
  for (let i = head; i < a.length - tail; i++) out.push({ sign: "-", text: a[i] });
  for (let i = head; i < b.length - tail; i++) out.push({ sign: "+", text: b[i] });
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + context); i++) out.push({ sign: " ", text: a[i] });
  return out;
}

/** Splits assistant markdown into segments: text ("md"), fenced code ("code": lang, src),
 *  tables ("table": text), and ```mermaid / ```chart blocks (src). Code and tables come out
 *  so they can run wider than prose and carry a Copy button. */
export function splitSegments(md) {
  const lines = String(md ?? "").split("\n");
  const out = [];
  let text = [];
  let fence = null; // { marker, lang, body }
  const flush = () => {
    const t = text.join("\n");
    if (t.trim()) out.push({ type: "md", text: t });
    text = [];
  };
  const isRow = (l) => /^\s{0,3}\|.*\|\s*$/.test(l ?? "");
  const isRule = (l) => /^\s{0,3}\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l ?? "") && /-/.test(l ?? "") && /\|/.test(l ?? "");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fence) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
      if (m) {
        flush();
        fence = { marker: m[1], lang: m[2].toLowerCase(), body: [] };
        continue;
      }
      if (isRow(line) && isRule(lines[i + 1])) {
        flush();
        const rows = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && isRow(lines[i])) rows.push(lines[i++]);
        i--;
        out.push({ type: "table", text: rows.join("\n") });
        continue;
      }
      text.push(line);
      continue;
    }
    const close = new RegExp(`^ {0,3}${fence.marker[0] === "`" ? "`" : "~"}{${fence.marker.length},}\\s*$`).test(line);
    if (close) {
      out.push(segmentOf(fence));
      fence = null;
      continue;
    }
    fence.body.push(line);
  }
  // Still being written (or never closed): what there is so far, as code.
  if (fence) out.push({ type: "code", lang: fence.lang, src: fence.body.join("\n") });
  flush();
  return out;
}

function segmentOf(fence) {
  const src = fence.body.join("\n");
  return fence.lang === "mermaid" || fence.lang === "chart" ? { type: fence.lang, src } : { type: "code", lang: fence.lang, src };
}

/** "claude-opus-5-5-20260101" -> "Opus 5.5". */
export function modelName(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id ?? "");
  if (!m) return id ?? null;
  const fam = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] && m[3].length < 3 ? `${fam} ${m[2]}.${m[3]}` : `${fam} ${m[2]}`;
}

// ---- the transcript ---------------------------------------------------------

/**
 * Rows, in order. Every row has a stable `key` and a `kind`:
 *  user {text, queued?} · assistant {text, segments} · thinking {text}
 *  tool {id, name, input, result: null | {text, error}, edit?: [{old,new}], todos?}
 *  command {name, args, output} · notice {text, tone: "info"|"warn"|"error"}
 *  compact {summary} · turn {ms}
 */
export class Transcript {
  constructor() {
    this.rows = [];
    this.tools = new Map(); // tool_use id -> row
    this.orphans = new Map(); // tool_use id -> result whose call isn't loaded (yet)
    this.seen = new Set();
    this.title = null;
    this.model = null;
    this.context = null; // tokens in the last request
    this.cost = null;
    this.version = 0; // bumps on any change
    this.lastCommand = null;
    this.at = null; // the record being added: its timestamp, given to the rows it makes
  }

  /** Adds every complete JSON line of `text`. Bad lines are skipped. */
  ingest(text) {
    let changed = false;
    for (const line of String(text ?? "").split("\n")) {
      if (!line || line[0] !== "{") continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (this.add(d)) changed = true;
    }
    if (changed) this.version++;
    return changed;
  }

  push(row) {
    if (this.at && !row.at) row.at = this.at;
    this.rows.push(row);
    return true;
  }

  add(d) {
    if (!d || typeof d !== "object") return false;
    if (d.uuid) {
      if (this.seen.has(d.uuid)) return false;
      this.seen.add(d.uuid);
    }
    this.at = typeof d.timestamp === "string" ? d.timestamp : null;
    switch (d.type) {
      case "ai-title": this.title = d.aiTitle || this.title; return true;
      case "summary": if (!this.title && d.summary) this.title = d.summary; return true;
      case "cost-state": this.cost = typeof d.totalCostUSD === "number" ? d.totalCostUSD : this.cost; return true;
      case "continued-in": return this.push({ key: `cont-${d.continuedInSessionId}`, kind: "notice", tone: "info", text: "This conversation continues in a new session." });
      case "user": return d.isSidechain ? false : this.user(d);
      case "assistant": return d.isSidechain ? false : this.assistant(d);
      case "system": return d.isSidechain ? false : this.system(d);
      case "attachment": {
        const a = d.attachment;
        if (a?.type === "queued_command" && a.prompt && a.commandMode !== "task-notification") {
          return this.push({ key: d.uuid ?? `q-${this.rows.length}`, kind: "user", text: String(a.prompt), queued: true });
        }
        return false;
      }
      default: return false;
    }
  }

  user(d) {
    const key = d.uuid ?? `u-${this.rows.length}`;
    if (d.isCompactSummary) {
      const c = d.message?.content;
      const summary = typeof c === "string" ? c : resultText(c);
      const last = this.rows[this.rows.length - 1];
      if (last?.kind === "compact" && !last.summary) { last.summary = summary; return true; }
      return this.push({ key, kind: "compact", summary });
    }
    if (d.isMeta) return false;
    const content = d.message?.content;
    if (Array.isArray(content)) {
      let changed = false;
      const texts = [];
      for (const c of content) {
        if (c?.type === "tool_result") {
          const result = { text: clip(resultText(c.content), RESULT_KEEP), error: !!c.is_error };
          const row = this.tools.get(c.tool_use_id);
          if (row) row.result = result;
          else this.orphans.set(c.tool_use_id, result);
          changed = true;
        } else if (c?.type === "text") texts.push(c.text);
        else if (c?.type === "image") texts.push("[image]");
      }
      if (texts.length) changed = this.userText(key, texts.join("\n")) || changed;
      return changed;
    }
    if (typeof content === "string") return this.userText(key, content);
    return false;
  }

  userText(key, raw) {
    const text = stripReminders(raw);
    if (!text) return false;
    if (/^\[Request interrupted by user/.test(text)) return this.push({ key, kind: "notice", tone: "warn", text: "Interrupted" });
    const name = tag(text, "command-name");
    if (name) {
      const row = { key, kind: "command", name: name.startsWith("/") ? name : `/${name}`, args: tag(text, "command-args") ?? "", output: "" };
      this.lastCommand = row;
      return this.push(row);
    }
    const out = tag(text, "local-command-stdout") ?? tag(text, "local-command-stderr");
    if (out !== null) {
      const clean = out.replace(/\u001b\[[0-9;]*m/g, "").trim();
      if (this.lastCommand && this.rows[this.rows.length - 1] === this.lastCommand) {
        this.lastCommand.output = clip(clean, RESULT_KEEP);
        return true;
      }
      return clean ? this.push({ key, kind: "notice", tone: "info", text: clip(clean, 400) }) : false;
    }
    if (/<local-command-caveat>/.test(text)) return false;
    const bash = tag(text, "bash-input");
    if (bash !== null) {
      const row = { key, kind: "command", name: "!", args: bash, output: "" };
      this.lastCommand = row;
      return this.push(row);
    }
    const bashOut = tag(text, "bash-stdout");
    if (bashOut !== null) {
      const err = tag(text, "bash-stderr") ?? "";
      if (this.lastCommand) this.lastCommand.output = clip([bashOut, err].filter(Boolean).join("\n"), RESULT_KEEP);
      return true;
    }
    if (/<task-notification>|^<task-id>/.test(text)) {
      const summary = tag(text, "summary") ?? tag(text, "status") ?? "Background task update";
      return this.push({ key, kind: "notice", tone: "info", icon: "bell", text: oneLine(summary, 200) });
    }
    return this.push({ key, kind: "user", text });
  }

  assistant(d) {
    const m = d.message ?? {};
    if (m.model && m.model !== "<synthetic>") this.model = m.model;
    const u = m.usage;
    if (u) this.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    const content = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
    const base = d.uuid ?? m.id ?? `a-${this.rows.length}`;
    let changed = !!u;
    content.forEach((c, i) => {
      const key = `${base}-${i}`;
      if (c?.type === "text" && c.text?.trim()) {
        if (d.isApiErrorMessage) changed = this.push({ key, kind: "notice", tone: "error", text: oneLine(c.text, 300) }) || changed;
        else changed = this.push({ key, kind: "assistant", text: c.text, segments: splitSegments(c.text) }) || changed;
      } else if (c?.type === "thinking" || c?.type === "redacted_thinking") {
        // Consecutive thinking blocks read as one.
        const last = this.rows[this.rows.length - 1];
        if (last?.kind === "thinking") { last.text = [last.text, c.thinking ?? ""].filter(Boolean).join("\n\n"); changed = true; }
        else changed = this.push({ key, kind: "thinking", text: c.thinking ?? "" }) || changed;
      } else if (c?.type === "tool_use") {
        const row = { key: c.id ?? key, kind: "tool", id: c.id, name: c.name, input: c.input ?? {}, result: null };
        if (this.orphans.has(c.id)) { row.result = this.orphans.get(c.id); this.orphans.delete(c.id); }
        if (c.id) this.tools.set(c.id, row);
        changed = this.push(row) || changed;
      }
    });
    return changed;
  }

  system(d) {
    const key = d.uuid ?? `s-${this.rows.length}`;
    switch (d.subtype) {
      case "compact_boundary": {
        const pre = d.compactMetadata?.preTokens;
        return this.push({ key, kind: "compact", summary: null, tokens: pre ?? null });
      }
      case "turn_duration":
        return typeof d.durationMs === "number" ? this.push({ key, kind: "turn", ms: d.durationMs }) : false;
      case "api_error": {
        const last = this.rows[this.rows.length - 1];
        if (last?.kind === "notice" && last.api) return false;
        return this.push({ key, kind: "notice", tone: "warn", api: true, text: "API error, retrying…" });
      }
      case "local_command":
        return false;
      default:
        if ((d.level === "error" || d.level === "warning") && typeof d.content === "string") {
          return this.push({ key, kind: "notice", tone: d.level === "error" ? "error" : "warn", text: oneLine(stripReminders(d.content), 300) });
        }
        return false;
    }
  }

  /** Puts an earlier stretch of the file (parsed on its own) in front of this one. */
  prepend(earlier) {
    for (const [id, result] of this.orphans) {
      const row = earlier.tools.get(id);
      if (row) { row.result = result; this.orphans.delete(id); }
    }
    for (const [id, row] of earlier.tools) if (!this.tools.has(id)) this.tools.set(id, row);
    for (const id of earlier.seen) this.seen.add(id);
    const keys = new Set(this.rows.map((r) => r.key));
    this.rows = earlier.rows.filter((r) => !keys.has(r.key)).concat(this.rows);
    this.title ??= earlier.title;
    this.model ??= earlier.model;
    this.version++;
  }
}

/** The todo list a TodoWrite call set: [{ text, status }]. */
export function todosOf(input) {
  return (Array.isArray(input?.todos) ? input.todos : []).map((t) => ({
    text: String(t.content ?? t.activeForm ?? ""),
    status: t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : "todo",
  }));
}

/** "12.3k" for token counts. */
export function tokens(n) {
  if (n == null) return null;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/** "1m 05s" for durations. */
export function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// ---- reading a conversation as turns ----------------------------------------

const STEP = new Set(["tool", "thinking"]);

/**
 * The rows as blocks to draw, turn by turn: your message, then what Claude did folded into one
 * `work` block (its tool calls, thinking and the narration between them), then its answer.
 *  - { kind: "work", key, rows, ms, live }: the steps (and narration) of one stretch of a turn
 *  - { kind: "answer", key, row, last }: assistant text after the turn's last step
 *  - any other row as it is (user, command, compact, notice)
 * `live`: the conversation's last turn is still running, so its stretch stays one live block.
 * `turn` rows (how long a turn took) go onto the turn's work block.
 */
export function arrange(rows, live = false) {
  const out = [];
  let run = []; // assistant, thinking and tool rows since the last boundary
  const close = (isLast) => {
    if (!run.length) return;
    const steps = run.filter((r) => STEP.has(r.kind));
    const tools = steps.some((r) => r.kind === "tool");
    if (isLast && live && steps.length) {
      out.push({ kind: "work", key: `w-${run[0].key}`, rows: run, ms: null, live: true });
    } else if (!tools) {
      // Only thinking and text: nothing to fold.
      for (const r of run) out.push(r.kind === "assistant" ? { kind: "answer", key: r.key, row: r } : r);
    } else {
      let end = run.length;
      while (end > 0 && run[end - 1].kind === "assistant") end--;
      out.push({ kind: "work", key: `w-${run[0].key}`, rows: run.slice(0, end), ms: null, live: false });
      for (const r of run.slice(end)) out.push({ kind: "answer", key: r.key, row: r });
    }
    run = [];
  };
  for (const r of rows) {
    if (r.kind === "assistant" || STEP.has(r.kind)) { run.push(r); continue; }
    close(false);
    if (r.kind === "turn") {
      // Claude's own "worked for": onto this turn's last work block.
      for (let i = out.length - 1; i >= 0 && out[i].kind !== "user"; i--) {
        if (out[i].kind === "work") { out[i].ms = r.ms; break; }
      }
      continue;
    }
    out.push(r);
  }
  close(true);
  let lastAnswer = -1;
  out.forEach((b, i) => { if (b.kind === "answer") lastAnswer = i; });
  if (lastAnswer >= 0) out[lastAnswer].last = true;
  return out;
}

const EDITS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;

/** What a work block did, for its one-line summary:
 *  { steps, errors, text: "Read 3 files, edited 2 files, ran 5 commands" }. */
export function workSummary(rows) {
  const read = new Set(), edited = new Set();
  let commands = 0, searches = 0, fetches = 0, agents = 0, other = 0, steps = 0, errors = 0;
  for (const r of rows) {
    if (r.kind !== "tool") continue;
    steps++;
    if (r.result?.error) errors++;
    const i = r.input ?? {};
    if (r.name === "Read" || r.name === "NotebookRead") read.add(i.file_path ?? i.notebook_path ?? steps);
    else if (EDITS.test(r.name)) edited.add(i.file_path ?? i.notebook_path ?? steps);
    else if (/^(Bash|BashOutput|KillShell|KillBash|Monitor)$/.test(r.name)) commands++;
    else if (/^(Grep|Glob|WebSearch|ToolSearch)$/.test(r.name)) searches++;
    else if (r.name === "WebFetch") fetches++;
    else if (/^(Task|Agent)$/.test(r.name)) agents++;
    else if (!/^(TodoWrite|TaskCreate|TaskUpdate|TaskList)$/.test(r.name)) other++;
  }
  const n = (k, one, many) => (k ? `${k} ${k === 1 ? one : many}` : null);
  const parts = [
    read.size ? `read ${n(read.size, "file", "files")}` : null,
    edited.size ? `edited ${n(edited.size, "file", "files")}` : null,
    commands ? `ran ${n(commands, "command", "commands")}` : null,
    searches ? `searched ${searches === 1 ? "once" : `${searches} times`}` : null,
    fetches ? `fetched ${n(fetches, "page", "pages")}` : null,
    agents ? `ran ${n(agents, "agent", "agents")}` : null,
    other ? `used ${n(other, "other tool", "other tools")}` : null,
  ].filter(Boolean);
  const text = parts.join(", ");
  return { steps, errors, text: text ? text[0].toUpperCase() + text.slice(1) : "" };
}

/** What a running step is doing, in a few words: "Running cargo build", "Editing main.rs". */
export function stepNow(row) {
  if (!row) return null;
  if (row.kind === "thinking") return "Thinking";
  if (row.kind !== "tool") return null;
  const i = row.input ?? {};
  const file = base(i.file_path ?? i.notebook_path);
  switch (row.name) {
    case "Bash": return i.description ? oneLine(i.description, 60) : `Running ${oneLine(i.command, 60)}`;
    case "Read": return `Reading ${file}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `Editing ${file}`;
    case "Write": return `Writing ${file}`;
    case "Grep": case "Glob": return `Searching ${oneLine(i.pattern, 40)}`;
    case "WebSearch": return `Searching the web: ${oneLine(i.query, 40)}`;
    case "WebFetch": return `Fetching ${oneLine(i.url, 50)}`;
    case "Task": case "Agent": return `Agent: ${oneLine(i.description ?? i.prompt, 50)}`;
    case "TodoWrite": return "Updating the todo list";
    default: return toolName(row.name);
  }
}

/** A path for reading: home as ~, and long ones as ~/…/dir/file. */
export function shortPath(p, max = 48) {
  const h = home(p);
  if (h.length <= max) return h;
  const parts = h.split("/");
  const tail = parts.slice(-2).join("/");
  return `${parts[0] === "~" ? "~/" : parts[0] === "" ? "/" : ""}…/${tail}`;
}

/** Text for reading aloud: no code, tables, diagrams, links' targets or markdown marks. */
export function speakable(md) {
  const parts = splitSegments(md).filter((s) => s.type === "md").map((s) => s.text);
  return parts.join("\n\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The question a blocked agent shows (Claude Code's numbered menu) from its screen:
 * { title, detail, question, options: [{ n, text }], cursor } or null when there's none.
 * The menu must be near the bottom, numbered 1.. in order, with one line marked ❯ (or ›).
 */
export function parseMenu(screen) {
  const BOX = /^[\s│┃|╭╮╰╯─━┌┐└┘]+|[\s│┃|╭╮╰╯─━┌┐└┘]+$/g;
  const all = String(screen ?? "").split("\n").map((l) => l.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""));
  const tail = all.slice(-40);
  const opt = /^\s*([❯›>])?\s*(\d{1,2})[.)]\s+(.+?)\s*$/;
  let last = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i].replace(BOX, " ");
    if (opt.test(l)) { last = i; break; }
  }
  if (last < 0) return null;
  // Walk up through the options (lines in between are an option's wrapped description).
  const options = [];
  let cursor = null, first = last;
  for (let i = last; i >= 0 && last - i < 24; i--) {
    const l = tail[i].replace(BOX, " ");
    const m = opt.exec(l);
    if (m) {
      options.unshift({ n: Number(m[2]), text: m[3].replace(/\s{2,}/g, " ") });
      if (m[1]) cursor = Number(m[2]);
      first = i;
      if (Number(m[2]) === 1) break;
    } else if (!l.trim()) break;
  }
  if (!options.length || options[0].n !== 1 || cursor == null) return null;
  if (options.some((o, i) => o.n !== i + 1)) return null;
  // Above the menu: the question, then what it's about, up to a rule or a gap of two.
  const above = [];
  for (let i = first - 1; i >= 0 && above.length < 12; i--) {
    const raw = tail[i];
    if (/^\s*[╭┌]|^\s*[─━]{6,}/.test(raw)) break;
    const l = raw.replace(BOX, " ").trim();
    if (!l && above.length && !above[0]) break;
    above.unshift(l);
  }
  while (above.length && !above[0]) above.shift();
  while (above.length && !above[above.length - 1]) above.pop();
  const question = above.length ? above[above.length - 1] : "Claude is asking";
  const title = above.length > 1 ? above[0] : null;
  const detail = above.slice(title ? 1 : 0, -1).filter(Boolean).join("\n");
  return { title, detail, question, options, cursor };
}

/** "14:32", or "Nov 11 14:32" when it isn't today. */
export function clockTime(iso, now = new Date()) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()} ${hm}`;
}
