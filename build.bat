@echo off
REM Windows desktop build script for Connection Pulse
REM Requires Visual Studio with "Desktop development with C++" workload

REM Load Visual Studio environment (update path for your VS version)
REM VS 2022: "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
REM VS 2026: "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"

REM Ensure Node.js and Cargo are in PATH
set PATH=%PATH%;C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin

REM Navigate to project and build
cd /d %~dp0
npm run tauri build
