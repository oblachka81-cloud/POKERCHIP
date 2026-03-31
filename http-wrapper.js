const { spawn } = require('child_process');
const path = require('path');

// Запускаем наш основной сервер
const server = spawn('node', ['index.js'], {
    stdio: 'inherit',
    cwd: __dirname
});

server.on('error', (err) => {
    console.error('Ошибка запуска:', err);
});

server.on('close', (code) => {
    console.log(`Сервер завершил работу с кодом ${code}`);
});
