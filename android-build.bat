@echo off
REM Android release build script for Connection Pulse
REM Update paths below to match your environment

REM JDK 21 path (Microsoft OpenJDK, Oracle, or other)
set JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.9.10-hotspot

REM Android SDK path (usually in AppData\Local\Android\Sdk)
set ANDROID_HOME=C:\Users\yuquan\AppData\Local\Android\Sdk

REM NDK path (inside Android SDK)
set NDK_HOME=%ANDROID_HOME%\ndk\27.0.12077973

REM Ensure Node.js and Cargo are in PATH
set PATH=C:\Program Files\nodejs;%USERPROFILE%\.cargo\bin;%PATH%

REM Navigate to project and build Android release
cd /d %~dp0
npm run tauri android build

echo.
echo Build complete. Output locations:
echo   APK: src-tauri\gen\android\app\build\outputs\apk\universal\release\
echo   AAB: src-tauri\gen\android\app\build\outputs\bundle\universalRelease\
