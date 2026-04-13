const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

console.log('=== Axius WRN Server ===');
console.log('TOKEN:', YANDEX_TOKEN ? 'SET' : 'NOT SET');

class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async fileExists(path) {
        try {
            await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${path}`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            return true;
        } catch { return false; }
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
        console.log('[Disk] Written:', path);
    }

    async deleteFile(path) {
        try {
            await axios.delete(`https://cloud-api.yandex.net/v1/disk/resources?path=${path}&permanently=true`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
        } catch {}
    }

    async listTaskFiles() {
        try {
            const res = await axios.get(`https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}`, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            return (res.data._embedded?.items || []).filter(f => f.name.endsWith('.task'));
        } catch { return []; }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

function urlToFilename(url) {
    return url.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
}

// Главная
app.get('/', (req, res) => res.send('Axius WRN OK'));

// Проверить кэш
app.get('/check/:filename', async (req, res) => {
    const filename = req.params.filename;
    const exists = await disk.fileExists(`${TASK_FOLDER}/${filename}`);
    res.json({ exists });
});

// Создать задачу
app.post('/request', async (req, res) => {
    const url = req.body.trim();
    const filename = urlToFilename(url) + '.task';
    
    console.log('[Request]', url, '->', filename);
    await disk.writeFile(`${TASK_FOLDER}/${filename}`, Buffer.from(url));
    res.json({ status: 'queued', filename });
});

// Скачать результат
app.get('/download/:filename', async (req, res) => {
    const data = await disk.readFile(`${TASK_FOLDER}/${req.params.filename}`);
    res.set('Content-Type', 'text/html').send(data);
});

// Воркер
async function worker() {
    const tasks = await disk.listTaskFiles();
    for (const t of tasks) {
        const name = t.name;
        const htmlName = name.replace('.task', '.html');
        const taskPath = `${TASK_FOLDER}/${name}`;
        const htmlPath = `${TASK_FOLDER}/${htmlName}`;
        
        if (await disk.fileExists(htmlPath)) {
            await disk.deleteFile(taskPath);
            continue;
        }
        
        try {
            const url = (await disk.readFile(taskPath)).toString().trim();
            console.log('[Worker] Fetching:', url);
            
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 30000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            
            await disk.writeFile(htmlPath, Buffer.from(res.data));
            await disk.deleteFile(taskPath);
            console.log('[Worker] Done:', htmlName);
        } catch (e) {
            console.error('[Worker] Error:', e.message);
            await disk.writeFile(htmlPath, Buffer.from(`<h1>Error</h1><p>${e.message}</p>`));
            await disk.deleteFile(taskPath);
        }
    }
}

setInterval(worker, 3000);
worker();

app.listen(PORT, () => console.log('Server on', PORT));
