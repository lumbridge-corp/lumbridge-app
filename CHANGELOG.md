# Changelog

Lumbridge App.

## [Unreleased]

## [0.1.0] - 2026-11-11

The first release of Lumbridge, built from source on Linux and macOS.
`lumbridge-app --version` prints 0.1.14, the version of the code line it continues.

### New
- **Diagrams in mods.** `mermaidSvg(source, { dark })` draws Mermaid diagrams in the app (no
  browser, no network) and `svgFile(svg)` saves a mod's own SVG chart; both give a path for
  `image(path)`, text included.
- **Lumbridge.** The app is Lumbridge (`lumbridge-app`, home `~/.config/lumbridge-app`,
  `com.lumbridgecorp.app`). It talks to lumbridge-core (`lbc`); mods import from `"lumbridge"`.
- **Tabs in panes.** A pane can hold several terminals or mods as tabs, one shown at a time:
  the pane header shows them (click, double-click to name, middle-click or × to close, + for a
  new one), ctrl+alt+t / ctrl+alt+w / ctrl+alt+. / ctrl+alt+, add, close and switch, and dragging
  a pane onto another pane's header puts it among that pane's tabs. Tabs are kept with the
  machine's layout, so they survive restarts and show on every screen.
- **Raw and Pretty.** A terminal pane can be drawn as the terminal (Raw) or as its agent's
  conversation rendered (Pretty), from the header or ctrl+alt+v; the terminal keeps running.
- **Pretty view.** The shipped `pretty` mod draws the Claude Code conversation in a terminal pane
  from Claude's transcript: messages, collapsible tool calls with diffs and todo lists, mermaid
  and chart blocks as pictures, and a prompt box that types into the terminal.
- **Pretty view, polished.** It uses the pane's width (prose at a reading measure; code, tables,
  diffs and diagrams full width); each turn's tool calls fold into one "Worked for 1m 05s · Read 3
  files, ran 2 commands" row (failures in red) above Claude's answer; Copy on messages, code
  blocks, commands and outputs; Read aloud (`speak`); paste (text, or an image into Claude's
  input). While Claude works, Enter queues (sent when it finishes), Ctrl+Enter or Steer sends now,
  Stop / Esc interrupts, Interrupt & send does both; a blocked agent's question gets its answers
  as buttons. "↓ N new messages" when scrolled up. The view's own Raw button is gone (the pane
  header's switch stays).

### Changed
- Coding agents show one neutral icon instead of their makers' logos. Give a program its own icon in
  `programs.json`.
- `scripts/lumbridge-app-update` builds in its own checkout, or on the ssh host named by
  `LUMBRIDGE_APP_BUILDER`.

### Removed
- The updater, usage telemetry, feedback upload and release-notes downloads: the app opens no
  connection of its own. Settings → Updates and Privacy are now About.
- The Lumbridge 98 layout, its mod and its theme.
