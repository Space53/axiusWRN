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
const YANDEX_TOKEN = process.env.YANDEX_TOKEN || '';
const TASK_FOLDER = 'app:/tasks';

// Логи
const logs = [];
function log(msg) {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 200) logs.shift();
}

// Пользователи
const users = { 'admin': { password: 'admin123', sites: [] } };

// ============ НОВЫЙ PHP БРАУЗЕР (НЕ ЛОМАЕТ СТАРЫЙ КОД) ============
app.get('/php-browser', (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('URL required');
    
    log(`PHP Browser: ${url}`);
    
    const phpCode = `<?php
        $url = '${url}';
        
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 60);
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0');
        
        $html = curl_exec($ch);
        curl_close($ch);
        
        if (!$html) {
            http_response_code(500);
            echo 'Failed to fetch URL';
            exit;
        }
        
        $parsed = parse_url($url);
        $base = $parsed['scheme'] . '://' . $parsed['host'];
        $html = str_replace('<head>', '<head><base href="' . $base . '/">', $html);
        
        echo $html;
    ?>`;
    
    const phpFile = `/tmp/browser_${Date.now()}.php`;
    fs.writeFileSync(phpFile, phpCode);
    
    exec(`php ${phpFile}`, (error, stdout, stderr) => {
        fs.unlinkSync(phpFile);
        
        if (error) {
            log(`PHP Error: ${error.message}`);
            return res.status(500).send(`PHP Error: ${error.message}`);
        }
        
        res.send(stdout);
    });
});

// ============ СТАРЫЙ КОД (НЕ ТРОГАЕМ) ============
app.post('/fetch', (req, res) => {
    const { task_id, target_url } = req.body;
    log(`/fetch: ${task_id}`);
    res.status(202).json({ status: 'queued' });
});

app.get('/result', (req, res) => {
    res.json({ status: 'processing' });
});

app.get('/login', (req, res) => {
    res.send('Login page');
});

app.post('/login', (req, res) => {
    req.session.user = { username: req.body.username };
    res.redirect('/dashboard');
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.send('<h1>Dashboard</h1><a href="/php-test">Тест PHP Браузера</a>');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ============ ТЕСТОВАЯ СТРАНИЦА PHP БРАУЗЕРА ============
app.get('/php-test', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>PHP Браузер Тест</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #fff; padding: 20px; }
                input { width: 80%; padding: 15px; background: #2a2a4e; border: 1px solid #444; border-radius: 10px; color: #fff; }
                button { padding: 15px 30px; background: #00d4ff; border: none; border-radius: 10px; font-weight: bold; cursor: pointer; }
                iframe { width: 100%; height: 80vh; border: none; margin-top: 20px; background: #fff; }
            </style>
        </head>
        <body>
            <h1>🌐 PHP Браузер</h1>
            <form onsubmit="loadUrl(); return false;">
                <input type="url" id="url" placeholder="Введите URL" value="https://web.telegram.org/k/">
                <button type="submit">Открыть</button>
            </form>
            <iframe id="browser"></iframe>
            <script>
                function loadUrl() {
                    const url = document.getElementById('url').value;
                    document.getElementById('browser').src = '/php-browser?url=' + encodeURIComponent(url);
                }
                loadUrl();
            </script>
        </body>
        </html>
    `);
});

app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.redirect('/login');
});

app.listen(PORT, () => {
    log(`Server running on port ${PORT}`);
});
