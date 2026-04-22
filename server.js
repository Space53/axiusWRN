const express = require('express');
const session = require('express-session');
const { exec } = require('child_process');
const fs = require('fs');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'axius-secret',
    resave: false,
    saveUninitialized: false
}));

const PORT = process.env.PORT || 3000;

// Пользователи
const users = new Map();
users.set('admin', { username: 'admin', password: 'admin123', sites: [] });

// Логи
const logs = [];
function log(msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
}

log('Server started with PHP browser');

// ============ ЗАПУСК PHP-СКРИПТА ИЗ NODE.JS ============
function phpBrowser(url, method = 'GET', postData = null) {
    return new Promise((resolve, reject) => {
        const phpScript = `
            <?php
            session_start();
            
            $url = '${url}';
            $method = '${method}';
            
            $ch = curl_init();
            curl_setopt($ch, CURLOPT_URL, $url);
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
            curl_setopt($ch, CURLOPT_TIMEOUT, 60);
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0');
            
            if ($method === 'POST') {
                curl_setopt($ch, CURLOPT_POST, true);
                curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($_POST));
            }
            
            $html = curl_exec($ch);
            curl_close($ch);
            
            // Внедряем base
            $parsed = parse_url($url);
            $base = $parsed['scheme'] . '://' . $parsed['host'];
            $html = str_replace('<head>', '<head><base href="' . $base . '/">', $html);
            
            echo $html;
            ?>
        `;
        
        fs.writeFileSync('/tmp/browser.php', phpScript);
        
        exec('php /tmp/browser.php', (error, stdout, stderr) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

// ============ ЭНДПОИНТ ДЛЯ PHP-БРАУЗЕРА ============
app.get('/browser', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    
    log('PHP Browser: ' + url);
    
    try {
        const html = await phpBrowser(url);
        res.send(html);
    } catch (e) {
        log('Error: ' + e.message);
        res.status(500).send(e.message);
    }
});

app.post('/browser', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    
    log('PHP Browser POST: ' + url);
    
    try {
        const html = await phpBrowser(url, 'POST', req.body);
        res.send(html);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// ============ СТАРЫЙ API (ДЛЯ ANDROID) ============
app.post('/fetch', (req, res) => {
    const { task_id, target_url } = req.body;
    log('/fetch: ' + task_id);
    res.status(202).json({ status: 'queued' });
});

app.get('/result', (req, res) => {
    res.json({ status: 'done', result_id: 'test' });
});

// ============ СТРАНИЦЫ ============
app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
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
    const user = users.get(username);
    
    if (user && user.password === password) {
        req.session.user = { username };
        log('Login: ' + username);
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
            <style>
                body { font-family: Arial; background: #1a1a2e; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
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
    
    if (users.has(username)) {
        return res.redirect('/register?error=Пользователь уже существует');
    }
    
    users.set(username, { username, password, sites: [] });
    req.session.user = { username };
    log('Register: ' + username);
    res.redirect('/dashboard');
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const username = req.session.user.username;
    const user = users.get(username);
    
    let sitesHtml = '';
    user.sites.forEach(site => {
        sitesHtml += `
            <div style="background:#2a2a4e;padding:15px;border-radius:15px;display:flex;align-items:center;gap:15px;margin-bottom:10px;">
                <div style="width:40px;height:40px;background:#00d4ff;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;">${site.icon}</div>
                <div style="flex:1;">
                    <div style="font-weight:bold;">${site.name}</div>
                    <div style="font-size:12px;opacity:0.7;">${site.url}</div>
                </div>
                <a href="/view/${site.id}" style="background:#00d4ff;color:#1a1a2e;padding:8px 12px;border-radius:8px;text-decoration:none;">Открыть</a>
                <a href="/delete/${site.id}" style="color:#ff4444;text-decoration:none;" onclick="return confirm('Удалить?')">🗑️</a>
            </div>
        `;
    });
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; margin: 0; }
                .header { background: #00d4ff; padding: 15px; display: flex; justify-content: space-between; }
                .header h1 { color: #1a1a2e; margin: 0; }
                .container { max-width: 800px; margin: 20px auto; padding: 15px; }
                .add-box { background: #2a2a4e; padding: 20px; border-radius: 15px; margin-bottom: 20px; }
                .add-box input { width: 100%; padding: 12px; margin: 8px 0; background: #1a1a2e; border: 1px solid #444; border-radius: 10px; color: #fff; }
                .add-box button { width: 100%; padding: 12px; background: #00ff88; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                .logout { background: rgba(0,0,0,0.2); color: #1a1a2e; padding: 8px 15px; border-radius: 5px; text-decoration: none; }
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

app.post('/add', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const { name, url } = req.body;
    const user = users.get(req.session.user.username);
    const icon = url.includes('telegram') ? '📱' : '🌐';
    
    user.sites.push({ id: Date.now().toString(), name, url, icon });
    res.redirect('/dashboard');
});

app.get('/view/:id', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const user = users.get(req.session.user.username);
    const site = user.sites.find(s => s.id === req.params.id);
    
    if (!site) return res.redirect('/dashboard');
    
    const proxyUrl = `/browser?url=${encodeURIComponent(site.url)}`;
    
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body { margin: 0; background: #1a1a2e; }
                .bar { background: #2a2a4e; padding: 10px 15px; display: flex; gap: 10px; }
                .bar a { color: #fff; text-decoration: none; padding: 8px 12px; background: #3a3a5e; border-radius: 5px; }
                .url { flex: 1; padding: 8px 12px; background: #1a1a2e; border-radius: 5px; color: #00d4ff; }
                iframe { width: 100%; height: calc(100vh - 50px); border: none; }
            </style>
        </head>
        <body>
            <div class="bar">
                <a href="/dashboard">← Назад</a>
                <div class="url">${site.url}</div>
            </div>
            <iframe src="${proxyUrl}" sandbox="allow-same-origin allow-scripts allow-forms allow-popups"></iframe>
        </body>
        </html>
    `);
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/logs', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{font-family:monospace;background:#1a1a2e;color:#0f0;padding:20px;}</style></head><body><h1>📋 Логи</h1><a href="/dashboard">← Назад</a><pre>';
    logs.slice().reverse().forEach(l => html += l + '\n');
    html += '</pre></body></html>';
    
    res.send(html);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Login: admin / admin123`);
});
