@echo off
rem End-to-end smoke test: real demo-live runtime → bridge stdout → inspector.
rem Pipes the actual orchestrator's bus events (not the bundled fixture) into
rem the live cockpit. Uses ENCHANTER_BRIDGE=stdout per the v0.3.2 wire-up.

cd /d "%~dp0\..\..\"

if not exist "inspector\target\release\enchanter.exe" (
    echo enchanter.exe not built. Run: cd inspector ^&^& cargo build --release
    pause
    exit /b 1
)

echo ============================================================
echo Enchanter v0.5.0 LIVE smoke test
echo ============================================================
echo Stage 1: spawning real MCP filesystem server
echo Stage 2: orchestrator runs all 7 phases against it
echo Stage 3: bridge forwards bus events as JSONL to inspector
echo ============================================================
echo Press 'q' in the inspector to quit early.
echo.

set ENCHANTER_BRIDGE=stdout
npx tsx scripts/demo-live.ts | inspector\target\release\enchanter.exe

echo.
pause
