const express = require('express');
const axios = require('axios');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: '*/*', limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Сессии для входа на Render
app.use(session({
    secret: process.env.SESSION_SECRET || 'axius-wrn-secret-key-' + Date.now(),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 24 часа
}));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

// Простая база пользователей (в памяти)
const users = new Map();
// Добавляем тестового пользователя
users.set('admin', {
    username: 'admin',
    password: '$2a$10$r6Pk4QxqF5hK9jN8vQqJ6OqZ5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Z5Za', // "admin123"
    accounts: []
});

const logs = [];
function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 100) logs.shift();
}

log('=== Axius WRN Server with Auth ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));

// Хранилище кук для прокси
const cookieJar = new Map();

class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async listTaskFiles() {
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
        const dl = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/download?path=${path}`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        const res = await axios.get(dl.data.href, { responseType: 'arraybuffer' });
        return Buffer.from(res.data);
    }

    async writeFile(path, data) {
        const up = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources/upload?path=${path}&overwrite=true`, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        await axios.put(up.data.href, data, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
    }

    async deleteFile(path) {
        try {
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${path}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
        } catch (e) {}
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// ============================================================
// АВТОРИЗАЦИЯ НА RENDER
// ============================================================

// Middleware для проверки авторизации
function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Страница входа
app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/dashboard');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Axius WRN - Вход</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', Arial, sans-serif;
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .login-box {
                    background: rgba(255,255,255,0.1);
                    backdrop-filter: blur(10px);
                    border-radius: 20px;
                    padding: 40px;
                    width: 100%;
                    max-width: 400px;
                    border: 1px solid rgba(255,255,255,0.2);
                }
                h1 {
                    color: #00d4ff;
                    text-align: center;
                    margin-bottom: 30px;
                }
                .input-group {
                    margin-bottom: 20px;
                }
                input {
                    width: 100%;
                    padding: 15px;
                    background: rgba(255,255,255,0.05);
                    border: 1px solid rgba(255,255,255,0.2);
                    border-radius: 10px;
                    color: #fff;
                    font-size: 16px;
                }
                input::placeholder { color: rgba(255,255,255,0.5); }
                input:focus { outline: none; border-color: #00d4ff; }
                button {
                    width: 100%;
                    padding: 15px;
                    background: #00d4ff;
                    color: #1a1a2e;
                    border: none;
                    border-radius: 10px;
                    font-size: 16px;
                    font-weight: bold;
                    cursor: pointer;
                    transition: 0.3s;
                }
                button:hover { background: #00b8e6; }
                .links {
                    text-align: center;
                    margin-top: 20px;
                }
                .links a {
                    color: rgba(255,255,255,0.7);
                    text-decoration: none;
                    font-size: 14px;
                }
                .links a:hover { color: #00d4ff; }
                .error {
                    color: #ff4444;
                    text-align: center;
                    margin-bottom: 15px;
                }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h1>🚀 Axius WRN</h1>
                ${req.query.error ? '<div class="error">❌ ' + req.query.error + '</div>' : ''}
                ${req.query.registered ? '<div class="success" style="color:#00ff88;text-align:center;margin-bottom:15px;">✅ Регистрация успешна! Войдите.</div>' : ''}
                <form method="POST" action="/login">
                    <div class="input-group">
                        <input type="text" name="username" placeholder="Логин" required>
                    </div>
                    <div class="input-group">
                        <input type="password" name="password" placeholder="Пароль" required>
                    </div>
                    <button type="submit">Войти</button>
                </form>
                <div class="links">
                    <a href="/register">Создать аккаунт</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Обработка входа
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    const user = users.get(username);
    if (!user) {
        return res.redirect('/login?error=Пользователь не найден');
    }
    
    // Проверка пароля (для простоты - прямое сравнение, в реальности bcrypt)
    if (user.password !== password && !bcrypt.compareSync(password, user.password)) {
        return res.redirect('/login?error=Неверный пароль');
    }
    
    req.session.user = { username };
    log('[Auth] User logged in: ' + username);
    res.redirect('/dashboard');
});

// Страница регистрации
app.get('/register', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Axius WRN - Регистрация</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', Arial, sans-serif;
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    min-height: 100vh;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                }
                .register-box {
                    background: rgba(255,255,255,0.1);
                    backdrop-filter: blur(10px);
                    border-radius: 20px;
                    padding: 40px;
                    width: 100%;
                    max-width: 400px;
                    border: 1px solid rgba(255,255,255,0.2);
                }
                h1 {
                    color: #00d4ff;
                    text-align: center;
                    margin-bottom: 30px;
                }
                .input-group { margin-bottom: 20px; }
                input {
                    width: 100%;
                    padding: 15px;
                    background: rgba(255,255,255,0.05);
                    border: 1px solid rgba(255,255,255,0.2);
                    border-radius: 10px;
                    color: #fff;
                    font-size: 16px;
                }
                input::placeholder { color: rgba(255,255,255,0.5); }
                input:focus { outline: none; border-color: #00d4ff; }
                button {
                    width: 100%;
                    padding: 15px;
                    background: #00ff88;
                    color: #1a1a2e;
                    border: none;
                    border-radius: 10px;
                    font-size: 16px;
                    font-weight: bold;
                    cursor: pointer;
                    transition: 0.3s;
                }
                button:hover { background: #00e676; }
                .links {
                    text-align: center;
                    margin-top: 20px;
                }
                .links a {
                    color: rgba(255,255,255,0.7);
                    text-decoration: none;
                    font-size: 14px;
                }
                .links a:hover { color: #00d4ff; }
                .error {
                    color: #ff4444;
                    text-align: center;
                    margin-bottom: 15px;
                }
            </style>
        </head>
        <body>
            <div class="register-box">
                <h1>📝 Регистрация</h1>
                ${req.query.error ? '<div class="error">❌ ' + req.query.error + '</div>' : ''}
                <form method="POST" action="/register">
                    <div class="input-group">
                        <input type="text" name="username" placeholder="Логин" required>
                    </div>
                    <div class="input-group">
                        <input type="password" name="password" placeholder="Пароль" required>
                    </div>
                    <div class="input-group">
                        <input type="password" name="confirm" placeholder="Подтвердите пароль" required>
                    </div>
                    <button type="submit">Зарегистрироваться</button>
                </form>
                <div class="links">
                    <a href="/login">Уже есть аккаунт? Войти</a>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Обработка регистрации
app.post('/register', (req, res) => {
    const { username, password, confirm } = req.body;
    
    if (password !== confirm) {
        return res.redirect('/register?error=Пароли не совпадают');
    }
    
    if (users.has(username)) {
        return res.redirect('/register?error=Пользователь уже существует');
    }
    
    if (password.length < 6) {
        return res.redirect('/register?error=Пароль должен быть не менее 6 символов');
    }
    
    users.set(username, {
        username,
        password: password, // В реальности: bcrypt.hashSync(password, 10)
        accounts: []
    });
    
    log('[Auth] New user registered: ' + username);
    res.redirect('/login?registered=1');
});

// Выход
app.get('/logout', (req, res) => {
    const username = req.session.user?.username;
    req.session.destroy();
    log('[Auth] User logged out: ' + username);
    res.redirect('/login');
});

// ============================================================
// ЗАЩИЩЁННЫЕ СТРАНИЦЫ
// ============================================================

// Главный дашборд
app.get('/dashboard', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const user = users.get(username);
    
    let accountsHtml = '';
    if (user.accounts && user.accounts.length > 0) {
        user.accounts.forEach(acc => {
            accountsHtml += `
                <div class="account-card">
                    <div class="account-icon">${acc.icon || '🌐'}</div>
                    <div class="account-info">
                        <div class="account-name">${acc.name}</div>
                        <div class="account-url">${acc.url}</div>
                    </div>
                    <a href="/browser/${acc.id}" class="account-btn">Открыть</a>
                    <a href="/delete-account/${acc.id}" class="account-delete" onclick="return confirm('Удалить аккаунт?')">🗑️</a>
                </div>
            `;
        });
    } else {
        accountsHtml = '<p style="color: rgba(255,255,255,0.5); text-align: center;">Нет сохранённых аккаунтов</p>';
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Axius WRN - Дашборд</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: 'Segoe UI', Arial, sans-serif;
                    background: #1a1a2e;
                    color: #eee;
                    min-height: 100vh;
                }
                .header {
                    background: linear-gradient(135deg, #00d4ff 0%, #0099cc 100%);
                    padding: 20px 30px;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                }
                .header h1 { color: #1a1a2e; }
                .user-info {
                    display: flex;
                    align-items: center;
                    gap: 20px;
                }
                .user-info span { color: #1a1a2e; font-weight: bold; }
                .logout-btn {
                    background: rgba(0,0,0,0.2);
                    color: #1a1a2e;
                    padding: 10px 20px;
                    border-radius: 5px;
                    text-decoration: none;
                    font-weight: bold;
                }
                .container { max-width: 1200px; margin: 30px auto; padding: 0 20px; }
                .add-account {
                    background: rgba(255,255,255,0.05);
                    border-radius: 15px;
                    padding: 30px;
                    margin-bottom: 30px;
                    border: 1px solid rgba(255,255,255,0.1);
                }
                .add-account h2 {
                    color: #00d4ff;
                    margin-bottom: 20px;
                }
                .form-row {
                    display: flex;
                    gap: 15px;
                }
                .form-row input {
                    flex: 1;
                    padding: 15px;
                    background: rgba(255,255,255,0.05);
                    border: 1px solid rgba(255,255,255,0.2);
                    border-radius: 10px;
                    color: #fff;
                    font-size: 16px;
                }
                .form-row button {
                    padding: 15px 30px;
                    background: #00ff88;
                    color: #1a1a2e;
                    border: none;
                    border-radius: 10px;
                    font-size: 16px;
                    font-weight: bold;
                    cursor: pointer;
                }
                .accounts-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                    gap: 20px;
                }
                .account-card {
                    background: rgba(255,255,255,0.05);
                    border-radius: 15px;
                    padding: 20px;
                    display: flex;
                    align-items: center;
                    gap: 15px;
                    border: 1px solid rgba(255,255,255,0.1);
                    transition: 0.3s;
                }
                .account-card:hover {
                    background: rgba(255,255,255,0.1);
                    border-color: #00d4ff;
                }
                .account-icon {
                    width: 50px;
                    height: 50px;
                    background: #00d4ff;
                    border-radius: 12px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 24px;
                    color: #1a1a2e;
                }
                .account-info { flex: 1; }
                .account-name {
                    font-weight: bold;
                    margin-bottom: 5px;
                }
                .account-url {
                    font-size: 12px;
                    opacity: 0.7;
                }
                .account-btn {
                    background: #00d4ff;
                    color: #1a1a2e;
                    padding: 10px 15px;
                    border-radius: 8px;
                    text-decoration: none;
                    font-size: 14px;
                    font-weight: bold;
                }
                .account-delete {
                    color: #ff4444;
                    text-decoration: none;
                    font-size: 18px;
                    opacity: 0.7;
                }
                .account-delete:hover { opacity: 1; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN</h1>
                <div class="user-info">
                    <span>👤 ${username}</span>
                    <a href="/logout" class="logout-btn">Выйти</a>
                </div>
            </div>
            
            <div class="container">
                <div class="add-account">
                    <h2>➕ Добавить аккаунт</h2>
                    <form method="POST" action="/add-account">
                        <div class="form-row">
                            <input type="text" name="name" placeholder="Название (например, Telegram)" required>
                            <input type="url" name="url" placeholder="URL (https://web.telegram.org/k/)" required>
                            <button type="submit">Добавить</button>
                        </div>
                    </form>
                </div>
                
                <h2 style="margin-bottom: 20px;">📱 Мои аккаунты</h2>
                <div class="accounts-grid">
                    ${accountsHtml}
                </div>
            </div>
        </body>
        </html>
    `);
});

// Добавление аккаунта
app.post('/add-account', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const { name, url } = req.body;
    
    const user = users.get(username);
    const accountId = Date.now().toString();
    
    user.accounts.push({
        id: accountId,
        name: name,
        url: url,
        icon: getIconForUrl(url)
    });
    
    log('[Account] Added: ' + name + ' (' + url + ') for ' + username);
    res.redirect('/dashboard');
});

// Удаление аккаунта
app.get('/delete-account/:id', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const accountId = req.params.id;
    
    const user = users.get(username);
    user.accounts = user.accounts.filter(a => a.id !== accountId);
    
    log('[Account] Deleted account ' + accountId);
    res.redirect('/dashboard');
});

// Браузер для конкретного аккаунта
app.get('/browser/:id', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const accountId = req.params.id;
    
    const user = users.get(username);
    const account = user.accounts.find(a => a.id === accountId);
    
    if (!account) {
        return res.redirect('/dashboard');
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>${account.name} - Axius WRN</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { background: #1a1a2e; }
                .browser-bar {
                    background: #2a2a4e;
                    padding: 10px 20px;
                    display: flex;
                    gap: 10px;
                    align-items: center;
                }
                .browser-bar a {
                    color: #fff;
                    text-decoration: none;
                    padding: 8px 15px;
                    background: rgba(255,255,255,0.1);
                    border-radius: 5px;
                }
                .browser-bar .url-display {
                    flex: 1;
                    padding: 8px 15px;
                    background: rgba(0,0,0,0.3);
                    border-radius: 5px;
                    color: #00d4ff;
                }
                .proxy-frame {
                    width: 100%;
                    height: calc(100vh - 50px);
                    border: none;
                    background: #fff;
                }
            </style>
        </head>
        <body>
            <div class="browser-bar">
                <a href="/dashboard">← Назад</a>
                <div class="url-display">${account.url}</div>
            </div>
            <iframe src="/proxy/${accountId}" class="proxy-frame"></iframe>
        </body>
        </html>
    `);
});

// Прокси для аккаунта
app.get('/proxy/:id', requireAuth, async (req, res) => {
    const username = req.session.user.username;
    const accountId = req.params.id;
    
    const user = users.get(username);
    const account = user.accounts.find(a => a.id === accountId);
    
    if (!account) {
        return res.status(404).send('Account not found');
    }
    
    try {
        // Загружаем страницу через прокси
        const response = await axios.get(account.url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            maxRedirects: 5
        });
        
        // Проксируем ответ
        res.set('Content-Type', response.headers['content-type'] || 'text/html');
        res.send(response.data);
    } catch (e) {
        res.status(502).send('<h1>Error loading page</h1><p>' + e.message + '</p>');
    }
});

function getIconForUrl(url) {
    if (url.includes('telegram')) return '📱';
    if (url.includes('instagram')) return '📷';
    if (url.includes('youtube')) return '▶️';
    if (url.includes('facebook')) return '👥';
    if (url.includes('twitter') || url.includes('x.com')) return '🐦';
    if (url.includes('google')) return '🔍';
    return '🌐';
}

// ============================================================
// ГЛАВНАЯ (редирект)
// ============================================================
app.get('/', (req, res) => {
    if (req.session.user) {
        res.redirect('/dashboard');
    } else {
        res.redirect('/login');
    }
});

// Запуск сервера
app.listen(PORT, () => {
    log('=== Server running on port ' + PORT + ' ===');
    log('=== Login at /login ===');
    log('=== Register at /register ===');
});

// ============================================================
// ВОРКЕР ДЛЯ ЗАДАЧ (фоновый)
// ============================================================
async function workerLoop() {
    while (true) {
        try {
            const tasks = await disk.listTaskFiles();
            for (const task of tasks) {
                // Обработка задач (как раньше)
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 3000));
    }
}
workerLoop().catch(e => log('[Worker] Error: ' + e.message));
