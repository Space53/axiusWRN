const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '50mb' }));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

const logs = [];
function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 100) logs.shift();
}

log('=== Axius WRN Server Starting ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));
log('TASK_FOLDER: ' + TASK_FOLDER);

// ============================================================
// СТАТИСТИКА СЕРВЕРА
// ============================================================
const stats = {
    startTime: new Date(),
    tasksProcessed: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    totalBytesDownloaded: 0,
    totalResponseTime: 0,
    lastCheck: null,
    lastCheckResult: null,
    checksSucceeded: 0,
    checksFailed: 0,
    selfChecks: []
};

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
            const tasks = items.filter(f => f.name.endsWith('.task') && !f.name.includes('_result'));
            return tasks;
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
        log('[Disk] Written: ' + path.split('/').pop());
    }

    async deleteFile(path) {
        try {
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${path}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            log('[Disk] Deleted: ' + path.split('/').pop());
        } catch (e) {}
    }

    async fileExists(path) {
        try {
            await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${path}`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            return true;
        } catch { return false; }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

// ============================================================
// САМОДИАГНОСТИКА
// ============================================================

const TEST_URLS = [
    'https://httpbin.org/get',
    'https://api.github.com/zen',
    'https://google.com'
];

async function performSelfCheck() {
    const checkId = 'check_' + Date.now();
    const startTime = Date.now();
    
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('🔍 [SELF-CHECK] Starting self-diagnostics...');
    log('   Check ID: ' + checkId);
    
    const results = [];
    let allSuccess = true;
    
    for (const testUrl of TEST_URLS) {
        const testStart = Date.now();
        try {
            log('   Testing: ' + testUrl);
            const response = await axios.get(testUrl, {
                timeout: 15000,
                validateStatus: status => status < 500
            });
            
            const duration = Date.now() - testStart;
            results.push({
                url: testUrl,
                status: response.status,
                duration: duration,
                success: true
            });
            
            log('   ✅ ' + response.status + ' (' + duration + 'ms)');
            
        } catch (error) {
            allSuccess = false;
            const duration = Date.now() - testStart;
            results.push({
                url: testUrl,
                error: error.message,
                duration: duration,
                success: false
            });
            
            log('   ❌ Failed: ' + error.message + ' (' + duration + 'ms)');
        }
    }
    
    // Проверяем доступ к Яндекс.Диску
    try {
        log('   Testing: Yandex.Disk API');
        const testStart = Date.now();
        await disk.listTaskFiles();
        const duration = Date.now() - testStart;
        
        results.push({
            url: 'Yandex.Disk API',
            status: 200,
            duration: duration,
            success: true
        });
        
        log('   ✅ Yandex.Disk API (' + duration + 'ms)');
        
    } catch (error) {
        allSuccess = false;
        results.push({
            url: 'Yandex.Disk API',
            error: error.message,
            success: false
        });
        
        log('   ❌ Yandex.Disk API: ' + error.message);
    }
    
    const totalDuration = Date.now() - startTime;
    
    // Сохраняем результат
    stats.lastCheck = new Date();
    stats.lastCheckResult = {
        id: checkId,
        success: allSuccess,
        totalDuration: totalDuration,
        results: results
    };
    
    if (allSuccess) {
        stats.checksSucceeded++;
        log('✅ [SELF-CHECK] PASSED (' + totalDuration + 'ms)');
    } else {
        stats.checksFailed++;
        log('❌ [SELF-CHECK] FAILED (' + totalDuration + 'ms)');
    }
    
    // Добавляем в историю
    stats.selfChecks.push({
        time: new Date(),
        success: allSuccess,
        duration: totalDuration,
        resultsCount: results.length
    });
    
    if (stats.selfChecks.length > 20) {
        stats.selfChecks.shift();
    }
    
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    return results;
}

// Планировщик самодиагностики
function scheduleSelfCheck() {
    // Случайная задержка от 0 до 3 минут (180000 мс)
    const randomDelay = Math.floor(Math.random() * 180000);
    
    log(`[Scheduler] Next self-check in ${Math.floor(randomDelay / 1000)}s`);
    
    setTimeout(() => {
        performSelfCheck().catch(e => {
            log('[SELF-CHECK] Error: ' + e.message);
        });
        
        // Запускаем следующий цикл (через 5 минут)
        setTimeout(scheduleSelfCheck, 300000);
    }, randomDelay);
}

// ============================================================
// ГЛАВНАЯ СТРАНИЦА С РАСШИРЕННОЙ СТАТИСТИКОЙ
// ============================================================

app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;
    const successRate = stats.tasksProcessed > 0 
        ? ((stats.tasksSucceeded / stats.tasksProcessed) * 100).toFixed(1) 
        : '0';
    const avgResponseTime = stats.tasksSucceeded > 0 
        ? Math.round(stats.totalResponseTime / stats.tasksSucceeded) 
        : 0;
    
    let html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Axius WRN Server</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Arial, sans-serif; 
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            padding: 20px;
            color: #eee;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: #00d4ff; margin-bottom: 20px; }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }
        .stat-card {
            background: rgba(255,255,255,0.1);
            padding: 20px;
            border-radius: 10px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.2);
        }
        .stat-label { font-size: 12px; opacity: 0.7; text-transform: uppercase; }
        .stat-value { font-size: 32px; font-weight: bold; color: #00d4ff; }
        .stat-unit { font-size: 14px; opacity: 0.5; }
        .section {
            background: rgba(255,255,255,0.05);
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 20px;
            border: 1px solid rgba(255,255,255,0.1);
        }
        .section-title {
            font-size: 18px;
            margin-bottom: 15px;
            color: #00d4ff;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .log-entry {
            font-family: 'Consolas', monospace;
            font-size: 12px;
            padding: 5px 0;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            color: #aaa;
        }
        .log-entry:last-child { border-bottom: none; }
        .success { color: #00ff88; }
        .error { color: #ff4444; }
        .check-history {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 10px;
        }
        .check-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #00ff88;
        }
        .check-dot.failed { background: #ff4444; }
        .badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: bold;
        }
        .badge.success { background: #00ff8833; color: #00ff88; }
        .badge.error { background: #ff444433; color: #ff4444; }
        .refresh-btn {
            background: #00d4ff;
            color: #1a1a2e;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-weight: bold;
            margin-left: auto;
        }
        .flex { display: flex; align-items: center; }
    </style>
    <script>
        setTimeout(() => location.reload(), 10000);
    </script>
</head>
<body>
    <div class="container">
        <div class="flex">
            <h1>🚀 Axius WRN Server</h1>
            <button class="refresh-btn" onclick="location.reload()">🔄 Обновить</button>
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-label">Uptime</div>
                <div class="stat-value">${uptimeStr}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Задач обработано</div>
                <div class="stat-value">${stats.tasksProcessed}</div>
                <div class="stat-unit">${stats.tasksSucceeded} успешно, ${stats.tasksFailed} ошибок</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Успешность</div>
                <div class="stat-value">${successRate}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Среднее время ответа</div>
                <div class="stat-value">${avgResponseTime}</div>
                <div class="stat-unit">миллисекунд</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Скачано данных</div>
                <div class="stat-value">${(stats.totalBytesDownloaded / 1024 / 1024).toFixed(2)}</div>
                <div class="stat-unit">МБ</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Самодиагностика</div>
                <div class="stat-value">${stats.checksSucceeded}/${stats.checksSucceeded + stats.checksFailed}</div>
                <div class="stat-unit">успешных проверок</div>
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">
                <span>📊 История самодиагностики</span>
            </div>
            <div class="check-history">
`;

    stats.selfChecks.slice().reverse().forEach(check => {
        const time = new Date(check.time).toLocaleTimeString('ru-RU');
        html += `<span class="check-dot ${check.success ? '' : 'failed'}" title="${time}: ${check.success ? 'Успешно' : 'Ошибка'} (${check.duration}ms)"></span>`;
    });

    html += `
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">
                <span>🔍 Последняя проверка</span>
            </div>
`;

    if (stats.lastCheckResult) {
        const check = stats.lastCheckResult;
        html += `<p>Проведена: ${new Date(stats.lastCheck).toLocaleString('ru-RU')}</p>`;
        html += `<p>Результат: <span class="badge ${check.success ? 'success' : 'error'}">${check.success ? '✅ УСПЕШНО' : '❌ ОШИБКА'}</span> (${check.totalDuration}ms)</p>`;
        html += `<ul style="margin-top: 10px; list-style: none;">`;
        check.results.forEach(r => {
            html += `<li style="padding: 5px 0;">`;
            if (r.success) {
                html += `<span class="success">✅</span> ${r.url} — ${r.status} (${r.duration}ms)`;
            } else {
                html += `<span class="error">❌</span> ${r.url} — ${r.error}`;
            }
            html += `</li>`;
        });
        html += `</ul>`;
    } else {
        html += `<p>Проверка ещё не проводилась</p>`;
    }

    html += `
        </div>
        
        <div class="section">
            <div class="section-title">
                <span>📋 Логи сервера</span>
                <span style="font-size: 12px; opacity: 0.5;">(последние 50)</span>
            </div>
`;

    logs.slice().reverse().forEach(l => {
        const isError = l.includes('ERROR') || l.includes('❌') || l.includes('Failed');
        const isSuccess = l.includes('✅') || l.includes('DONE') || l.includes('PASSED');
        let logClass = '';
        if (isError) logClass = 'error';
        else if (isSuccess) logClass = 'success';
        
        html += `<div class="log-entry ${logClass}">${escapeHtml(l)}</div>`;
    });

    html += `
        </div>
    </div>
</body>
</html>`;
    
    res.send(html);
});

function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ============================================================
// ОБРАБОТКА ЗАДАЧ
// ============================================================

async function processTask(taskFile) {
    const taskName = taskFile.name;
    const taskPath = `${TASK_FOLDER}/${taskName}`;
    const resultId = taskName.replace('.task', '_result');
    const resultPath = `${TASK_FOLDER}/${resultId}.task`;
    
    stats.tasksProcessed++;
    const startTime = Date.now();
    
    log('[Worker] Processing: ' + taskName);
    
    try {
        const taskData = await disk.readFile(taskPath);
        const requestStr = taskData.toString('utf8');
        
        let url = '';
        const lines = requestStr.split('\r\n');
        if (lines[0]) {
            const parts = lines[0].split(' ');
            url = parts[1];
        }
        
        log('[Worker] Fetching: ' + url);
        
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        const duration = Date.now() - startTime;
        stats.tasksSucceeded++;
        stats.totalBytesDownloaded += response.data.length;
        stats.totalResponseTime += duration;
        
        log(`[Worker] Response: ${response.status}, ${response.data.length} bytes, ${duration}ms`);
        
        let httpResponse = `HTTP/1.1 ${response.status} OK\r\n`;
        
        // Определяем Content-Type
        const contentType = response.headers['content-type'] || 'text/html';
        httpResponse += `Content-Type: ${contentType}\r\n`;
        httpResponse += `Content-Length: ${response.data.length}\r\n\r\n`;
        
        const header = Buffer.from(httpResponse, 'utf8');
        const body = Buffer.from(response.data);
        const full = Buffer.concat([header, body]);
        
        await disk.writeFile(resultPath, full);
        await disk.deleteFile(taskPath);
        
        log('[Worker] DONE: ' + taskName);
        
    } catch (e) {
        stats.tasksFailed++;
        log('[Worker] ERROR: ' + e.message);
        
        const errorResponse = `HTTP/1.1 500 Error\r\nContent-Type: text/html\r\n\r\n<h1>Error</h1><p>${e.message}</p>`;
        await disk.writeFile(resultPath, Buffer.from(errorResponse));
        await disk.deleteFile(taskPath);
    }
}

async function workerLoop() {
    log('[Worker] Started');
    
    while (true) {
        try {
            const tasks = await disk.listTaskFiles();
            
            for (const task of tasks) {
                await processTask(task);
            }
        } catch (e) {
            log('[Worker] Loop error: ' + e.message);
        }
        
        await new Promise(r => setTimeout(r, 3000));
    }
}

// ============================================================
// ЗАПУСК ВСЕГО
// ============================================================

workerLoop().catch(e => log('[Worker] Fatal: ' + e.message));

// Запускаем самодиагностику через 10 секунд после старта
setTimeout(() => {
    scheduleSelfCheck();
    log('[Scheduler] Self-check system initialized');
}, 10000);

app.listen(PORT, () => log('Server on port ' + PORT));
