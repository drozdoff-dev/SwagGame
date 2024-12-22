const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: 'http://swag-game.ru', // Или '*' для всех доменов
        methods: ['GET', 'POST'],
        credentials: true,
    }
});

app.use(cors({
    origin: 'http://swag-game.ru', // Или '*' для всех доменов
    methods: ['GET', 'POST'],
    credentials: true,
}));

const MAP_SIZE = 5000;
const PLAYER_RADIUS = 20;
const BULLET_RADIUS = 5;
const BULLET_SPEED = 5;
const PLAYER_SPEED = 2; // Фиксированная скорость движения
const BULLET_LIFETIME = 300; // Максимальная "жизнь" пули в тиках
const EDGE_THICKNESS = 100; // Толщина красной границы

const players = {};
const bullets = [];

function getUniqueNickname(desiredNickname) {
    // Если никнейм не задан или равен 'Player', устанавливаем базовый никнейм 'Player'
    if (!desiredNickname || desiredNickname.trim() === '') {
        desiredNickname = 'Player';
    }

    // Удаляем лишние пробелы
    desiredNickname = desiredNickname.trim();

    let uniqueNickname = desiredNickname;
    let suffix = 1;

    // Собираем все текущие никнеймы игроков
    const existingNicknames = Object.values(players).map(player => player.nickname.toLowerCase());

    // Пока никнейм занят, добавляем суффикс
    while (existingNicknames.includes(uniqueNickname.toLowerCase())) {
        uniqueNickname = `${desiredNickname}${suffix}`;
        suffix++;
    }

    return uniqueNickname;
}

io.on('connection', (socket) => {
    console.log('A player connected:', socket.id);

    // Отправляем ID игрока
    socket.emit('init', { id: socket.id });

    socket.on('startGame', (nickname) => {
        const uniqueNickname = getUniqueNickname(nickname);

        players[socket.id] = {
            x: Math.random() * (MAP_SIZE - 2 * EDGE_THICKNESS) + EDGE_THICKNESS,
            y: Math.random() * (MAP_SIZE - 2 * EDGE_THICKNESS) + EDGE_THICKNESS,
            alive: true,
            kills: 0,
            nickname: uniqueNickname,
            lastProcessedInput: 0,
            inputQueue: [],
            angle: null // Начальный угол направления (null означает остановку)
        };
        console.log(`Player ${socket.id} started the game with nickname: ${players[socket.id].nickname}`);
    });

    // Обработка "ping" запросов
    socket.on('ping', () => {
        socket.emit('pong'); // Отправляем "pong" клиенту
    });

    // Обновление направления игрока
    socket.on('move', (data) => {
        const player = players[socket.id];
        if (player && player.alive && typeof data.angle === 'number') {
            // Ограничиваем угол в пределах [0, 2π]
            player.angle = ((data.angle % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
            console.log(`Player ${socket.id} set angle to ${player.angle}`);
        }
    });

    // Обработка события остановки движения
    socket.on('stop', () => {
        const player = players[socket.id];
        if (player && player.alive) {
            player.angle = null; // Устанавливаем угол в null, чтобы остановить движение
            console.log(`Player ${socket.id} stopped moving.`);
        }
    });

    // Обработка выстрела
    socket.on('shoot', (bulletData) => {
        const player = players[socket.id];
        if (player && player.alive && typeof bulletData.angle === 'number') {
            bullets.push({
                x: player.x,
                y: player.y,
                angle: bulletData.angle,
                owner: socket.id,
                lifetime: BULLET_LIFETIME
            });
            console.log(`Player ${socket.id} fired a bullet at angle ${bulletData.angle}`);
        }
    });

    // Обработка отключения игрока
    socket.on('disconnect', () => {
        console.log('A player disconnected:', socket.id);
        delete players[socket.id];
    });

    // Обработка рестарта игрока
    socket.on('restart', () => {
        if (players[socket.id]) {
            players[socket.id].x = Math.random() * (MAP_SIZE - 2 * EDGE_THICKNESS) + EDGE_THICKNESS;
            players[socket.id].y = Math.random() * (MAP_SIZE - 2 * EDGE_THICKNESS) + EDGE_THICKNESS;
            players[socket.id].alive = true;
            players[socket.id].kills = 0;
            players[socket.id].angle = null; // Сброс угла направления
            console.log(`Player ${socket.id} restarted the game.`);
        }
    });
});

// Обновление состояния игры с отправкой серверных обновлений
setInterval(() => {
    // Обновление пуль
    for (let i = bullets.length - 1; i >= 0; i--) {
        const bullet = bullets[i];
        bullet.x += Math.cos(bullet.angle) * BULLET_SPEED;
        bullet.y += Math.sin(bullet.angle) * BULLET_SPEED;
        bullet.lifetime--;

        // Удаляем пулю, если она вышла за пределы карты или закончился срок жизни
        if (
            bullet.x < 0 || bullet.x > MAP_SIZE ||
            bullet.y < 0 || bullet.y > MAP_SIZE ||
            bullet.lifetime <= 0
        ) {
            bullets.splice(i, 1);
            continue;
        }

        // Проверяем столкновения с игроками
        for (const id in players) {
            const player = players[id];
            if (player.alive && id !== bullet.owner) {
                const dx = bullet.x - player.x;
                const dy = bullet.y - player.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < PLAYER_RADIUS + BULLET_RADIUS) {
                    player.alive = false;
                    player.kills = 0;
                    
                    bullets.splice(i, 1);
                    io.to(id).emit('gameOver');
                
                    // Обновляем убийства владельца пули
                    if (players[bullet.owner]) {
                        players[bullet.owner].kills += 1;
                        // Отправляем событие убийства убийце
                        io.to(bullet.owner).emit('playerKilled');
                    }
                    console.log(`Player ${bullet.owner} killed player ${id}`);
                    break;
                }
            }
        }
    }

    // Обновление позиций игроков на основе текущих направлений
    for (const id in players) {
        const player = players[id];
        if (player.alive && typeof player.angle === 'number') {
            player.x += Math.cos(player.angle) * PLAYER_SPEED;
            player.y += Math.sin(player.angle) * PLAYER_SPEED;

            // Ограничиваем позицию внутри карты, учитывая красную границу
            player.x = Math.max(EDGE_THICKNESS, Math.min(MAP_SIZE - EDGE_THICKNESS, player.x));
            player.y = Math.max(EDGE_THICKNESS, Math.min(MAP_SIZE - EDGE_THICKNESS, player.y));
        }
    }

    function getLeaderboard() {
        return Object.values(players)
            .sort((a, b) => b.kills - a.kills)
            .slice(0, 10)
            .map((player) => ({
                nickname: player.nickname,
                kills: player.kills,
            }))
            .filter(player => player.nickname);
    }
    
    // Отправляем таблицу лидеров клиентам
    const timestamp = Date.now();
    io.emit('update', { 
        players, 
        bullets, 
        leaderboard: getLeaderboard(),
        timestamp
    });
}, 1000 / 60); // 60 раз в секунду (каждые ~16.67 мс)

server.listen(3100, () => {
    console.log('Server running on port 3100');
});