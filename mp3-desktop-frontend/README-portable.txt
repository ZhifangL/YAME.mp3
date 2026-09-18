YAME.mp3 — portable build
========================

Nothing to install. This one file is the whole application.

To run it
---------
Double-click YAME.exe. Windows SmartScreen will warn that the publisher is
unknown, because the build is not code-signed — "More info" then "Run anyway".

On first launch YAME unpacks its metadata engine to

  %LOCALAPPDATA%\YAME\engine\<version>\yame-engine.exe

and reuses it from then on. That is why there is only one file here.

To uninstall it
---------------
Delete YAME.exe, then delete %LOCALAPPDATA%\YAME. Nothing is written to the
registry and nothing is placed anywhere else.

What it writes, and where
-------------------------
  %USERPROFILE%\.config\yame\presets.json   your saved rulesets
  %USERPROFILE%\.config\yame\engine.log     engine diagnostics

Set YAME_CONFIG_DIR to keep those somewhere else. Your music files are only
ever touched when you press Apply — everything before that is a preview.

If something goes wrong
-----------------------
engine.log records what the engine did and any error it hit; it is the first
thing to look at, and the first thing to include in a bug report. It is
appended to on every launch, so the *end* of the file is the most recent run.

If the file does not exist at all, the engine never ran — which is itself the
diagnosis, and worth reporting.
