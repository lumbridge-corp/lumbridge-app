// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// One pane, or a pane with tabs. With one tab: the program's icon (the app's
// program table), the agent's name or the terminal's title, the folder, and the
// agent's status. With several: a strip of tabs (click shows, double-click
// names, middle-click or × closes), the shown one marked. On hover: a new tab,
// raw/pretty for a terminal, split, zoom and close.
// Props from the app: { pane, terminal } (a pane with tabs: { pane: <its stack>, terminal: null, tabs: true }).

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, openOverlay } from "lumbridge";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// What a tab is called: a given name, else the agent, else the title, else the program.
function label(p) {
  if (p.named && p.name) return p.name;
  return ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.name || p.program?.name || "shell";
}

function status(t, st, size = 7) {
  if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(size + 5).flex_none().text_color(t.working).spin(900);
  if (st === "blocked") return div().size(size).flex_none().rounded(4).bg(t.blocked);
  if (st === "done") return div().size(size).flex_none().rounded(4).bg(t.done);
  return null;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  // This pane's tabs in order (one entry for a pane without tabs).
  tabs() {
    const id = props()?.pane;
    return panes().filter((p) => p.unit === id || (p.pane === id && !p.unit)).sort((a, b) => (a.index ?? 1) - (b.index ?? 1));
  }

  button(t, id, icon, tip, onClick) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .flex_none()
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onClick();
      })
      .tooltip(tip)
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  rename(p) {
    openOverlay({
      mod: "prompt", kind: "dialog", width: 380,
      props: { title: "Name this tab", value: p.named ? p.name : "", hint: "empty: called after its program",
        command: { name: "pane.rename", args: { pane: p.pane } } },
    });
  }

  // One tab of a pane with tabs.
  chip(t, p) {
    const on = p.shown;
    const pic = icon(p.program, 13, on ? t.foreground : t.dim);
    const st = status(t, p.status);
    const close = () => run("pane.close", { pane: p.pane });
    return h_flex()
      .id(`pt-${p.pane}`)
      .relative()
      .h_full()
      .px(10)
      .gap(6)
      .min_w(56)
      .max_w(200)
      .flex_shrink(1)
      .items_center()
      .border_r(1)
      .border_color(t.border)
      .bg(on ? t.background : t.chrome ?? t.surface)
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(on ? t.background : t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); close(); })
      .on_click((e, cx) => {
        cx.stop_propagation();
        if (e.click_count === 2) this.rename(p);
        else run("pane.focus", { pane: p.pane });
      })
      .tooltip([label(p), folder(p.cwd), "double-click to name"].filter(Boolean).join(" · "))
      .when(on, (el) => el.child(div().absolute().top(0).left(0).right(0).h(2).bg(t.accent)))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().min_w(0).truncate().when(on, (el) => el.font_medium()).child(label(p)))
      .when(p.view === "pretty", (el) => el.child(svg("mods/pane/pretty.svg").size(11).flex_none().text_color(t.accent)))
      .when(Boolean(st), (el) => el.child(st))
      .when(on || this.hovered, (el) => el.child(
        div().id(`pt-x-${p.pane}`).flex_none().rounded(3).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); close(); })
          .tooltip("Close tab")
          .child(svg("mods/pane/close.svg").size(11))));
  }

  // Raw | Pretty for the shown terminal.
  views(t, shown) {
    if (!shown?.terminal) return null;
    const seg = (id, name, iconName, on) => div().id(`pv-${id}-${shown.pane}`)
      .h(20).px(6).flex().items_center().gap(4).rounded(4).text_size(11)
      .text_color(on ? t.foreground : t.dim)
      .when(on, (el) => el.bg(t.background).shadow_sm())
      .hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); run("pane.view", { pane: shown.pane, view: id }); })
      .child(svg(`mods/pane/${iconName}.svg`).size(12)).child(name);
    const pretty = shown.view === "pretty";
    return h_flex().flex_none().p(2).gap(2).rounded(6).bg(t.hover)
      .child(seg("raw", "Raw", "raw", !pretty))
      .child(seg("pretty", "Pretty", "pretty", pretty));
  }

  render(cx) {
    const t = theme();
    const tabs = this.tabs();
    if (!tabs.length) return div();
    const shown = tabs.find((p) => p.shown) ?? tabs[0];
    const unit = props()?.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    const many = tabs.length > 1;
    const agent = shown.program?.agent;
    let head = h_flex()
      .id(`pane-head-${unit}`)
      .size_full()
      .gap(8)
      .items_center()
      .bg(many ? (t.chrome ?? t.surface) : t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click((e, cx) => {
        if (e.click_count === 2) run("pane.tab.new", { pane: unit });
        else run("pane.focus", { pane: shown.pane });
      });
    if (many) {
      head = head.pr(8).child(
        h_flex().h_full().flex_1().min_w(0).overflow_hidden().children(tabs.map((p) => this.chip(t, p))));
    } else {
      const pic = icon(shown.program, 14, t.dim);
      const st = shown.status;
      head = head.px(10)
        .when(Boolean(pic), (el) => el.child(pic))
        .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(label(shown)))
        .child(div().flex_1().truncate().text_color(t.dim).child(folder(shown.cwd)))
        .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
        .when(st !== "blocked" && Boolean(status(t, st)), el => el.child(status(t, st)));
    }
    // The view switch stays visible on an agent (it's what you switch most); the rest on hover.
    const views = (agent || shown.view || this.hovered) ? this.views(t, shown) : null;
    return head
      .when(Boolean(views), (el) => el.child(views))
      .when(this.hovered, (el) => el
        .child(this.button(t, `ph-t-${unit}`, "plus", "New tab in this pane (ctrl+alt+t)", () => run("pane.tab.new", { pane: unit })))
        .child(this.button(t, `ph-r-${unit}`, "split-right", "Split right", () => run("pane.split", { direction: "right", pane: unit })))
        .child(this.button(t, `ph-d-${unit}`, "split-down", "Split down", () => run("pane.split", { direction: "down", pane: unit })))
        .child(this.button(t, `ph-z-${unit}`, shown.zoomed ? "unzoom" : "zoom", shown.zoomed ? "Show all panes" : "Zoom", () => run("pane.zoom", { pane: unit })))
        .child(this.button(t, `ph-x-${unit}`, "close", many ? "Close pane and its tabs" : "Close pane", () => run("pane.close", { pane: unit }))));
  }
}
