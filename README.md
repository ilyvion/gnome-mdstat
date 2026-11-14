# MD RAID Status

A GNOME Shell extension that shows the state of Linux software RAID (md) arrays
in the top bar. It can monitor the machine it runs on or another host over SSH.

- The top bar shows one pip per device position of each array, the graphical
  counterpart of the `[UU_]` in `/proc/mdstat`. Arrays are separated by a gap.

  | Pip | Meaning |
  | --- | --- |
  | White | Device in sync |
  | Yellow | Device being rebuilt |
  | Red | Device failed |
  | Red outline | Device missing |

- While an array is syncing, checking, rebuilding or degraded, the pips are
  joined by a short text such as `check 42.0%` or `degraded, recover 12.3%`.
- An icon replaces the pips when no array is found or the host cannot be
  reached.
- The menu lists each array with its level, size, state, progress, speed,
  remaining time and member devices.

Supports GNOME Shell 50.

## How it works

The extension periodically reads the md attributes under `/sys/block/md*/` with
a single `grep` command. These files are world-readable, so no root access is
needed. For a remote host, that command is appended as one argument to a
command prefix you configure (typically `ssh`).

## Settings

| Setting                  | Default | Meaning                                                                                   |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| Remote command           | empty   | Command prefix that runs its argument on the monitored host. Empty monitors this machine. |
| Timeout                  | 20 s    | A query that has not finished after this long is killed.                                  |
| Interval                 | 60 s    | Time between queries while all arrays are idle.                                           |
| Interval during activity | 5 s     | Time between queries while an array is busy.                                              |

### Remote command

Example: `ssh -i ~/.ssh/id_monitor server`

- The command is run by the local `sh` as `exec <remote command> '<query>'`, so
  `~` and environment variables are expanded.
- It has to be a single command. To set environment variables, use
  `env NAME=value ssh …`.
- It has to work without asking for a password or passphrase. Queries run with
  `SSH_ASKPASS_REQUIRE=never`, so a prompt becomes an error shown in the menu.
- The remote login shell has to be POSIX compatible.

## Building

Requires Node.js, npm and `glib-compile-schemas`.

```sh
npm install
npm run build    # compiles into dist/, a complete extension directory
npm test         # builds, then runs the parser tests
npm run check    # type-checks without emitting
```

## Installing

For development, symlink `dist/` into your extensions directory:

```sh
npm run link
```

Or build an installable zip:

```sh
npm run pack
gnome-extensions install --force mdstat@ilyvion.shell-extension.zip
```

GNOME Shell discovers new extensions at login, so log out and back in, then:

```sh
gnome-extensions enable mdstat@ilyvion
```

## Development

GNOME Shell on Wayland cannot reload extension code in a running session.
`npm run nested` builds the extension and starts a nested shell in a window,
which picks up the current build. It requires the `mutter-devkit` package.

Errors and `console.log` output of the extension appear in the journal:

```sh
journalctl -f -o cat /usr/bin/gnome-shell
```

### Layout

| Path               | Contents                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `src/mdstat.ts`    | The sysfs query, parsing and text formatting. Has no GNOME dependencies. |
| `src/extension.ts` | Panel indicator, menu, polling and subprocess handling.                  |
| `src/prefs.ts`     | Settings window.                                                         |
| `schemas/`         | GSettings schema.                                                        |
| `stylesheet.css`   | Styles for the indicator and menu.                                       |
| `scripts/`         | Build, link and pack scripts.                                            |
| `test/`            | Parser tests, run against the compiled `dist/mdstat.js`.                 |

## License

Licensed under either of

- Apache License, Version 2.0, ([LICENSE-APACHE](LICENSE-APACHE) or <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or <http://opensource.org/licenses/MIT>)

at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in the work by you, as defined in the Apache-2.0 license, shall be
dual licensed as above, without any additional terms or conditions.
