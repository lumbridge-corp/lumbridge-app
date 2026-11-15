# Pretty view: design

The pretty view (`defaults/mods/pretty`) draws a terminal pane's Claude Code
conversation for a person reading it all day. v1 worked; this pass makes it
read like a document and drive like Claude Code's own prompt.

## Layout

```
┌ pane header (pane mod): title · folder · [Raw | Pretty]  ← the only view switch
├ view header (36px): status dot · conversation title · model · ctx · cost
├ conversation (scrolls) ─────────────────────────────────────────────┐
│  gutter 24 │ track: min(width − 2·gutter, 1180), centered         │
│            │  prose (markdown text) ≤ 860 px, left-aligned        │
│            │  code, diffs, tables, diagrams, tool runs: full track│
├ composer ────────────────────────────────────────────────────────────┤
│  state strip: Working · 1m 12s · Running cargo build    3/7  [Stop] │
│  queued:  "also run the tests"            [Send now] [Edit] [×]     │
│  [paste] prompt…………………………………………… [mic] [Steer] [Queue ⏎]       │
│  Enter queues · Ctrl+Enter steers now · Esc interrupts              │
└──────────────────────────────────────────────────────────────────────┘
```

- The track uses the width: small side gutters (24 px, 12 px when narrow),
  centered only past 1180 px so an ultrawide pane doesn't stretch lines.
- Prose keeps a reading measure (860 px ≈ 110 characters at 14 px); anything
  tabular or spatial (code, diffs, tables, diagrams, tool output) runs the full
  track. Fenced code and tables are split out of the markdown for that. Code
  blocks are our own card (language, Copy, mono text) rather than TextView's
  fence, which draws its own frame and label and has no copy hook for mods.
- Every row is one direct child of the scroll area, so "jump to latest" and
  scroll-to-item keep working. The track is a single column today; a left rail
  (outline / minimap of turns) can be added later as a row around it without
  touching the rows.

## Hierarchy

A conversation is turns. A turn reads as: **your message → what Claude did
(quiet, folded) → Claude's answer (primary)**.

1. **Your message**: a tinted card (accent 12%) with a thin accent edge, left
   aligned like everything else, shrinking to short messages. Messages sent
   while Claude was working carry "steered".
2. **The work**: consecutive tool calls, thinking and the narration between
   them ("Let me check…") fold into one row:
   `▸ Worked for 1m 05s · 12 steps · Read 3 files, edited 2, ran 5 commands`
   with a red "1 failed" when a step errored. Expanded, it lists the steps on a
   left rule: tool rows (icon, name, mono one-line summary, ✓/✗/spinner) that
   expand to their detail, thinking rows (collapsed, muted italic), narration
   as small muted markdown, todo lists compactly.
3. **The answer**: the assistant text after the last step of a turn, full
   contrast, 14 px, the only thing at full weight.
4. Notices (interrupted, API errors, compaction, slash commands) stay inline and
   small; errors in red.

While a turn runs (the last turn, status working/blocked) its work row is
**live**: spinner, elapsed time, the step running now, the last six steps shown
and the latest narration; it folds into the summary when the turn ends.
The "Worked for" duration comes from the turn's `turn_duration` record, so the
separate divider row goes.

### Details inside a step

- Bash: the command in a code block with Copy; its description; the output
  clipped to 12 lines with "Show N more lines"; Copy output.
- Edit / MultiEdit / Write: the file path (click: copy it) above a -/+ diff.
- Read / Grep / Glob / search: path or pattern, then the result clipped.
- Agent: its prompt, then its answer as markdown.
- Anything else: its input as JSON, then the result.

Paths are shortened (`~/…/src/main.rs` past 48 characters). There is no
"open file" command a mod can call with a path yet (the Files panel takes no
file prop), so clicking a path copies it.

## Interactions

- **Copy**: hover any message → Copy (top right of your card; in the action row
  under an answer). Code blocks: Copy in their corner. Steps: Copy command,
  Copy output. A copied control shows ✓ for 1.5 s.
- **Read aloud**: in an answer's action row. Runs `speak say <text>` on this
  computer (lumbridge-speak) with code blocks, tables, diagrams, links and
  markdown marks removed; while it plays the control is "Stop" (`speak stop`).
- **Time**: an answer's action row and your card show the time on hover
  (HH:MM, with the date when not today).
- The action row under the latest answer is always visible; earlier ones on
  hover (their height is kept so nothing jumps).
- **Latest**: scrolling up detaches from the bottom; a small pill appears
  centered just above the composer: "↓ 3 new messages" (or "↓ Latest"); it
  disappears when you scroll back down or click it.
- **Paste**: a button in the prompt: clipboard text goes in at the cursor. An
  image (no text on the clipboard, or pasting an image into the prompt with
  Ctrl+V) is attached to Claude's own input: Ctrl+V pressed in the terminal
  (Claude Code reads the clipboard image), or `terminal.paste_image` when the
  terminal is on another machine. A chip says "Image attached"; it goes with
  the next message.
- **Dictation**: on macOS a mic in the prompt says "Hold right ⌥ to dictate
  (tap for hands-free)": lumbridge-voice types into the focused prompt; it has
  no CLI to start dictation, so the mic only explains and focuses the prompt.

## The prompt: send, queue, steer, interrupt

Claude Code accepts input while it works: a message submitted mid-turn is held
by Claude Code and injected at its next step (the transcript records it as a
`queued_command` attachment); `lbc send` pastes and presses Enter, so a send
while working is exactly that. On that basis:

| Agent state | Enter | Ctrl+Enter | Buttons |
|---|---|---|---|
| idle / done / no status | **Send** now | Send now | Send |
| working | **Queue** (held here) | **Steer** (send now) | Queue, Steer, Interrupt & send; Stop in the strip |
| blocked (a question/permission) | Queue | Queue | the question's options; Answer in Raw |

- **Queue** holds messages in Lumbridge (shared state, per terminal), shown as
  chips above the prompt: click to edit (it comes back into the prompt), ×
  removes, "Send now" steers it. When the agent stops working (idle/done),
  everything queued goes as one message, like Claude Code's own queue.
  A message sent in the last 3 s counts as working, so a quick second Enter
  queues instead of racing.
- **Steer** sends now into the running turn; until Claude picks it up the
  message shows as a faded "steering…" card.
- **Interrupt** (Stop, or Esc in the prompt while working) is `lbc interrupt`
  (the agent's stop key: Esc for Claude Code).
- **Interrupt & send** interrupts, waits for the turn to stop (≤ 8 s), then sends.

States in the strip above the prompt:

- **Working**: spinner, elapsed since the turn began, the step running now
  (`Running cargo build`, `Editing ~/…/main.rs`, `Thinking`), the todo
  progress (3/7), Stop.
- **Waiting for you** (blocked): the question read from the terminal's screen
  (Claude Code's numbered menu, `❯ 1. Yes`), one button per option. A click
  re-reads the screen, checks the same menu is still there, moves the cursor
  with up/down and presses Enter. If the menu can't be read: "Answer in Raw".
- **Idle**: no strip; the prompt says "Message Claude…".

## Look

Only `theme()` colors (light and dark): background for the view, surface for
cards, raised/hover for controls, border for rules, muted/dim for secondary
text, accent for your messages and links, working/blocked for states,
ansi1/ansi2 for errors and diffs. 14 px text, 13 px secondary, 12 px meta,
11.5 px mono in steps. 8 px rhythm: 20 px between turns' blocks, 8 px within.
