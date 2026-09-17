YAME.mp3 — portable build
========================

Nothing to install. This folder is the whole application.

  YAME.exe         the app
  yame-engine.exe  the engine it runs (a Python program, frozen)

Keep the two files together: YAME looks for yame-engine.exe next to itself.

To run it
---------
Double-click YAME.exe. Windows SmartScreen will warn that the publisher is
unknown, because the build is not code-signed — "More info" then "Run anyway".

To uninstall it
---------------
Delete this folder. That is all it does: nothing is written to the registry,
and no files are placed anywhere else.

What it writes, and where
-------------------------
  %USERPROFILE%\.config\yame\presets.json   your saved rulesets
  %USERPROFILE%\.config\yame\engine.log     engine diagnostics

Set YAME_CONFIG_DIR to keep those somewhere else. Your music files are only
ever touched when you press Apply — everything before that is a preview.

If something goes wrong
-----------------------
engine.log records what the engine did and any error it hit; it is the first
thing to look at, and the first thing to include in a bug report.
