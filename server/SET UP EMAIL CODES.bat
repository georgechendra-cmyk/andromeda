@echo off
rem Double-click: sign-in codes and password resets by email, sent from your Gmail. Nothing else changes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-email.ps1"
pause
