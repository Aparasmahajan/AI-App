@echo off
REM Start whisper-server with the flags that actually work on this CPU-BLAS build.
REM -nfa disables flash attention (was crashing mid-request on this build).
REM -ng disables GPU init noise (we have no GPU anyway).
cd /d "%~dp0..\addon\whisper-blas-bin-x64\Release"
whisper-server.exe -m "%~dp0..\addon\ggml-base.en.bin" --host 127.0.0.1 --port 9000 -nfa -ng
