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
    try { users = JSON.parse(fs.readFileSync(usersFile)); } catch (e) { users = {}; }
}
if (!users['admin']) {
    users['admin'] = { username: 'admin', password: 'admin123', sites: [], bots: [] };
}
for (const username in users) {
    if (!users[username].sites) users[username].sites = [];
    if (!users[username].bots) users[username].bots = [];
}
saveUsers();

function saveUsers() {
    try { fs.writeFileSync(usersFile, JSON.stringify(users, null, 2)); } catch (e) {}
}

// ============ YANDEX DISK ============
class YandexDisk {
    constructor(token) { this.token = token; }
    async listFolder(p) {
        if (!this.token) return [];
        try {
            const r = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(p)}&limit=100`, {
                headers: { 'Authorization': 'OAuth ' + this.token }
            });
            return r.data._embedded?.items || [];
        } catch (e) { return []; }
    }
    async readFile(p) {
        const dl = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${encodeURIComponent(p)}`, {
            headers: { 'Authorization': 'OAuth ' + this.token }
        });
        const r = await axios.get(dl.data.href, { responseType: 'arraybuffer' });
        return Buffer.from(r.data);
    }
    async writeFile(p, d) {
        const up = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(p)}&overwrite=true`, {
            headers: { 'Authorization': 'OAuth ' + this.token }
        });
        await axios.put(up.data.href, d, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    async deleteFile(p) {
        try { await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(p)}&permanently=true`, { headers: { 'Authorization': 'OAuth ' + this.token } }); } catch (e) {}
    }
    async listTaskFiles() {
        const items = await this.listFolder(TASK_FOLDER);
        return items.filter(f => f.name.endsWith('.task') && !f.name.includes('_result'));
    }
}
const disk = new YandexDisk(YANDEX_TOKEN);

// ============ TELEGRAM BOT MANAGER ============
class TelegramBotManager {
    constructor(disk) { this.disk = disk; }

    async getBotChats(botUsername) {
        const chatsPath = `${BOT_FOLDER}/${botUsername}/chats`;
        try {
            const items = await this.disk.listFolder(chatsPath);
            return items.filter(c => c.type === 'dir').map(c => ({ chat_id: c.name, username: c.name }));
        } catch (e) { return []; }
    }

    async getChatMessages(botUsername, chatId, limit = 50) {
        const notifPath = `${BOT_FOLDER}/${botUsername}/chats/${chatId}`;
        try {
            const files = await this.disk.listFolder(notifPath);
            const messages = [];
            const jsonFiles = files.filter(f => f.name.endsWith('.json')).sort((a, b) => new Date(b.modified) - new Date(a.modified)).slice(0, limit);
            for (const file of jsonFiles) {
                const content = await this.disk.readFile(`${notifPath}/${file.name}`);
                messages.push(JSON.parse(content.toString()));
            }
            return messages;
        } catch (e) { return []; }
    }

    async sendMessage(botUsername, chatId, text) {
        let botToken = '';
        try { botToken = (await this.disk.readFile(`${BOT_FOLDER}/${botUsername}/token.txt`)).toString().trim(); } catch (e) {
            for (const username in users) {
                const bot = (users[username].bots || []).find(b => b.username === botUsername);
                if (bot && bot.token) { botToken = bot.token; break; }
            }
        }
        if (!botToken) throw new Error('Token not found');
        const response = await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text: text });
        return { success: true, message_id: response.data.result.message_id };
    }

    async handleIncomingMessage(botUsername, update) {
        const msg = update.message;
        if (!msg || !msg.text) return;
        const chatId = String(msg.chat.id);
        const text = msg.text;
        const firstName = msg.from?.first_name || 'Пользователь';
        log(`[Bot @${botUsername}] ${firstName} (${chatId}): ${text}`);

        const notification = { type: 'message', chat_id: chatId, text: text, from: firstName, timestamp: new Date().toISOString(), status: 'received', message_id: msg.message_id };
        const chatFolder = `${BOT_FOLDER}/${botUsername}/chats/${chatId}`;
        const notifFile = `${chatFolder}/msg_${Date.now()}.json`;
        try {
            await this.disk.writeFile(`${chatFolder}/.gitkeep`, Buffer.from(''));
            await this.disk.writeFile(notifFile, Buffer.from(JSON.stringify(notification)));
        } catch (e) {}

        // Отвечаем ТОЛЬКО на команды, не спамим
        if (text === '/start') {
            await this.sendMessage(botUsername, chatId, `👋 Привет, ${firstName}!\n\nЯ бот Axius WRN.\n\nКоманды:\n/start\n/help\n/status`);
        } else if (text === '/help') {
            await this.sendMessage(botUsername, chatId, '🆘 Помощь: напиши мне, я сохраню сообщение в облаке.');
        } else if (text === '/status') {
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            await this.sendMessage(botUsername, chatId, `📊 Сервер активен. Uptime: ${Math.floor(uptime/3600)}ч ${Math.floor((uptime%3600)/60)}м`);
        }
        // НЕ отвечаем на обычные сообщения — не спамим!
    }

    async getUpdates(botUsername) {
        let botToken = '';
        try { botToken = (await this.disk.readFile(`${BOT_FOLDER}/${botUsername}/token.txt`)).toString().trim(); } catch (e) {
            for (const username in users) {
                const bot = (users[username].bots || []).find(b => b.username === botUsername);
                if (bot && bot.token) { botToken = bot.token; break; }
            }
        }
        if (!botToken) return;
        const offsetPath = `${BOT_FOLDER}/${botUsername}/offset.txt`;
        let offset = 0;
        try { offset = parseInt((await this.disk.readFile(offsetPath)).toString().trim()) || 0; } catch (e) {}
        try {
            const response = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, { params: { offset: offset + 1, timeout: 10 } });
            for (const update of response.data.result || []) {
                await this.handleIncomingMessage(botUsername, update);
                offset = update.update_id;
            }
            if (response.data.result?.length > 0) {
                await this.disk.writeFile(offsetPath, Buffer.from(String(offset)));
            }
        } catch (e) {}
    }
}

const botManager = new TelegramBotManager(disk);
const startTime = Date.now();

// ============ ВОРКЕР ЗАДАЧ ============
async function processTask(tf) {
    const name = tf.name;
    const rid = name.replace('.task', '_result') + '.task';
    try {
        const data = await disk.readFile(`${TASK_FOLDER}/${name}`);
        const str = data.toString('utf8');
        let url = '';
        const lines = str.split('\r\n');
        if (lines[0]) { const p = lines[0].split(' '); url = p[1]; }
        if (!url) return;
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, maxRedirects: 5, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const h = `HTTP/1.1 ${r.status} OK\r\nContent-Type: text/html\r\nContent-Length: ${r.data.length}\r\n\r\n`;
        await disk.writeFile(`${TASK_FOLDER}/${rid}`, Buffer.concat([Buffer.from(h), Buffer.from(r.data)]));
        await disk.deleteFile(`${TASK_FOLDER}/${name}`);
    } catch (e) {}
}
async function workerLoop() {
    while (true) {
        try { const tasks = await disk.listTaskFiles(); for (const t of tasks) await processTask(t); } catch (e) {}
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ============ BOT POLLER ============
async function botPollerLoop() {
    while (true) {
        try {
            for (const username in users) {
                for (const bot of (users[username].bots || [])) {
                    await botManager.getUpdates(bot.username);
                }
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ============ MIDDLEWARE ============
function requireAuth(req, res, next) {
    if (req.session.user) return next();
    const token = req.query.token || req.body.token;
    if (token && token === YANDEX_TOKEN) { req.session.user = { username: 'admin' }; return next(); }
    res.redirect('/login');
}
function apiAuth(req, res, next) {
    if (req.session.user) return next();
    const token = req.query.token || req.body.token;
    if (token && token === YANDEX_TOKEN) { req.session.user = { username: 'admin' }; return next(); }
    res.status(401).json({ error: 'Unauthorized' });
}

// ============ СТРАНИЦЫ ============
app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Вход</title><style>body{font-family:Arial;background:#1a1a2e;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.box{background:#2a2a4e;padding:40px;border-radius:20px;width:350px;}h1{color:#00d4ff;text-align:center;}input{width:100%;padding:15px;margin:10px 0;background:#1a1a2e;border:1px solid #444;border-radius:10px;color:#fff;box-sizing:border-box;}button{width:100%;padding:15px;background:#00d4ff;border:none;border-radius:10px;font-weight:bold;cursor:pointer;}</style></head><body><div class="box"><h1>🚀 Axius WRN</h1><form method="POST" action="/login"><input type="text" name="username" placeholder="Логин" value="admin" required><input type="password" name="password" placeholder="Пароль" value="admin123" required><button type="submit">Войти</button></form></div></body></html>`);
});
app.post('/login', (req, res) => {
    const u = users[req.body.username];
    if (u && u.password === req.body.password) { req.session.user = { username: req.body.username }; return res.redirect('/dashboard'); }
    res.redirect('/login?error=1');
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.get('/dashboard', requireAuth, (req, res) => {
    const un = req.session.user.username;
    const u = users[un];
    let sites = ''; (u.sites || []).forEach(s => { sites += `<div class="card"><span>🌐</span><div><b>${s.name}</b></div><a href="/view/${s.id}" class="btn">Открыть</a></div>`; });
    let bots = ''; (u.bots || []).forEach(b => { bots += `<div class="card"><span>🤖</span><div><b>@${b.username}</b></div><a href="/bot-chats/${b.username}" class="btn">Чаты</a></div>`; });
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Дашборд</title><style>body{font-family:Arial;background:#1a1a2e;color:#eee;margin:0;}.header{background:#00d4ff;padding:20px;display:flex;justify-content:space-between;}.header h1{color:#1a1a2e;margin:0;}.container{max-width:800px;margin:30px auto;padding:20px;}.section{background:#2a2a4e;padding:30px;border-radius:15px;margin-bottom:30px;}h2{color:#00d4ff;}input{width:100%;padding:15px;margin:10px 0;background:#1a1a2e;border:1px solid #444;border-radius:10px;color:#fff;box-sizing:border-box;}button{width:100%;padding:15px;background:#00ff88;border:none;border-radius:10px;font-weight:bold;cursor:pointer;}.card{background:#3a3a5e;padding:15px;border-radius:10px;display:flex;align-items:center;gap:15px;margin-bottom:10px;}.btn{background:#00d4ff;color:#1a1a2e;padding:8px 15px;border-radius:8px;text-decoration:none;}.logout{background:rgba(0,0,0,0.2);color:#1a1a2e;padding:10px 20px;border-radius:5px;text-decoration:none;}</style></head><body><div class="header"><h1>🚀 Axius WRN</h1><div><span>👤 ${un}</span><a href="/logout" class="logout">Выйти</a></div></div><div class="container"><div class="section"><h2>➕ Добавить сайт</h2><form method="POST" action="/add-site"><input type="text" name="name" placeholder="Название"><input type="url" name="url" placeholder="URL"><button>Добавить</button></form></div><div class="section"><h2>📱 Сайты</h2>${sites||'<p style="opacity:0.5;">Нет сайтов</p>'}</div><div class="section"><h2>🤖 Боты</h2><form method="POST" action="/add-bot"><input type="text" name="bot_username" placeholder="Имя бота"><input type="text" name="bot_token" placeholder="Токен"><button>Добавить бота</button></form>${bots||'<p style="opacity:0.5;">Нет ботов</p>'}</div></div></body></html>`);
});
app.post('/add-site', requireAuth, (req, res) => { const u = users[req.session.user.username]; if (!u.sites) u.sites = []; u.sites.push({ id: Date.now().toString(), name: req.body.name, url: req.body.url }); saveUsers(); res.redirect('/dashboard'); });
app.post('/add-bot', requireAuth, (req, res) => { const u = users[req.session.user.username]; if (!u.bots) u.bots = []; u.bots.push({ username: req.body.bot_username, token: req.body.bot_token }); saveUsers(); log('Bot added: @' + req.body.bot_username); res.redirect('/dashboard'); });
app.get('/view/:id', requireAuth, (req, res) => { const site = users[req.session.user.username].sites?.find(s => s.id === req.params.id); if (!site) return res.redirect('/dashboard'); res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;}iframe{width:100%;height:100vh;border:none;}</style></head><body><iframe src="/browser?url=${encodeURIComponent(site.url)}"></iframe></body></html>`); });
app.get('/browser', async (req, res) => { const url = req.query.url; if (!url) return res.status(400).send('URL required'); try { const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 30000 }); let html = r.data; html = html.replace('<head>', `<head><base href="${new URL(url).origin}/">`); res.send(html); } catch (e) { res.status(500).send('Error: ' + e.message); } });

app.get('/bot-chats/:botUsername', requireAuth, async (req, res) => {
    const bu = req.params.botUsername;
    let chats = [];
    try { const items = await disk.listFolder(`${BOT_FOLDER}/${bu}/chats`); chats = items.filter(i => i.type === 'dir').map(i => ({ chat_id: i.name })); } catch (e) {}
    let chtml = ''; chats.forEach(c => { chtml += `<div class="card"><span>💬</span><div><b>${c.chat_id}</b></div><a href="/bot-chat/${bu}/${c.chat_id}" class="btn">Открыть</a></div>`; });
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Чаты @${bu}</title><style>body{font-family:Arial;background:#1a1a2e;color:#eee;margin:0;}.header{background:#00d4ff;padding:20px;display:flex;justify-content:space-between;}.header h1{color:#1a1a2e;margin:0;}.container{max-width:800px;margin:30px auto;padding:20px;}.card{background:#3a3a5e;padding:15px;border-radius:10px;display:flex;align-items:center;gap:15px;margin-bottom:10px;}.btn{background:#00d4ff;color:#1a1a2e;padding:8px 15px;border-radius:8px;text-decoration:none;}</style></head><body><div class="header"><h1>💬 Чаты @${bu}</h1><a href="/dashboard" style="color:#1a1a2e;text-decoration:none;padding:10px;background:rgba(0,0,0,0.1);border-radius:5px;">← Назад</a></div><div class="container">${chtml||'<p style="opacity:0.5;">Нет чатов. Напишите боту!</p>'}</div></body></html>`);
});

// ============ СТРАНИЦА ЧАТА (ВАШ HTML) ============
app.get('/bot-chat/:botUsername/:chatId', requireAuth, async (req, res) => {
    const { botUsername, chatId } = req.params;
    const username = req.session.user.username;
    const user = users[username];
    const bot = (user.bots || []).find(b => b.username === botUsername);
    if (!bot) return res.redirect('/dashboard');

    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>Чат ${chatId} — @${botUsername}</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #1a1a2e; margin: 0; padding: 20px; color: #e2e8f0; }
        .container { max-width: 800px; margin: 0 auto; }
        h1 { font-size: 1.5rem; color: #00d4ff; display: flex; align-items: center; gap: 12px; }
        .sub { color: #94a3b8; margin-bottom: 1rem; }
        .card { background: #2a2a4e; border-radius: 24px; padding: 1.25rem; margin-bottom: 20px; border: 1px solid #3a3a5e; }
        .form-group { margin-bottom: 1rem; }
        label { font-weight: 600; display: block; margin-bottom: 6px; font-size: 0.85rem; color: #cbd5e1; }
        input, textarea { width: 100%; padding: 12px; border: 1px solid #444; border-radius: 16px; font-size: 0.9rem; background: #1a1a2e; color: #fff; }
        button { background: #00d4ff; color: #1a1a2e; border: none; padding: 12px 20px; border-radius: 40px; font-weight: 600; cursor: pointer; margin-right: 8px; margin-bottom: 8px; }
        button.secondary { background: #3a3a5e; color: #fff; }
        .msg { padding: 12px 16px; border-radius: 16px; margin-bottom: 8px; max-width: 80%; }
        .msg.received { background: #3a3a5e; }
        .msg.sent { background: #00d4ff; color: #1a1a2e; margin-left: auto; }
        .msg-from { font-size: 0.75rem; opacity: 0.7; margin-bottom: 4px; }
        .msg-text { font-size: 1rem; }
        .msg-time { font-size: 0.65rem; opacity: 0.5; text-align: right; }
        #messagesContainer { max-height: calc(100vh - 300px); overflow-y: auto; padding: 10px 0; }
        .input-area { display: flex; gap: 10px; margin-top: 10px; }
        .input-area input { flex: 1; }
        .nav a { color: #00d4ff; text-decoration: none; }
        #statusText { font-size: 0.8rem; color: #94a3b8; margin-top: 5px; }
    </style>
</head>
<body>
<div class="container">
    <div class="nav"><a href="/bot-chats/${botUsername}">← Назад к чатам</a> | <a href="/dashboard">🏠 Дашборд</a></div>
    <h1>💬 Чат ${chatId}</h1>
    <div class="sub">Бот: @${botUsername}</div>

    <div class="card">
        <div id="messagesContainer"><p style="opacity:0.5;text-align:center;">Загрузка сообщений...</p></div>
    </div>

    <div class="card">
        <div class="input-area">
            <input type="text" id="msgInput" placeholder="Введите сообщение...">
            <button onclick="sendMsg()">📤</button>
            <button class="secondary" onclick="refreshMsgs()">🔄</button>
        </div>
        <div id="statusText"></div>
    </div>
</div>

<script>
    const BOT_USERNAME = '${botUsername}';
    const CHAT_ID = '${chatId}';
    let messages = [];

    async function loadMessages() {
        try {
            const r = await fetch('/api/bots/' + BOT_USERNAME + '/chats/' + CHAT_ID + '/messages?limit=100');
            const data = await r.json();
            messages = (data.messages || []).reverse();
            renderMessages();
        } catch (e) {
            document.getElementById('messagesContainer').innerHTML = '<p style="opacity:0.5;">Ошибка загрузки</p>';
        }
    }

    function renderMessages() {
        const container = document.getElementById('messagesContainer');
        if (messages.length === 0) {
            container.innerHTML = '<p style="opacity:0.5;text-align:center;">Нет сообщений</p>';
            return;
        }
        container.innerHTML = messages.map(m => {
            const sent = m.status === 'sent';
            const time = new Date(m.timestamp || m.time).toLocaleTimeString();
            return '<div class="msg ' + (sent ? 'sent' : 'received') + '">' +
                '<div class="msg-from">' + (sent ? 'Вы' : (m.from || '???')) + '</div>' +
                '<div class="msg-text">' + escapeHtml(m.text || '') + '</div>' +
                '<div class="msg-time">' + time + '</div></div>';
        }).join('');
        container.scrollTop = container.scrollHeight;
    }

    function escapeHtml(s) { return s.replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[m]); }

    async function sendMsg() {
        const input = document.getElementById('msgInput');
        const text = input.value.trim();
        if (!text) return;
        const status = document.getElementById('statusText');
        status.textContent = 'Отправка...';
        try {
            await fetch('/api/bots/' + BOT_USERNAME + '/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: CHAT_ID, text: text })
            });
            input.value = '';
            status.textContent = '✅ Отправлено';
            setTimeout(() => status.textContent = '', 2000);
            setTimeout(loadMessages, 500);
        } catch (e) {
            status.textContent = '❌ Ошибка: ' + e.message;
        }
    }

    function refreshMsgs() { loadMessages(); document.getElementById('statusText').textContent = '🔄 Обновлено'; setTimeout(() => document.getElementById('statusText').textContent = '', 2000); }

    document.getElementById('msgInput').addEventListener('keypress', e => { if (e.key === 'Enter') sendMsg(); });

    loadMessages();
    setInterval(loadMessages, 8000);
</script>
</body>
</html>`);
});

// ============ API ============
app.post('/fetch', (req, res) => { res.status(202).json({ status: 'queued' }); });
app.get('/result', (req, res) => { res.json({ status: 'processing' }); });
app.get('/api/bots', apiAuth, (req, res) => { const u = users[req.session.user?.username || 'admin']; res.json({ bots: u?.bots || [] }); });
app.post('/api/bots/register', apiAuth, (req, res) => { const u = users[req.session.user?.username || 'admin']; if (!u.bots) u.bots = []; u.bots.push({ username: req.body.bot_username, token: req.body.bot_token }); saveUsers(); res.json({ success: true }); });
app.delete('/api/bots/:botUsername', apiAuth, (req, res) => { const u = users[req.session.user?.username || 'admin']; u.bots = (u.bots || []).filter(b => b.username !== req.params.botUsername); saveUsers(); res.json({ success: true }); });
app.get('/api/bots/:botUsername/chats', apiAuth, async (req, res) => { try { res.json({ chats: await botManager.getBotChats(req.params.botUsername) }); } catch (e) { res.json({ chats: [] }); } });
app.get('/api/bots/:botUsername/chats/:chatId/messages', apiAuth, async (req, res) => { try { res.json({ messages: await botManager.getChatMessages(req.params.botUsername, req.params.chatId) }); } catch (e) { res.json({ messages: [] }); } });
app.post('/api/bots/:botUsername/send', apiAuth, async (req, res) => { try { res.json(await botManager.sendMessage(req.params.botUsername, req.body.chat_id, req.body.text)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/logs', requireAuth, (req, res) => { let h = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Логи</title><style>body{font-family:monospace;background:#1a1a2e;color:#0f0;padding:20px;}a{color:#00d4ff;}pre{background:#0d0d1a;padding:20px;border-radius:10px;}</style></head><body><a href="/dashboard">← Назад</a><h1>📋 Логи</h1><pre>'; logs.slice().reverse().forEach(l => h += l + '\n'); h += '</pre></body></html>'; res.send(h); });
app.get('/', (req, res) => { if (req.session.user) return res.redirect('/dashboard'); res.redirect('/login'); });

app.listen(PORT, () => { log('=== Server running on port ' + PORT + ' ==='); });
workerLoop();
botPollerLoop();
