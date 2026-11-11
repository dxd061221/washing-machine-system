@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动宿舍洗衣机状态参考系统...
echo 学生端：http://localhost:3000/
echo 管理端：http://localhost:3000/admin
node server.js
pause
