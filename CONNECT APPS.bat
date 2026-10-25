@echo off
title Andromeda Connector
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is needed: get it from https://nodejs.org and run this again. & pause & exit /b 1)
rem your own list of apps (tools\connections.example.json shows how); Claude Desktop's apps are read too
if not exist "tools\connections.json" echo {"mcpServers": {}}> "tools\connections.json"
node tools\connector.mjs
pause
