@echo off
echo Installing dependencies...
npm install
echo.
echo Starting NVR Data Collection...
node collect_nvr.js
pause
