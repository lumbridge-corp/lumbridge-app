# Contributing to Lumbridge

Lumbridge is at v0.1 and kept by a small team. Please read this first.

## Before you start

- **Bugs:** open an issue. Say what you did, what happened, what you expected, your OS, desktop
  (X11 or Wayland) and graphics card, and the output of `lumbridge-app --version` and `lbc --version`.
- **Security problems:** do not open an issue. See [SECURITY.md](SECURITY.md).
- **Small fixes** (typos, clear bugs, docs): send a pull request.
- **Larger changes** (new features, new settings, a change to a file format, the mod API or the
  command list): open an issue first and wait for a reply. We say no to many features to keep the
  app small.

The app stays small; everything that can be a mod is a mod. Before adding to the app itself, ask:
does the app have to act on it, can only the app see it, and can a mod not do it correctly? If the
answer to all three is no, it belongs in a mod.

## Build and test

The README's quick start has the packages and tools for Ubuntu. Then:

```sh
git submodule update --init --depth 1   # vendor/ghostty
cargo build --locked
scripts/ci.sh
```

`scripts/ci.sh` is what CI runs: it builds the tests and runs them headless, with a throwaway home,
so nothing touches your real `~/.config/lumbridge-app` or your running core. The render tests use the
software Vulkan driver (`mesa-vulkan-drivers`). Run it before you open a pull request.

On Linux, try UI changes in the sandbox (`scripts/sandbox up`, then `scripts/sandbox shot`, `do`,
`click`, `type`, and `scripts/sandbox down`): its own core, home and a headless display, so nothing
opens on your screen. Never run a bare `target/*/lumbridge-app` against your real app home.

## What we look for

- One change per pull request. Small is good.
- Tests for behaviour you change or add.
- `defaults/AGENTS.md` (the guide every user's agents read) and `src/SKILL.md` updated in the same
  pull request when what users or agents can do changes. `cargo test` checks that the guide names
  every command and setting.
- A line in `CHANGELOG.md` under "Unreleased" for anything a user would notice.
- Plain words in docs, comments and messages. Short sentences.
- No new network calls, telemetry or update checks. The app opens no connection of its own.
- No new dependency without a reason in the pull request text. After a dependency change, run
  `just notices` (needs cargo-about and Bun, see [licenses/README.md](licenses/README.md)) and review
  the generated notices.
- Gate per operating system only where the system really behaves differently, behind one small
  module per concern.

## Never commit

- Passwords, tokens, keys or real `.env` files.
- Real names, e-mail addresses or messages of real people. Use made-up data: user `sam`, host `desk`,
  `example.com`.
- Private host names, private network addresses or internal links. For addresses use the
  documentation ranges, such as `192.0.2.1`.
- Screenshots that show any of the above.

`scripts/scrub-check` looks for these. If it flags something that is fine, add a line to
`.scrub-allow` with the reason and say so in the pull request.

## Third-party code

Say so in the pull request if any part of your change is copied or adapted from somewhere else, and
give the source and its licence. Add it to the notices (`licenses/inventory.json`, then
`just notices`). We cannot take code under a licence that conflicts with Apache-2.0. Keep every
copyright line and licence header that third-party files already carry, and the `LUMBRIDGE:` markers
on our changes to vendored code.

## Pull requests

- Write the commit subject as a short sentence that says what changed.
- In the pull request, say what the change does, why, and how you tested it.
- A maintainer reviews and merges.

## Licence of your work

By sending a contribution you agree that it is licensed under Apache-2.0, the licence of this
repository.

## Conduct

Be kind and direct. Argue about the work, not the person. Harassment and personal attacks get you
removed.
