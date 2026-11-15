// The pretty view of a terminal pane: the Claude Code conversation running in it, drawn
// from Claude's own transcript (~/.claude/projects/<slug>/<session>.jsonl on the terminal's
// machine), with a prompt box that types into the terminal. Props: { pane, terminal }.
// The terminal keeps running underneath; the pane header's Raw | Pretty switches back.
// Design: docs/pretty-design.md in the app's repo.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import * as host from "lumbridge";
import { theme, props, terminals, agents, panes, run, exec, lbc, settings, notify, nextCommand, shared, setShared } from "lumbridge";
import {
  Transcript, READ_SCRIPT, parseRead, projectSlug, toolSummary, toolName, toolIcon, editDiff, todosOf, modelName, tokens,
  duration, arrange, workSummary, stepNow, shortPath, speakable, parseMenu, clockTime,
} from "./transcript.js";
import { chartSvg } from "./chart.js";

const ICON = (name) => `mods/pretty/icons/${name}.svg`;
const FIRST_READ = 3_000_000; // bytes from the end of the file on the first read
const STEP_READ = 6_000_000; // most read at once later (a bigger jump starts over)
const PAGE = 40; // blocks drawn; "Show earlier" adds a page
const WORKING_MS = 1500;
const IDLE_TICKS = 4; // idle: every 4th tick
const TRACK = 1180; // the conversation's widest; past it, it centers
const MEASURE = 860; // prose's widest: a reading measure
const LIVE_STEPS = 6; // a running turn shows its last few steps
const CLIP = 12; // output lines before "Show more"
const RECENT_MS = 3000; // a message sent this recently counts as the agent working
const QUEUE = (address) => `pretty.queue/${address}`;

// Theme colors with alpha: "#rrggbb" + "aa".
const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c ?? "") ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c);
const lines = (s) => String(s ?? "").replace(/\s+$/, "").split("\n");
const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The terminal this copy shows, and what its labels say. */
function target() {
  const p = props() ?? {};
  const address = p.terminal ?? panes().find((x) => x.pane === p.pane)?.terminal ?? null;
  const term = address ? terminals().find((t) => t.address === address) : null;
  const labels = term?.labels ?? {};
  const slash = address ? address.lastIndexOf("/") : -1;
  return {
    pane: p.pane ?? null,
    address,
    term,
    machine: slash > 0 ? address.slice(0, slash) : null,
    session: p.session ?? labels["claude.session"] ?? null,
    cwd: p.cwd ?? labels["claude.cwd"] ?? term?.cwd ?? null,
    path: p.transcript ?? null,
    status: term?.status ?? agents().find((a) => a.address === address)?.status ?? null,
  };
}

function isMac() {
  try { return host.window?.()?.platform === "macos"; } catch { return false; }
}

export default class Pretty extends View {
  static parseMenu = parseMenu; // for tests: how a blocked agent's screen reads

  init(_props, cx) {
    this.t = new Transcript();
    this.key = null; // which transcript is loaded
    this.state = "loading"; // loading | ready | missing | none | gone
    this.next = 0; // byte offset of the next read
    this.from = 0; // byte offset where the loaded rows begin (0: the whole file)
    this.busy = false;
    this.ticks = 0;
    this.show = PAGE;
    this.open = new Set(); // expanded: work blocks, steps, thinking, "show more" outputs
    this.closed = new Set(); // live work blocks folded by hand
    this.stick = true;
    this.toBottom = true;
    this.wheel = 0; // how far up from the bottom the wheel went since leaving it
    this.seen = 0; // messages there were when the view left the bottom
    this.screen = "";
    this.diagrams = new Map();
    this.width = 800;
    this.dark = !!settings()?.dark;
    this.hover = null; // the message under the pointer
    this.copied = null; // the copy control that just copied
    this.speaking = null; // the answer being read aloud
    this.pending = []; // sent, not in the transcript yet: { id, text, kind, users, at }
    this.lastSend = 0;
    this.menu = null; // a blocked agent's question, read from its screen
    this.image = false; // an image waits in Claude's own input
    this.workSince = 0;
    this.scroll = ScrollHandle.new();
    this.screenScroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: "Message Claude…" });
    this.input.set_auto_grow(1, 10);
    this.value = "";
    this.before = "";
    this.input.on("change", (_e, cx) => {
      this.before = this.value;
      this.value = this.input.value();
      if (!this.before.trim() !== !this.value.trim()) cx?.notify();
    });
    this.input.on("submit", (e, cx) => {
      if (e?.shift) return;
      this.submit(cx, e?.secondary ? "now" : "enter");
    });
    this.input.on("paste_other", (_e, cx) => this.attachImage(cx));
    cx.timer.every(WORKING_MS, (cx) => this.tick(cx));
    // The elapsed time while a turn runs (data, once a second; nothing when idle).
    cx.timer.every(1000, (cx) => { if (target().status === "working") cx.notify(); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.input.focus();
        cx.notify();
      }
    });
    this.tick(cx);
  }

  // ---- data -----------------------------------------------------------------

  tick(cx) {
    const at = target();
    const dark = !!settings()?.dark;
    if (dark !== this.dark) {
      this.dark = dark;
      this.diagrams.clear();
      this.renderDiagrams(cx, this.t.rows);
    }
    if (!at.term && !at.path) {
      if (this.state !== "gone") { this.state = "gone"; cx.notify(); }
      return;
    }
    const working = at.status === "working" || at.status === "blocked";
    if (at.status === "working" && !this.wasWorking) this.workSince = Date.now();
    this.wasWorking = at.status === "working";
    if (at.status === "blocked") this.readMenu(cx, at);
    else if (this.menu) { this.menu = null; cx.notify(); }
    this.flushQueue(cx, at);
    if (!at.session && !at.path) {
      if (this.state !== "none") { this.state = "none"; this.reset(null); }
      this.readScreen(cx, at);
      return;
    }
    const key = `${at.machine ?? ""}|${at.path ?? `${at.cwd}|${at.session}`}`;
    if (key !== this.key) this.reset(key);
    this.ticks++;
    if (this.state === "missing") this.readScreen(cx, at);
    if (!working && !this.pending.length && this.state !== "loading" && this.ticks % IDLE_TICKS) return;
    this.read(cx, at);
  }

  reset(key) {
    this.key = key;
    this.t = new Transcript();
    this.state = key ? "loading" : this.state;
    this.next = 0;
    this.from = 0;
    this.show = PAGE;
    this.open.clear();
    this.closed.clear();
    this.stick = true;
    this.toBottom = true;
  }

  read(cx, at) {
    if (this.busy) return;
    this.busy = true;
    const key = this.key;
    const first = this.next === 0;
    cx.spawn(async (cx) => {
      try {
        const args = ["-c", READ_SCRIPT, "pretty", projectSlug(at.cwd), at.session ?? "-", String(this.next), String(first ? FIRST_READ : STEP_READ), "-", at.path ?? "-"];
        const r = await exec("sh", args, { on: at.machine, timeout: 20000 });
        if (key !== this.key) return;
        const got = parseRead(r.stdout ?? "");
        if (got.missing) {
          if (this.state !== "missing") { this.state = "missing"; cx.notify(); }
          return;
        }
        if (got.error) return;
        if (!first && got.start > this.next) {
          // It grew by more than one read: start over from its end.
          this.t = new Transcript();
          this.from = got.from;
        } else if (first) this.from = got.from;
        const changed = this.t.ingest(got.text);
        this.next = got.next;
        const was = this.state;
        this.state = "ready";
        const arrived = this.settlePending();
        if (changed || was !== "ready" || arrived) {
          if (this.stick) this.toBottom = true;
          this.renderDiagrams(cx, this.t.rows);
          cx.notify();
        }
      } catch (e) {
        if (this.state === "loading") { this.state = "missing"; this.error = String(e?.message ?? e); cx.notify(); }
      } finally {
        this.busy = false;
      }
    });
  }

  /** Older rows than the first read loaded: the bytes before `from`. */
  loadEarlier(cx) {
    const at = target();
    if (this.busy || this.from <= 0) return;
    this.busy = true;
    const key = this.key;
    cx.spawn(async (cx) => {
      try {
        const start = Math.max(0, this.from - FIRST_READ);
        const args = ["-c", READ_SCRIPT, "pretty", projectSlug(at.cwd), at.session ?? "-", String(start), String(FIRST_READ), String(this.from), at.path ?? "-"];
        const r = await exec("sh", args, { on: at.machine, timeout: 20000 });
        if (key !== this.key) return;
        const got = parseRead(r.stdout ?? "");
        if (got.missing || got.error) return;
        const earlier = new Transcript();
        earlier.ingest(got.text);
        const before = arrange(this.t.rows).length;
        this.t.prepend(earlier);
        // All of it was one line that began earlier (a huge request record): step over it.
        this.from = got.from < this.from ? got.from : got.start;
        this.show += arrange(this.t.rows).length - before;
        this.renderDiagrams(cx, earlier.rows);
        cx.notify();
      } finally {
        this.busy = false;
      }
    });
  }

  readScreen(cx, at) {
    if (this.screenBusy || !at.address) return;
    this.screenBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await lbc(["read", "--lines", "300", at.address]);
        const text = (r.stdout ?? "").replace(/\s+$/, "");
        if (text !== this.screen) { this.screen = text; this.screenBottom = true; cx.notify(); }
      } catch {
        // The screen is a fallback; an unreadable one stays as it was.
      } finally {
        this.screenBusy = false;
      }
    });
  }

  /** A blocked agent's question: its numbered menu, read off the screen. */
  readMenu(cx, at) {
    if (this.menuBusy || !at.address) return;
    this.menuBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await lbc(["read", "--lines", "60", at.address]);
        const menu = parseMenu(r.stdout ?? "");
        const was = JSON.stringify(this.menu);
        this.menu = menu ?? { none: true };
        if (JSON.stringify(this.menu) !== was) cx.notify();
      } catch {
        if (!this.menu) { this.menu = { none: true }; cx.notify(); }
      } finally {
        this.menuBusy = false;
      }
    });
  }

  /** Draws the mermaid and chart blocks of these rows into images (once per source). */
  renderDiagrams(cx, rows) {
    const mermaid = typeof host.mermaidSvg === "function" ? host.mermaidSvg : null;
    const file = typeof host.svgFile === "function" ? host.svgFile : null;
    const todo = [];
    for (const row of rows) {
      if (row.kind !== "assistant") continue;
      for (const seg of row.segments) {
        if (seg.type !== "mermaid" && seg.type !== "chart") continue;
        const k = this.diagramKey(seg);
        if (this.diagrams.has(k)) continue;
        if (seg.type === "mermaid" && !mermaid) continue;
        if (seg.type === "chart" && !file) continue;
        this.diagrams.set(k, { pending: true });
        todo.push([k, seg]);
      }
    }
    if (!todo.length) return;
    cx.spawn(async (cx) => {
      for (const [k, seg] of todo) {
        let out;
        try {
          if (seg.type === "mermaid") out = await mermaid(seg.src, { dark: this.dark });
          else out = await file(chartSvg(seg.src, this.chartColors()));
        } catch (e) {
          out = { error: String(e?.message ?? e) };
        }
        this.diagrams.set(k, out && (out.path || out.error) ? out : { error: "nothing was drawn" });
        cx.notify();
      }
    });
  }

  diagramKey(seg) {
    return `${seg.type}|${this.dark ? "d" : "l"}|${seg.src}`;
  }

  chartColors() {
    const t = theme();
    const palette = [...new Set([t.accent, t.ansi4, t.ansi2, t.ansi3, t.ansi5, t.ansi6, t.ansi1].filter(Boolean))];
    return { text: t.foreground, muted: t.muted, grid: t.border, bg: t.background, palette };
  }

  userCount() {
    let n = 0;
    for (const r of this.t.rows) if (r.kind === "user") n++;
    return n;
  }

  /** Sent messages that Claude's transcript now has: drop their stand-ins. */
  settlePending() {
    if (!this.pending.length) return false;
    const users = this.userCount();
    const now = Date.now();
    const before = this.pending.length;
    let arrived = 0;
    this.pending = this.pending.filter((p) => {
      if (users - p.users > arrived) { arrived++; return false; }
      return now - p.at < 90_000;
    });
    return this.pending.length !== before;
  }

  // ---- acting on the terminal ------------------------------------------------

  /** The text to send: Enter without Shift also put a newline in; take it back out. */
  draft() {
    const v = this.input.value();
    const b = this.before ?? "";
    if (v.length === b.length + 1) {
      let i = 0;
      while (i < b.length && v[i] === b[i]) i++;
      if (v[i] === "\n" && v.slice(0, i) + v.slice(i + 1) === b) return b;
    }
    return v.replace(/\n$/, "");
  }

  takeDraft() {
    const text = this.draft().replace(/^\s+|\s+$/g, "");
    this.input.set_value("");
    this.value = this.before = "";
    return text;
  }

  /** Working, waiting on a question, or sent to a moment ago: what Enter does then is queue. */
  busyNow(at) {
    return at.status === "working" || at.status === "blocked" || Date.now() - this.lastSend < RECENT_MS;
  }

  queue(at = target()) {
    const q = at.address ? shared(QUEUE(at.address)) : null;
    return Array.isArray(q) ? q : [];
  }

  setQueue(at, list) {
    if (at.address) setShared(QUEUE(at.address), list.length ? list : null);
  }

  /** Enter: send, or queue while the agent works. Ctrl+Enter ("now"): steer it in now. */
  submit(cx, how) {
    const at = target();
    const text = this.draft().replace(/^\s+|\s+$/g, "");
    if (!text || !at.address) {
      this.input.set_value(text);
      return;
    }
    const blocked = at.status === "blocked";
    if ((how === "enter" && this.busyNow(at)) || (how === "now" && blocked)) this.enqueue(cx, at, this.takeDraft());
    else this.send(cx, at, this.takeDraft(), at.status === "working" ? "steer" : "send");
  }

  enqueue(cx, at, text) {
    if (!text) return;
    this.setQueue(at, [...this.queue(at), { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text }]);
    cx.notify();
  }

  /** Types it into the terminal now (`lbc send`: a paste, then Enter). Claude Code takes a
   *  message sent mid-turn at its next step. */
  send(cx, at, text, kind) {
    if (!text || !at.address) return;
    this.stick = true;
    this.toBottom = true;
    this.lastSend = Date.now();
    this.image = false;
    const item = { id: this.lastSend, text, kind, users: this.userCount(), at: this.lastSend };
    this.pending.push(item);
    cx.notify();
    cx.spawn(async (cx) => {
      let failed = null;
      try {
        const r = await lbc(["send", at.address, text, "--json"]);
        if (r.code !== 0) {
          failed = (r.stderr || r.stdout || "").trim();
          try { failed = JSON.parse(r.stdout)?.error?.message ?? failed; } catch { /* plain text */ }
          failed ||= "lbc send failed";
        }
      } catch (e) {
        failed = String(e?.message ?? e);
      }
      if (failed) {
        this.pending = this.pending.filter((p) => p !== item);
        notify({ title: "Not sent", body: failed, level: "error" });
        if (!this.input.value()) this.input.set_value(text);
      }
      this.ticks = 0;
      this.tick(cx);
      cx.notify();
    });
  }

  /** Everything queued goes as one message once the agent stops working. */
  flushQueue(cx, at) {
    if (this.flushing || !at.address || this.busyNow(at)) return;
    const q = this.queue(at);
    if (!q.length) return;
    this.setQueue(at, []);
    this.send(cx, at, q.map((m) => m.text).join("\n\n"), "send");
  }

  async stop(at) {
    if (!at.address) return;
    const r = await lbc(["interrupt", at.address, "--json"]).catch(() => null);
    if (!r || r.code !== 0) await lbc(["keys", at.address, "esc"]).catch(() => null);
  }

  interrupt(cx) {
    const at = target();
    cx.spawn(async (cx) => { await this.stop(at); cx.notify(); });
  }

  /** Stops the turn, waits for it to end (at most 8 s), then sends. */
  interruptAndSend(cx) {
    const at = target();
    const text = this.takeDraft();
    if (!text) { this.interrupt(cx); return; }
    this.flushing = true;
    cx.spawn(async (cx) => {
      try {
        await this.stop(at);
        for (let i = 0; i < 32 && target().status === "working"; i++) await cx.sleep(250);
        this.lastSend = 0;
        this.send(cx, target(), text, "send");
      } finally {
        this.flushing = false;
      }
    });
  }

  /** Answers a blocked agent's menu: re-reads it, checks it's the same, moves, presses Enter. */
  pick(cx, option) {
    const at = target();
    const shown = this.menu;
    if (!at.address || !shown?.options) return;
    cx.spawn(async (cx) => {
      const r = await lbc(["read", "--lines", "60", at.address]).catch(() => null);
      const now = parseMenu(r?.stdout ?? "");
      const same = now && target().status === "blocked" && JSON.stringify(now.options) === JSON.stringify(shown.options);
      if (!same) {
        notify({ title: "The question changed", body: "Answer it in Raw, or try again.", level: "warning" });
        this.menu = now ?? { none: true };
        cx.notify();
        return;
      }
      const moves = option - now.cursor;
      const keys = [...Array(Math.abs(moves)).fill(moves > 0 ? "down" : "up"), "enter"];
      const k = await lbc(["keys", at.address, ...keys]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (k.code !== 0) notify({ title: "Not answered", body: (k.stderr || k.stdout || "lbc keys failed").trim(), level: "error" });
      this.menu = null;
      cx.notify();
    });
  }

  /** The clipboard's text into the prompt; with no text there, its image into Claude's input. */
  paste(cx) {
    let text = null;
    try { text = cx.read_from_clipboard(); } catch { /* not granted or unreadable */ }
    if (text) {
      const v = this.input.value();
      this.input.set_value(v && !/\s$/.test(v) ? `${v} ${text}` : `${v}${text}`);
      this.value = this.input.value();
      this.input.focus();
      cx.notify();
      return;
    }
    this.attachImage(cx);
  }

  /** Claude Code reads images from the clipboard on Ctrl+V, so press it there; a terminal on
   *  another machine gets the image copied over by the app (terminal.paste_image). */
  attachImage(cx) {
    const at = target();
    if (!at.address) return;
    cx.spawn(async (cx) => {
      if (at.machine) {
        if (at.pane) run("pane.focus", { pane: at.pane });
        run("terminal.paste_image");
      } else {
        const r = await lbc(["keys", at.address, "ctrl+v"]).catch(() => ({ code: 1 }));
        if (r.code !== 0) { notify({ title: "No image attached", body: "Lumbridge couldn't press Ctrl+V in the terminal.", level: "error" }); return; }
      }
      this.image = true;
      cx.notify();
    });
  }

  copy(cx, id, text) {
    try { cx.write_to_clipboard(String(text ?? "")); } catch (e) { notify({ title: "Not copied", body: String(e?.message ?? e), level: "error" }); return; }
    this.copied = id;
    cx.notify();
    cx.spawn(async (cx) => {
      await cx.sleep(1500);
      if (this.copied === id) { this.copied = null; cx.notify(); }
    });
  }

  /** Reads an answer aloud on this computer (lumbridge-speak's `speak`); again: stop. */
  speak(cx, key, md) {
    if (this.speaking) {
      const was = this.speaking;
      this.speaking = null;
      cx.notify();
      cx.spawn(async () => { await exec("speak", ["stop"]).catch(() => null); });
      if (was === key) return;
    }
    const text = speakable(md);
    if (!text) return;
    this.speaking = key;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("speak", ["say", text], { timeout: 600_000 });
        if (r.code !== 0 && this.speaking === key) notify({ title: "Couldn't read it aloud", body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
      } catch (e) {
        if (this.speaking === key) notify({ title: "Couldn't read it aloud", body: `speak (lumbridge-speak) isn't available here: ${e?.message ?? e}`, level: "error" });
      } finally {
        if (this.speaking === key) { this.speaking = null; cx.notify(); }
      }
    });
  }

  raw() {
    const p = props() ?? {};
    if (p.pane) run("pane.view", { pane: p.pane, view: "raw" });
  }

  toggle(key) {
    if (this.open.has(key)) this.open.delete(key);
    else this.open.add(key);
  }

  hovered(key) {
    return (on, cx) => {
      if (on) this.hover = key;
      else if (this.hover === key) this.hover = null;
      cx.notify();
    };
  }

  messages() {
    let n = 0;
    for (const r of this.t.rows) if (r.kind === "user" || r.kind === "assistant") n++;
    return n;
  }

  // ---- drawing ----------------------------------------------------------------

  render(cx) {
    const t = theme();
    const at = target();
    const gutter = this.width < 640 ? 12 : 24;
    const track = Math.max(240, Math.min(TRACK, this.width - gutter * 2));
    const root = v_flex().id("pretty").size_full().bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } });
    if (this.state === "gone") return root.child(this.empty(t, "x", "This terminal has ended", "There's nothing left to show here.", false));
    if (this.state === "none" || this.state === "missing") {
      const title = this.state === "none" ? "No Claude conversation here" : "Waiting for the transcript";
      const body = this.state === "none"
        ? "The pretty view draws Claude Code's transcript. This terminal has no claude.session label (Claude's SessionStart hook sets it), so here is its screen."
        : "Claude's transcript for this session isn't there yet. Here is the terminal's screen meanwhile.";
      return root.child(this.header(t, at)).child(this.notice(t, title, body)).child(this.screenView(t)).child(this.composer(t, at, track));
    }
    return root
      .child(this.header(t, at))
      .child(this.conversation(t, at, track))
      .child(this.composer(t, at, track));
  }

  mono() {
    return settings()?.font_family ?? "JetBrains Mono";
  }

  header(t, at) {
    const status = at.status;
    const title = this.t.title ?? (this.state === "none" ? at.term?.title || "Terminal" : "Claude Code");
    const chip = (id, text, tip) => div().id(id).flex_none().px(7).py(2).rounded(6).bg(t.raised).text_size(11).text_color(t.muted).tooltip(tip).child(text);
    const color = status === "working" ? t.working : status === "blocked" ? t.blocked : status === "done" ? t.done : t.idle;
    const word = status === "working" ? "Working" : status === "blocked" ? "Waiting for you" : status === "done" ? "Done" : status ? "Idle" : "No status";
    return h_flex().id("pretty-head").flex_none().h(36).px(16).gap(10).items_center().border_b(1).border_color(t.border).bg(t.background)
      .child(div().id("pretty-dot").size(8).rounded(4).flex_none().bg(color).tooltip(word)
        .when(status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1400 })))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(title))
      .when(!!this.t.model, (el) => el.child(chip("pretty-model", modelName(this.t.model), this.t.model)))
      .when(this.t.context != null, (el) => el.child(chip("pretty-ctx", `${tokens(this.t.context)} ctx`, "Tokens in the last request")))
      .when(this.t.cost != null, (el) => el.child(chip("pretty-cost", `$${this.t.cost.toFixed(2)}`, "Session cost")));
  }

  /** A small control: icon, optional label. kind: "primary" | "ghost" (default) | "danger" | "quiet". */
  button(t, id, icon, label, onClick, tip, kind = "ghost") {
    const primary = kind === true || kind === "primary";
    const quiet = kind === "quiet";
    const fg = primary ? t.solid_foreground : kind === "danger" ? t.ansi1 : t.muted;
    return h_flex().id(id).flex_none().gap(5).items_center().h(quiet ? 24 : 28).px(label ? 10 : 7).rounded(7)
      .bg(primary ? t.solid : "#00000000").text_color(fg)
      .when(!quiet, (el) => el.border(1).border_color(primary ? t.solid : t.border))
      .hover((s) => s.bg(primary ? t.solid : t.hover).text_color(primary ? t.solid_foreground : kind === "danger" ? t.ansi1 : t.foreground))
      .cursor_pointer()
      .when(!!tip, (el) => el.tooltip(tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .when(!!icon, (el) => el.child(svg(ICON(icon)).size(13).flex_none()))
      .when(!!label, (el) => el.child(div().text_size(12).font_medium().child(label)));
  }

  /** A copy control: the copy icon, a check for a moment after it copied. */
  copyButton(t, id, text, label, tip = "Copy") {
    const done = this.copied === id;
    return h_flex().id(id).flex_none().gap(4).items_center().h(22).px(label ? 7 : 5).rounded(6)
      .text_color(done ? t.done : t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(done ? t.done : t.foreground))
      .tooltip(done ? "Copied" : tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.copy(cx, id, text); })
      .child(svg(ICON(done ? "check" : "copy")).size(12).flex_none())
      .when(!!label, (el) => el.child(div().text_size(11.5).child(done ? "Copied" : label)));
  }

  empty(t, icon, title, body, withRaw) {
    return v_flex().flex_1().items_center().justify_center().gap(10).p(24)
      .child(div().size(40).rounded(20).bg(t.raised).flex().items_center().justify_center().child(svg(ICON(icon)).size(18).text_color(t.muted)))
      .child(div().text_size(15).font_semibold().child(title))
      .child(div().max_w(420).text_size(13).text_color(t.muted).child(body))
      .when(withRaw && !!props()?.pane, (el) => el.child(this.button(t, "pretty-empty-raw", "terminal", "Switch to raw", () => this.raw())));
  }

  notice(t, title, body) {
    return h_flex().flex_none().mx(16).mt(12).p(12).gap(12).items_start().rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(svg(ICON("sparkles")).size(16).flex_none().mt(1).text_color(t.accent))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().text_size(13).font_semibold().child(title))
        .child(div().text_size(12.5).text_color(t.muted).child(body)))
      .when(!!props()?.pane, (el) => el.child(this.button(t, "pretty-switch-raw", "terminal", "Switch to raw", () => this.raw())));
  }

  screenView(t) {
    const text = this.screen || "(reading the screen…)";
    const all = lines(text).slice(-300);
    if (this.screenBottom) { this.screenBottom = false; this.screenScroll.scroll_to_item(1); }
    return div().id("pretty-screen").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.screenScroll).mx(16).my(12).p(12).rounded(10)
      .bg(t.surface).border(1).border_color(t.border)
      .child(div().font_family(this.mono()).text_size(12).line_height("17.5px").text_color(t.foreground).child(all.join("\n")))
      .child(div().h(1));
  }

  // ---- the conversation ---------------------------------------------------------

  conversation(t, at, track) {
    const live = at.status === "working" || at.status === "blocked";
    const blocks = arrange(this.t.rows, live);
    const shown = blocks.slice(Math.max(0, blocks.length - this.show));
    const hidden = blocks.length - shown.length;
    const children = [];
    if (hidden > 0 || this.from > 0) {
      children.push(h_flex().justify_center().py(4).child(this.button(t, "pretty-earlier", "arrow-up",
        hidden > 0 ? "Show earlier" : "Load earlier messages",
        (cx) => {
          if (hidden > 0) { this.show += PAGE; this.stick = false; cx.notify(); } else this.loadEarlier(cx);
        }, null, "quiet")));
    }
    if (this.state === "loading") {
      children.push(h_flex().gap(8).items_center().justify_center().py(40).text_color(t.muted)
        .child(svg(ICON("spinner")).size(14).spin(900)).child(div().text_size(13).child("Loading the conversation…")));
    } else if (!blocks.length && !this.pending.length) {
      children.push(v_flex().items_center().py(48).gap(6)
        .child(div().text_size(15).font_semibold().child("A fresh conversation"))
        .child(div().text_size(13).text_color(t.muted).child("Write below to start; it goes to Claude in the terminal.")));
    }
    shown.forEach((b, i) => {
      const el = this.block(t, b, track, at);
      // A little more air before each of your messages: turns read as turns.
      children.push(b.kind === "user" && i > 0 ? div().pt(6).child(el) : el);
    });
    for (const p of this.pending) children.push(this.userCard(t, { key: `pending-${p.id}`, text: p.text, pending: p.kind }, track));
    children.push(div().id("pretty-bottom").h(12).flex_none());
    if (this.toBottom) {
      this.toBottom = false;
      this.scroll.scroll_to_item(children.length - 1);
    }
    // The rows are the scroll area's own children: scroll_to_item counts those. Each is the
    // track's width; a left rail (an outline of turns) can go beside them later.
    const list = v_flex().id("pretty-rows").size_full().items_center().pt(18).gap(12).overflow_y_scrollbar().track_scroll(this.scroll)
      .on_scroll_wheel((e, cx) => {
        const dy = e.delta?.y ?? 0;
        if (this.stick) {
          if (dy > 0) { this.stick = false; this.wheel = dy; this.seen = this.messages(); cx.notify(); }
        } else {
          this.wheel += dy;
          if (this.wheel <= 0) { this.stick = true; this.toBottom = true; cx.notify(); }
        }
      })
      .children(children.map((c) => div().w(track).flex_none().child(c)));
    const fresh = Math.max(0, this.messages() - this.seen);
    return div().flex_1().min_h(0).relative()
      .child(list)
      .when(!this.stick, (el) => el.child(h_flex().absolute().bottom(12).left(0).right(0).justify_center()
        .child(h_flex().id("pretty-latest").h(28).px(12).gap(6).items_center().rounded(14)
          .bg(t.popover ?? t.surface).border(1).border_color(t.border).shadow_md()
          .text_size(12).font_medium().text_color(fresh ? t.foreground : t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.stick = true; this.toBottom = true; cx.notify(); })
          .child(svg(ICON("arrow-down")).size(12).flex_none())
          .child(fresh ? plural(fresh, "new message", "new messages") : "Latest"))));
  }

  block(t, b, track, at) {
    switch (b.kind) {
      case "user": return this.userCard(t, b, track);
      case "answer": return this.answer(t, b, track);
      case "work": return this.work(t, b, at);
      case "thinking": return this.thinkingRow(t, b);
      case "tool": return this.toolRow(t, b, false);
      case "command": return this.command(t, b);
      case "compact": return this.compact(t, b);
      case "notice": {
        const color = b.tone === "error" ? t.ansi1 : b.tone === "warn" ? t.blocked : t.muted;
        return h_flex().gap(7).items_center().pl(2).text_color(color)
          .child(svg(ICON(b.icon ?? (b.tone === "info" ? "bell" : b.tone === "error" ? "alert" : "x"))).size(12).flex_none())
          .child(div().min_w(0).text_size(12.5).child(b.text));
      }
      default: return div();
    }
  }

  /** Your message: a tinted card, left like everything else; copy and time beside it on hover. */
  userCard(t, row, track) {
    const long = row.text.length > 1400 && !this.open.has(row.key);
    const text = long ? `${row.text.slice(0, 1400)}…` : row.text;
    // Text measured inside a shrink-to-fit box wraps at its narrowest; give the card a width.
    const max = Math.min(MEASURE, track - 80);
    const note = row.pending === "steer" ? "Steering · Claude reads it at its next step"
      : row.pending ? "Sending…"
      : row.queued ? "Sent while Claude was working" : null;
    const need = Math.max(text.length * 7.2 + 30, note ? note.length * 6 + 44 : 0);
    const oneLine = !/\n/.test(text) && need < max;
    const width = oneLine ? Math.max(48, Math.ceil(need)) : max;
    const on = this.hover === row.key;
    const time = clockTime(row.at);
    return h_flex().id(`user-${safeId(row.key)}`).w_full().gap(6).items_start()
      .on_hover(this.hovered(row.key))
      .child(v_flex().w(width).flex_none().px(14).py(9).gap(5).rounded(12)
        .bg(alpha(t.accent, 0.12) ?? t.raised).border(1).border_color(alpha(t.accent, 0.24) ?? t.border)
        .when(!!row.pending, (el) => el.opacity(0.6))
        .child(div().text_size(14).line_height("21px").text_color(t.foreground).child(text))
        .when(!!note, (el) => el.child(h_flex().gap(5).items_center().text_size(11).text_color(t.muted)
          .when(row.pending === "steer" || row.queued, (el) => el.child(svg(ICON("zap")).size(10).flex_none()))
          .child(note)))
        .when(row.text.length > 1400, (el) => el.child(
          div().id(`user-more-${safeId(row.key)}`).text_size(12).text_color(t.accent).cursor_pointer()
            .on_click((_e, cx) => { this.toggle(row.key); cx.notify(); })
            .child(long ? "Show all" : "Show less"))))
      .when(!row.pending, (el) => el.child(h_flex().gap(4).items_center().pt(5)
        .when(!on, (el) => el.invisible())
        .child(this.copyButton(t, `copy-${safeId(row.key)}`, row.text, null, "Copy message"))
        .when(!!time, (el) => el.child(div().text_size(11).text_color(t.dim).child(time)))));
  }

  /** Claude's answer: the turn's primary text. Prose at a reading measure; code, tables and
   *  diagrams the full width; Copy / Read aloud / time underneath. */
  answer(t, b, track) {
    const row = b.row;
    const on = this.hover === b.key || b.last || this.speaking === b.key;
    const parts = row.segments.map((seg, i) => this.segment(t, row, seg, i, track));
    const time = clockTime(row.at);
    const speaking = this.speaking === b.key;
    return v_flex().id(`ans-${safeId(b.key)}`).w_full().gap(10)
      .on_hover(this.hovered(b.key))
      .children(parts)
      .child(h_flex().gap(2).items_center().h(22).ml(-5)
        .when(!on, (el) => el.invisible())
        .child(this.copyButton(t, `copy-${safeId(b.key)}`, row.text, "Copy", "Copy the answer (markdown)"))
        .child(h_flex().id(`speak-${safeId(b.key)}`).flex_none().gap(4).items_center().h(22).px(7).rounded(6)
          .text_color(speaking ? t.accent : t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(speaking ? t.accent : t.foreground))
          .tooltip(speaking ? "Stop reading (speak stop)" : "Read aloud on this computer (speak)")
          .on_click((_e, cx) => { cx.stop_propagation(); this.speak(cx, b.key, row.text); })
          .child(svg(ICON(speaking ? "stop" : "volume")).size(12).flex_none())
          .child(div().text_size(11.5).child(speaking ? "Stop" : "Read aloud")))
        .when(!!time, (el) => el.child(div().pl(6).text_size(11).text_color(t.dim).child(time))));
  }

  segment(t, row, seg, i, track) {
    const id = `${safeId(row.key)}-${i}`;
    switch (seg.type) {
      case "md":
        return div().w_full().max_w(MEASURE).child(TextView.markdown(`md-${id}`, seg.text).selectable(true).text_size(14).text_color(t.foreground));
      case "table":
        return div().w_full().child(TextView.markdown(`tb-${id}`, seg.text).selectable(true).text_size(13.5).text_color(t.foreground));
      case "code":
        return this.codeCard(t, `cd-${id}`, seg.lang, seg.src);
      default:
        return this.diagram(t, row, seg, i, track);
    }
  }

  /** A fenced code block: its language and Copy on top, the code below (mono, wrapped). */
  codeCard(t, id, lang, src) {
    return v_flex().id(id).w_full().rounded(8).border(1).border_color(t.border).bg(t.surface).overflow_hidden()
      .child(h_flex().h(28).pl(12).pr(4).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_family(this.mono()).text_size(11).text_color(t.dim).child(lang || "text"))
        .child(this.copyButton(t, `${id}-copy`, src, "Copy", "Copy the code")))
      .child(div().w_full().px(12).py(9).font_family(this.mono()).text_size(12.5).line_height("19px").text_color(t.foreground).child(src || " "));
  }

  diagram(t, row, seg, i, track) {
    const id = `dg-${safeId(row.key)}-${i}`;
    const code = (extra) => v_flex().gap(6)
      .child(this.codeCard(t, `${id}-code`, seg.type === "chart" ? "chart" : "mermaid", seg.src))
      .when(!!extra, (el) => el.child(div().text_size(12).text_color(t.ansi1).child(extra)));
    const d = this.diagrams.get(this.diagramKey(seg));
    if (!d) return code(null);
    if (d.pending) {
      return h_flex().id(id).gap(8).items_center().p(14).rounded(10).border(1).border_color(t.border).text_color(t.muted)
        .child(svg(ICON("spinner")).size(13).spin(900)).child(div().text_size(12.5).child(seg.type === "chart" ? "Drawing the chart…" : "Drawing the diagram…"));
    }
    if (d.error) return code(`${seg.type === "chart" ? "Chart" : "Diagram"} error: ${d.error}`);
    const room = track - 26;
    const scale = Math.min(1, room / Math.max(1, d.width ?? room));
    const w = Math.round((d.width ?? room) * scale), h = Math.round((d.height ?? 200) * scale);
    return h_flex().id(id).w_full().justify_center().p(12).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(image(d.path).w(w).h(h));
  }

  // ---- what Claude did --------------------------------------------------------------

  /** One stretch of steps, folded: "Worked for 1m 05s · 12 steps · Read 3 files, ran 2 commands".
   *  A running one shows its last steps and what it's doing now. */
  work(t, b, at) {
    const s = workSummary(b.rows);
    const open = b.live ? !this.closed.has(b.key) : this.open.has(b.key);
    const toggle = (cx) => {
      if (b.live) { if (this.closed.has(b.key)) this.closed.delete(b.key); else this.closed.add(b.key); }
      else this.toggle(b.key);
      cx.notify();
    };
    const steps = b.rows.filter((r) => r.kind !== "assistant");
    const waiting = b.live && at.status === "blocked";
    const title = waiting ? "Waiting for you" : b.live ? "Working" : b.ms ? `Worked for ${duration(b.ms)}` : "Worked";
    const head = h_flex().id(`wk-${safeId(b.key)}`).h(30).px(8).ml(-8).gap(8).items_center().rounded(8).cursor_pointer()
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => toggle(cx))
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
      .child(waiting ? svg(ICON("alert")).size(13).flex_none().text_color(t.blocked)
        : b.live ? svg(ICON("spinner")).size(13).flex_none().text_color(t.working).spin(900)
        : svg(ICON("layers")).size(13).flex_none().text_color(t.dim))
      .child(div().flex_none().text_size(13).font_medium().text_color(waiting ? t.blocked : b.live ? t.foreground : t.muted).child(title))
      .child(div().flex_none().text_size(12.5).text_color(t.dim).child(`· ${plural(s.steps || steps.length, "step", "steps")}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.dim).child(s.text ? `· ${s.text}` : ""))
      .when(s.errors > 0, (el) => el.child(h_flex().flex_none().gap(4).items_center().px(6).h(20).rounded(5).bg(alpha(t.ansi1, 0.12) ?? t.raised).text_color(t.ansi1)
        .child(svg(ICON("alert")).size(11)).child(div().text_size(11.5).font_medium().child(`${s.errors} failed`))));
    if (!open) return head;
    const all = b.rows;
    const showAll = !b.live || this.open.has(`${b.key}-all`);
    const from = showAll ? 0 : Math.max(0, all.length - LIVE_STEPS);
    const body = v_flex().ml(5).pl(14).border_l(1).border_color(t.input).gap(1)
      .when(from > 0, (el) => el.child(div().id(`wk-all-${safeId(b.key)}`).py(4).text_size(12).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.open.add(`${b.key}-all`); cx.notify(); })
        .child(`Show ${plural(from, "earlier step", "earlier steps")}`)))
      .children(all.slice(from).map((r) => this.step(t, r, b.live && !waiting)));
    return v_flex().w_full().gap(2).child(head).child(body);
  }

  step(t, row, live) {
    if (row.kind === "thinking") return this.thinkingRow(t, row);
    if (row.kind === "assistant") {
      // Narration between steps ("Let me check…"): small and quiet.
      return div().w_full().max_w(MEASURE).py(4).text_size(13).text_color(t.muted)
        .child(TextView.markdown(`nar-${safeId(row.key)}`, row.text).selectable(true).text_size(13).text_color(t.muted));
    }
    return this.toolRow(t, row, live);
  }

  chipRow(t, key, icon, name, summary, state) {
    const open = this.open.has(key);
    const error = state === "error";
    return h_flex().id(`chip-${safeId(key)}`).h(28).px(8).ml(-8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(error, (el) => el.bg(alpha(t.ansi1, 0.07) ?? t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.toggle(key); cx.notify(); })
      .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim))
      .child(svg(ICON(icon)).size(13).flex_none().text_color(error ? t.ansi1 : t.muted))
      .child(div().flex_none().text_size(12.5).font_medium().text_color(error ? t.ansi1 : t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().font_family(this.mono()).text_size(11.5).text_color(t.muted).child(summary || ""))
      .child(state === "running" ? svg(ICON("spinner")).size(12).flex_none().text_color(t.working).spin(900)
        : error ? svg(ICON("x")).size(12).flex_none().text_color(t.ansi1)
        : state === "done" ? svg(ICON("check")).size(12).flex_none().text_color(t.dim)
        : div());
  }

  thinkingRow(t, row) {
    const open = this.open.has(row.key);
    const words = row.text ? row.text.trim().split(/\s+/).length : 0;
    return v_flex()
      .child(h_flex().id(`chip-${safeId(row.key)}`).h(26).px(8).ml(-8).gap(8).items_center().rounded(6).cursor_pointer()
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.muted))
        .on_click((_e, cx) => { this.toggle(row.key); cx.notify(); })
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).flex_none())
        .child(svg(ICON("brain")).size(12).flex_none())
        .child(div().text_size(12).italic().child(words ? `Thought · ${plural(words, "word", "words")}` : "Thought")))
      .when(open, (el) => el.child(div().max_w(MEASURE).pl(27).pb(8).pt(2).text_size(12.5).italic().line_height("19px").text_color(t.muted)
        .child(row.text?.trim() || "The model's thinking is hidden in this transcript.")));
  }

  toolRow(t, row, live) {
    const open = this.open.has(row.key);
    const state = row.result ? (row.result.error ? "error" : "done") : live ? "running" : null;
    if (row.name === "TodoWrite") {
      const todos = todosOf(row.input);
      const done = todos.filter((x) => x.status === "done").length;
      return v_flex()
        .child(this.chipRow(t, row.key, "list", "Todos", `${done}/${todos.length} done`, state))
        .when(open, (el) => el.child(div().pl(27).pb(8).child(this.todoList(t, row, todos))));
    }
    return v_flex()
      .child(this.chipRow(t, row.key, toolIcon(row.name), toolName(row.name), toolSummary(row.name, row.input), state))
      .when(open, (el) => el.child(this.toolDetail(t, row)));
  }

  /** Mono text, clipped to CLIP lines with "Show N more lines", Copy in its corner. */
  output(t, key, text, color, copyTip = "Copy output") {
    const all = lines(text || "(no output)");
    const more = this.open.has(`${key}-more`);
    const max = more ? 400 : CLIP;
    const shown = all.slice(0, max).join("\n") || " ";
    const rest = all.length - Math.min(all.length, max);
    return v_flex().w_full().gap(2)
      .child(h_flex().w_full().items_start().rounded(6).bg(t.surface).border(1).border_color(t.border)
        .child(div().flex_1().min_w(0).px(10).py(7).font_family(this.mono()).text_size(11.5).line_height("17px").text_color(color ?? t.foreground).child(shown))
        .child(div().p(3).child(this.copyButton(t, `${key}-copy`, text, null, copyTip))))
      .when(all.length > CLIP, (el) => el.child(div().id(`${key}-more`).pl(2).text_size(11.5).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.toggle(`${key}-more`); cx.notify(); })
        .child(more ? (rest ? `Show less · ${plural(rest, "more line", "more lines")} not shown` : "Show less") : `Show ${plural(all.length - CLIP, "more line", "more lines")}`)));
  }

  label(t, text) {
    return div().pt(2).text_size(10.5).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  /** A file path: shortened, copied on click. */
  pathLine(t, key, path) {
    if (!path) return div();
    const id = `path-${safeId(key)}`;
    const done = this.copied === id;
    return h_flex().id(id).gap(6).items_center().h(22).px(6).ml(-6).rounded(5).cursor_pointer()
      .text_color(done ? t.done : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(done ? "Copied" : `${path} · click to copy`)
      .on_click((_e, cx) => { cx.stop_propagation(); this.copy(cx, id, path); })
      .child(svg(ICON(done ? "check" : "file")).size(12).flex_none())
      .child(div().font_family(this.mono()).text_size(11.5).child(shortPath(path, 72)));
  }

  diff(t, edits) {
    const rows = [];
    for (const e of edits) {
      for (const d of editDiff(e.old, e.new)) rows.push(d);
      rows.push(null);
    }
    rows.pop();
    const shown = rows.slice(0, 80);
    const red = t.ansi1, green = t.ansi2;
    return v_flex().w_full().rounded(6).overflow_hidden().bg(t.surface).border(1).border_color(t.border).py(4).font_family(this.mono()).text_size(11.5)
      .children(shown.map((d) => d === null
        ? div().h(1).my(3).bg(t.border)
        : h_flex().px(8).gap(8).bg(d.sign === "-" ? alpha(red, 0.12) : d.sign === "+" ? alpha(green, 0.12) : "#00000000")
          .child(div().w(8).flex_none().text_color(d.sign === "-" ? red : d.sign === "+" ? green : t.dim).child(d.sign))
          .child(div().flex_1().min_w(0).text_color(d.sign === " " ? t.muted : t.foreground).child(d.text || " "))))
      .when(rows.length > shown.length, (el) => el.child(div().px(8).text_size(11).text_color(t.dim).child(`… ${plural(rows.length - shown.length, "more line", "more lines")}`)));
  }

  toolDetail(t, row) {
    const i = row.input ?? {};
    const k = safeId(row.key);
    const body = v_flex().w_full().pl(27).pb(10).pt(2).gap(6);
    const err = !!row.result?.error;
    const result = (tip) => row.result
      ? v_flex().gap(4).when(err, (el) => el.child(this.label(t, "Error"))).child(this.output(t, `out-${k}`, row.result.text, err ? t.ansi1 : t.muted, tip))
      : div().text_size(11.5).text_color(t.dim).child("No result yet");
    switch (row.name) {
      case "Bash":
        return body
          .when(!!i.description, (el) => el.child(div().text_size(12).text_color(t.muted).child(i.description)))
          .child(this.output(t, `cmd-${k}`, `$ ${i.command ?? ""}`, t.foreground, "Copy command"))
          .child(result("Copy output"));
      case "Edit":
        return body.child(this.pathLine(t, row.key, i.file_path)).child(this.diff(t, [{ old: i.old_string, new: i.new_string }])).when(err, (el) => el.child(result()));
      case "MultiEdit":
        return body.child(this.pathLine(t, row.key, i.file_path)).child(this.diff(t, (i.edits ?? []).map((e) => ({ old: e.old_string, new: e.new_string })))).when(err, (el) => el.child(result()));
      case "Write":
        return body.child(this.pathLine(t, row.key, i.file_path)).child(this.diff(t, [{ old: "", new: i.content ?? "" }])).when(err, (el) => el.child(result()));
      case "Read": case "NotebookEdit":
        return body.child(this.pathLine(t, row.key, i.file_path ?? i.notebook_path)).child(result());
      case "Grep": case "Glob": case "WebSearch":
        return body.when(!!i.path, (el) => el.child(this.pathLine(t, row.key, i.path))).child(result());
      case "Task": case "Agent":
        return body.child(this.output(t, `prompt-${k}`, i.prompt ?? "", t.muted, "Copy prompt")).child(row.result
          ? div().max_w(MEASURE).child(TextView.markdown(`agent-${k}`, lines(row.result.text).slice(0, 80).join("\n")).selectable(true).text_size(13))
          : div().text_size(11.5).text_color(t.dim).child("Running…"));
      default:
        return body.child(this.output(t, `in-${k}`, JSON.stringify(i, null, 2).slice(0, 4000), t.muted, "Copy input")).child(result());
    }
  }

  todoList(t, row, todos) {
    return v_flex().gap(5).children(todos.map((x, i) => h_flex().id(`todo-${safeId(row.key)}-${i}`).gap(9).items_center()
      .child(div().size(14).flex_none().rounded(4).border(1)
        .border_color(x.status === "done" ? t.accent : x.status === "doing" ? t.working : t.input)
        .bg(x.status === "done" ? t.accent : "#00000000").flex().items_center().justify_center()
        .when(x.status === "done", (el) => el.child(svg(ICON("check")).size(10).text_color(t.accent_foreground)))
        .when(x.status === "doing", (el) => el.child(div().size(6).rounded(3).bg(t.working))))
      .child(div().flex_1().min_w(0).text_size(13)
        .text_color(x.status === "done" ? t.muted : t.foreground)
        .when(x.status === "done", (el) => el.line_through())
        .when(x.status === "doing", (el) => el.font_medium())
        .child(x.text))));
  }

  command(t, row) {
    const open = this.open.has(row.key);
    const has = !!row.output;
    return v_flex().id(`cmd-${safeId(row.key)}`).w_full().gap(6)
      .child(h_flex().child(h_flex().id(`cmd-chip-${safeId(row.key)}`).gap(6).items_center().px(10).h(26).rounded(13).bg(t.raised)
        .when(has, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.toggle(row.key); cx.notify(); }))
        .child(svg(ICON(row.name === "!" ? "terminal" : "slash")).size(11).text_color(t.muted))
        .child(div().font_family(this.mono()).text_size(12).text_color(t.foreground).child(row.name === "!" ? row.args : `${row.name}${row.args ? ` ${row.args}` : ""}`))
        .when(has, (el) => el.child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(11).text_color(t.dim)))))
      .when(has && open, (el) => el.child(this.output(t, `cmdout-${safeId(row.key)}`, row.output, t.muted)));
  }

  compact(t, row) {
    const open = this.open.has(row.key);
    return v_flex().gap(8)
      .child(h_flex().id(`compact-${safeId(row.key)}`).gap(10).items_center().text_color(t.muted)
        .when(!!row.summary, (el) => el.cursor_pointer().on_click((_e, cx) => { this.toggle(row.key); cx.notify(); }))
        .child(div().flex_1().h(1).bg(t.border))
        .child(svg(ICON("scissors")).size(12))
        .child(div().text_size(11.5).child(row.summary ? (open ? "Summary of the earlier conversation" : "Conversation compacted · show summary") : `Conversation compacted${row.tokens ? ` (${tokens(row.tokens)} tokens)` : ""}`))
        .child(div().flex_1().h(1).bg(t.border)))
      .when(open && !!row.summary, (el) => el.child(v_flex().p(12).rounded(10).bg(t.surface).border(1).border_color(t.border)
        .child(TextView.markdown(`compact-md-${safeId(row.key)}`, row.summary).selectable(true).text_size(12.5).text_color(t.muted))));
  }

  // ---- the prompt -----------------------------------------------------------------

  /** What the running turn is doing: since when, the step now, the todo list's progress. */
  live(at) {
    const rows = this.t.rows;
    let last = null, start = null, todos = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!last && (r.kind === "tool" || r.kind === "thinking" || r.kind === "assistant")) last = r;
      if (!todos && r.kind === "tool" && r.name === "TodoWrite") todos = todosOf(r.input);
      if (r.kind === "user" && !r.queued) { start = r.at ? Date.parse(r.at) : null; break; }
    }
    if (!start || Number.isNaN(start) || Date.now() - start > 12 * 3600_000) start = this.workSince || null;
    const now = last?.kind === "tool" && !last.result ? stepNow(last)
      : last?.kind === "thinking" ? "Thinking"
      : last?.kind === "assistant" ? null : "Thinking";
    const doing = todos?.find((x) => x.status === "doing")?.text ?? null;
    return { elapsed: start ? Date.now() - start : null, now, todos, doing };
  }

  strip(t, at, track) {
    if (at.status === "working") {
      const l = this.live(at);
      const done = l.todos ? l.todos.filter((x) => x.status === "done").length : 0;
      return h_flex().id("pretty-state").w(track).h(30).gap(8).items_center()
        .child(svg(ICON("spinner")).size(13).flex_none().text_color(t.working).spin(900))
        .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child("Working"))
        .when(l.elapsed != null, (el) => el.child(div().flex_none().text_size(12.5).text_color(t.muted).child(`· ${duration(l.elapsed)}`)))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(l.now ? `· ${l.now}` : ""))
        .when(!!l.todos?.length, (el) => el.child(h_flex().id("pretty-todos").flex_none().gap(5).items_center().px(7).h(20).rounded(5).bg(t.raised)
          .text_size(11.5).text_color(t.muted).tooltip(l.doing ?? "Todos")
          .child(svg(ICON("list")).size(11)).child(`${done}/${l.todos.length}`)))
        .child(this.button(t, "pretty-stop", "stop", "Stop", (cx) => this.interrupt(cx), "Interrupt the turn (Esc)", "danger"));
    }
    if (at.status === "blocked") return this.question(t, at, track);
    return null;
  }

  /** A blocked agent: its question and one button per answer, else "Answer in Raw". */
  question(t, at, track) {
    const m = this.menu?.options ? this.menu : null;
    const card = v_flex().id("pretty-question").w(track).p(12).gap(8).rounded(10)
      .bg(alpha(t.blocked, 0.1) ?? t.raised).border(1).border_color(alpha(t.blocked, 0.4) ?? t.border)
      .child(h_flex().gap(8).items_center()
        .child(svg(ICON("alert")).size(14).flex_none().text_color(t.blocked))
        .child(div().flex_none().text_size(13).font_semibold().text_color(t.blocked).child("Waiting for you"))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(m?.title ?? ""))
        .when(!!at.pane, (el) => el.child(this.button(t, "pretty-answer-raw", "terminal", "Answer in Raw", () => this.raw(), "Show the terminal", "quiet"))));
    if (!m) {
      return card.child(div().text_size(12.5).text_color(t.foreground).child(this.menu?.none
        ? "Claude is asking something in the terminal. Answer it in Raw."
        : "Reading the question…"));
    }
    return card
      .when(!!m.detail, (el) => el.child(div().px(10).py(6).rounded(6).bg(t.surface).font_family(this.mono()).text_size(11.5).text_color(t.foreground)
        .child(lines(m.detail).slice(0, 6).join("\n"))))
      .child(div().text_size(13).font_medium().child(m.question))
      .child(h_flex().flex_wrap().gap(6).children(m.options.map((o) => {
        const first = o.n === 1;
        return h_flex().id(`pretty-opt-${o.n}`).gap(6).items_center().h(28).px(10).rounded(7).cursor_pointer()
          .bg(first ? t.solid : t.background).text_color(first ? t.solid_foreground : t.foreground)
          .border(1).border_color(first ? t.solid : t.border)
          .hover((s) => s.bg(first ? t.solid : t.hover))
          .tooltip(`Answer ${o.n}: ${o.text}`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.pick(cx, o.n); })
          .child(div().text_size(11).text_color(first ? t.solid_foreground : t.dim).child(String(o.n)))
          .child(div().text_size(12.5).max_w(420).truncate().child(o.text));
      })));
  }

  queueChips(t, at, track) {
    const q = this.queue(at);
    if (!q.length && !this.image) return null;
    return v_flex().w(track).gap(4)
      .when(q.length > 0, (el) => el.child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(svg(ICON("clock")).size(11))
        .child(`Queued · ${at.status === "blocked" ? "sends after you answer and Claude finishes" : "sends when Claude finishes"}`)))
      .children(q.map((m) => h_flex().id(`pretty-q-${m.id}`).w_full().h(32).pl(10).pr(4).gap(4).items_center().rounded(8)
        .bg(t.surface).border(1).border_color(t.border).cursor_pointer()
        .hover((s) => s.border_color(t.input))
        .tooltip("Click to edit")
        .on_click((_e, cx) => this.editQueued(cx, at, m))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(m.text.replace(/\s+/g, " ")))
        .when(at.status !== "blocked", (el) => el.child(this.button(t, `pretty-q-now-${m.id}`, "zap", "Send now", (cx) => {
          this.setQueue(at, this.queue(at).filter((x) => x.id !== m.id));
          this.send(cx, at, m.text, at.status === "working" ? "steer" : "send");
        }, at.status === "working" ? "Steer it into the running turn now" : "Send it now", "quiet")))
        .child(this.button(t, `pretty-q-x-${m.id}`, "x", null, (cx) => { this.setQueue(at, this.queue(at).filter((x) => x.id !== m.id)); cx.notify(); }, "Remove", "quiet"))))
      .when(this.image, (el) => el.child(h_flex().id("pretty-image").gap(6).items_center().h(26).px(8).rounded(7).bg(t.raised).text_size(12).text_color(t.muted)
        .child(svg(ICON("image")).size(12))
        .child("Image attached in Claude's input · goes with your next message")
        .child(div().id("pretty-image-x").cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.image = false; cx.notify(); }).child(svg(ICON("x")).size(11)))));
  }

  editQueued(cx, at, m) {
    this.setQueue(at, this.queue(at).filter((x) => x.id !== m.id));
    const v = this.input.value().trim();
    this.input.set_value(v ? `${m.text}\n${v}` : m.text);
    this.value = this.input.value();
    this.input.focus();
    cx.notify();
  }

  composer(t, at, track) {
    const working = at.status === "working";
    const blocked = at.status === "blocked";
    const busy = working || blocked;
    const canSend = !!at.address && this.state !== "gone";
    const has = !!this.value.trim();
    const strip = this.strip(t, at, track);
    const chips = this.queueChips(t, at, track);
    const mac = isMac();
    const hint = this.state === "none" ? "Enter types it into the terminal · Shift+Enter for a new line"
      : working ? "Enter queues · Ctrl+Enter steers it in now · Esc interrupts"
      : blocked ? "Enter queues it for after the answer"
      : "Enter to send · Shift+Enter for a new line";
    return v_flex().id("pretty-compose").flex_none().items_center().pt(8).pb(10).gap(8).border_t(1).border_color(t.border).bg(t.background)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && target().status === "working") { cx.stop_propagation(); this.interrupt(cx); }
      })
      .when(!!strip, (el) => el.child(strip))
      .when(!!chips, (el) => el.child(chips))
      .child(h_flex().w(track).gap(4).items_end().pl(4).pr(5).py(5).rounded(12)
        .bg(t.surface).border(1).border_color(t.input)
        .child(this.button(t, "pretty-paste", "clipboard", null, (cx) => this.paste(cx), "Paste (text into the prompt; an image into Claude's input)", "quiet"))
        .child(div().flex_1().min_w(0).py(3).text_size(14).child(Textarea.new(this.input).w_full()))
        .when(mac, (el) => el.child(this.button(t, "pretty-mic", "mic", null, () => this.input.focus(), "Hold right ⌥ to dictate · tap it for hands-free (Lumbridge Voice)", "quiet")))
        .when(working && has, (el) => el
          .child(this.button(t, "pretty-int-send", "skip", "Interrupt & send", (cx) => this.interruptAndSend(cx), "Stop the turn, then send this"))
          .child(this.button(t, "pretty-steer", "zap", "Steer", (cx) => this.submit(cx, "now"), "Send now: Claude reads it at its next step (Ctrl+Enter)")))
        .child(busy
          ? this.button(t, "pretty-send", "clock", "Queue", (cx) => this.submit(cx, "enter"), "Queue: sends when Claude finishes (Enter)", canSend && has ? "primary" : "ghost")
          : this.button(t, "pretty-send", "arrow-up", null, (cx) => this.submit(cx, "enter"), "Send (Enter)", canSend ? "primary" : "ghost")))
      .child(div().text_size(11).text_color(t.dim).child(hint));
  }
}
