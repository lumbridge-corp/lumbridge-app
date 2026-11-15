//! The frame's core screens, shown instead of the main window until a core
//! that can serve this app runs:
//! - none found (core_bin.rs): point at one, or build and install it, then retry;
//! - too old (or missing a method the app calls): build a newer one, then retry
//!   (nothing is downloaded: builds are from source);
//! - a newer generation than this app speaks: build a newer app.
//! Then the main window opens.

use crate::lbc::{Core, Mismatch};
use crate::mods::Request;
use crate::settings::{self, color as c};
use gpui::prelude::FluentBuilder as _;
use gpui::*;
use std::sync::Arc;

const ICON: &[u8] = include_bytes!("../assets/lumbridge/lumbridge-app.png");
const CORE_PLACE: &str = if cfg!(windows) { r"%LOCALAPPDATA%\Programs\lumbridge-core" } else { "~/.local/bin" };

/// What's missing before the main window can open.
pub enum Need {
    Install,
    Connect(String),
    Fix(Mismatch),
}

impl Need {
    pub fn connection(error: anyhow::Error) -> Self {
        match error.downcast_ref::<crate::lbc::ConnectError>() {
            Some(error) => Self::Connect(error.to_string()),
            None => Self::Install,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Need;

    #[test]
    fn unreadable_core_connections_offer_installation_instead_of_retry() {
        let error = anyhow::anyhow!("bad hello reply from core: EOF");
        assert!(matches!(Need::connection(error), Need::Install));
    }

    #[test]
    fn structured_core_errors_keep_the_recovery_hint_and_retry() {
        let message = "the core pipe cannot be accessed\n\ntry again without elevation";
        let error = anyhow::Error::new(crate::lbc::ConnectError(message.into())).context("connecting");
        assert!(matches!(Need::connection(error), Need::Connect(text) if text == message));
    }
}

enum State {
    Ready,
    Failed(String),
}

pub struct Setup {
    need: Need,
    state: State,
    requests: Option<async_channel::Receiver<Request>>,
    icon: Arc<Image>,
}

pub fn open(need: Need, requests: async_channel::Receiver<Request>, cx: &mut App) {
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(620.0), px(460.0)), cx))),
        titlebar: Some(TitlebarOptions { title: Some(crate::lumbridge::NAME.into()), ..Default::default() }),
        app_id: Some(crate::lumbridge::APP_ID.into()),
        ..Default::default()
    };
    let icon = Arc::new(Image::from_bytes(ImageFormat::Png, ICON.to_vec()));
    cx.open_window(options, |_, cx| cx.new(|_| Setup { need, state: State::Ready, requests: Some(requests), icon }))
        .expect("cannot open the Lumbridge window");
    cx.activate(true);
}

impl Setup {
    /// Connects to the core; if it serves this app, closes this window and
    /// opens the main one, else says what's still needed.
    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match Core::connect() {
            Ok(core) => match crate::lbc::check(&core.hello) {
                Ok(()) => {
                    let Some(requests) = self.requests.take() else { return };
                    window.remove_window();
                    crate::open_main(core, requests, cx);
                    return;
                }
                Err(m) => {
                    self.need = Need::Fix(m);
                    self.state = State::Ready;
                }
            },
            Err(e) => {
                self.need = Need::connection(e);
                self.state = State::Ready;
            }
        }
        cx.notify();
    }

    /// Looks for the core again (after it was built and installed), then `start`.
    fn retry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let configured = settings::load_person().ok().and_then(|p| p.core);
        match crate::core_bin::find(configured.as_deref()) {
            Some(bin) => {
                crate::core_bin::use_core(bin);
                self.start(window, cx);
            }
            None => {
                self.state = State::Failed("Still no lumbridge-core on this computer.".into());
                cx.notify();
            }
        }
    }

    fn choose(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: false, prompt: Some("Use this lumbridge-core".into()) });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(bin) = paths.into_iter().next() else { return };
            let _ = this.update_in(cx, |this, window, cx| {
                if crate::core_bin::version(&bin).is_none() {
                    this.state = State::Failed(format!("{} isn't lumbridge-core (it should answer `--version` with `lbc …`)", bin.display()));
                    cx.notify();
                    return;
                }
                // Remembered: next time Lumbridge looks there first.
                let mut person = settings::load_person().unwrap_or_default();
                person.core = Some(bin.to_string_lossy().into_owned());
                let _ = settings::write_person(&person);
                crate::core_bin::use_core(bin);
                this.start(window, cx);
            });
        })
        .detach();
    }

    /// Title, what's going on, and the line under the buttons.
    fn words(&self) -> (String, String, String) {
        match &self.need {
            Need::Install => (
                "Lumbridge needs lumbridge-core".into(),
                "lumbridge-core runs your terminals and agents, and keeps them alive when this window closes. Lumbridge couldn't find it on this computer.".into(),
                format!("Build it from source and put lumbridge-core (and lbc) in {CORE_PLACE}, then Retry."),
            ),
            Need::Connect(error) => (
                "Lumbridge can't connect to lumbridge-core".into(),
                error.clone(),
                "Once you've resolved this, try again.".into(),
            ),
            Need::Fix(Mismatch::TooOld { have, need }) => (
                "Lumbridge needs a newer lumbridge-core".into(),
                format!("Yours is {have}; this Lumbridge needs {need} or newer. Your terminals keep running while you replace it."),
                "Build a newer lumbridge-core from source and install it, then Retry.".into(),
            ),
            Need::Fix(Mismatch::Missing(methods)) => (
                "Lumbridge needs a newer lumbridge-core".into(),
                format!("Your lumbridge-core can't do everything this Lumbridge needs ({}). Your terminals keep running while you replace it.", methods.join(", ")),
                "Build a newer lumbridge-core from source and install it, then Retry.".into(),
            ),
            Need::Fix(Mismatch::Newer { generation }) => (
                "This Lumbridge is older than your lumbridge-core".into(),
                format!("Your lumbridge-core speaks a newer protocol (generation {generation}) than this Lumbridge understands. Update Lumbridge; your terminals keep running."),
                "Build a newer Lumbridge from source (lumbridge-app-update).".into(),
            ),
        }
    }
}

fn button(id: &'static str, label: &'static str, primary: bool) -> Stateful<Div> {
    div()
        .id(id)
        .h(px(38.0))
        .px(px(18.0))
        .flex()
        .items_center()
        .rounded(px(9.0))
        .cursor_pointer()
        .text_size(px(14.0))
        .font_weight(FontWeight::SEMIBOLD)
        .when(primary, |d| d.bg(c("accent")).text_color(c("accent_foreground")).hover(|s| s.opacity(0.9)))
        .when(!primary, |d| d.border_1().border_color(c("border")).text_color(c("foreground")).hover(|s| s.bg(c("raised"))))
        .child(label)
}

impl Render for Setup {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (title, body, foot) = self.words();
        let actions = match &self.need {
            Need::Install => div()
                .flex()
                .gap(px(10.0))
                .child(button("retry", "Retry", true).on_click(cx.listener(|this, _, w, cx| this.retry(w, cx))))
                .child(button("choose", "I have it somewhere…", false).on_click(cx.listener(|this, _, w, cx| this.choose(w, cx)))),
            Need::Connect(_) => div().child(button("retry", "Retry", true).on_click(cx.listener(|this, _, w, cx| this.start(w, cx)))),
            Need::Fix(Mismatch::Newer { .. }) => div()
                .flex()
                .gap(px(10.0))
                .child(button("quit", "Quit", false).on_click(cx.listener(|_, _, _, cx| cx.quit()))),
            Need::Fix(_) => div()
                .flex()
                .gap(px(10.0))
                .child(button("retry", "Retry", true).on_click(cx.listener(|this, _, w, cx| this.retry(w, cx)))),
        };
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(c("background"))
            .text_color(c("foreground"))
            .font_family(settings::get().ui_font_family.clone())
            .child(
                div()
                    .w(px(520.0))
                    .flex()
                    .flex_col()
                    .gap(px(18.0))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(14.0))
                            .child(img(self.icon.clone()).w(px(48.0)).h(px(48.0)))
                            .child(div().text_size(px(22.0)).font_weight(FontWeight::SEMIBOLD).child(title)),
                    )
                    .child(div().text_size(px(14.0)).line_height(px(21.0)).text_color(c("muted")).child(body))
                    .child(actions)
                    .child(div().text_size(px(12.5)).line_height(px(19.0)).text_color(c("dim")).child(foot))
                    .child(match &self.state {
                        State::Ready => div(),
                        State::Failed(e) => div().text_size(px(13.0)).text_color(c("blocked")).child(e.clone()),
                    }),
            )
    }
}
