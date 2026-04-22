const express = require('express');
const axios = require('axios');
const session = require('express-session');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: '*/*', limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Сессии
app.use(session({
    secret: 'axius-wrn-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

// Простая база пользователей (пароли в открытом виде для теста)
const users = new Map();
users.set('admin', { username: 'admin', password: 'admin123', accounts: [] });

const logs = [];
function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 100) logs.shift();
}

log('=== Axius WRN Server ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));

// Middleware авторизации
function requireAuth(req, res, next) {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
}

// ============ СТРАНИЦЫ ============

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
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
                .box { background: rgba(255,255,255,0.1); padding: 40px; border-radius: 20px; width: 350px; }
                h1 { color: #00d4ff; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; color: #fff; }
                button { width: 100%; padding: 15px; background: #00d4ff; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .error { color: #ff4444; text-align: center; }
                .success { color: #00ff88; text-align: center; }
                a { color: #00d4ff; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>🚀 Axius WRN</h1>
                ${req.query.error ? '<div class="error">❌ ' + req.query.error + '</div>' : ''}
                ${req.query.registered ? '<div class="success">✅ Регистрация успешна!</div>' : ''}
                <form method="POST" action="/login">
                    <input type="text" name="username" placeholder="Логин" value="admin" required>
                    <input type="password" name="password" placeholder="Пароль" value="admin123" required>
                    <button type="submit">Войти</button>
                </form>
                <p style="text-align: center; margin-top: 20px;"><a href="/register">Создать аккаунт</a></p>
                <p style="color: rgba(255,255,255,0.5); text-align: center; font-size: 12px;">Тест: admin / admin123</p>
            </div>
        </body>
        </html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.get(username);
    
    if (!user) {
        return res.redirect('/login?error=Пользователь не найден');
    }
    
    if (user.password !== password) {
        return res.redirect('/login?error=Неверный пароль');
    }
    
    req.session.user = { username };
    log('[Auth] Login: ' + username);
    res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Axius WRN - Регистрация</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
                .box { background: rgba(255,255,255,0.1); padding: 40px; border-radius: 20px; width: 350px; }
                h1 { color: #00ff88; text-align: center; }
                input { width: 100%; padding: 15px; margin: 10px 0; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; color: #fff; }
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
                    <input type="password" name="password" placeholder="Пароль (мин. 6 символов)" required>
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
    
    if (!username || !password) {
        return res.redirect('/register?error=Заполните все поля');
    }
    
    if (password !== confirm) {
        return res.redirect('/register?error=Пароли не совпадают');
    }
    
    if (password.length < 6) {
        return res.redirect('/register?error=Пароль должен быть не менее 6 символов');
    }
    
    if (users.has(username)) {
        return res.redirect('/register?error=Пользователь уже существует');
    }
    
    users.set(username, { username, password, accounts: [] });
    log('[Auth] Registered: ' + username);
    res.redirect('/login?registered=1');
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
                <div style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 15px; display: flex; align-items: center; gap: 15px; margin-bottom: 10px;">
                    <div style="width: 50px; height: 50px; background: #00d4ff; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px;">${acc.icon || '🌐'}</div>
                    <div style="flex: 1;">
                        <div style="font-weight: bold;">${acc.name}</div>
                        <div style="font-size: 12px; opacity: 0.7;">${acc.url}</div>
                    </div>
                    <a href="/browser/${acc.id}" style="background: #00d4ff; color: #1a1a2e; padding: 10px 15px; border-radius: 8px; text-decoration: none;">Открыть</a>
                    <a href="/delete-account/${acc.id}" style="color: #ff4444; text-decoration: none;" onclick="return confirm('Удалить?')">🗑️</a>
                </div>
            `;
        });
    } else {
        accountsHtml = '<p style="color: rgba(255,255,255,0.5);">Нет сохранённых аккаунтов</p>';
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
                .add-box input { width: 100%; padding: 15px; margin: 10px 0; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); border-radius: 10px; color: #fff; }
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
                </div>
            </div>
            <div class="container">
                <div class="add-box">
                    <h2>➕ Добавить аккаунт</h2>
                    <form method="POST" action="/add-account">
                        <input type="text" name="name" placeholder="Название (Telegram)" required>
                        <input type="url" name="url" placeholder="URL (https://web.telegram.org/k/)" required>
                        <button type="submit">Добавить</button>
                    </form>
                </div>
                <h2>📱 Мои аккаунты</h2>
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
    
    const icon = url.includes('telegram') ? '📱' : url.includes('instagram') ? '📷' : url.includes('youtube') ? '▶️' : '🌐';
    
    user.accounts.push({ id: Date.now().toString(), name, url, icon });
    log('[Account] Added: ' + name);
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
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>${account.name}</title>
            <style>
                body { margin: 0; background: #1a1a2e; }
                .bar { background: #2a2a4e; padding: 10px 20px; display: flex; gap: 10px; }
                .bar a { color: #fff; text-decoration: none; padding: 8px 15px; background: rgba(255,255,255,0.1); border-radius: 5px; }
                .url { flex: 1; padding: 8px 15px; background: rgba(0,0,0,0.3); border-radius: 5px; color: #00d4ff; }
                iframe { width: 100%; height: calc(100vh - 50px); border: none; background: #fff; }
            </style>
        </head>
        <body>
            <div class="bar">
                <a href="/dashboard">← Назад</a>
                <div class="url">${account.url}</div>
                <a href="${account.url}" target="_blank">↗️</a>
            </div>
            <iframe src="${account.url}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"></iframe>
        </body>
        </html>
    `);
});

app.get('/', (req, res) => {
    res.redirect(req.session.user ? '/dashboard' : '/login');
});

// ============ ЗАПУСК ============
app.listen(PORT, () => {
    log('=== Server running on port ' + PORT + ' ===');
    log('=== Login: admin / admin123 ===');
});
