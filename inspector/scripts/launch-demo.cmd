@echo off
rem Launch the inspector with the bundled fixture as a paced live stream.
rem Usable double-clicked from Explorer, or chained via `start` / `wt`.

cd /d "%~dp0\.."

if not exist "target\release\enchanter.exe" (
    echo enchanter.exe not built. Run: cargo build --release
    pause
    exit /b 1
)
if not exist "target\release\examples\demo_emit.exe" (
    echo demo_emit example not built. Run: cargo build --release --example demo_emit
    pause
    exit /b 1
)

target\release\examples\demo_emit.exe --speed 2 tests\fixtures\demo-events.jsonl | target\release\enchanter.exe
