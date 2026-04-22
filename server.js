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
            sites: [] 
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

    async listTaskFiles() {
        if (!this.token) return [];
        try {
            const res = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}&limit=100`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            const items = res.data._embedded?.items || [];
            return items.filter(f => f.name.endsWith('.task') && !f.name.includes('_result'));
        } catch (e) {
            return [];
        }
    }

    async readFile(path) {
        const dl = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${TASK_FOLDER}/${path}`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        const res = await axios.get(dl.data.href, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    }

    async writeFile(path, data) {
        const up = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${TASK_FOLDER}/${path}&overwrite=true`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        await axios.put(up.data.href, data, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        log('[Disk] Written: ' + path);
    }

    async deleteFile(path) {
        try {
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}/${path}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
        } catch (e) {}
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// ============ NODE.JS БРАУЗЕР (КУКИ СОХРАНЯЮТСЯ) ============
const cookieJar = {};

async function nodeBrowser(url, sessionId = 'default') {
    const parsed = new URL(url);
    const host = parsed.hostname;
    
    // Загружаем куки для этого хоста
    const cookieFile = `/tmp/cookies_${host}.json`;
    let cookies = [];
    if (fs.existsSync(cookieFile)) {
        cookies = JSON.parse(fs.readFileSync(cookieFile));
    }
    
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    log('[Browser] Fetching: ' + url);
    
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Cookie': cookieString
        },
        timeout: 30000,
        maxRedirects: 5
    });
    
    // Сохраняем куки из ответа
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
        const newCookies = (Array.isArray(setCookie) ? setCookie : [setCookie])
            .map(c => {
                const parts = c.split(';')[0].split('=');
                return { name: parts[0], value: parts[1] };
            });
        fs.writeFileSync(cookieFile, JSON.stringify(newCookies));
    }
    
    let html = response.data;
    const base = parsed.origin;
    html = html.replace('<head>', `<head><base href="${base}/">`);
    
    log('[Browser] Done: ' + html.length + ' bytes');
    
    return html;
}

// ============ ВОРКЕР ДЛЯ ОБРАБОТКИ ЗАДАЧ ============
async function processTask(taskFile) {
    const taskName = taskFile.name;
    const resultId = taskName.replace('.task', '_result') + '.task';
    
    log('[Worker] Processing: ' + taskName);
    
    try {
        const taskData = await disk.readFile(taskName);
        const requestStr = taskData.toString('utf8');
        
        let url = '';
        const lines = requestStr.split('\r\n');
        if (lines[0]) {
            const parts = lines[0].split(' ');
            url = parts[1];
        }
        
        if (!url) {
            log('[Worker] No URL in task', 'ERROR');
            return;
        }
        
        const html = await nodeBrowser(url);
        
        const httpResponse = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${html.length}\r\n\r\n${html}`;
        
        await disk.writeFile(resultId, Buffer.from(httpResponse));
        await disk.deleteFile(taskName);
        
        log('[Worker] DONE: ' + taskName);
        
    } catch (e) {
        log('[Worker] ERROR: ' + e.message, 'ERROR');
        
        const errorResponse = `HTTP/1.1 500 Error\r\nContent-Type: text/html\r\n\r\n<h1>Error</h1><p>${e.message}</p>`;
        await disk.writeFile(resultId, Buffer.from(errorResponse));
        await disk.deleteFile(taskName);
    }
}

async function workerLoop() {
    log('[Worker] Started');
    
    while (true) {
        try {
            const tasks = await disk.listTaskFiles();
            
            if (tasks.length > 0) {
                log('[Worker] Found ' + tasks.length + ' tasks');
                for (const task of tasks) {
                    await processTask(task);
                }
            }
        } catch (e) {
            log('[Worker] Loop error: ' + e.message, 'ERROR');
        }
        
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ============ API ============
app.post('/fetch', async (req, res) => {
    const { task_id, target_url } = req.body;
    log('[API] /fetch: ' + task_id);
    res.status(202).json({ status: 'queued', task_id });
});

app.get('/result', async (req, res) => {
    res.json({ status: 'processing' });
});

// ============ БРАУЗЕР ЭНДПОИНТ ============
app.get('/browser', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    
    try {
        const html = await nodeBrowser(url, req.session.id);
        res.send(html);
    } catch (e) {
        log('[Browser] Error: ' + e.message, 'ERROR');
        res.status(500).send(`<h1>Ошибка</h1><p>${e.message}</p>`);
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
                    <input type="password" name="confirm" placeholder="Подтвердите пароль" required>
                    <button type="submit">Зарегистрироваться</button>
                </form>
                <p style="text-align: center; margin-top: 20px;"><a href="/login">← Назад</a></p>
            </div>
        </body>
        </html>
    `);
});

app.post('/register', (req, res) => {
    const { username, password, confirm } = req.body;
    
    if (!username || !password || password !== confirm) {
        return res.redirect('/register?error=Пароли не совпадают');
    }
    
    if (users[username]) {
        return res.redirect('/register?error=Пользователь уже существует');
    }
    
    users[username] = { username, password, sites: [] };
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
    if (user.sites && user.sites.length > 0) {
        user.sites.forEach(site => {
            const icon = site.url.includes('telegram') ? '📱' : '🌐';
            sitesHtml += `
                <div style="background:#2a2a4e;padding:15px;border-radius:15px;display:flex;align-items:center;gap:15px;margin-bottom:10px;">
                    <div style="width:40px;height:40px;background:#00d4ff;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;">${icon}</div>
                    <div style="flex:1;">
                        <div style="font-weight:bold;">${site.name}</div>
                        <div style="font-size:12px;opacity:0.7;">${site.url}</div>
                    </div>
                    <a href="/view/${site.id}" style="background:#00d4ff;color:#1a1a2e;padding:8px 12px;border-radius:8px;text-decoration:none;">Открыть</a>
                    <a href="/delete/${site.id}" style="color:#ff4444;" onclick="return confirm('Удалить?')">🗑️</a>
                </div>
            `;
        });
    }
    
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
                .add-box { background: #2a2a4e; padding: 30px; border-radius: 15px; margin-bottom: 30px; }
                .add-box input { width: 100%; padding: 15px; margin: 10px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; }
                .add-box button { width: 100%; padding: 15px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .logout { background: rgba(0,0,0,0.2); color: #1a1a2e; padding: 10px 20px; border-radius: 5px; text-decoration: none; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN</h1>
                <div>
                    <span>👤 ${username}</span>
                    <a href="/logout" class="logout">Выйти</a>
                    <a href="/logs" style="color:#1a1a2e;margin-left:10px;">📋 Логи</a>
                </div>
            </div>
            <div class="container">
                <div class="add-box">
                    <h2>➕ Добавить сайт</h2>
                    <form method="POST" action="/add">
                        <input type="text" name="name" placeholder="Название" required>
                        <input type="url" name="url" placeholder="URL" value="https://web.telegram.org/k/" required>
                        <button type="submit">Добавить</button>
                    </form>
                </div>
                <h2>📱 Мои сайты</h2>
                ${sitesHtml || '<p style="opacity:0.5;">Нет сайтов</p>'}
            </div>
        </body>
        </html>
    `);
});

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
                .bar { background: #2a2a4e; padding: 10px 20px; display: flex; gap: 10px; }
                .bar a { color: #fff; text-decoration: none; padding: 8px 15px; background: #3a3a5e; border-radius: 5px; }
                .url { flex: 1; padding: 8px 15px; background: #1a1a2e; border-radius: 5px; color: #00d4ff; }
                iframe { width: 100%; height: calc(100vh - 50px); border: none; }
            </style>
        </head>
        <body>
            <div class="bar">
                <a href="/dashboard">← Назад</a>
                <div class="url">${site.url}</div>
            </div>
            <iframe src="${browserUrl}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
        </body>
        </html>
    `);
});

app.get('/delete/:id', requireAuth, (req, res) => {
    const username = req.session.user.username;
    users[username].sites = users[username].sites.filter(s => s.id !== req.params.id);
    saveUsers();
    res.redirect('/dashboard');
});

app.get('/logs', requireAuth, (req, res) => {
    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Логи</title>
            <style>
                body { font-family: monospace; background: #1a1a2e; color: #0f0; padding: 20px; }
                a { color: #00d4ff; }
                pre { background: #0d0d1a; padding: 20px; border-radius: 10px; }
            </style>
        </head>
        <body>
            <a href="/dashboard">← Назад</a>
            <h1>📋 Логи</h1>
            <pre>`;
    
    logs.slice().reverse().forEach(l => html += l + '\n');
    
    html += `</pre></body></html>`;
    
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
    log('=== Browser: /browser?url=... ===');
});

workerLoop().catch(e => log('[Worker] Fatal: ' + e.message));
