# Windows testing

The port is developed on Apple Silicon, where a Windows build cannot be
produced: PyInstaller freezes only for the interpreter it runs under, and there
is no MSVC linker. What *can* run on the Mac is a type check —
`cargo check --target x86_64-pc-windows-gnu` (needs `mingw-w64` from Homebrew and
`rustup target add x86_64-pc-windows-gnu`) — which catches compile errors but
nothing about behaviour.

So there are three layers, in increasing order of what they prove.

## 1. CI: does it still build? (automatic, no laptop needed)

`.github/workflows/ci.yml` runs on every push and pull request:

| Job | Runs on | Proves |
| --- | --- | --- |
| `engine` | ubuntu | 135 engine tests pass |
| `frontend` | ubuntu | types, lint, unit tests, production build |
| `shell` | ubuntu, **windows**, macos | `cargo test` compiles and passes, per platform |
| `package-windows` | **windows** | the engine freezes on Windows, the app builds, an NSIS installer comes out |

The `package-windows` job uploads `YAME_<version>_x64-setup.exe` as a build
artifact, downloadable from the run's summary page. That artifact is the thing
to install on the laptop — it is built by a clean Windows machine with no local
state, so if it installs and runs, the build half is settled.

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
