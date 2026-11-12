# Windows testing

The port is developed on Apple Silicon, where a Windows build cannot be
produced: PyInstaller freezes only for the interpreter it runs under, and there
is no MSVC linker. What *can* run on the Mac is a type check —
`cargo check --target x86_64-pc-windows-gnu` (needs `mingw-w64` from Homebrew and
`rustup target add x86_64-pc-windows-gnu`) — which catches compile errors but
nothing about behaviour.

So there are three layers, in increasing order of what they prove.

## 1. CI: does it still build? (automatic, no laptop needed)

`.github/workflows/ci.yml` runs on every push and pull request. Two tiers:

**Verify** — every push and PR, all three platforms, roughly three minutes. It
packages nothing, so a two-line change is not billed as a release.

| Job | Runs on | Proves |
| --- | --- | --- |
| `Frontend` | ubuntu | types, lint, unit tests, production build |
| `Engine` | ubuntu | the pytest suite passes |
| `Shell check (<os>)` | ubuntu, **windows**, macos | `cargo check --all-targets` — the shell *and its tests* compile per platform |
| `Shell tests` | ubuntu | `cargo test` passes, under a 10-minute bound |

**Package** — on demand, or automatically on `main`. Minutes rather than
seconds, because it freezes the engine and runs a full release compile.

| Job | Runs on | Proves |
| --- | --- | --- |
| `Windows portable build` | **windows** | the engine freezes on Windows; uploads `yame-windows-portable` (`YAME-portable-x64.zip`) |
| `Windows installer` | **windows** | an NSIS installer comes out; uploads `yame-windows-installer` |

Both packaging jobs are skipped on pull requests (a PR's ref is not `main`), so
ask for them explicitly:

```bash
gh workflow run CI --ref <branch> -f package=true
gh run watch
```

Download either artifact from the run's summary page. The installer inside
`yame-windows-installer` is `YAME_<version>_x64-setup.exe`; that, or the portable
zip, is the thing to install on the laptop — it is built by a clean Windows
machine with no local state, so if it installs and runs, the build half is
settled.

Note the asymmetry: the Windows `Shell check` job only *type-checks*, because
`cargo test` is Linux-only. A Windows test that compiles but hangs or fails will
not be caught here — that is what the laptop is for.

Iterating on a Windows compile error needs no laptop at all: push and read the
job log.

## 2. On the laptop: the manual checklist

`ports/windows/CHECKLIST.md` is the scripted pass, ordered so that an early
failure makes the later steps meaningless. It covers what CI cannot: the menu
bar, the context menus, the Open With dialog, the clipboard, drag-and-drop, and
process cleanup.

Two results matter more than the rest, because they are the decisions that were
made blind:

- **Window chrome** — whether the app ends up drawing its own header *and* a
  native title bar at the same time.
- **Orphaned engines** — whether closing YAME leaves a `yame-engine.exe` behind.

## 3. Optional: let the agent drive the laptop

If a bug needs interactive back-and-forth rather than a checklist, the fastest
route is to run commands on the laptop directly instead of pasting output back.

**Windows built-in OpenSSH (nothing to install).** On the laptop, in an
administrator PowerShell:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
whoami                      # the account to log in as
ipconfig | Select-String IPv4   # this machine's address
```

Then from the Mac: `ssh <user>@<ip>`, and the agent can run the same commands and
read the same output. The only new listener is sshd, and `Stop-Service sshd`
closes it again.

**VS Code Remote-SSH** does the same with a GUI, and is easier if you want to
watch what is happening.

Neither is needed for the checklist pass. They matter only if a Windows-only bug
needs investigating, and they can be switched on for an hour and off again.

### What the agent still cannot do

- **See the screen.** Anything visual is a description in, description out. A
  screenshot of a wrong-looking window is genuinely useful.
- **Judge native feel.** Whether the menu reads like a Windows app is a human
  call; the checklist asks for it explicitly.
- **Sign anything.** Windows SmartScreen will warn about an unsigned installer.
  That is expected for now, and is the same class of problem as the macOS
  "damaged, move to Bin" issue in the README — it needs a code signing
  certificate, not a code change.

## Choosing the cheapest check that answers the question

The three layers above are not equally expensive, and most changes do not need
the most expensive one. Roughly, fastest first:

| Question | Command | Cost |
| --- | --- | --- |
| Did I break a store, rule or path helper? | `cd mp3-desktop-frontend && pnpm run check` | ~6s |
| Did I break the engine? | `cd mp3-metadata-api && .venv/bin/python -m pytest -q` | ~1s |
| Did I break the shell, on any platform? | `gh run list --limit 1` after a push | ~3 min |
| Does a real Windows build come out? | dispatch with `package` ticked | ~5-8 min |

The tiers themselves are described in §1. The two that matter for choosing are
that the verify tier runs on every push and packages nothing, and that packaging
has to be asked for — or arrives as a side effect of pushing to `main`.

Docs-only changes (`**/*.md`, `ports/**`, `LICENSE`) skip CI entirely — but only
on `push`. `paths-ignore` does not apply to `pull_request`, so a documentation
PR still runs the whole verify tier.

### Iterating without CI at all

The store, the rules and the diagnostics are platform-independent, so most
undo/search/menu-logic changes can be settled on the Mac in seconds — and the
whole class of bug that needed two Ctrl+Z presses was in shared code every time.

```bash
cd mp3-desktop-frontend
pnpm run check          # types, lint and all 76 tests, ~6s
pnpm run desktop:dev    # the app with hot reload, for seeing it
```

For a change that is genuinely Windows-specific — window chrome, the menu bar,
paths — the verify tier's Windows `cargo check` catches compile breaks in about
three minutes, and only a behaviour question needs the laptop.

### What is deliberately still slow

The Windows release compile is the expensive part and it is not wasteful: the
Rust cache key is now constant rather than per-commit, so the dependency build is
paid once rather than on nearly every push. The first run after a dependency
changes will still take minutes, and that is the correct trade for not rebuilding
the tree every time.
