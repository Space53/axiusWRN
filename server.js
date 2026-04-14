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
    if (logs.length > 50) logs.shift();
}

log('=== Axius WRN Server Starting ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));
log('TASK_FOLDER: ' + TASK_FOLDER);

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
            // ВАЖНО: только .task, НЕ _result.task
            const tasks = items.filter(f => f.name.endsWith('.task') && !f.name.includes('_result'));
            log('[Disk] Found ' + tasks.length + ' tasks');
            return tasks;
        } catch (e) {
            log('[Disk] ERROR: ' + e.message);
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

// ============ ЭНДПОИНТЫ ============

app.get('/', (req, res) => {
    let html = '<h1>Axius WRN Server</h1><pre>';
    logs.slice().reverse().forEach(l => html += l + '\n');
    html += '</pre>';
    res.send(html);
});

app.post('/fetch', async (req, res) => {
    const { task_id, target_url } = req.body;
    log('[API] /fetch: ' + task_id);
    
    if (!task_id || !target_url) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    
    res.status(202).json({ status: 'queued', task_id });
});

app.get('/result', async (req, res) => {
    const { task_id } = req.query;
    
    const resultPath = `${TASK_FOLDER}/${task_id}_result.task`;
    const exists = await disk.fileExists(resultPath);
    
    if (exists) {
        res.json({ status: 'done', result_id: task_id + '_result' });
    } else {
        res.json({ status: 'processing' });
    }
});

// ============ ВОРКЕР ============

async function processTask(taskFile) {
    const taskName = taskFile.name;
    const taskPath = `${TASK_FOLDER}/${taskName}`;
    const resultId = taskName.replace('.task', '_result');
    const resultPath = `${TASK_FOLDER}/${resultId}.task`;
    
    log('[Worker] Processing: ' + taskName);
    
    try {
        const taskData = await disk.readFile(taskPath);
        const requestStr = taskData.toString('utf8');
        
        // Извлекаем URL
        let url = '';
        const lines = requestStr.split('\r\n');
        if (lines[0]) {
            const parts = lines[0].split(' ');
            url = parts[1];
        }
        
        let host = '';
        for (const line of lines) {
            if (line.toLowerCase().startsWith('host:')) {
                host = line.substring(5).trim();
                break;
            }
        }
        
        if (!url.startsWith('http')) {
            url = 'https://' + host + url;
        }
        
        log('[Worker] Fetching: ' + url);
        
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        log('[Worker] Response: ' + response.status + ', ' + response.data.length + ' bytes');
        
        // Формируем HTTP-ответ
        let httpResponse = `HTTP/1.1 ${response.status} OK\r\n`;
        httpResponse += `Content-Type: text/html\r\n`;
        httpResponse += `Content-Length: ${response.data.length}\r\n\r\n`;
        
        const header = Buffer.from(httpResponse, 'utf8');
        const body = Buffer.from(response.data);
        const full = Buffer.concat([header, body]);
        
        await disk.writeFile(resultPath, full);
        await disk.deleteFile(taskPath);
        
        log('[Worker] DONE: ' + taskName);
        
    } catch (e) {
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

workerLoop().catch(e => log('[Worker] Fatal: ' + e.message));

app.listen(PORT, () => log('Server on port ' + PORT));
