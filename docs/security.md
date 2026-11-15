# Security and privacy

## Mods have your access

A mod is trusted JavaScript running inside Lumbridge. It can run programs with your environment, fetch URLs and read files.
The built-in file API limits writes to the app home, but a mod can run a program to write elsewhere. That is not a security boundary.
Mods can also run programs on connected machines.

There is no permission prompt for each program or network request. Read a mod before installing it, and treat it like a shell script you would run yourself.
Layouts can load mods. Check those references too.

## What stays on disk

The default app home is `~/.config/lumbridge-app`, including on macOS and Windows (under your user home).
`XDG_CONFIG_HOME` changes the config root. `LUMBRIDGE_APP_HOME` selects an app home directly and takes precedence.

This folder holds your settings, keys, layouts, mods, generated agent guide and API types.
It also holds mod data, shared state, window positions, and this screen's focus and zoom.
Mods may store sensitive data here. Lumbridge does not encrypt this folder.
The [installed guide's file map](../defaults/AGENTS.md#the-files) explains the files.

Spaces, tabs and splits are stored in each machine's core document, not in the app home.
Terminals and their output belong to lumbridge-core.
Removing the app home does not stop the core or erase its data.

The app exposes a local control socket in its home so agents can inspect and drive the window.
Treat access to that home as access to the window and its commands.
Remote connections use SSH through the core.

## No network of its own

Lumbridge has no updater, no usage telemetry and no feedback upload: the app itself opens no
connection. Builds are from source (`scripts/lumbridge-app-update`). Mods are the exception: they can
fetch URLs and run programs, as above.

[Back to Lumbridge](../README.md)
