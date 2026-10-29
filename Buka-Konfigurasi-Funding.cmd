@echo off
setlocal
cd /d "%~dp0"
where npm.cmd >nul 2>&1
if errorlevel 1 (
	echo npm tidak ditemukan. Pastikan Node.js sudah terpasang, lalu buka ulang file ini.
	pause
	exit /b 1
)

call npm.cmd --prefix "%~dp0backend" run funding:admin -- --open
if errorlevel 1 (
	echo.
	echo Panel Funding TPK gagal dijalankan. Periksa pesan error di atas.
	pause
)
