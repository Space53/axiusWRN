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

log('=== Axius WRN Server ===');
log('TOKEN: ' + (YANDEX_TOKEN ? 'SET' : 'NOT SET'));

const stats = {
    startTime: new Date(),
    tasksProcessed: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    totalBytesDownloaded: 0,
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
        log('[Disk] Written: ' + path.split('/').pop());
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

async function processTask(taskFile) {
    const taskName = taskFile.name;
    const taskPath = `${TASK_FOLDER}/${taskName}`;
    const resultId = taskName.replace('.task', '_result');
    const resultPath = `${TASK_FOLDER}/${resultId}.task`;
    
    stats.tasksProcessed++;
    
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
        
        stats.tasksSucceeded++;
        stats.totalBytesDownloaded += response.data.length;
        
        const httpResponse = `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${response.data.length}\r\n\r\n`;
        const header = Buffer.from(httpResponse);
        const full = Buffer.concat([header, response.data]);
        
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
    while (true) {
        try {
            const tasks = await disk.listTaskFiles();
            for (const task of tasks) {
                await processTask(task);
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 3000));
    }
}

workerLoop();

app.get('/', (req, res) => {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    res.send(`
        <html><head><title>Axius WRN</title></head>
        <body style="font-family: Arial; padding: 20px;">
            <h1>🚀 Axius WRN Server</h1>
            <p>Uptime: ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m</p>
            <p>Tasks: ${stats.tasksSucceeded}/${stats.tasksProcessed} success</p>
            <p>Downloaded: ${(stats.totalBytesDownloaded/1024/1024).toFixed(2)} MB</p>
        </body></html>
    `);
});

app.listen(PORT, () => log('Server on port ' + PORT));
