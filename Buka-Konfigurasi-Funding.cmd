@echo off
cd /d "%~dp0"
start "Funding Admin TPK" cmd /k "npm --prefix backend run funding:admin -- --open"
exit /b 0
