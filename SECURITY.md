# Security policy

## Reporting a problem

Please do not open a public issue, pull request or discussion for a security problem.

Email **security@lumbridgecorp.com**.

Please include:

- The version or commit (`lumbridge-app --version`, `lbc --version`).
- Your operating system and CPU type.
- What you did, what happened, and what you expected.
- Whether it needs local access, network access, or another account.
- The impact you think it has.
- A small way to reproduce it, if you have one.

Remove passwords, tokens and private data from logs before you send them.

## What happens next

- We reply to say we have your report.
- We tell you whether we can reproduce it and what we plan to do.
- We keep you informed until it is fixed or closed.
- We credit you in the change log when the fix ships, unless you ask us not to.

Please give us a fair chance to fix the problem before you publish it. We ask for 90 days, or less if
a fix is out sooner.

## Supported versions

The latest release and the latest commit on `main` are supported. There are no back-ports.

## How Lumbridge is meant to be used

- The app runs as you. It opens no network port and makes no connection of its own: no updater,
  no telemetry, no feedback upload.
- Its control socket lives in the app home (`~/.config/lumbridge-app`). Anyone who can reach that
  folder can drive the window and its commands.
- Mods are trusted JavaScript, not sandboxed extensions. They can run programs with your environment,
  fetch URLs, read files and run programs on connected machines. Layouts can load mods.
- Terminals run in Lumbridge Core; remote machines are reached through SSH by the core.

See [security and privacy](docs/security.md) for the details.

## What counts

In scope:

- Terminal output, a file name, a link or other outside content that makes the app run a command,
  open a connection, or read or write a file, where the docs say it cannot.
- A way to reach the window's commands or a terminal without access to the app home or the core.
- Leaks of tokens, keys or terminal content to logs, other users or the network.
- A secret or private data committed to this repository.

Out of scope:

- Anything that needs an attacker who already has your user account on the machine.
- Mods and layouts you install. They run as you. Read them first.
- Third-party programs and agents that run in your terminals. Report those to their owners.
- Denial of service by a local user against their own machine.

## Good faith

We will not take legal action against anyone who finds and reports a problem in good faith, keeps to
this policy, and does not access or change other people's data.
