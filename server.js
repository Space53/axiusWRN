const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');
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

const logs = [];
function log(msg, level = 'INFO') {
    const entry = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 300) logs.shift();
}

log('=== Axius WRN Server Starting ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));

const usersFile = '/tmp/users.json';
let users = {};
if (fs.existsSync(usersFile)) {
    try {
        users = JSON.parse(fs.readFileSync(usersFile));
    } catch (e) {
        users = {};
    }
}

if (!users['admin']) {
    users['admin'] = {
        username: 'admin',
        password: 'admin123',
        sites: [],
        bots: []
    };
}

for (const username in users) {
    if (!users[username].sites) users[username].sites = [];
    if (!users[username].bots) users[username].bots = [];
}

saveUsers();

function saveUsers() {
    try {
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    } catch (e) {
        log('Error saving users: ' + e.message, 'ERROR');
    }
}

class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async listFolder(folderPath) {
        if (!this.token) return [];
        try {
            const res = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(folderPath)}&limit=100`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            return res.data._embedded?.items || [];
        } catch (e) {
            return [];
        }
    }

    async readFile(relativePath) {
        const dl = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(relativePath)}`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        const res = await axios.get(dl.data.href, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    }

    async writeFile(relativePath, data) {
        const up = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(relativePath)}&overwrite=true`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        await axios.put(up.data.href, data, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
    }

    async deleteFile(relativePath) {
        try {
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(relativePath)}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
        } catch (e) {}
    }

    async fileExists(relativePath) {
        try {
            await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(relativePath)}`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            return true;
        } catch (e) {
            return false;
        }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

class TelegramBotManager {
    constructor(disk) {
        this.disk = disk;
    }

    async registerBot(username, botToken, botUsername) {
        const botPath = `${BOT_FOLDER}/${botUsername}`;
        const tokenFile = `${botPath}/token.txt`;
        const configFile = `${botPath}/config.json`;

        await this.disk.writeFile(tokenFile, Buffer.from(botToken));
        await this.disk.writeFile(configFile, Buffer.from(JSON.stringify({
            bot_username: botUsername,
            owner: username,
            created_at: new Date().toISOString(),
            status: 'active'
        }, null, 2)));

        await this.disk.writeFile(`${botPath}/chats/.gitkeep`, Buffer.from(''));

        log(`[Bot] Registered @${botUsername} for ${username}`);
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
                    username: c.name
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

    async sendMessage(botUsername, chatId, text) {
        let botToken = '';
        
        const tokenFile = `${BOT_FOLDER}/${botUsername}/token.txt`;
        try {
            botToken = (await this.disk.readFile(tokenFile)).toString().trim();
        } catch (e) {
            for (const username in users) {
                const bot = (users[username].bots || []).find(b => b.username === botUsername);
                if (bot && bot.token) {
                    botToken = bot.token;
                    break;
                }
            }
        }

        if (!botToken) {
            throw new Error('Bot token not found');
        }

        log(`[Bot] Sending message via @${botUsername} to ${chatId}: ${text.substring(0, 50)}`);

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
        try {
            await this.disk.writeFile(notifPath, Buffer.from(JSON.stringify(notification, null, 2)));
        } catch (e) {
            log(`[Bot] Failed to save notification: ${e.message}`, 'WARN');
        }

        log(`[Bot] Message sent, ID: ${response.data.result.message_id}`);
        return { success: true, message_id: response.data.result.message_id };
    }

    // ============ ОБРАБОТКА ВХОДЯЩИХ СООБЩЕНИЙ ============
    async handleIncomingMessage(botUsername, update) {
        const msg = update.message;
        if (!msg || !msg.text) return;

        const chatId = msg.chat.id;
        const text = msg.text;
        const firstName = msg.from?.first_name || 'Пользователь';
        const lastName = msg.from?.last_name || '';

        log(`[Bot @${botUsername}] Message from ${firstName} (${chatId}): ${text}`);

        // Сохраняем входящее сообщение
        const notification = {
            type: 'message',
            chat_id: String(chatId),
            text: text,
            from: firstName + (lastName ? ' ' + lastName : ''),
            timestamp: new Date().toISOString(),
            status: 'received',
            message_id: msg.message_id
        };

        const notifPath = `${BOT_FOLDER}/${botUsername}/chats/@${chatId}/notifications/notif_${Date.now()}.json`;
        try {
            await this.disk.writeFile(notifPath, Buffer.from(JSON.stringify(notification, null, 2)));
        } catch (e) {}

        // ============ КОМАНДЫ ============
        if (text === '/start') {
            const reply = 
                `👋 *Привет, ${firstName}!*\n\n` +
                `Я бот *Axius WRN* — системы обхода блокировок.\n\n` +
                `🔹 *Что я умею:*\n` +
                `• Сохранять твои чаты и сообщения\n` +
                `• Работать через облако\n` +
                `• Обходить блокировки\n\n` +
                `📱 *Мои команды:*\n` +
                `/start — Этот текст\n` +
                `/help — Помощь\n` +
                `/status — Статус системы\n\n` +
                `⚡ *Я работаю через Яндекс.Диск и Render!*`;

            await this.sendMessage(botUsername, String(chatId), reply);
            log(`[Bot @${botUsername}] Replied to /start from ${firstName}`);
        }

        if (text === '/help') {
            const reply = 
                `🆘 *Помощь Axius WRN*\n\n` +
                `Я — бот системы обхода блокировок.\n\n` +
                `*Как использовать:*\n` +
                `1. Добавь бота в приложении\n` +
                `2. Напиши мне в Telegram\n` +
                `3. Все сообщения сохраняются в облаке\n` +
                `4. Читай их в приложении\n\n` +
                `*Проблемы?* Пиши @admin`;

            await this.sendMessage(botUsername, String(chatId), reply);
            log(`[Bot @${botUsername}] Replied to /help from ${firstName}`);
        }

        if (text === '/status') {
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const uptimeStr = `${Math.floor(uptime / 3600)}ч ${Math.floor((uptime % 3600) / 60)}м ${uptime % 60}с`;

            const reply = 
                `📊 *Статус системы*\n\n` +
                `✅ Сервер: *активен*\n` +
                `⏱️ Uptime: *${uptimeStr}*\n` +
                `🔑 Токен: *${YANDEX_TOKEN ? 'установлен' : 'нет'}*\n` +
                `🤖 Бот: *@${botUsername}*\n` +
                `💬 Чатов: *${await this.getBotChats(botUsername).then(c => c.length).catch(() => 0)}*`;

            await this.sendMessage(botUsername, String(chatId), reply);
            log(`[Bot @${botUsername}] Replied to /status from ${firstName}`);
        }

        // Эхо на любое другое сообщение
        if (!text.startsWith('/')) {
            const reply = `📩 *Сообщение получено!*\n\nТвой текст сохранён в облаке.\nСпасибо, что пользуешься *Axius WRN*!`;
            await this.sendMessage(botUsername, String(chatId), reply);
        }
    }

    // ============ ПОЛУЧЕНИЕ ОБНОВЛЕНИЙ ============
    async getUpdates(botUsername) {
        let botToken = '';
        
        const tokenFile = `${BOT_FOLDER}/${botUsername}/token.txt`;
        try {
            botToken = (await this.disk.readFile(tokenFile)).toString().trim();
        } catch (e) {
            for (const username in users) {
                const bot = (users[username].bots || []).find(b => b.username === botUsername);
                if (bot && bot.token) {
                    botToken = bot.token;
                    break;
                }
            }
        }

        if (!botToken) {
            log(`[Bot @${botUsername}] Token not found, skipping updates`, 'WARN');
            return;
        }

        const offsetPath = `${BOT_FOLDER}/${botUsername}/offset.txt`;
        let offset = 0;
        try {
            offset = parseInt((await this.disk.readFile(offsetPath)).toString().trim()) || 0;
        } catch (e) {}

        try {
            const response = await axios.get(
                `https://api.telegram.org/bot${botToken}/getUpdates`,
                { params: { offset: offset + 1, timeout: 30 } }
            );

            const updates = response.data.result || [];
            
            for (const update of updates) {
                await this.handleIncomingMessage(botUsername, update);
                offset = update.update_id;
            }

            if (updates.length > 0) {
                await this.disk.writeFile(offsetPath, Buffer.from(String(offset)));
            }
        } catch (e) {
            // Игнорируем ошибки polling
        }
    }

    async deleteBot(username, botUsername) {
        const botPath = `${BOT_FOLDER}/${botUsername}`;
        try {
            const items = await this.disk.listFolder(botPath);
            for (const item of items) {
                await this.disk.deleteFile(item.path);
            }
        } catch (e) {}

        log(`[Bot] Deleted @${botUsername}`);
        return { success: true };
    }
}

const botManager = new TelegramBotManager(disk);
const startTime = Date.now();

// ============ ФОНОВЫЙ ОПРОС БОТОВ ============
async function botPollerLoop() {
    log('[Bot Poller] Started');
    
    while (true) {
        try {
            for (const username in users) {
                const user = users[username];
                for (const bot of (user.bots || [])) {
                    await botManager.getUpdates(bot.username);
                }
            }
        } catch (e) {
            log('[Bot Poller] Error: ' + e.message, 'ERROR');
        }
        
        await new Promise(r => setTimeout(r, 5000));
    }
}

function requireAuth(req, res, next) {
    if (req.session.user) return next();
    
    const token = req.query.token || req.body.token;
    if (token && token === YANDEX_TOKEN) {
        req.session.user = { username: 'admin' };
        return next();
    }
    
    res.redirect('/login');
}

function apiAuth(req, res, next) {
    if (req.session.user) return next();
    
    const token = req.query.token || req.body.token;
    if (token && token === YANDEX_TOKEN) {
        req.session.user = { username: 'admin' };
        return next();
    }
    
    log(`[API] Unauthorized: ${req.originalUrl}`, 'WARN');
    res.status(401).json({ error: 'Unauthorized' });
}

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Axius WRN - Вход</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .box { background: #2a2a4e; padding: 40px; border-radius: 20px; width: 350px; }
                h1 { color: #00d4ff; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; box-sizing: border-box; }
                button { width: 100%; padding: 15px; background: #00d4ff; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                a { color: #00d4ff; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>🚀 Axius WRN</h1>
                ${req.query.error ? '<p style="color:#ff4444;">❌ ' + req.query.error + '</p>' : ''}
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

app.get('/dashboard', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const user = users[username];
    
    let sitesHtml = '';
    (user.sites || []).forEach(site => {
        sitesHtml += `<div class="card"><span class="icon">🌐</span><div class="info"><div class="name">${site.name}</div></div><a href="/view/${site.id}" class="btn">Открыть</a></div>`;
    });

    let botsHtml = '';
    (user.bots || []).forEach(bot => {
        botsHtml += `<div class="card"><span class="icon">🤖</span><div class="info"><div class="name">@${bot.username}</div></div><a href="/bot-chats/${bot.username}" class="btn">Чаты</a></div>`;
    });

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Дашборд</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; margin: 0; }
                .header { background: #00d4ff; padding: 20px; display: flex; justify-content: space-between; }
                .header h1 { color: #1a1a2e; margin: 0; }
                .container { max-width: 800px; margin: 30px auto; padding: 20px; }
                .section { background: #2a2a4e; padding: 30px; border-radius: 15px; margin-bottom: 30px; }
                .section h2 { margin-top: 0; color: #00d4ff; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; box-sizing: border-box; }
                button { width: 100%; padding: 15px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .card { background: #3a3a5e; padding: 15px; border-radius: 10px; display: flex; align-items: center; gap: 15px; margin-bottom: 10px; }
                .icon { font-size: 30px; }
                .info { flex: 1; }
                .name { font-weight: bold; }
                .btn { background: #00d4ff; color: #1a1a2e; padding: 8px 15px; border-radius: 8px; text-decoration: none; }
                .logout { background: rgba(0,0,0,0.2); color: #1a1a2e; padding: 10px 20px; border-radius: 5px; text-decoration: none; }
                .nav { display: flex; gap: 10px; }
                .nav a { color: #1a1a2e; text-decoration: none; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN</h1>
                <div style="display: flex; gap: 20px;">
                    <div class="nav">
                        <a href="/logs">📋 Логи</a>
                    </div>
                    <span>👤 ${username}</span>
                    <a href="/logout" class="logout">Выйти</a>
                </div>
            </div>
            <div class="container">
                <div class="section">
                    <h2>➕ Добавить сайт</h2>
                    <form method="POST" action="/add-site">
                        <input type="text" name="name" placeholder="Название" required>
                        <input type="url" name="url" placeholder="URL" required>
                        <button type="submit">Добавить</button>
                    </form>
                </div>
                <div class="section">
                    <h2>📱 Сайты</h2>
                    ${sitesHtml || '<p style="opacity:0.5;">Нет сайтов</p>'}
                </div>
                <div class="section">
                    <h2>🤖 Telegram Боты</h2>
                    <form method="POST" action="/add-bot">
                        <input type="text" name="bot_username" placeholder="Имя бота" required>
                        <input type="text" name="bot_token" placeholder="Токен от @BotFather" required>
                        <button type="submit">Добавить бота</button>
                    </form>
                    ${botsHtml || '<p style="opacity:0.5;">Нет ботов</p>'}
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/add-site', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const { name, url } = req.body;
    users[username].sites.push({ id: Date.now().toString(), name, url });
    saveUsers();
    res.redirect('/dashboard');
});

app.post('/add-bot', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const { bot_username, bot_token } = req.body;
    
    if (!users[username].bots) users[username].bots = [];
    
    const exists = users[username].bots.find(b => b.username === bot_username);
    if (exists) {
        return res.redirect('/dashboard?error=Бот уже добавлен');
    }
    
    users[username].bots.push({
        username: bot_username,
        token: bot_token,
        added_at: new Date().toISOString()
    });
    saveUsers();
    
    log('[Bot] Added: @' + bot_username + ' for ' + username);
    res.redirect('/dashboard');
});

app.get('/view/:id', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const site = users[username].sites?.find(s => s.id === req.params.id);
    if (!site) return res.redirect('/dashboard');
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>${site.name}</title>
            <style>
                body { margin: 0; }
                .bar { background: #2a2a4e; padding: 10px; display: flex; gap: 10px; }
                .bar a { color: #fff; text-decoration: none; padding: 8px 15px; background: #3a3a5e; border-radius: 5px; }
                iframe { width: 100%; height: calc(100vh - 50px); border: none; }
            </style>
        </head>
        <body>
            <div class="bar"><a href="/dashboard">← Назад</a></div>
            <iframe src="/browser?url=${encodeURIComponent(site.url)}"></iframe>
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

app.get('/bot-chats/:botUsername', requireAuth, async (req, res) => {
    const { botUsername } = req.params;
    const username = req.session.user.username;
    const user = users[username];
    
    const bot = (user.bots || []).find(b => b.username === botUsername);
    if (!bot) return res.redirect('/dashboard');
    
    let chats = [];
    try {
        chats = await botManager.getBotChats(botUsername);
    } catch (e) {}
    
    let chatsHtml = '';
    chats.forEach(chat => {
        chatsHtml += `
            <div class="card">
                <span class="icon">💬</span>
                <div class="info"><div class="name">@${chat.chat_id}</div></div>
                <a href="/bot-chat/${botUsername}/${chat.chat_id}" class="btn">Открыть</a>
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
                .card { background: #3a3a5e; padding: 15px; border-radius: 10px; display: flex; align-items: center; gap: 15px; margin-bottom: 10px; }
                .icon { font-size: 30px; }
                .info { flex: 1; }
                .name { font-weight: bold; }
                .btn { background: #00d4ff; color: #1a1a2e; padding: 8px 15px; border-radius: 8px; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>💬 Чаты @${botUsername}</h1>
                <a href="/dashboard" style="color:#1a1a2e;text-decoration:none;padding:10px;background:rgba(0,0,0,0.1);border-radius:5px;">← Назад</a>
            </div>
            <div class="container">
                ${chatsHtml || '<p style="opacity:0.5;">Нет чатов. Напишите боту в Telegram!</p>'}
            </div>
        </body>
        </html>
    `);
});

app.get('/bot-chat/:botUsername/:chatId', requireAuth, async (req, res) => {
    const { botUsername, chatId } = req.params;
    const username = req.session.user.username;
    const user = users[username];
    
    const bot = (user.bots || []).find(b => b.username === botUsername);
    if (!bot) return res.redirect('/dashboard');
    
    let messages = [];
    try {
        messages = await botManager.getChatMessages(botUsername, chatId, 50);
    } catch (e) {}
    
    let messagesHtml = '';
    messages.reverse().forEach(msg => {
        const isSent = msg.status === 'sent';
        const content = msg.text || msg.caption || `[${msg.type}]`;
        const from = msg.from || (isSent ? 'Вы' : 'Пользователь');
        const time = new Date(msg.timestamp).toLocaleTimeString();
        
        messagesHtml += `
            <div class="message ${isSent ? 'sent' : 'received'}">
                <div class="msg-from">${from}</div>
                <div class="msg-text">${content}</div>
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
            </style>
        </head>
        <body>
            <div class="header">
                <h1>💬 @${chatId}</h1>
                <a href="/bot-chats/${botUsername}" style="color:#1a1a2e;text-decoration:none;padding:10px;background:rgba(0,0,0,0.1);border-radius:5px;">← Назад</a>
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

app.post('/fetch', (req, res) => {
    res.status(202).json({ status: 'queued' });
});

app.get('/result', (req, res) => {
    res.json({ status: 'processing' });
});

app.get('/api/bots', apiAuth, (req, res) => {
    const username = req.session.user?.username || 'admin';
    const user = users[username];
    log('[API] GET /api/bots');
    res.json({ bots: user?.bots || [] });
});

app.post('/api/bots/register', apiAuth, (req, res) => {
    const username = req.session.user?.username || 'admin';
    const { bot_username, bot_token } = req.body;
    
    log('[API] POST /api/bots/register: @' + bot_username);
    
    if (!users[username].bots) users[username].bots = [];
    
    const exists = users[username].bots.find(b => b.username === bot_username);
    if (exists) {
        return res.json({ success: true, bot_username, status: 'already_exists' });
    }
    
    users[username].bots.push({
        username: bot_username,
        token: bot_token,
        added_at: new Date().toISOString()
    });
    saveUsers();
    
    res.json({ success: true, bot_username });
});

app.delete('/api/bots/:botUsername', apiAuth, (req, res) => {
    const username = req.session.user?.username || 'admin';
    const { botUsername } = req.params;
    
    log('[API] DELETE /api/bots/' + botUsername);
    
    users[username].bots = (users[username].bots || []).filter(b => b.username !== botUsername);
    saveUsers();
    
    res.json({ success: true });
});

app.get('/api/bots/:botUsername/chats', apiAuth, async (req, res) => {
    const { botUsername } = req.params;
    log('[API] GET /api/bots/' + botUsername + '/chats');
    
    try {
        const chats = await botManager.getBotChats(botUsername);
        res.json({ chats });
    } catch (e) {
        log('[API] Error: ' + e.message, 'ERROR');
        res.json({ chats: [] });
    }
});

app.get('/api/bots/:botUsername/chats/:chatId/messages', apiAuth, async (req, res) => {
    const { botUsername, chatId } = req.params;
    log('[API] GET /api/bots/' + botUsername + '/chats/' + chatId + '/messages');
    
    try {
        const messages = await botManager.getChatMessages(botUsername, chatId);
        res.json({ messages });
    } catch (e) {
        log('[API] Error: ' + e.message, 'ERROR');
        res.json({ messages: [] });
    }
});

app.post('/api/bots/:botUsername/send', apiAuth, async (req, res) => {
    const { botUsername } = req.params;
    const { chat_id, text } = req.body;
    
    log('[API] POST /api/bots/' + botUsername + '/send to ' + chat_id + ': ' + text?.substring(0, 50));
    
    try {
        const result = await botManager.sendMessage(botUsername, chat_id, text);
        res.json(result);
    } catch (e) {
        log('[API] Send error: ' + e.message, 'ERROR');
        res.status(500).json({ error: e.message });
    }
});

app.get('/logs', requireAuth, (req, res) => {
    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Логи</title><style>body{font-family:monospace;background:#1a1a2e;color:#0f0;padding:20px;}a{color:#00d4ff;}pre{background:#0d0d1a;padding:20px;border-radius:10px;max-height:80vh;overflow-y:auto;}</style></head><body><a href="/dashboard">← Назад</a><a href="/logs" style="float:right;">🔄 Обновить</a><h1>📋 Логи (' + logs.length + ')</h1><pre>';
    logs.slice().reverse().forEach(l => html += l + '\n');
    html += '</pre><script>setTimeout(()=>location.reload(),5000);</script></body></html>';
    res.send(html);
});

app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.redirect('/login');
});

app.listen(PORT, () => {
    log('=== Server running on port ' + PORT + ' ===');
    log('=== Login: admin / admin123 ===');
    log('=== Bot commands: /start, /help, /status ===');
});

// Запускаем бот-поллер
botPollerLoop().catch(e => log('[Bot Poller] Fatal: ' + e.message));
