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

// ============ ЛОГИ ============
const logs = [];
function log(msg, level = 'INFO') {
    const entry = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 200) logs.shift();
}

log('=== Axius WRN Server Starting ===');

// ============ ПОЛЬЗОВАТЕЛИ ============
const usersFile = '/tmp/users.json';
let users = {};
if (fs.existsSync(usersFile)) {
    try {
        users = JSON.parse(fs.readFileSync(usersFile));
    } catch (e) {
        users = {};
    }
}

// Гарантированно создаём админа
if (!users['admin']) {
    users['admin'] = {
        username: 'admin',
        password: 'admin123',
        sites: [],
        bots: []
    };
}

// Гарантированно добавляем bots и sites всем пользователям
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

// ============ YANDEX DISK API ============
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

// ============ TELEGRAM BOT API ============
const BOT_FOLDER = 'app:/bots';

class TelegramBotManager {
    constructor(disk) {
        this.disk = disk;
    }

    async registerBot(username, botToken, botUsername) {
        const botPath = `${BOT_FOLDER}/${botUsername}`;
        const tokenFile = `${botPath}/token.txt`;
        const configFile = `${botPath}/config.json`;

        // Создаём папку бота
        await this.disk.writeFile(tokenFile, Buffer.from(botToken));
        await this.disk.writeFile(configFile, Buffer.from(JSON.stringify({
            bot_username: botUsername,
            owner: username,
            created_at: new Date().toISOString(),
            status: 'active'
        }, null, 2)));

        // Создаём папку для чатов
        await this.disk.writeFile(`${botPath}/chats/.gitkeep`, Buffer.from(''));

        log(`[Bot] Registered @${botUsername} for ${username}`);
        return { success: true, bot_username: botUsername };
    }

    async getUserBots(username) {
        const bots = [];
        const user = users[username];
        if (user && user.bots) {
            return user.bots;
        }
        return bots;
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
        const tokenFile = `${BOT_FOLDER}/${botUsername}/token.txt`;
        let botToken;
        try {
            botToken = (await this.disk.readFile(tokenFile)).toString().trim();
        } catch (e) {
            throw new Error('Bot token not found');
        }

        const response = await axios.post(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            { chat_id: chatId, text: text }
        );

        // Сохраняем сообщение
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
    }

    async deleteBot(username, botUsername) {
        const botPath = `${BOT_FOLDER}/${botUsername}`;
        try {
            // Удаляем все файлы бота
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

// ============ MIDDLEWARE ============
function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

// ============ АВТОРИЗАЦИЯ ============
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

// ============ ДАШБОРД ============
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
                input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; }
                button { width: 100%; padding: 15px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .card { background: #3a3a5e; padding: 15px; border-radius: 10px; display: flex; align-items: center; gap: 15px; margin-bottom: 10px; }
                .icon { font-size: 30px; }
                .info { flex: 1; }
                .name { font-weight: bold; }
                .btn { background: #00d4ff; color: #1a1a2e; padding: 8px 15px; border-radius: 8px; text-decoration: none; }
                .logout { background: rgba(0,0,0,0.2); color: #1a1a2e; padding: 10px 20px; border-radius: 5px; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN</h1>
                <div>
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
    
    // Проверяем, нет ли уже такого бота
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
    
    // Пытаемся зарегистрировать на Яндекс.Диске
    try {
        botManager.registerBot(username, bot_token, bot_username);
    } catch (e) {
        // Игнорируем ошибки Яндекс.Диска
    }
    
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

// ============ API ДЛЯ БОТОВ ============
app.get('/api/bots', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    const user = users[username];
    const bots = (user && user.bots) ? user.bots : [];
    res.json({ bots });
});

app.post('/api/bots/register', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    const { bot_username, bot_token } = req.body;
    
    if (!users[username].bots) users[username].bots = [];
    
    // Проверяем, нет ли уже такого бота
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
    
    log('[API] Bot registered: @' + bot_username);
    
    res.json({ success: true, bot_username });
});

app.delete('/api/bots/:botUsername', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    const { botUsername } = req.params;
    
    if (users[username].bots) {
        users[username].bots = users[username].bots.filter(b => b.username !== botUsername);
    }
    saveUsers();
    
    log('[API] Bot deleted: @' + botUsername);
    
    res.json({ success: true });
});

app.get('/api/bots/:botUsername/chats', requireAuth, async (req, res) => {
    const { botUsername } = req.params;
    try {
        const chats = await botManager.getBotChats(botUsername);
        res.json({ chats });
    } catch (e) {
        res.json({ chats: [] });
    }
});

app.get('/api/bots/:botUsername/chats/:chatId/messages', requireAuth, async (req, res) => {
    const { botUsername, chatId } = req.params;
    try {
        const messages = await botManager.getChatMessages(botUsername, chatId);
        res.json({ messages });
    } catch (e) {
        res.json({ messages: [] });
    }
});

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

// ============ СТАРЫЙ API ============
app.post('/fetch', (req, res) => {
    res.status(202).json({ status: 'queued' });
});

app.get('/result', (req, res) => {
    res.json({ status: 'processing' });
});

app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.redirect('/login');
});

// ============ ЗАПУСК ============
app.listen(PORT, () => {
    log('=== Server running on port ' + PORT + ' ===');
    log('=== Login: admin / admin123 ===');
});
