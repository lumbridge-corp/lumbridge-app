# Lumbridge

Lumbridge is a desktop app for terminals and coding agents. Keep work in spaces, see which agents need you,
and leave terminals running when you close the window.

It is the window of [Lumbridge](https://lumbridgecorp.com), the open engine for agentic organizations
([all Lumbridge repositories](https://github.com/lumbridge-corp)).
The terminals themselves run in [Lumbridge Core](https://github.com/lumbridge-corp/lumbridge-core) (`lbc`).

## Status

- **Version:** 0.1. Interfaces can change until 1.0. `lumbridge-app --version` prints 0.1.14, the version
  of the code line it continues; release v0.1.0 is this tree.
- **Runs on:** Linux (X11 and Wayland) and macOS, on x86_64 and aarch64. The steps below are tested on
  Ubuntu 24.04, x86_64. The Windows code is kept, but not tested.
- **Not yet:**
  - No installer, packages or downloads: you build from source.
  - No updater. `scripts/lumbridge-app-update` rebuilds from your checkout.

## Quick start

You need git, a C toolchain, the GPU and windowing libraries, Rust 1.95 or newer (1.97.1 is used),
Zig 0.16.0 (exactly that release) and Lumbridge Core.

On Ubuntu 24.04, the build tools and libraries:

```sh
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential xz-utils pkg-config \
  clang libclang-dev libfontconfig-dev libfreetype-dev libwayland-dev libvulkan-dev \
  libxkbcommon-dev libxkbcommon-x11-dev mesa-vulkan-drivers

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.97.1
. "$HOME/.cargo/env"

# Zig 0.16.0 (on aarch64, use zig-aarch64-linux-0.16.0)
curl -fsSLO https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz
mkdir -p "$HOME/.local/bin"
tar -xf zig-x86_64-linux-0.16.0.tar.xz -C "$HOME/.local"
ln -sf "$HOME/.local/zig-x86_64-linux-0.16.0/zig" "$HOME/.local/bin/zig"
export PATH="$HOME/.local/bin:$PATH"
```

`mesa-vulkan-drivers` is the Vulkan driver for Intel and AMD graphics and the software fallback; with an
NVIDIA card, its own driver brings Vulkan.

Lumbridge Core, built and started the way its README says:

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/lumbridge-corp/lumbridge-core.git
(cd lumbridge-core && sh scripts/install-local.sh)
```

Then the app. The first build takes a while and downloads the Rust crates and Zig packages it needs:

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/lumbridge-corp/lumbridge-app.git
cd lumbridge-app
cargo build --release --locked
bash scripts/lumbridge-app-install-linux
lumbridge-app --version
lumbridge-app commands | head -5
```

The install script copies the app to `~/.local/share/lumbridge-app/`, links `~/.local/bin/lumbridge-app`,
and adds a launcher entry (`~/.local/share/applications/lumbridge-app.desktop`) with its icon. Start
Lumbridge from your desktop's launcher or with `lumbridge-app`. To remove it, delete those files and
`~/.config/lumbridge-app`.

On macOS, install the Xcode Command Line Tools (`xcode-select --install`), Rust from <https://rustup.rs>,
Zig 0.16.0 from <https://ziglang.org/download/>, and Lumbridge Core. Then build the same way and run
`scripts/lumbridge-app-install-macos`, which installs `~/Applications/Lumbridge.app` and
`~/.local/bin/lumbridge-app`.

The app finds `lbc` on PATH and in the usual places, and never downloads one.

## Find your work

A **space** holds work on one machine, usually in one repo. Each space has **tabs**. Split a tab into **panes** to put terminals or mod panels beside each other.

An unnamed space follows its first terminal's folder. Name a space or tab when you want a label that stays.
New tabs start in the focused terminal's folder.

The agents sidebar brings agents from your spaces into one list, including workers started by another agent.
Agents that report status show as:

- **Working:** still busy.
- **Blocked:** waiting for you.
- **Done:** finished while you were looking elsewhere.
- **Idle:** not working, or a finished agent you have looked at.

Click an agent to see it. A worker without a pane opens in **peek**, over your tab. Keep it as a tab if you want it beside your other work.
Ctrl-click a live terminal address in terminal text to peek at it; use Cmd-click on macOS.
An address such as `t7` means a terminal on the same machine as the terminal showing it. `vps/t7` names one on another machine.

The window arranges terminals. The core runs them.
Closing the window leaves them running; closing a pane or tab ends its terminals.
After a reboot or core crash, kept panes get fresh shells in their last folders, not their old programs.

## Work on another machine

Add an SSH machine from Settings → Machines or the sidebar's Add machine action.
Pick a host from your SSH config or type how SSH reaches it.
Spaces on that machine run their terminals there, not on your computer.

Each machine keeps its spaces, tabs and splits in its core. Connected screens share that structure and the live terminals, but keep their own focus and zoom.
Remote work keeps running when your local window closes or your laptop sleeps, as long as the remote machine and core stay up.

## Make it yours

Open the command palette to find an action by name, or open Settings to change fonts, colors, sounds and other preferences.
The built-in layouts are Lumbridge and Terminals.
A **layout** arranges the window. **Mods** are small JavaScript programs that draw its panels, menus and dialogs.

Duplicate a shipped layout or mod before changing its structure or code. Your copies stay yours; Lumbridge updates the shipped ones on start.
Save a personal layout, mod or key file and the window reloads it.
A broken edit keeps the last good version and reports the error.

Ctrl+Shift+P shows every command and its key (Cmd+Shift+P on macOS). Change any key in `keys.json`; see [the keys section](defaults/AGENTS.md#keys-keysjson) of the mod guide for the format, including JSON objects for named, typed command arguments.

Coding agents show one neutral icon. To give a program its own name, icon or tile, add it to `programs.json`
in the app home (see [the mod guide](defaults/AGENTS.md)).

[Layouts and mods](docs/mods.md) · [Commands](docs/commands.md)

## For agents

```sh
lumbridge-app --skill
```

This prints the agent guide for driving the window. The lumbridge-core skill points agents here.
Use lumbridge-core for running and coordinating programs; use the app to change what you see.

```sh
lumbridge-app ls
lumbridge-app status
lumbridge-app commands
```

The first two inspect the open window. The command list also works without one.
See the [command reference](docs/commands.md) for arguments.

## What it sends and where

Lumbridge never checks for updates, downloads anything or sends usage data. It opens no network port.
Settings → About shows the app's and the core's versions. Settings, layouts, mods and their data stay in
`~/.config/lumbridge-app`; terminals and their output belong to the core. Remote machines are reached
through SSH, by the core.

Mods are trusted code, not sandboxed extensions: they can run programs and fetch URLs.
Read [security and privacy](docs/security.md) before installing someone else's mod.

## Docs

- [Layouts and mods](docs/mods.md): how the window is built and how to change it.
- [Commands](docs/commands.md): every command, generated from the app.
- [Labels](docs/labels.md): the terminal labels the app reads and writes.
- [Security and privacy](docs/security.md): what mods can do and what stays on disk.
- [Change log](CHANGELOG.md).

## Work on the code

The checks are [scripts/ci.sh](scripts/ci.sh): it builds the tests and runs them headless (the render tests
use the software Vulkan driver from `mesa-vulkan-drivers`). CI runs the same script.
[just](https://just.systems/) has shortcuts: `just build`, `just test`, `just install`.

```sh
git submodule update --init --depth 1   # if you cloned without submodules
cargo build --locked
scripts/ci.sh
```

Never run a bare `target/*/lumbridge-app` against your real app home: it opens a second window on your
setup. Use `scripts/sandbox` (Linux, a headless display) or a scratch `LUMBRIDGE_APP_HOME`.

Documentation checks also need [Bun](https://bun.sh): `just docs-check` checks generated pages and CLI examples; `just docs-generate` refreshes the reference pages.

To compare drawing changes on Windows, Linux or macOS, run the same fixed workloads against each build:

```sh
python scripts/bench.py --bin <app executable> --set spinners --seconds 20
```

The runner requires `lbc` on PATH and uses the Python executable running the script. It prints a unique artifact folder with the run settings, counters and results, then stops its private app, terminals and core. Every set uses Python fixture programs. `--only spinners` measures just the quiet native spinner scenario. `--set titles` runs eight agents whose titles spin after a prefix (`π ⠹ task`) on the main layout. Keep the window visible and the display awake, and compare the same window activity and display settings; inactive windows may draw at a lower rate. Benchmark checks: `python -m unittest discover -s scripts -p test_bench.py`.

`scripts/scrub-check` looks for private addresses, home folders and tokens before anything is published.
See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and checks.

## Security

Do not open a public issue for a security problem. Email security@lumbridgecorp.com.
See [SECURITY.md](SECURITY.md) and the [trust model](docs/security.md).

## License

Lumbridge App started as a fork of [Herdr](https://github.com/herdrdev/herdr-app) (Apache-2.0). Thanks to its authors.

[Apache-2.0](LICENSE). Copyright 2026 Lumbridge Corp for its own work.
Code from other projects keeps its authors' copyright and notices; the included third-party licenses are in
[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES) and [licenses/](licenses/README.md).
Program icons from Simple Icons are their owners' trademarks; no trademark rights are granted
([defaults/icons/LICENSES.md](defaults/icons/LICENSES.md)).
