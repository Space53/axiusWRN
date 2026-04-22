const express = require('express');
const session = require('express-session');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Сессии
app.use(session({
    secret: 'axius-wrn-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const PORT = process.env.PORT || 3000;

// База пользователей
const users = new Map();
users.set('admin', { 
    username: 'admin', 
    password: 'admin123', 
    accounts: [] 
});

// Логи
const logs = [];
function log(msg, level = 'INFO') {
    const entry = `[${new Date().toISOString()}] [${level}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 200) logs.shift();
}

log('=== Axius WRN Server Started ===');
log('Admin: admin / admin123');

// Middleware авторизации
function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

// ============ СТРАНИЦА ЛОГОВ ============
app.get('/logs', requireAuth, (req, res) => {
    let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN - Логи</title>
            <style>
                body { font-family: 'Consolas', monospace; background: #1a1a2e; color: #eee; padding: 20px; margin: 0; }
                h1 { color: #00d4ff; display: flex; align-items: center; gap: 10px; }
                .log-container { background: #0d0d1a; padding: 20px; border-radius: 10px; max-height: 80vh; overflow-y: auto; }
                .log-entry { padding: 5px 0; border-bottom: 1px solid #2a2a4e; font-size: 13px; }
                .log-time { color: #888; margin-right: 15px; }
                .log-level-INFO { color: #00ff88; }
                .log-level-ERROR { color: #ff4444; }
                .log-level-WARN { color: #ffaa00; }
                .nav { margin-bottom: 20px; }
                .nav a { color: #00d4ff; text-decoration: none; margin-right: 20px; padding: 10px; background: rgba(255,255,255,0.1); border-radius: 5px; }
                .nav a:hover { background: rgba(255,255,255,0.2); }
                .clear-btn { background: #ff4444; color: #fff; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-left: auto; }
                .header { display: flex; align-items: center; }
                .stats { margin-left: 20px; font-size: 14px; color: #888; }
            </style>
        </head>
        <body>
            <div class="nav">
                <a href="/dashboard">← Дашборд</a>
                <a href="/logs">🔄 Обновить</a>
            </div>
            <div class="header">
                <h1>📋 Логи сервера</h1>
                <span class="stats">Всего записей: ${logs.length}</span>
                <button class="clear-btn" onclick="clearLogs()">🗑️ Очистить</button>
            </div>
            <div class="log-container" id="logs">
    `;
    
    logs.slice().reverse().forEach(l => {
        const match = l.match(/\[(.+?)\] \[(.+?)\] (.+)/);
        if (match) {
            const time = new Date(match[1]).toLocaleTimeString('ru-RU');
            const level = match[2];
            const msg = match[3];
            html += `<div class="log-entry"><span class="log-time">[${time}]</span><span class="log-level-${level}">[${level}]</span> ${msg}</div>`;
        } else {
            html += `<div class="log-entry">${l}</div>`;
        }
    });
    
    html += `
            </div>
            <script>
                function clearLogs() {
                    fetch('/clear-logs', { method: 'POST' }).then(() => location.reload());
                }
                setTimeout(() => location.reload(), 10000);
            </script>
        </body>
        </html>
    `;
    
    res.send(html);
});

app.post('/clear-logs', requireAuth, (req, res) => {
    logs.length = 0;
    log('Logs cleared by user');
    res.json({ ok: true });
});

// ============ ПРОКСИ ДЛЯ САЙТОВ (обход iframe) ============
app.get('/proxy', requireAuth, async (req, res) => {
    const url = req.query.url;
    
    if (!url) {
        return res.status(400).send('URL required');
    }
    
    log('Proxy request: ' + url);
    
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'identity'
            },
            maxRedirects: 5,
            timeout: 30000
        });
        
        // Убираем X-Frame-Options
        let html = response.data;
        if (typeof html === 'string') {
            // Удаляем X-Frame-Options из meta-тегов
            html = html.replace(/<meta[^>]*X-Frame-Options[^>]*>/gi, '');
            // Добавляем базовый URL для относительных ссылок
            const baseUrl = new URL(url).origin;
            html = html.replace('<head>', `<head><base href="${baseUrl}/">`);
        }
        
        // Убираем заголовки, блокирующие iframe
        delete response.headers['x-frame-options'];
        delete response.headers['content-security-policy'];
        
        res.set(response.headers);
        res.send(html);
        
        log('Proxy success: ' + url);
    } catch (e) {
        log('Proxy error: ' + url + ' - ' + e.message, 'ERROR');
        res.status(502).send(`<h1>Ошибка загрузки</h1><p>${e.message}</p><p><a href="/dashboard">← Назад</a></p>`);
    }
});

// Прокси для статических ресурсов (CSS, JS, картинки)
app.get('/proxy-assets', requireAuth, async (req, res) => {
    const url = req.query.url;
    
    if (!url) {
        return res.status(400).send('URL required');
    }
    
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': req.query.referer || ''
            },
            timeout: 30000
        });
        
        const contentType = response.headers['content-type'];
        if (contentType) res.set('Content-Type', contentType);
        
        res.send(response.data);
    } catch (e) {
        res.status(404).send('');
    }
});

// ============ СТРАНИЦЫ ============

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
                .box { background: rgba(255,255,255,0.1); padding: 40px; border-radius: 20px; width: 350px; }
                h1 { color: #00d4ff; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; color: #fff; box-sizing: border-box; }
                button { width: 100%; padding: 15px; background: #00d4ff; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .error { color: #ff4444; text-align: center; }
                a { color: #00d4ff; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>🚀 Axius WRN</h1>
                ${req.query.error ? '<div class="error">❌ ' + req.query.error + '</div>' : ''}
                <form method="POST" action="/login">
                    <input type="text" name="username" placeholder="Логин" value="admin" required>
                    <input type="password" name="password" placeholder="Пароль" value="admin123" required>
                    <button type="submit">Войти</button>
                </form>
                <p style="text-align: center; margin-top: 20px;"><a href="/register">Создать аккаунт</a></p>
            </div>
        </body>
        </html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.get(username);
    
    if (!user || user.password !== password) {
        log('Failed login: ' + username, 'WARN');
        return res.redirect('/login?error=Неверный логин или пароль');
    }
    
    req.session.user = { username };
    log('Login: ' + username);
    res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN - Регистрация</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                .box { background: rgba(255,255,255,0.1); padding: 40px; border-radius: 20px; width: 350px; }
                h1 { color: #00ff88; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; color: #fff; box-sizing: border-box; }
                button { width: 100%; padding: 15px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .error { color: #ff4444; text-align: center; }
                a { color: #00d4ff; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>📝 Регистрация</h1>
                ${req.query.error ? '<div class="error">❌ ' + req.query.error + '</div>' : ''}
                <form method="POST" action="/register">
                    <input type="text" name="username" placeholder="Логин" required>
                    <input type="password" name="password" placeholder="Пароль" required>
                    <input type="password" name="confirm" placeholder="Подтвердите пароль" required>
                    <button type="submit">Зарегистрироваться</button>
                </form>
                <p style="text-align: center; margin-top: 20px;"><a href="/login">← Назад ко входу</a></p>
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
    
    if (users.has(username)) {
        return res.redirect('/register?error=Пользователь уже существует');
    }
    
    users.set(username, { username, password, accounts: [] });
    log('Registered: ' + username);
    res.redirect('/login');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/dashboard', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const user = users.get(username);
    
    let accountsHtml = '';
    if (user.accounts && user.accounts.length > 0) {
        user.accounts.forEach(acc => {
            accountsHtml += `
                <div style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 15px; display: flex; align-items: center; gap: 15px; margin-bottom: 10px;">
                    <div style="width: 40px; height: 40px; background: #00d4ff; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px;">${acc.icon || '🌐'}</div>
                    <div style="flex: 1;">
                        <div style="font-weight: bold;">${acc.name}</div>
                        <div style="font-size: 12px; opacity: 0.7;">${acc.url}</div>
                    </div>
                    <a href="/browser/${acc.id}" style="background: #00d4ff; color: #1a1a2e; padding: 8px 12px; border-radius: 8px; text-decoration: none;">Открыть</a>
                    <a href="/delete-account/${acc.id}" style="color: #ff4444; text-decoration: none;" onclick="return confirm('Удалить?')">🗑️</a>
                </div>
            `;
        });
    } else {
        accountsHtml = '<p style="color: rgba(255,255,255,0.5);">Нет сохранённых сайтов</p>';
    }
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN - Дашборд</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; margin: 0; }
                .header { background: linear-gradient(135deg, #00d4ff, #0099cc); padding: 20px; display: flex; justify-content: space-between; }
                .header h1 { color: #1a1a2e; margin: 0; }
                .container { max-width: 800px; margin: 30px auto; padding: 20px; }
                .add-box { background: rgba(255,255,255,0.05); padding: 30px; border-radius: 15px; margin-bottom: 30px; }
                .add-box input { width: 100%; padding: 15px; margin: 10px 0; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; color: #fff; box-sizing: border-box; }
                .add-box button { width: 100%; padding: 15px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .logout { background: rgba(0,0,0,0.2); color: #1a1a2e; padding: 10px 20px; border-radius: 5px; text-decoration: none; }
                .nav-links { display: flex; gap: 10px; }
                .nav-links a { color: #1a1a2e; text-decoration: none; padding: 10px 15px; background: rgba(0,0,0,0.1); border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🚀 Axius WRN</h1>
                <div style="display: flex; align-items: center; gap: 20px;">
                    <div class="nav-links">
                        <a href="/logs">📋 Логи</a>
                    </div>
                    <span>👤 ${username}</span>
                    <a href="/logout" class="logout">Выйти</a>
                </div>
            </div>
            <div class="container">
                <div class="add-box">
                    <h2>➕ Добавить сайт</h2>
                    <form method="POST" action="/add-account">
                        <input type="text" name="name" placeholder="Название (например, Telegram)" required>
                        <input type="url" name="url" placeholder="URL (https://web.telegram.org/k/)" required>
                        <button type="submit">Добавить</button>
                    </form>
                    <p style="font-size: 12px; opacity: 0.7; margin-top: 10px;">💡 Сайты открываются через прокси (обходит блокировку iframe)</p>
                </div>
                <h2>📱 Мои сайты</h2>
                ${accountsHtml}
            </div>
        </body>
        </html>
    `);
});

app.post('/add-account', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const { name, url } = req.body;
    const user = users.get(username);
    
    const icon = url.includes('telegram') ? '📱' : url.includes('google') ? '🔍' : url.includes('youtube') ? '▶️' : url.includes('instagram') ? '📷' : '🌐';
    
    user.accounts.push({ id: Date.now().toString(), name, url, icon });
    log('Added site: ' + name + ' (' + url + ')');
    res.redirect('/dashboard');
});

app.get('/delete-account/:id', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const user = users.get(username);
    user.accounts = user.accounts.filter(a => a.id !== req.params.id);
    res.redirect('/dashboard');
});

app.get('/browser/:id', requireAuth, (req, res) => {
    const username = req.session.user.username;
    const user = users.get(username);
    const account = user.accounts.find(a => a.id === req.params.id);
    
    if (!account) return res.redirect('/dashboard');
    
    const proxyUrl = `/proxy?url=${encodeURIComponent(account.url)}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>${account.name} - Axius WRN</title>
            <style>
                body { margin: 0; background: #1a1a2e; }
                .bar { background: #2a2a4e; padding: 10px 20px; display: flex; gap: 10px; align-items: center; }
                .bar a { color: #fff; text-decoration: none; padding: 8px 15px; background: rgba(255,255,255,0.1); border-radius: 5px; }
                .url { flex: 1; padding: 8px 15px; background: rgba(0,0,0,0.3); border-radius: 5px; color: #00d4ff; font-size: 14px; }
                iframe { width: 100%; height: calc(100vh - 50px); border: none; background: #fff; }
                .loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; font-size: 20px; }
            </style>
        </head>
        <body>
            <div class="bar">
                <a href="/dashboard">← Назад</a>
                <div class="url">${account.url}</div>
                <a href="${account.url}" target="_blank">↗️ Открыть напрямую</a>
                <a href="/logs">📋 Логи</a>
            </div>
            <iframe src="${proxyUrl}" onload="document.querySelector('.loading').style.display='none'"></iframe>
            <div class="loading">⏳ Загрузка через прокси...</div>
        </body>
        </html>
    `);
    
    log('Browser opened: ' + account.name);
});

app.get('/', (req, res) => {
    res.redirect('/login');
});

app.listen(PORT, () => {
    log('=== Server running on port ' + PORT + ' ===');
});
