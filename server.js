const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

app.use(session({
    secret: 'axius-wrn-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const PORT = process.env.PORT || 3000;
const YANDEX_TOKEN = process.env.YANDEX_TOKEN || '';
const TASK_FOLDER = 'app:/tasks';
const BOT_FOLDER = 'app:/bots';
const USERS_FOLDER = 'app:/users';
const MAX_STORAGE_PER_USER = 3 * 1024 * 1024 * 1024; // 3 ГБ

// ============ ЛОГИ ============
const logs = [];
function log(msg, level = 'INFO') {
    const entry = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 500) logs.shift();
}

log('=== Axius WRN Server with Telegram Bot Manager ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));

// ============ ПОЛЬЗОВАТЕЛИ ============
const usersFile = '/tmp/users.json';
let users = {};
if (fs.existsSync(usersFile)) {
    users = JSON.parse(fs.readFileSync(usersFile));
} else {
    users = {
        'admin': {
            username: 'admin',
            password: 'admin123',
            sites: [],
            bots: [],
            storagePath: '/tmp/axius_storage/admin',
            localOnly: false
        }
    };
    fs.writeFileSync(usersFile, JSON.stringify(users));
}

function saveUsers() {
    fs.writeFileSync(usersFile, JSON.stringify(users));
}

// ============ YANDEX DISK API ============
class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async listFolder(folderPath) {
        if (!this.token) return [];
        try {
            const res = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(folderPath)}&limit=1000`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            return res.data._embedded?.items || [];
        } catch (e) {
            return [];
        }
    }

    async fileExists(path) {
        if (!this.token) return false;
        try {
            await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(path)}`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            return true;
        } catch (e) {
            return false;
        }
    }

    async readFile(relativePath) {
        const fullPath = `${relativePath}`;
        const dl = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(fullPath)}`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        const res = await axios.get(dl.data.href, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    }

    async writeFile(relativePath, data) {
        const fullPath = `${relativePath}`;
        const up = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(fullPath)}&overwrite=true`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        await axios.put(up.data.href, data, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
    }

    async deleteFile(relativePath) {
        const fullPath = `${relativePath}`;
        try {
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(fullPath)}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
        } catch (e) {}
    }

    async deleteFolder(relativePath) {
        const fullPath = `${relativePath}`;
        try {
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(fullPath)}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
        } catch (e) {}
    }

    async getFolderSize(folderPath) {
        try {
            const items = await this.listFolder(folderPath);
            let totalSize = 0;
            for (const item of items) {
                if (item.type === 'file') {
                    totalSize += item.size || 0;
                } else if (item.type === 'dir') {
                    totalSize += await this.getFolderSize(item.path);
                }
            }
            return totalSize;
        } catch (e) {
            return 0;
        }
    }

    async listTaskFiles() {
        try {
            const items = await this.listFolder(TASK_FOLDER);
            return items.filter(f => f.name.endsWith('.task') && !f.name.includes('_result'));
        } catch (e) {
            return [];
        }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// ============ TELEGRAM BOT MANAGER ============
class TelegramBotManager {
    constructor(disk) {
        this.disk = disk;
        this.activeBots = new Map();
    }

    async registerBot(username, botToken, botUsername) {
        const botPath = `${BOT_FOLDER}/${botUsername}`;
        const tokenPath = `${botPath}/token.txt`;
        const configPath = `${botPath}/config.json`;

        await this.disk.writeFile(tokenPath, Buffer.from(botToken));

        const config = {
            bot_username: botUsername,
            owner: username,
            created_at: new Date().toISOString(),
            status: 'active'
        };
        await this.disk.writeFile(configPath, Buffer.from(JSON.stringify(config, null, 2)));

        await this.disk.writeFile(`${botPath}/chats/.gitkeep`, Buffer.from(''));

        const userBotTokensPath = `${USERS_FOLDER}/${username}/bot_tokens.json`;
        let userBotTokens = [];
        try {
            userBotTokens = JSON.parse((await this.disk.readFile(userBotTokensPath)).toString());
        } catch (e) {
            userBotTokens = [];
        }

        userBotTokens.push({
            username: botUsername,
            token: botToken,
            added_at: new Date().toISOString()
        });
        await this.disk.writeFile(userBotTokensPath, Buffer.from(JSON.stringify(userBotTokens, null, 2)));

        log(`[Bot Manager] Registered bot @${botUsername} for user ${username}`);
        return { success: true, bot_username: botUsername };
    }

    async getBotChats(botUsername) {
        const chatsPath = `${BOT_FOLDER}/${botUsername}/chats`;
        try {
            const items = await this.disk.listFolder(chatsPath);
            return items
                .filter(c => c.type === 'dir')
                .map(c => ({
                    chat_id: c.name.replace('@', ''),
                    username: c.name,
                    path: c.path
                }));
        } catch (e) {
            return [];
        }
    }

    async getChatMessages(botUsername, chatId, limit = 50) {
        const notifPath = `${BOT_FOLDER}/${botUsername}/chats/@${chatId}/notifications`;
        try {
            const files = await this.disk.listFolder(notifPath);
            const messages = [];

            const jsonFiles = files
                .filter(f => f.name.endsWith('.json'))
                .sort((a, b) => new Date(b.modified) - new Date(a.modified))
                .slice(0, limit);

            for (const file of jsonFiles) {
                const content = await this.disk.readFile(`${notifPath}/${file.name}`);
                messages.push(JSON.parse(content.toString()));
            }

            return messages;
        } catch (e) {
            return [];
        }
    }

    async getChatMedia(botUsername, chatId) {
        const mediaPath = `${BOT_FOLDER}/${botUsername}/chats/@${chatId}/media`;
        try {
            const files = await this.disk.listFolder(mediaPath);
            return files
                .filter(f => f.type === 'file')
                .map(f => ({
                    name: f.name,
                    size: f.size,
                    type: this.guessMediaType(f.name),
                    url: f.path,
                    modified: f.modified
                }));
        } catch (e) {
            return [];
        }
    }

    guessMediaType(filename) {
        const ext = path.extname(filename).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'photo';
        if (['.mp4', '.avi', '.mov', '.webm'].includes(ext)) return 'video';
        if (['.mp3', '.ogg', '.wav', '.m4a'].includes(ext)) return 'audio';
        if (['.pdf', '.doc', '.docx', '.txt'].includes(ext)) return 'document';
        if (['.sticker', '.webp'].includes(ext)) return 'sticker';
        return 'file';
    }

    async sendMessage(botUsername, chatId, text) {
        const tokenPath = `${BOT_FOLDER}/${botUsername}/token.txt`;
        let botToken;
        try {
            botToken = (await this.disk.readFile(tokenPath)).toString().trim();
        } catch (e) {
            throw new Error('Bot token not found');
        }

        try {
            const response = await axios.post(
                `https://api.telegram.org/bot${botToken}/sendMessage`,
                { chat_id: chatId, text: text }
            );

            const notification = {
                type: 'message_sent',
                chat_id: chatId,
                text: text,
                timestamp: new Date().toISOString(),
                status: 'sent',
                message_id: response.data.result.message_id
            };

            const notifPath = `${BOT_FOLDER}/${botUsername}/chats/@${chatId}/notifications/notif_${Date.now()}.json`;
            await this.disk.writeFile(notifPath, Buffer.from(JSON.stringify(notification, null, 2)));

            return { success: true, message_id: response.data.result.message_id };

        } catch (e) {
            log(`[Bot Manager] Error sending message: ${e.message}`, 'ERROR');
            throw e;
        }
    }

    async sendMedia(botUsername, chatId, mediaType, fileBuffer, caption = '') {
        const tokenPath = `${BOT_FOLDER}/${botUsername}/token.txt`;
        const botToken = (await this.disk.readFile(tokenPath)).toString().trim();

        const timestamp = Date.now();
        const ext = this.getExtension(mediaType);
        const fileName = `${mediaType}_${timestamp}${ext}`;
        const mediaPath = `${BOT_FOLDER}/${botUsername}/chats/@${chatId}/media/${fileName}`;
        const userMediaPath = `${USERS_FOLDER}/${botToken}_${chatId}/${MEDIA_FOLDER}/${fileName}`;

        // Сохраняем медиа на Яндекс.Диск
        await this.disk.writeFile(mediaPath, fileBuffer);

        // Отправляем через Telegram API
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append(mediaType, fileBuffer, fileName);
        if (caption) formData.append('caption', caption);

        const response = await axios.post(
            `https://api.telegram.org/bot${botToken}/send${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)}`,
            formData,
            { headers: { 'Content-Type': 'multipart/form-data' } }
        );

        // Создаём уведомление
        const notification = {
            type: `${mediaType}_sent`,
            chat_id: chatId,
            file_name: fileName,
            file_size: fileBuffer.length,
            timestamp: new Date().toISOString(),
            status: 'sent',
            message_id: response.data.result.message_id
        };

        const notifPath = `${BOT_FOLDER}/${botUsername}/chats/@${chatId}/notifications/notif_${timestamp}.json`;
        await this.disk.writeFile(notifPath, Buffer.from(JSON.stringify(notification, null, 2)));

        // Копируем в incoming пользователя
        const incomingPath = `${USERS_FOLDER}/incoming/new_${mediaType}_${timestamp}.json`;
        await this.disk.writeFile(incomingPath, Buffer.from(JSON.stringify(notification, null, 2)));

        return { success: true, file_name: fileName, message_id: response.data.result.message_id };
    }

    getExtension(mediaType) {
        const map = {
            'photo': '.jpg',
            'video': '.mp4',
            'audio': '.mp3',
            'document': '.pdf',
            'voice': '.ogg',
            'sticker': '.webp'
        };
        return map[mediaType] || '.bin';
    }

    async processIncomingUpdate(botUsername, update) {
        if (update.message) {
            const msg = update.message;
            const chatId = String(msg.chat.id);
            const timestamp = Date.now();

            // Определяем тип сообщения
            let notification = {
                chat_id: chatId,
                timestamp: new Date().toISOString(),
                message_id: msg.message_id
            };

            if (msg.text) {
                notification.type = 'message';
                notification.text = msg.text;
                notification.from = msg.from?.username || msg.from?.first_name || 'Unknown';
            } else if (msg.photo) {
                notification.type = 'photo';
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                notification.file_id = fileId;
                notification.caption = msg.caption || '';
                notification.from = msg.from?.username || msg.from?.first_name || 'Unknown';
            } else if (msg.video) {
                notification.type = 'video';
                notification.file_id = msg.video.file_id;
                notification.caption = msg.caption || '';
                notification.from = msg.from?.username || msg.from?.first_name || 'Unknown';
            } else if (msg.audio) {
                notification.type = 'audio';
                notification.file_id = msg.audio.file_id;
                notification.from = msg.from?.username || msg.from?.first_name || 'Unknown';
            } else if (msg.document) {
                notification.type = 'document';
                notification.file_id = msg.document.file_id;
                notification.file_name = msg.document.file_name;
                notification.from = msg.from?.username || msg.from?.first_name || 'Unknown';
            } else if (msg.voice) {
                notification.type = 'voice';
                notification.file_id = msg.voice.file_id;
                notification.from = msg.from?.username || msg.from?.first_name || 'Unknown';
            } else if (msg.sticker) {
                notification.type = 'sticker';
                notification.file_id = msg.sticker.file_id;
                notification.from = msg.from?.username || msg.from?.first_name || 'Unknown';
            } else {
                notification.type = 'unknown';
                notification.from = msg.from?.username || msg.from?.first_name || 'Unknown';
            }

            // Сохраняем уведомление
            const notifPath = `${BOT_FOLDER}/${botUsername}/chats/@${chatId}/notifications/notif_${timestamp}.json`;
            await this.disk.writeFile(notifPath, Buffer.from(JSON.stringify(notification, null, 2)));

            // Копируем в incoming
            const incomingPath = `${USERS_FOLDER}/incoming/new_${notification.type}_${timestamp}.json`;
            await this.disk.writeFile(incomingPath, Buffer.from(JSON.stringify(notification, null, 2)));

            log(`[Bot Manager] Received ${notification.type} from @${chatId}`);
        }
    }

    async getUpdates(botUsername) {
        const tokenPath = `${BOT_FOLDER}/${botUsername}/token.txt`;
        const botToken = (await this.disk.readFile(tokenPath)).toString().trim();

        // Получаем последний offset
        const offsetPath = `${BOT_FOLDER}/${botUsername}/offset.txt`;
        let offset = 0;
        try {
            offset = parseInt((await this.disk.readFile(offsetPath)).toString().trim()) || 0;
        } catch (e) {
            offset = 0;
        }

        try {
            const response = await axios.get(
                `https://api.telegram.org/bot${botToken}/getUpdates`,
                { params: { offset: offset + 1, timeout: 30 } }
            );

            const updates = response.data.result || [];
            for (const update of updates) {
                await this.processIncomingUpdate(botUsername, update);
                offset = update.update_id;
            }

            // Сохраняем offset
            if (updates.length > 0) {
                await this.disk.writeFile(offsetPath, Buffer.from(String(offset)));
            }

            return { success: true, updates_count: updates.length };
        } catch (e) {
            return { success: true, updates_count: 0, error: e.message };
        }
    }

    async getUserBots(username) {
        const userBotTokensPath = `${USERS_FOLDER}/${username}/bot_tokens.json`;
        try {
            return JSON.parse((await this.disk.readFile(userBotTokensPath)).toString());
        } catch (e) {
            return [];
        }
    }

    async deleteBot(username, botUsername) {
        const botPath = `${BOT_FOLDER}/${botUsername}`;
        await this.disk.deleteFolder(botPath);

        const userBotTokensPath = `${USERS_FOLDER}/${username}/bot_tokens.json`;
        let userBotTokens = [];
        try {
            userBotTokens = JSON.parse((await this.disk.readFile(userBotTokensPath)).toString());
        } catch (e) {
            userBotTokens = [];
        }
        userBotTokens = userBotTokens.filter(b => b.username !== botUsername);
        await this.disk.writeFile(userBotTokensPath, Buffer.from(JSON.stringify(userBotTokens, null, 2)));

        log(`[Bot Manager] Deleted bot @${botUsername} for user ${username}`);
        return { success: true };
    }

    async clearCloudStorage(username) {
        const userPath = `${USERS_FOLDER}/${username}`;
        const bots = await this.getUserBots(username);

        // Очищаем папки ботов
        for (const bot of bots) {
            await this.disk.deleteFolder(`${BOT_FOLDER}/${bot.username}`);
        }

        // Очищаем папку пользователя
        await this.disk.deleteFolder(userPath);

        // Пересоздаём пустую структуру
        await this.disk.writeFile(`${userPath}/bot_tokens.json`, Buffer.from('[]'));
        await this.disk.writeFile(`${userPath}/config.json`, Buffer.from(JSON.stringify({
            username: username,
            storage_cleared_at: new Date().toISOString(),
            local_only: true
        }, null, 2)));

        log(`[Bot Manager] Cleared cloud storage for user ${username}`);
        return { success: true };
    }

    async checkStorageLimit(username) {
        const userPath = `${USERS_FOLDER}/${username}`;
        const size = await this.disk.getFolderSize(userPath);

        if (size > MAX_STORAGE_PER_USER) {
            log(`[Bot Manager] Storage limit exceeded for ${username} (${(size/1024/1024/1024).toFixed(2)} GB)`);
            await this.clearCloudStorage(username);
            return { cleared: true, previous_size: size };
        }

        return { cleared: false, current_size: size, limit: MAX_STORAGE_PER_USER };
    }
}

const botManager = new TelegramBotManager(disk);

// ============ СТАРЫЙ ВОРКЕР ДЛЯ ЗАДАЧ ============
async function processTask(taskFile) {
    const taskName = taskFile.name;
    const resultId = taskName.replace('.task', '_result') + '.task';

    log('[Worker] Processing: ' + taskName);

    try {
        const taskData = await disk.readFile(`${TASK_FOLDER}/${taskName}`);
        const requestStr = taskData.toString('utf8');

        let url = '';
        const lines = requestStr.split('\r\n');
        if (lines[0]) {
            const parts = lines[0].split(' ');
            url = parts[1];
        }

        if (!url) return;

        log('[Worker] Fetching: ' + url);

        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const httpResponse = `HTTP/1.1 ${response.status} OK\r\nContent-Type: text/html\r\nContent-Length: ${response.data.length}\r\n\r\n`;
        const header = Buffer.from(httpResponse, 'utf8');
        const body = Buffer.from(response.data);
        const full = Buffer.concat([header, body]);

        await disk.writeFile(`${TASK_FOLDER}/${resultId}`, full);
        await disk.deleteFile(`${TASK_FOLDER}/${taskName}`);

        log('[Worker] DONE: ' + taskName);
    } catch (e) {
        log('[Worker] ERROR: ' + e.message, 'ERROR');
        const errorResponse = `HTTP/1.1 500 Error\r\nContent-Type: text/html\r\n\r\n<h1>Error</h1><p>${e.message}</p>`;
        await disk.writeFile(`${TASK_FOLDER}/${resultId}`, Buffer.from(errorResponse));
        await disk.deleteFile(`${TASK_FOLDER}/${taskName}`);
    }
}

async function workerLoop() {
    log('[Worker] Started');
    while (true) {
        try {
            const tasks = await disk.listTaskFiles();
            for (const task of tasks) {
                await processTask(task);
            }
        } catch (e) {
            log('[Worker] Loop error: ' + e.message, 'ERROR');
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ============ ВОРКЕР ДЛЯ ОПРОСА БОТОВ ============
async function botPollerLoop() {
    log('[Bot Poller] Started');
    while (true) {
        try {
            const botsFolder = await disk.listFolder(BOT_FOLDER);
            for (const item of botsFolder) {
                if (item.type === 'dir') {
                    const botUsername = item.name;
                    await botManager.getUpdates(botUsername);
                }
            }
        } catch (e) {
            log('[Bot Poller] Error: ' + e.message, 'ERROR');
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

// ============ СТАРЫЙ API ============
app.post('/fetch', async (req, res) => {
    const { task_id, target_url } = req.body;
    log('[API] /fetch: ' + task_id);
    res.status(202).json({ status: 'queued', task_id });
});

app.get('/result', async (req, res) => {
    res.json({ status: 'processing' });
});

// ============ НОВЫЙ API: TELEGRAM BOT MANAGER ============

// Зарегистрировать бота
app.post('/api/bots/register', requireAuth, async (req, res) => {
    const { bot_token, bot_username } = req.body;
    const username = req.session.user.username;

    try {
        const result = await botManager.registerBot(username, bot_token, bot_username);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Получить список ботов пользователя
app.get('/api/bots', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    try {
        const bots = await botManager.getUserBots(username);
        res.json({ bots });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Получить список чатов бота
app.get('/api/bots/:botUsername/chats', requireAuth, async (req, res) => {
    const { botUsername } = req.params;
    try {
        const chats = await botManager.getBotChats(botUsername);
        res.json({ chats });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Получить сообщения чата
app.get('/api/bots/:botUsername/chats/:chatId/messages', requireAuth, async (req, res) => {
    const { botUsername, chatId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    try {
        const messages = await botManager.getChatMessages(botUsername, chatId, limit);
        res.json({ messages });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Получить медиа чата
app.get('/api/bots/:botUsername/chats/:chatId/media', requireAuth, async (req, res) => {
    const { botUsername, chatId } = req.params;
    try {
        const media = await botManager.getChatMedia(botUsername, chatId);
        res.json({ media });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Отправить сообщение
app.post('/api/bots/:botUsername/send', requireAuth, async (req, res) => {
    const { botUsername } = req.params;
    const { chat_id, text } = req.body;
    try {
        const result = await botManager.sendMessage(botUsername, chat_id, text);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Получить обновления бота
app.post('/api/bots/:botUsername/updates', requireAuth, async (req, res) => {
    const { botUsername } = req.params;
    try {
        const result = await botManager.getUpdates(botUsername);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Удалить бота
app.delete('/api/bots/:botUsername', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    const { botUsername } = req.params;
    try {
        const result = await botManager.deleteBot(username, botUsername);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Очистить облачное хранилище
app.post('/api/storage/clear', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    try {
        const result = await botManager.clearCloudStorage(username);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Проверить объём хранилища
app.get('/api/storage/check', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    try {
        const result = await botManager.checkStorageLimit(username);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============ АВТОРИЗАЦИЯ ============
function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN - Вход</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .box { background: #2a2a4e; padding: 40px; border-radius: 20px; width: 350px; }
                h1 { color: #00d4ff; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; }
                button { width: 100%; padding: 15px; background: #00d4ff; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                a { color: #00d4ff; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>🚀 Axius WRN</h1>
                <form method="POST" action="/login">
                    <input type="text" name="username" placeholder="Логин" value="admin" required>
                    <input type="password" name="password" placeholder="Пароль" value="admin123" required>
                    <button type="submit">Войти</button>
                </form>
                <p style="text-align: center; margin-top: 20px;"><a href="/register">Регистрация</a></p>
            </div>
        </body>
        </html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users[username];
    if (user && user.password === password) {
        req.session.user = { username };
        log('[Auth] Login: ' + username);
        res.redirect('/dashboard');
    } else {
        res.redirect('/login?error=Неверный логин или пароль');
    }
});

app.get('/register', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Регистрация</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .box { background: #2a2a4e; padding: 40px; border-radius: 20px; width: 350px; }
                h1 { color: #00ff88; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; }
                button { width: 100%; padding: 15px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                a { color: #00d4ff; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>📝 Регистрация</h1>
                <form method="POST" action="/register">
                    <input type="text" name="username" placeholder="Логин" required>
                    <input type="password" name="password" placeholder="Пароль" required>
                    <button type="submit">Зарегистрироваться</button>
                </form>
                <p style="text-align: center; margin-top: 20px;"><a href="/login">← Назад</a></p>
            </div>
        </body>
        </html>
    `);
});

app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.redirect('/register?error=Заполните все поля');
    if (users[username]) return res.redirect('/register?error=Пользователь уже существует');

    users[username] = { username, password, sites: [], bots: [] };
    saveUsers();
    req.session.user = { username };
    log('[Auth] Registered: ' + username);
    res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ============ ДАШБОРД С УПРАВЛЕНИЕМ БОТАМИ ============
app.get('/dashboard', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const user = users[username];

    let sitesHtml = '';
    (user.sites || []).forEach(site => {
        sitesHtml += `
            <div class="card">
                <span class="icon">${site.url.includes('telegram') ? '📱' : '🌐'}</span>
                <div class="info">
                    <div class="name">${site.name}</div>
                    <div class="url">${site.url}</div>
                </div>
                <a href="/view/${site.id}" class="btn">Открыть</a>
                <a href="/delete/${site.id}" class="btn-delete">🗑️</a>
            </div>`;
    });

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN - Дашборд</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; margin: 0; }
                .header { background: #00d4ff; padding: 20px; display: flex; justify-content: space-between; }
                .header h1 { color: #1a1a2e; margin: 0; }
                .container { max-width: 900px; margin: 30px auto; padding: 20px; }
                .section { background: #2a2a4e; padding: 30px; border-radius: 15px; margin-bottom: 30px; }
                .section h2 { margin-top: 0; color: #00d4ff; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; box-sizing: border-box; }
                button { width: 100%; padding: 15px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .card { background: #3a3a5e; padding: 15px; border-radius: 10px; display: flex; align-items: center; gap: 15px; margin-bottom: 10px; }
                .icon { font-size: 30px; }
                .info { flex: 1; }
                .name { font-weight: bold; }
                .url { font-size: 12px; opacity: 0.7; }
                .btn { background: #00d4ff; color: #1a1a2e; padding: 8px 15px; border-radius: 8px; text-decoration: none; }
                .btn-delete { color: #ff4444; text-decoration: none; }
                .logout { background: rgba(0,0,0,0.2); color: #1a1a2e; padding: 10px 20px; border-radius: 5px; text-decoration: none; }
                .nav-links { display: flex; gap: 10px; }
                .nav-links a { color: #1a1a2e; text-decoration: none; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN</h1>
                <div style="display: flex; gap: 20px; align-items: center;">
                    <div class="nav-links">
                        <a href="/logs">📋 Логи</a>
                        <a href="/telegram-bots">🤖 Telegram Боты</a>
                    </div>
                    <span>👤 ${username}</span>
                    <a href="/logout" class="logout">Выйти</a>
                </div>
            </div>
            <div class="container">
                <div class="section">
                    <h2>➕ Добавить сайт</h2>
                    <form method="POST" action="/add">
                        <input type="text" name="name" placeholder="Название" required>
                        <input type="url" name="url" placeholder="URL" required>
                        <button type="submit">Добавить</button>
                    </form>
                </div>
                <div class="section">
                    <h2>📱 Сайты</h2>
                    ${sitesHtml || '<p style="opacity:0.5;">Нет сайтов</p>'}
                </div>
            </div>
        </body>
        </html>
    `);
});

// ============ СТРАНИЦА УПРАВЛЕНИЯ БОТАМИ ============
app.get('/telegram-bots', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    let bots = [];
    try {
        bots = await botManager.getUserBots(username);
    } catch (e) {}

    let botsHtml = '';
    bots.forEach(bot => {
        botsHtml += `
            <div class="card">
                <span class="icon">🤖</span>
                <div class="info">
                    <div class="name">@${bot.username}</div>
                    <div class="url">Добавлен: ${new Date(bot.added_at).toLocaleDateString()}</div>
                </div>
                <a href="/bot-chats/${bot.username}" class="btn">Чаты</a>
                <button class="btn-delete" onclick="deleteBot('${bot.username}')">🗑️</button>
            </div>`;
    });

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Telegram Боты</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; margin: 0; }
                .header { background: #00d4ff; padding: 20px; display: flex; justify-content: space-between; }
                .header h1 { color: #1a1a2e; margin: 0; }
                .container { max-width: 800px; margin: 30px auto; padding: 20px; }
                .section { background: #2a2a4e; padding: 30px; border-radius: 15px; margin-bottom: 30px; }
                .section h2 { margin-top: 0; color: #00d4ff; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; }
                button { width: 100%; padding: 15px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .card { background: #3a3a5e; padding: 15px; border-radius: 10px; display: flex; align-items: center; gap: 15px; margin-bottom: 10px; }
                .icon { font-size: 30px; }
                .info { flex: 1; }
                .name { font-weight: bold; }
                .url { font-size: 12px; opacity: 0.7; }
                .btn { background: #00d4ff; color: #1a1a2e; padding: 8px 15px; border-radius: 8px; text-decoration: none; }
                .btn-delete { color: #ff4444; background: none; border: none; cursor: pointer; font-size: 18px; }
                .nav a { color: #1a1a2e; text-decoration: none; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🤖 Telegram Боты</h1>
                <div class="nav">
                    <a href="/dashboard">← Дашборд</a>
                </div>
            </div>
            <div class="container">
                <div class="section">
                    <h2>➕ Добавить бота</h2>
                    <form method="POST" action="/api/bots/register">
                        <input type="text" name="bot_username" placeholder="Имя бота (например, mybot)" required>
                        <input type="text" name="bot_token" placeholder="Токен бота от @BotFather" required>
                        <button type="submit">Добавить бота</button>
                    </form>
                </div>
                <div class="section">
                    <h2>📱 Мои боты</h2>
                    ${botsHtml || '<p style="opacity:0.5;">Нет ботов</p>'}
                </div>
            </div>
            <script>
                async function deleteBot(username) {
                    if (confirm('Удалить бота @' + username + '?')) {
                        await fetch('/api/bots/' + username, { method: 'DELETE' });
                        location.reload();
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// ============ СТРАНИЦА ЧАТОВ БОТА ============
app.get('/bot-chats/:botUsername', requireAuth, async (req, res) => {
    const { botUsername } = req.params;
    let chats = [];
    try {
        chats = await botManager.getBotChats(botUsername);
    } catch (e) {}

    let chatsHtml = '';
    chats.forEach(chat => {
        chatsHtml += `
            <div class="card">
                <span class="icon">💬</span>
                <div class="info">
                    <div class="name">@${chat.chat_id}</div>
                </div>
                <a href="/bot-chat/${botUsername}/${chat.chat_id}" class="btn">Открыть чат</a>
            </div>`;
    });

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Чаты @${botUsername}</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; margin: 0; }
                .header { background: #00d4ff; padding: 20px; display: flex; justify-content: space-between; }
                .header h1 { color: #1a1a2e; margin: 0; }
                .container { max-width: 800px; margin: 30px auto; padding: 20px; }
                .section { background: #2a2a4e; padding: 30px; border-radius: 15px; }
                .card { background: #3a3a5e; padding: 15px; border-radius: 10px; display: flex; align-items: center; gap: 15px; margin-bottom: 10px; }
                .icon { font-size: 30px; }
                .info { flex: 1; }
                .name { font-weight: bold; }
                .btn { background: #00d4ff; color: #1a1a2e; padding: 8px 15px; border-radius: 8px; text-decoration: none; }
                .nav a { color: #1a1a2e; text-decoration: none; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>💬 Чаты @${botUsername}</h1>
                <div class="nav">
                    <a href="/telegram-bots">← Боты</a>
                </div>
            </div>
            <div class="container">
                <div class="section">
                    ${chatsHtml || '<p style="opacity:0.5;">Нет чатов</p>'}
                </div>
            </div>
        </body>
        </html>
    `);
});

// ============ СТРАНИЦА ОДНОГО ЧАТА ============
app.get('/bot-chat/:botUsername/:chatId', requireAuth, async (req, res) => {
    const { botUsername, chatId } = req.params;
    let messages = [];
    try {
        messages = await botManager.getChatMessages(botUsername, chatId, 50);
    } catch (e) {}

    let messagesHtml = '';
    messages.reverse().forEach(msg => {
        const isSent = msg.status === 'sent';
        const icon = msg.type === 'photo' ? '🖼️' : msg.type === 'video' ? '🎬' : msg.type === 'audio' ? '🎵' : msg.type === 'document' ? '📄' : msg.type === 'sticker' ? '😀' : '💬';
        const content = msg.text || msg.caption || `[${msg.type}]`;
        const from = msg.from || 'Вы';
        const time = new Date(msg.timestamp).toLocaleTimeString();

        messagesHtml += `
            <div class="message ${isSent ? 'sent' : 'received'}">
                <div class="msg-from">${from}</div>
                <div class="msg-text">${icon} ${content}</div>
                <div class="msg-time">${time}</div>
            </div>`;
    });

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Чат @${chatId}</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; margin: 0; }
                .header { background: #00d4ff; padding: 15px; display: flex; justify-content: space-between; }
                .header h1 { color: #1a1a2e; margin: 0; font-size: 20px; }
                .container { max-width: 800px; margin: 0 auto; height: calc(100vh - 130px); overflow-y: auto; padding: 20px; }
                .message { padding: 15px; border-radius: 15px; margin-bottom: 10px; max-width: 70%; }
                .sent { background: #00d4ff; color: #1a1a2e; margin-left: auto; }
                .received { background: #3a3a5e; }
                .msg-from { font-size: 12px; opacity: 0.7; margin-bottom: 5px; }
                .msg-text { font-size: 16px; }
                .msg-time { font-size: 10px; opacity: 0.5; text-align: right; margin-top: 5px; }
                .input-area { display: flex; padding: 15px; background: #2a2a4e; }
                .input-area input { flex: 1; padding: 15px; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; margin-right: 10px; }
                .input-area button { padding: 15px 30px; background: #00d4ff; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .nav a { color: #1a1a2e; text-decoration: none; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>💬 @${chatId}</h1>
                <div class="nav">
                    <a href="/bot-chats/${botUsername}">← Назад</a>
                </div>
            </div>
            <div class="container" id="messages">
                ${messagesHtml || '<p style="opacity:0.5;text-align:center;">Нет сообщений</p>'}
            </div>
            <div class="input-area">
                <input type="text" id="msgInput" placeholder="Сообщение...">
                <button onclick="sendMsg()">📤</button>
            </div>
            <script>
                async function sendMsg() {
                    const text = document.getElementById('msgInput').value;
                    if (!text) return;
                    await fetch('/api/bots/${botUsername}/send', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({chat_id: '${chatId}', text: text})
                    });
                    document.getElementById('msgInput').value = '';
                    location.reload();
                }
                setTimeout(() => location.reload(), 5000);
            </script>
        </body>
        </html>
    `);
});

// ============ ОСТАЛЬНЫЕ СТАРЫЕ МАРШРУТЫ ============
app.post('/add', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const { name, url } = req.body;
    if (!users[username].sites) users[username].sites = [];
    users[username].sites.push({ id: Date.now().toString(), name, url });
    saveUsers();
    res.redirect('/dashboard');
});

app.get('/view/:id', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const site = users[username].sites?.find(s => s.id === req.params.id);
    if (!site) return res.redirect('/dashboard');
    const browserUrl = `/browser?url=${encodeURIComponent(site.url)}`;
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>${site.name}</title>
            <style>
                body { margin: 0; background: #1a1a2e; }
                .bar { background: #2a2a4e; padding: 10px; display: flex; gap: 10px; }
                .bar a { color: #fff; text-decoration: none; padding: 8px 15px; background: #3a3a5e; border-radius: 5px; }
                .url { flex: 1; padding: 8px; background: #1a1a2e; border-radius: 5px; color: #00d4ff; }
                iframe { width: 100%; height: calc(100vh - 50px); border: none; }
            </style>
        </head>
        <body>
            <div class="bar">
                <a href="/dashboard">← Назад</a>
                <div class="url">${site.url}</div>
            </div>
            <iframe src="${browserUrl}"></iframe>
        </body>
        </html>
    `);
});

app.get('/browser', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 30000
        });
        let html = response.data;
        const parsed = new URL(url);
        html = html.replace('<head>', `<head><base href="${parsed.origin}/">`);
        res.send(html);
    } catch (e) {
        res.status(500).send(`<h1>Error</h1><p>${e.message}</p>`);
    }
});

app.get('/delete/:id', requireAuth, (req, res) => {
    const username = req.session.user.username;
    users[username].sites = users[username].sites.filter(s => s.id !== req.params.id);
    saveUsers();
    res.redirect('/dashboard');
});

app.get('/logs', requireAuth, (req, res) => {
    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Логи</title><style>body{font-family:monospace;background:#1a1a2e;color:#0f0;padding:20px;}a{color:#00d4ff;}pre{background:#0d0d1a;padding:20px;border-radius:10px;}</style></head><body><a href="/dashboard">← Назад</a><h1>📋 Логи</h1><pre>';
    logs.slice().reverse().forEach(l => html += l + '\n');
    html += '</pre></body></html>';
    res.send(html);
});

app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.redirect('/login');
});

// ============ ЗАПУСК ============
app.listen(PORT, () => {
    log('=== Server running on port ' + PORT + ' ===');
    log('=== Login: admin / admin123 ===');
    log('=== Telegram Bot Manager: /telegram-bots ===');
});

workerLoop().catch(e => log('[Worker] Fatal: ' + e.message));
botPollerLoop().catch(e => log('[Bot Poller] Fatal: ' + e.message));
