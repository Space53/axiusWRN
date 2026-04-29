const express = require('express');
const session = require('express-session');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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

const logs = [];
function log(msg) {
    const entry = `[${new Date().toLocaleString()}] ${msg}`;
    console.log(entry);
    logs.unshift(entry);
    if (logs.length > 200) logs.pop();
}

log('🚀 Server starting...');

// ============ ПОЛЬЗОВАТЕЛИ ============
const usersFile = '/tmp/users.json';
let users = {};

function loadUsers() {
    if (fs.existsSync(usersFile)) {
        try {
            users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        } catch (e) {
            log('Error loading users: ' + e.message);
        }
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
        log('Error saving users: ' + e.message);
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
            throw new Error('YANDEX_TOKEN not set');
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
                params: {
                    path: folderPath,
                    limit: 1000
                }
            });
            return data._embedded?.items || [];
        } catch (e) {
            log(`Error listing folder ${folderPath}: ${e.message}`);
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
            params: {
                path: filePath,
                overwrite: true
            }
        });
        await axios.put(data.href, content, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
    }

    async deleteFile(filePath) {
        try {
            await this.request('resources', {
                method: 'DELETE',
                params: {
                    path: filePath,
                    permanently: true
                }
            });
        } catch (e) {
            log(`Error deleting ${filePath}: ${e.message}`);
        }
    }

    async createFolder(folderPath) {
        try {
            await this.request('resources', {
                method: 'PUT',
                params: {
                    path: folderPath
                }
            });
        } catch (e) {
            // Folder might already exist
        }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// ============ ВОРКЕР ЗАДАЧ ============
const TASK_FOLDER = 'app:/tasks';

async function processTaskFile(taskName) {
    const resultName = taskName.replace('.task', '_result.json');
    
    try {
        const taskContent = await disk.readFile(`${TASK_FOLDER}/${taskName}`);
        const taskJson = JSON.parse(taskContent.toString('utf8'));
        const { url, download_path } = taskJson;
        
        log(`[Worker] Processing: ${url}`);
        
        // Скачиваем файл
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 60000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        // Сохраняем результат
        const result = {
            url: url,
            download_path: download_path,
            status: 'completed',
            timestamp: new Date().toISOString(),
            size: response.data.length,
            content_type: response.headers['content-type']
        };
        
        // Сохраняем результат как JSON
        await disk.writeFile(`${TASK_FOLDER}/${resultName}`, 
            Buffer.from(JSON.stringify(result, null, 2)));
        
        // Удаляем исходный task файл
        await disk.deleteFile(`${TASK_FOLDER}/${taskName}`);
        
        // Если указан путь для сохранения, сохраняем файл
        if (download_path) {
            await disk.writeFile(download_path, response.data);
            log(`[Worker] Saved to: ${download_path}`);
        }
        
        log(`[Worker] Completed: ${url} (${response.data.length} bytes)`);
    } catch (e) {
        log(`[Worker] Error processing ${taskName}: ${e.message}`);
        
        // Сохраняем ошибку
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
    log('[Worker] Started, checking every 3 seconds...');
    
    while (true) {
        try {
            if (YANDEX_TOKEN) {
                const items = await disk.listFolder(TASK_FOLDER);
                const tasks = items.filter(item => 
                    item.name.endsWith('.task') && 
                    item.type === 'file'
                );
                
                for (const task of tasks) {
                    await processTaskFile(task.name);
                }
            }
        } catch (e) {
            log(`[Worker] Error: ${e.message}`);
        }
        
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

// ============ TELEGRAM BOT POLLER ============
const BOT_FOLDER = 'app:/bots';

async function ensureBotFolders(botName) {
    await disk.createFolder(`${BOT_FOLDER}/${botName}`);
    await disk.createFolder(`${BOT_FOLDER}/${botName}/chats`);
}

async function saveMessage(botName, chatId, message) {
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
    
    await disk.writeFile(filePath, Buffer.from(JSON.stringify(messageData, null, 2)));
    return messageData;
}

async function pollTelegramBots() {
    for (const [username, userData] of Object.entries(users)) {
        if (!userData.bots) continue;
        
        for (const bot of userData.bots) {
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
                    {
                        params: {
                            offset: offset + 1,
                            timeout: 30
                        }
                    }
                );
                
                for (const update of response.data.result || []) {
                    const message = update.message;
                    if (!message || !message.text) continue;
                    
                    const chatId = String(message.chat.id);
                    const text = message.text.trim();
                    const fromName = message.from?.first_name || message.from?.username || 'User';
                    
                    log(`[Bot @${bot.username}] From ${fromName} (${chatId}): ${text}`);
                    
                    // Сохраняем сообщение
                    await ensureBotFolders(bot.username);
                    await saveMessage(bot.username, chatId, message);
                    
                    // Отвечаем только на команды
                    if (text === '/start') {
                        await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
                            chat_id: chatId,
                            text: `👋 Привет, ${fromName}!\n\nЯ бот Axius WRN.\n\nДоступные команды:\n/start - Приветствие\n/help - Помощь\n/status - Статус сервера`
                        });
                    } else if (text === '/help') {
                        await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
                            chat_id: chatId,
                            text: '🆘 Помощь\n\nЯ сохраняю все сообщения в Яндекс.Диске. Администратор может просматривать чаты через веб-интерфейс.'
                        });
                    } else if (text === '/status') {
                        await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
                            chat_id: chatId,
                            text: `📊 Статус сервера\n🟢 Активен\n📅 ${new Date().toLocaleString()}`
                        });
                    }
                    
                    offset = update.update_id;
                }
                
                if (response.data.result?.length > 0) {
                    fs.writeFileSync(offsetFile, String(offset));
                }
            } catch (e) {
                log(`[Bot @${bot.username}] Poll error: ${e.message}`);
            }
        }
    }
}

// Запускаем поллинг ботов
setInterval(pollTelegramBots, 3000);
pollTelegramBots();

// ============ MIDDLEWARE ============
function requireAuth(req, res, next) {
    if (req.session.user && users[req.session.user.username]) {
        return next();
    }
    res.redirect('/login');
}

// ============ СТРАНИЦЫ ============

// Логин
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN - Вход</title>
            <style>
                *{margin:0;padding:0;box-sizing:border-box}
                body{font-family:'Segoe UI',Arial;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center}
                .login-card{background:white;border-radius:20px;padding:40px;width:400px;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
                h1{color:#333;margin-bottom:10px;text-align:center}
                .subtitle{color:#666;text-align:center;margin-bottom:30px}
                input{width:100%;padding:12px;margin:10px 0;border:1px solid #ddd;border-radius:8px;font-size:16px}
                button{width:100%;padding:12px;background:#667eea;color:white;border:none;border-radius:8px;font-size:16px;cursor:pointer;margin-top:20px}
                button:hover{background:#5a67d8}
                .error{color:#e74c3c;text-align:center;margin-top:10px}
            </style>
        </head>
        <body>
            <div class="login-card">
                <h1>🚀 Axius WRN</h1>
                <div class="subtitle">Вход в систему</div>
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
        req.session.user = { username: username };
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
    const currentUser = users[req.session.user.username];
    const sites = currentUser.sites || [];
    const bots = currentUser.bots || [];
    
    let sitesHtml = '';
    sites.forEach(site => {
        sitesHtml += `
            <div class="site-item">
                <span>🌐 ${escapeHtml(site.name)}</span>
                <a href="/view/${site.id}" class="btn">Открыть</a>
            </div>
        `;
    });
    
    let botsHtml = '';
    bots.forEach(bot => {
        botsHtml += `
            <div class="bot-item">
                <span>🤖 @${escapeHtml(bot.username)}</span>
                <a href="/bot-chats/${bot.username}" class="btn">Чаты</a>
            </div>
        `;
    });
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN - Дашборд</title>
            <style>
                *{margin:0;padding:0;box-sizing:border-box}
                body{font-family:'Segoe UI',Arial;background:#f5f5f5}
                .header{background:#2c3e50;color:white;padding:20px;display:flex;justify-content:space-between;align-items:center}
                .header h1{font-size:24px}
                .logout-btn{background:#e74c3c;color:white;padding:10px 20px;border-radius:8px;text-decoration:none}
                .container{max-width:1200px;margin:30px auto;padding:0 20px}
                .section{background:white;border-radius:12px;padding:25px;margin-bottom:30px;box-shadow:0 2px 10px rgba(0,0,0,0.1)}
                .section h2{margin-bottom:20px;color:#333}
                input,select{width:100%;padding:10px;margin:10px 0;border:1px solid #ddd;border-radius:6px}
                button{background:#3498db;color:white;padding:10px 20px;border:none;border-radius:6px;cursor:pointer}
                button:hover{background:#2980b9}
                .site-item,.bot-item{background:#f8f9fa;padding:15px;margin:10px 0;border-radius:8px;display:flex;justify-content:space-between;align-items:center}
                .btn{background:#3498db;color:white;padding:8px 16px;border-radius:6px;text-decoration:none}
                .nav-links{margin-top:20px;display:flex;gap:15px}
                .nav-links a{color:#3498db;text-decoration:none}
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN Dashboard</h1>
                <a href="/logout" class="logout-btn">Выйти</a>
            </div>
            <div class="container">
                <div class="section">
                    <h2>➕ Добавить сайт</h2>
                    <form method="POST" action="/add-site">
                        <input type="text" name="name" placeholder="Название сайта" required>
                        <input type="url" name="url" placeholder="URL (https://example.com)" required>
                        <button type="submit">Добавить сайт</button>
                    </form>
                </div>
                
                <div class="section">
                    <h2>📱 Мои сайты</h2>
                    ${sitesHtml || '<p style="color:#999;">Нет добавленных сайтов</p>'}
                </div>
                
                <div class="section">
                    <h2>🤖 Добавить Telegram бота</h2>
                    <form method="POST" action="/add-bot">
                        <input type="text" name="bot_username" placeholder="Username бота (без @)" required>
                        <input type="text" name="bot_token" placeholder="Токен бота" required>
                        <button type="submit">Добавить бота</button>
                    </form>
                </div>
                
                <div class="section">
                    <h2>🤖 Мои боты</h2>
                    ${botsHtml || '<p style="color:#999;">Нет добавленных ботов</p>'}
                </div>
                
                <div class="nav-links">
                    <a href="/logs">📋 Логи системы</a>
                    <a href="/api/bots">📡 API ботов</a>
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
    log(`🤖 Bot added: @${req.body.bot_username}`);
    res.redirect('/dashboard');
});

// Прокси браузера
app.get('/view/:id', requireAuth, (req, res) => {
    const user = users[req.session.user.username];
    const site = user.sites?.find(s => s.id === req.params.id);
    
    if (!site) {
        return res.redirect('/dashboard');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>${escapeHtml(site.name)}</title>
            <style>
                *{margin:0;padding:0}
                body{overflow:hidden}
                iframe{width:100%;height:100vh;border:none}
                .nav{background:#333;color:white;padding:10px;position:fixed;top:0;left:0;right:0;z-index:1000;display:flex;gap:15px}
                .nav a{color:white;text-decoration:none}
                iframe{margin-top:40px;height:calc(100vh - 40px)}
            </style>
        </head>
        <body>
            <div class="nav">
                <a href="/dashboard">← Дашборд</a>
                <span>${escapeHtml(site.name)}</span>
            </div>
            <iframe src="/browser?url=${encodeURIComponent(site.url)}"></iframe>
        </body>
        </html>
    `);
});

app.get('/browser', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).send('URL required');
    }
    
    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 30000,
            responseType: 'text'
        });
        
        let html = response.data;
        // Фиксируем относительные ссылки
        const urlObj = new URL(targetUrl);
        html = html.replace(/<head>/i, `<head><base href="${urlObj.protocol}//${urlObj.host}/">`);
        
        res.send(html);
    } catch (e) {
        res.status(500).send(`<h1>Ошибка загрузки</h1><p>${e.message}</p><a href="/dashboard">← Назад</a>`);
    }
});

// Страница чатов бота
app.get('/bot-chats/:botUsername', requireAuth, async (req, res) => {
    const { botUsername } = req.params;
    const user = users[req.session.user.username];
    const bot = user.bots?.find(b => b.username === botUsername);
    
    if (!bot) {
        return res.redirect('/dashboard');
    }
    
    let chats = [];
    if (YANDEX_TOKEN) {
        try {
            const items = await disk.listFolder(`${BOT_FOLDER}/${botUsername}/chats`);
            const chatIds = new Set();
            
            for (const item of items) {
                if (item.type === 'dir') {
                    chatIds.add(item.name);
                } else if (item.path) {
                    const match = item.path.match(/chats\/([^\/]+)/);
                    if (match) chatIds.add(match[1]);
                }
            }
            chats = Array.from(chatIds).map(id => ({ chat_id: id }));
        } catch (e) {
            log(`Error listing chats: ${e.message}`);
        }
    }
    
    let chatsHtml = '';
    chats.forEach(chat => {
        chatsHtml += `
            <div class="chat-item">
                <span>💬 ${escapeHtml(chat.chat_id)}</span>
                <a href="/bot-chat/${botUsername}/${chat.chat_id}" class="btn">Открыть</a>
            </div>
        `;
    });
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Чаты @${botUsername}</title>
            <style>
                *{margin:0;padding:0;box-sizing:border-box}
                body{font-family:'Segoe UI',Arial;background:#f5f5f5}
                .header{background:#2c3e50;color:white;padding:20px}
                .container{max-width:800px;margin:30px auto;padding:0 20px}
                .chat-item{background:white;padding:15px;margin:10px 0;border-radius:8px;display:flex;justify-content:space-between;align-items:center;box-shadow:0 2px 5px rgba(0,0,0,0.1)}
                .btn{background:#3498db;color:white;padding:8px 16px;border-radius:6px;text-decoration:none}
                .back-link{display:inline-block;margin:20px;color:#3498db;text-decoration:none}
            </style>
        </head>
        <body>
            <div class="header">
                <h1>💬 Чаты @${escapeHtml(botUsername)}</h1>
            </div>
            <a href="/dashboard" class="back-link">← Назад к дашборду</a>
            <div class="container">
                ${chatsHtml || '<p style="text-align:center;color:#999;">Нет активных чатов. Напишите боту первым!</p>'}
            </div>
        </body>
        </html>
    `);
});

// Страница конкретного чата
app.get('/bot-chat/:botUsername/:chatId', requireAuth, async (req, res) => {
    const { botUsername, chatId } = req.params;
    const user = users[req.session.user.username];
    const bot = user.bots?.find(b => b.username === botUsername);
    
    if (!bot) {
        return res.redirect('/dashboard');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Чат ${chatId} - @${botUsername}</title>
            <style>
                *{margin:0;padding:0;box-sizing:border-box}
                body{font-family:'Segoe UI',Arial;background:#1a1a2e;color:#eee}
                .header{background:#16213e;padding:20px;border-bottom:1px solid #0f3460}
                .container{max-width:800px;margin:0 auto;height:100vh;display:flex;flex-direction:column}
                .messages{flex:1;overflow-y:auto;padding:20px}
                .message{margin-bottom:15px;display:flex;flex-direction:column}
                .message.received{align-items:flex-start}
                .message.sent{align-items:flex-end}
                .message-bubble{max-width:70%;padding:10px 15px;border-radius:18px;margin:5px 0}
                .message.received .message-bubble{background:#2d3748;color:#fff}
                .message.sent .message-bubble{background:#4299e1;color:#fff}
                .message-meta{font-size:12px;color:#a0aec0;margin:0 10px}
                .input-area{background:#16213e;padding:20px;display:flex;gap:10px;border-top:1px solid #0f3460}
                .input-area input{flex:1;padding:12px;border:none;border-radius:25px;background:#2d3748;color:#fff;font-size:14px}
                .input-area input:focus{outline:none;border:1px solid #4299e1}
                .input-area button{padding:12px 24px;background:#4299e1;color:white;border:none;border-radius:25px;cursor:pointer}
                .back-link{display:inline-block;margin:15px;color:#4299e1;text-decoration:none}
                h1{font-size:18px;margin:0}
                .status{font-size:12px;color:#a0aec0;margin-top:5px}
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <a href="/bot-chats/${botUsername}" class="back-link">← Назад</a>
                    <h1>💬 Чат: ${escapeHtml(chatId)}</h1>
                    <div class="status">🤖 @${escapeHtml(botUsername)}</div>
                </div>
                <div class="messages" id="messages"></div>
                <div class="input-area">
                    <input type="text" id="messageInput" placeholder="Введите сообщение..." onkeypress="if(event.key==='Enter') sendMessage()">
                    <button onclick="sendMessage()">📤 Отправить</button>
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
                            return '
                                <div class="message ' + (isSent ? 'sent' : 'received') + '">
                                    <div class="message-meta">' + (isSent ? 'Вы' : escapeHtml(msg.from)) + ' • ' + time + '</div>
                                    <div class="message-bubble">' + escapeHtml(msg.text) + '</div>
                                </div>
                            ';
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
                        alert('Ошибка отправки: ' + e.message);
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

// Старый API для Android
app.post('/fetch', (req, res) => {
    res.json({ status: 'queued', message: 'Task received' });
});

app.get('/result', (req, res) => {
    res.json({ status: 'processing', message: 'Check later' });
});

// REST API
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
    const bot = user.bots?.find(b => b.username === req.params.name);
    
    if (!bot) {
        return res.status(404).json({ error: 'Bot not found' });
    }
    
    try {
        const response = await axios.post(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
            chat_id: req.body.chat_id,
            text: req.body.text
        });
        
        // Сохраняем отправленное сообщение
        if (YANDEX_TOKEN) {
            const sentMessage = {
                chat_id: String(req.body.chat_id),
                from: 'Admin',
                text: req.body.text,
                time: new Date().toISOString(),
                status: 'sent',
                message_id: response.data.result?.message_id || Date.now()
            };
            
            await ensureBotFolders(bot.username);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            await disk.writeFile(
                `${BOT_FOLDER}/${bot.username}/chats/${req.body.chat_id}/msg_sent_${timestamp}.json`,
                Buffer.from(JSON.stringify(sentMessage, null, 2))
            );
        }
        
        res.json({ success: true, message_id: response.data.result?.message_id });
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
        const chatIds = new Set();
        
        for (const item of items) {
            if (item.type === 'dir') {
                chatIds.add(item.name);
            } else if (item.path) {
                const match = item.path.match(/chats\/([^\/]+)/);
                if (match) chatIds.add(match[1]);
            }
        }
        
        res.json({ chats: Array.from(chatIds).map(id => ({ chat_id: id })) });
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
        
        for (const item of items.filter(i => i.name.endsWith('.json'))) {
            try {
                const content = await disk.readFile(`${folderPath}/${item.name}`);
                const msg = JSON.parse(content.toString());
                messages.push(msg);
            } catch (e) {}
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
    logs.forEach(log => {
        logsHtml += `<div class="log-entry">${escapeHtml(log)}</div>`;
    });
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Системные логи</title>
            <style>
                *{margin:0;padding:0;box-sizing:border-box}
                body{font-family:'Courier New',monospace;background:#1a1a2e;color:#0f0;padding:20px}
                .header{background:#16213e;padding:20px;margin-bottom:20px;border-radius:8px}
                .log-entry{font-family:monospace;padding:5px;border-bottom:1px solid #333;font-size:12px}
                .back-link{color:#0f0;text-decoration:none;display:inline-block;margin-bottom:20px}
            </style>
        </head>
        <body>
            <a href="/dashboard" class="back-link">← Назад к дашборду</a>
            <div class="header">
                <h1>📋 Системные логи</h1>
            </div>
            <div class="logs">
                ${logsHtml}
            </div>
        </body>
        </html>
    `);
});

// Главная страница
app.get('/', (req, res) => {
    if (req.session.user) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Запуск сервера
app.listen(PORT, () => {
    log(`✅ Server running on http://localhost:${PORT}`);
    log(`📝 Login: admin / admin123`);
    
    if (!YANDEX_TOKEN) {
        log(`⚠️  YANDEX_TOKEN not set. Яндекс.Диск функции не активны`);
        log(`💡 Set env: YANDEX_TOKEN=ваш_токен`);
    } else {
        log(`✅ Yandex.Disk token configured`);
        // Запускаем воркер
        workerLoop().catch(e => log(`Worker error: ${e.message}`));
    }
});
