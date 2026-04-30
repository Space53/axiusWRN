const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'axius-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const PORT = process.env.PORT || 3000;
const YANDEX_TOKEN = process.env.YANDEX_TOKEN || '';

// Логи
const logs = [];
function log(msg) {
    const entry = `[${new Date().toLocaleString()}] ${msg}`;
    console.log(entry);
    logs.unshift(entry);
    if (logs.length > 200) logs.pop();
}

log('Сервер запускается...');

// ============ ПОЛЬЗОВАТЕЛИ ============
const usersFile = '/tmp/users.json';
let users = {};

function loadUsers() {
    try {
        if (fs.existsSync(usersFile)) {
            const data = fs.readFileSync(usersFile, 'utf8');
            users = JSON.parse(data);
        }
    } catch (e) {
        log('Ошибка загрузки users: ' + e.message);
    }
    
    if (!users['admin']) {
        users['admin'] = {
            username: 'admin',
            password: 'admin123',
            sites: [],
            bots: []
        };
        saveUsers();
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    } catch (e) {
        log('Ошибка сохранения users: ' + e.message);
    }
}

loadUsers();

// ============ YANDEX DISK API ============
class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async request(endpoint, options = {}) {
        if (!this.token) {
            throw new Error('YANDEX_TOKEN не установлен');
        }
        
        const response = await axios({
            url: `https://cloud-api.yandex.net/v1/disk/${endpoint}`,
            method: options.method || 'GET',
            headers: {
                'Authorization': `OAuth ${this.token}`,
                ...options.headers
            },
            params: options.params,
            data: options.data
        });
        return response.data;
    }

    async listFolder(folderPath) {
        try {
            const data = await this.request('resources', {
                params: { path: folderPath, limit: 1000 }
            });
            return data._embedded?.items || [];
        } catch (e) {
            if (e.response?.status === 404) {
                return [];
            }
            log(`Ошибка listFolder: ${e.message}`);
            return [];
        }
    }

    async readFile(filePath) {
        const data = await this.request('resources/download', {
            params: { path: filePath }
        });
        const response = await axios.get(data.href, {
            responseType: 'arraybuffer'
        });
        return response.data;
    }

    async writeFile(filePath, content) {
        const data = await this.request('resources/upload', {
            params: { path: filePath, overwrite: true }
        });
        await axios.put(data.href, content, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
    }

    async deleteFile(filePath) {
        try {
            await this.request('resources', {
                method: 'DELETE',
                params: { path: filePath, permanently: true }
            });
        } catch (e) {
            log(`Ошибка deleteFile: ${e.message}`);
        }
    }

    async createFolder(folderPath) {
        try {
            await this.request('resources', {
                method: 'PUT',
                params: { path: folderPath }
            });
        } catch (e) {
            // Папка уже существует
        }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// ============ ВОРКЕР ============
const TASK_FOLDER = 'app:/tasks';

async function processTask(taskName) {
    const resultName = taskName.replace('.task', '_result.json');
    
    try {
        const content = await disk.readFile(`${TASK_FOLDER}/${taskName}`);
        const task = JSON.parse(content.toString('utf8'));
        const { url } = task;
        
        log(`[Worker] Скачиваю: ${url}`);
        
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        const result = {
            url: url,
            status: 'completed',
            timestamp: new Date().toISOString(),
            size: response.data.length,
            contentType: response.headers['content-type']
        };
        
        await disk.writeFile(`${TASK_FOLDER}/${resultName}`, 
            Buffer.from(JSON.stringify(result, null, 2)));
        await disk.deleteFile(`${TASK_FOLDER}/${taskName}`);
        
        log(`[Worker] Готово: ${url} (${response.data.length} bytes)`);
    } catch (e) {
        log(`[Worker] Ошибка: ${e.message}`);
        
        const errorResult = {
            error: e.message,
            timestamp: new Date().toISOString(),
            status: 'failed'
        };
        await disk.writeFile(`${TASK_FOLDER}/${taskName.replace('.task', '_error.json')}`,
            Buffer.from(JSON.stringify(errorResult, null, 2)));
    }
}

async function workerLoop() {
    if (!YANDEX_TOKEN) {
        log('[Worker] Ожидание YANDEX_TOKEN...');
        return;
    }
    
    log('[Worker] Запущен, проверка каждые 3 секунды');
    
    while (true) {
        try {
            const items = await disk.listFolder(TASK_FOLDER);
            const tasks = items.filter(item => 
                item.name.endsWith('.task') && item.type === 'file'
            );
            
            for (const task of tasks) {
                await processTask(task.name);
            }
        } catch (e) {
            // Ошибка игнорируется
        }
        
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ============ TELEGRAM BOT POLLER ============
const BOT_FOLDER = 'app:/bots';

async function saveTelegramMessage(botName, chatId, message) {
    if (!YANDEX_TOKEN) return;
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `msg_${timestamp}_${message.message_id || Date.now()}.json`;
    const filePath = `${BOT_FOLDER}/${botName}/chats/${chatId}/${fileName}`;
    
    const messageData = {
        chat_id: String(chatId),
        from: message.from?.first_name || message.from?.username || 'Unknown',
        text: message.text || '',
        time: new Date().toISOString(),
        status: 'received',
        message_id: message.message_id
    };
    
    await disk.createFolder(`${BOT_FOLDER}/${botName}/chats/${chatId}`);
    await disk.writeFile(filePath, Buffer.from(JSON.stringify(messageData, null, 2)));
}

async function pollTelegramBots() {
    for (const username in users) {
        const user = users[username];
        if (!user.bots) continue;
        
        for (const bot of user.bots) {
            const offsetFile = `/tmp/bot_offset_${bot.username}.txt`;
            let offset = 0;
            
            try {
                if (fs.existsSync(offsetFile)) {
                    offset = parseInt(fs.readFileSync(offsetFile, 'utf8')) || 0;
                }
            } catch (e) {}
            
            try {
                const response = await axios.get(
                    `https://api.telegram.org/bot${bot.token}/getUpdates`,
                    { params: { offset: offset + 1, timeout: 30 } }
                );
                
                for (const update of response.data.result || []) {
                    const message = update.message;
                    if (!message || !message.text) continue;
                    
                    const chatId = String(message.chat.id);
                    const text = message.text.trim();
                    const fromName = message.from?.first_name || message.from?.username || 'User';
                    
                    log(`[Bot @${bot.username}] ${fromName}: ${text}`);
                    
                    if (YANDEX_TOKEN) {
                        await saveTelegramMessage(bot.username, chatId, message);
                    }
                    
                    // Отвечаем только на команды
                    if (text === '/start') {
                        await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
                            chat_id: chatId,
                            text: `👋 Привет, ${fromName}!\n\nЯ бот Axius WRN.\n\nКоманды:\n/start - Приветствие\n/help - Помощь\n/status - Статус`
                        });
                    } else if (text === '/help') {
                        await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
                            chat_id: chatId,
                            text: '🆘 Помощь\n\nСообщения сохраняются в Яндекс.Диске. Администратор может просматривать чаты через веб-интерфейс.'
                        });
                    } else if (text === '/status') {
                        await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
                            chat_id: chatId,
                            text: `📊 Статус: активен\n🕐 ${new Date().toLocaleString()}`
                        });
                    }
                    
                    offset = update.update_id;
                }
                
                if (response.data.result?.length > 0) {
                    fs.writeFileSync(offsetFile, String(offset));
                }
            } catch (e) {
                // Ошибка игнорируется
            }
        }
    }
}

setInterval(pollTelegramBots, 3000);
pollTelegramBots();

// ============ MIDDLEWARE ============
function requireAuth(req, res, next) {
    if (req.session.user && users[req.session.user.username]) {
        next();
    } else {
        res.redirect('/login');
    }
}

// ============ СТРАНИЦЫ ============

// Логин
app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN - Вход</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    margin: 0;
                    padding: 0;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                }
                .login-box {
                    background: white;
                    padding: 40px;
                    border-radius: 10px;
                    box-shadow: 0 0 20px rgba(0,0,0,0.2);
                    width: 350px;
                }
                h1 {
                    text-align: center;
                    color: #333;
                    margin-bottom: 30px;
                }
                input {
                    width: 100%;
                    padding: 12px;
                    margin: 10px 0;
                    border: 1px solid #ddd;
                    border-radius: 5px;
                    box-sizing: border-box;
                }
                button {
                    width: 100%;
                    padding: 12px;
                    background: #667eea;
                    color: white;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                    font-size: 16px;
                }
                button:hover {
                    background: #5a67d8;
                }
                .error {
                    color: red;
                    text-align: center;
                    margin-top: 10px;
                }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h1>🚀 Axius WRN</h1>
                <form method="POST" action="/login">
                    <input type="text" name="username" placeholder="Логин" value="admin" required>
                    <input type="password" name="password" placeholder="Пароль" value="admin123" required>
                    <button type="submit">Войти</button>
                </form>
                ${req.query.error ? '<div class="error">Неверный логин или пароль</div>' : ''}
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
        res.redirect('/dashboard');
    } else {
        res.redirect('/login?error=1');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Дашборд
app.get('/dashboard', requireAuth, (req, res) => {
    const user = users[req.session.user.username];
    const sites = user.sites || [];
    const bots = user.bots || [];
    
    let sitesHtml = '';
    sites.forEach(site => {
        sitesHtml += `
            <div style="background:#f8f9fa;padding:15px;margin:10px 0;border-radius:5px;display:flex;justify-content:space-between">
                <span>🌐 ${site.name}</span>
                <a href="/view/${site.id}" style="background:#007bff;color:white;padding:5px 15px;border-radius:5px;text-decoration:none">Открыть</a>
            </div>
        `;
    });
    
    let botsHtml = '';
    bots.forEach(bot => {
        botsHtml += `
            <div style="background:#f8f9fa;padding:15px;margin:10px 0;border-radius:5px;display:flex;justify-content:space-between">
                <span>🤖 @${bot.username}</span>
                <a href="/bot-chats/${bot.username}" style="background:#28a745;color:white;padding:5px 15px;border-radius:5px;text-decoration:none">Чаты</a>
            </div>
        `;
    });
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Дашборд Axius WRN</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 0;
                    padding: 0;
                    background: #f4f4f4;
                }
                .header {
                    background: #333;
                    color: white;
                    padding: 20px;
                    display: flex;
                    justify-content: space-between;
                }
                .container {
                    max-width: 800px;
                    margin: 30px auto;
                    padding: 20px;
                }
                .section {
                    background: white;
                    padding: 20px;
                    margin-bottom: 20px;
                    border-radius: 5px;
                    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
                }
                h2 {
                    margin-top: 0;
                }
                input {
                    width: 100%;
                    padding: 10px;
                    margin: 10px 0;
                    border: 1px solid #ddd;
                    border-radius: 5px;
                    box-sizing: border-box;
                }
                button {
                    background: #007bff;
                    color: white;
                    padding: 10px 20px;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                }
                .logout {
                    background: #dc3545;
                    color: white;
                    padding: 10px 20px;
                    text-decoration: none;
                    border-radius: 5px;
                }
                .nav-links {
                    margin-top: 20px;
                    text-align: center;
                }
                .nav-links a {
                    margin: 0 10px;
                    color: #007bff;
                    text-decoration: none;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN Dashboard</h1>
                <a href="/logout" class="logout">Выйти</a>
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
                    ${sitesHtml || '<p>Нет сайтов</p>'}
                </div>
                
                <div class="section">
                    <h2>🤖 Добавить Telegram бота</h2>
                    <form method="POST" action="/add-bot">
                        <input type="text" name="bot_username" placeholder="Username бота" required>
                        <input type="text" name="bot_token" placeholder="Токен" required>
                        <button type="submit">Добавить</button>
                    </form>
                </div>
                
                <div class="section">
                    <h2>🤖 Боты</h2>
                    ${botsHtml || '<p>Нет ботов</p>'}
                </div>
                
                <div class="nav-links">
                    <a href="/logs">📋 Логи</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Добавление сайта
app.post('/add-site', requireAuth, (req, res) => {
    const user = users[req.session.user.username];
    if (!user.sites) user.sites = [];
    user.sites.push({
        id: Date.now().toString(),
        name: req.body.name,
        url: req.body.url
    });
    saveUsers();
    res.redirect('/dashboard');
});

// Добавление бота
app.post('/add-bot', requireAuth, (req, res) => {
    const user = users[req.session.user.username];
    if (!user.bots) user.bots = [];
    user.bots.push({
        username: req.body.bot_username,
        token: req.body.bot_token
    });
    saveUsers();
    log(`Добавлен бот: @${req.body.bot_username}`);
    res.redirect('/dashboard');
});

// Просмотр сайта
app.get('/view/:id', requireAuth, (req, res) => {
    const user = users[req.session.user.username];
    const site = user.sites.find(s => s.id === req.params.id);
    
    if (!site) {
        return res.redirect('/dashboard');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>${site.name}</title>
            <style>
                * { margin: 0; padding: 0; }
                .nav {
                    background: #333;
                    color: white;
                    padding: 10px;
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    z-index: 1000;
                }
                .nav a {
                    color: white;
                    text-decoration: none;
                }
                iframe {
                    width: 100%;
                    height: 100vh;
                    border: none;
                    margin-top: 40px;
                }
            </style>
        </head>
        <body>
            <div class="nav">
                <a href="/dashboard">← Назад</a> | ${site.name}
            </div>
            <iframe src="/browser?url=${encodeURIComponent(site.url)}"></iframe>
        </body>
        </html>
    `);
});

// Браузер прокси
app.get('/browser', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).send('URL required');
    }
    
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 30000
        });
        
        let html = response.data;
        const urlObj = new URL(url);
        html = html.replace(/<head>/i, `<head><base href="${urlObj.origin}/">`);
        res.send(html);
    } catch (e) {
        res.status(500).send(`Ошибка: ${e.message}`);
    }
});

// Страница чатов бота
app.get('/bot-chats/:botUsername', requireAuth, async (req, res) => {
    const { botUsername } = req.params;
    const user = users[req.session.user.username];
    const bot = user.bots.find(b => b.username === botUsername);
    
    if (!bot) {
        return res.redirect('/dashboard');
    }
    
    let chatsHtml = '<p>Нет чатов</p>';
    
    if (YANDEX_TOKEN) {
        try {
            const items = await disk.listFolder(`${BOT_FOLDER}/${botUsername}/chats`);
            const chatIds = new Set();
            
            for (const item of items) {
                if (item.type === 'dir') {
                    chatIds.add(item.name);
                }
            }
            
            if (chatIds.size > 0) {
                chatsHtml = '';
                for (const chatId of chatIds) {
                    chatsHtml += `
                        <div style="background:#f8f9fa;padding:15px;margin:10px 0;border-radius:5px;display:flex;justify-content:space-between">
                            <span>💬 ${chatId}</span>
                            <a href="/bot-chat/${botUsername}/${chatId}" style="background:#28a745;color:white;padding:5px 15px;border-radius:5px;text-decoration:none">Открыть</a>
                        </div>
                    `;
                }
            }
        } catch (e) {
            chatsHtml = '<p>Ошибка загрузки чатов</p>';
        }
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Чаты @${botUsername}</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    margin: 0;
                    padding: 20px;
                    background: #f4f4f4;
                }
                .container {
                    max-width: 800px;
                    margin: 0 auto;
                    background: white;
                    padding: 20px;
                    border-radius: 10px;
                }
                h1 {
                    margin-top: 0;
                }
                .back {
                    display: inline-block;
                    margin-bottom: 20px;
                    color: #007bff;
                    text-decoration: none;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <a href="/dashboard" class="back">← Назад</a>
                <h1>💬 Чаты @${botUsername}</h1>
                ${chatsHtml}
            </div>
        </body>
        </html>
    `);
});

// Страница чата
app.get('/bot-chat/:botUsername/:chatId', requireAuth, async (req, res) => {
    const { botUsername, chatId } = req.params;
    const user = users[req.session.user.username];
    const bot = user.bots.find(b => b.username === botUsername);
    
    if (!bot) {
        return res.redirect('/dashboard');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Чат ${chatId}</title>
            <style>
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                body {
                    font-family: Arial, sans-serif;
                    background: #1a1a2e;
                    color: #eee;
                }
                .header {
                    background: #16213e;
                    padding: 20px;
                    border-bottom: 1px solid #0f3460;
                }
                .container {
                    max-width: 800px;
                    margin: 0 auto;
                    height: 100vh;
                    display: flex;
                    flex-direction: column;
                }
                .messages {
                    flex: 1;
                    overflow-y: auto;
                    padding: 20px;
                }
                .message {
                    margin-bottom: 15px;
                    display: flex;
                    flex-direction: column;
                }
                .message.received {
                    align-items: flex-start;
                }
                .message.sent {
                    align-items: flex-end;
                }
                .message-bubble {
                    max-width: 70%;
                    padding: 10px 15px;
                    border-radius: 18px;
                    margin: 5px 0;
                }
                .message.received .message-bubble {
                    background: #2d3748;
                }
                .message.sent .message-bubble {
                    background: #4299e1;
                }
                .message-meta {
                    font-size: 12px;
                    color: #a0aec0;
                    margin: 0 10px;
                }
                .input-area {
                    background: #16213e;
                    padding: 20px;
                    display: flex;
                    gap: 10px;
                    border-top: 1px solid #0f3460;
                }
                .input-area input {
                    flex: 1;
                    padding: 12px;
                    border: none;
                    border-radius: 25px;
                    background: #2d3748;
                    color: #fff;
                    font-size: 14px;
                }
                .input-area input:focus {
                    outline: none;
                }
                .input-area button {
                    padding: 12px 24px;
                    background: #4299e1;
                    color: white;
                    border: none;
                    border-radius: 25px;
                    cursor: pointer;
                }
                .back-link {
                    display: inline-block;
                    margin: 15px;
                    color: #4299e1;
                    text-decoration: none;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <a href="/bot-chats/${botUsername}" class="back-link">← Назад</a>
                    <h2>Чат: ${chatId}</h2>
                    <p>🤖 @${botUsername}</p>
                </div>
                <div class="messages" id="messages"></div>
                <div class="input-area">
                    <input type="text" id="messageInput" placeholder="Введите сообщение..." onkeypress="if(event.key==='Enter') sendMessage()">
                    <button onclick="sendMessage()">Отправить</button>
                </div>
            </div>
            
            <script>
                const botUsername = '${botUsername}';
                const chatId = '${chatId}';
                
                async function loadMessages() {
                    try {
                        const response = await fetch('/api/bots/' + botUsername + '/chats/' + chatId + '/messages');
                        const data = await response.json();
                        const messages = data.messages || [];
                        const container = document.getElementById('messages');
                        
                        if (messages.length === 0) {
                            container.innerHTML = '<div style="text-align:center;color:#a0aec0;margin-top:50px;">Нет сообщений</div>';
                            return;
                        }
                        
                        container.innerHTML = messages.map(msg => {
                            const isSent = msg.status === 'sent';
                            const time = new Date(msg.time).toLocaleTimeString();
                            return \`
                                <div class="message \${isSent ? 'sent' : 'received'}">
                                    <div class="message-meta">\${isSent ? 'Вы' : (msg.from || 'Unknown')} • \${time}</div>
                                    <div class="message-bubble">\${escapeHtml(msg.text)}</div>
                                </div>
                            \`;
                        }).join('');
                        
                        container.scrollTop = container.scrollHeight;
                    } catch(e) {
                        console.error('Error loading messages:', e);
                    }
                }
                
                async function sendMessage() {
                    const input = document.getElementById('messageInput');
                    const text = input.value.trim();
                    if (!text) return;
                    
                    try {
                        const response = await fetch('/api/bots/' + botUsername + '/send', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({chat_id: chatId, text: text})
                        });
                        
                        if (response.ok) {
                            input.value = '';
                            setTimeout(loadMessages, 500);
                        }
                    } catch(e) {
                        alert('Ошибка: ' + e.message);
                    }
                }
                
                function escapeHtml(text) {
                    const div = document.createElement('div');
                    div.textContent = text;
                    return div.innerHTML;
                }
                
                loadMessages();
                setInterval(loadMessages, 3000);
            </script>
        </body>
        </html>
    `);
});

// API endpoints
app.post('/fetch', (req, res) => {
    res.json({ status: 'queued', message: 'Task received' });
});

app.get('/result', (req, res) => {
    res.json({ status: 'processing', message: 'Check later' });
});

app.get('/api/bots', requireAuth, (req, res) => {
    const user = users[req.session.user.username];
    res.json({ bots: user.bots || [] });
});

app.post('/api/bots/register', requireAuth, (req, res) => {
    const user = users[req.session.user.username];
    if (!user.bots) user.bots = [];
    user.bots.push({
        username: req.body.bot_username,
        token: req.body.bot_token
    });
    saveUsers();
    res.json({ success: true });
});

app.post('/api/bots/:name/send', requireAuth, async (req, res) => {
    const user = users[req.session.user.username];
    const bot = user.bots.find(b => b.username === req.params.name);
    
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    try {
        const response = await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
            chat_id: req.body.chat_id,
            text: req.body.text
        });
        
        if (YANDEX_TOKEN) {
            const sentMessage = {
                chat_id: String(req.body.chat_id),
                from: 'Admin',
                text: req.body.text,
                time: new Date().toISOString(),
                status: 'sent',
                message_id: Date.now()
            };
            
            await disk.createFolder(`${BOT_FOLDER}/${bot.username}/chats/${req.body.chat_id}`);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            await disk.writeFile(
                `${BOT_FOLDER}/${bot.username}/chats/${req.body.chat_id}/sent_${timestamp}.json`,
                Buffer.from(JSON.stringify(sentMessage, null, 2))
            );
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/bots/:name/chats', requireAuth, async (req, res) => {
    if (!YANDEX_TOKEN) {
        return res.json({ chats: [] });
    }
    
    try {
        const items = await disk.listFolder(`${BOT_FOLDER}/${req.params.name}/chats`);
        const chatIds = [];
        for (const item of items) {
            if (item.type === 'dir') {
                chatIds.push({ chat_id: item.name });
            }
        }
        res.json({ chats: chatIds });
    } catch (e) {
        res.json({ chats: [] });
    }
});

app.get('/api/bots/:name/chats/:cid/messages', requireAuth, async (req, res) => {
    if (!YANDEX_TOKEN) {
        return res.json({ messages: [] });
    }
    
    try {
        const folderPath = `${BOT_FOLDER}/${req.params.name}/chats/${req.params.cid}`;
        const items = await disk.listFolder(folderPath);
        const messages = [];
        
        for (const item of items) {
            if (item.name.endsWith('.json')) {
                try {
                    const content = await disk.readFile(`${folderPath}/${item.name}`);
                    messages.push(JSON.parse(content.toString()));
                } catch (e) {}
            }
        }
        
        messages.sort((a, b) => new Date(a.time) - new Date(b.time));
        res.json({ messages: messages.slice(-100) });
    } catch (e) {
        res.json({ messages: [] });
    }
});

// Логи
app.get('/logs', requireAuth, (req, res) => {
    let logsHtml = '';
    logs.forEach(logEntry => {
        logsHtml += `<div style="padding:5px;border-bottom:1px solid #333;font-family:monospace">${logEntry}</div>`;
    });
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Логи</title>
            <style>
                body {
                    font-family: monospace;
                    background: #1a1a2e;
                    color: #0f0;
                    padding: 20px;
                }
                .header {
                    background: #16213e;
                    padding: 20px;
                    margin-bottom: 20px;
                }
                .logs {
                    background: #0d0d1a;
                    padding: 20px;
                    border-radius: 5px;
                }
                a {
                    color: #0f0;
                    text-decoration: none;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <a href="/dashboard">← Назад</a>
                <h1>📋 Системные логи</h1>
            </div>
            <div class="logs">
                ${logsHtml}
            </div>
        </body>
        </html>
    `);
});

// Главная
app.get('/', (req, res) => {
    if (req.session.user) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

// Запуск
app.listen(PORT, () => {
    log(`✅ Сервер запущен на http://localhost:${PORT}`);
    log(`🔐 Логин: admin / admin123`);
    
    if (!YANDEX_TOKEN) {
        log(`⚠️  YANDEX_TOKEN не установлен (функции Яндекс.Диска недоступны)`);
    } else {
        log(`✅ Яндекс.Диск подключен`);
        workerLoop().catch(e => log(`Worker ошибка: ${e.message}`));
    }
});
