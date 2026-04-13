const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '50mb' }));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

console.log('=== Axius WRN Cache Server Starting ===');
console.log('YANDEX_TOKEN:', YANDEX_TOKEN ? 'SET' : 'NOT SET!');

class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async listFiles(prefix) {
        const url = `https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}&limit=100`;
        const response = await axios.get(url, {
            headers: { 'Authorization': `OAuth ${this.token}` }
        });
        const items = response.data._embedded.items || [];
        return items.filter(f => f.name.startsWith(prefix));
    }

    async fileExists(path) {
        try {
            const url = `https://cloud-api.yandex.net/v1/disk/resources?path=${path}`;
            await axios.get(url, { headers: { 'Authorization': `OAuth ${this.token}` } });
            return true;
        } catch (e) {
            return false;
        }
    }

    async readFile(path) {
        const downloadRes = await axios.get(
            `https://cloud-api.yandex.net/v1/disk/resources/download?path=${path}`,
            { headers: { 'Authorization': `OAuth ${this.token}` } }
        );
        const response = await axios.get(downloadRes.data.href, {
            responseType: 'arraybuffer'
        });
        return Buffer.from(response.data);
    }

    async writeFile(path, data) {
        const uploadRes = await axios.get(
            `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${path}&overwrite=true`,
            { headers: { 'Authorization': `OAuth ${this.token}` } }
        );
        await axios.put(uploadRes.data.href, data, {
            headers: { 'Content-Type': 'application/octet-stream' }
        });
        console.log('[Yandex] Written:', path);
    }

    async deleteFile(path) {
        try {
            await axios.delete(
                `https://cloud-api.yandex.net/v1/disk/resources?path=${path}&permanently=true`,
                { headers: { 'Authorization': `OAuth ${this.token}` } }
            );
            console.log('[Yandex] Deleted:', path);
        } catch (e) {}
    }

    async ensureFolder() {
        try {
            await axios.put(
                `https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}`,
                {},
                { headers: { 'Authorization': `OAuth ${this.token}` } }
            );
        } catch (e) {}
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

function urlToFilename(url) {
    return url
        .replace(/^https?:\/\//, '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .substring(0, 50);
}

async function processTask(taskFile) {
    const taskName = taskFile.name;
    const baseName = taskName.replace('.task', '');
    const taskPath = `${TASK_FOLDER}/${taskName}`;
    const processingPath = `${TASK_FOLDER}/${baseName}.processing`;
    const resultPath = `${TASK_FOLDER}/${baseName}.html`;

    console.log('[Worker] Processing:', baseName);

    try {
        // Создаём .processing
        await disk.writeFile(processingPath, Buffer.from(`Processing started at ${new Date().toISOString()}`));

        // Читаем URL из .task
        const taskData = await disk.readFile(taskPath);
        const url = taskData.toString('utf8').trim();

        console.log('[Worker] Fetching:', url);

        // Выполняем запрос
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        // Сохраняем результат
        await disk.writeFile(resultPath, Buffer.from(response.data));

        // Удаляем .task и .processing
        await disk.deleteFile(taskPath);
        await disk.deleteFile(processingPath);

        console.log('[Worker] Completed:', baseName, 'size:', response.data.length);

    } catch (error) {
        console.error('[Worker] Error:', baseName, error.message);

        // Сохраняем ошибку
        const errorHtml = `<html><body><h1>Error</h1><p>${error.message}</p></body></html>`;
        await disk.writeFile(resultPath, Buffer.from(errorHtml));

        await disk.deleteFile(taskPath);
        await disk.deleteFile(processingPath);
    }
}

async function workerLoop() {
    await disk.ensureFolder();

    while (true) {
        try {
            const files = await disk.listFiles('');
            const taskFiles = files.filter(f => f.name.endsWith('.task'));

            for (const taskFile of taskFiles) {
                const baseName = taskFile.name.replace('.task', '');
                const processingPath = `${TASK_FOLDER}/${baseName}.processing`;
                const resultPath = `${TASK_FOLDER}/${baseName}.html`;

                const hasProcessing = files.some(f => f.name === baseName + '.processing');
                const hasResult = files.some(f => f.name === baseName + '.html');

                if (!hasProcessing && !hasResult) {
                    await processTask(taskFile);
                }
            }

            // Очистка старых .html (старше 5 минут)
            const now = Date.now();
            for (const file of files) {
                if (file.name.endsWith('.html')) {
                    const modified = new Date(file.modified).getTime();
                    if (now - modified > 300000) {
                        await disk.deleteFile(`${TASK_FOLDER}/${file.name}`);
                        console.log('[Cleanup] Deleted old:', file.name);
                    }
                }
            }

        } catch (error) {
            console.error('[Worker] Loop error:', error.message);
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

// Запускаем воркер
workerLoop().catch(console.error);

// API для устройства
app.get('/check/:url', async (req, res) => {
    const url = req.params.url;
    const filename = urlToFilename(url);
    const htmlPath = `${TASK_FOLDER}/${filename}.html`;
    const taskPath = `${TASK_FOLDER}/${filename}.task`;
    const processingPath = `${TASK_FOLDER}/${filename}.processing`;

    const exists = await disk.fileExists(htmlPath);
    const isProcessing = await disk.fileExists(processingPath);
    const hasTask = await disk.fileExists(taskPath);

    res.json({
        exists: exists,
        processing: isProcessing,
        queued: hasTask
    });
});

app.post('/request', express.text(), async (req, res) => {
    const url = req.body.trim();
    const filename = urlToFilename(url);
    const taskPath = `${TASK_FOLDER}/${filename}.task`;

    await disk.ensureFolder();
    await disk.writeFile(taskPath, Buffer.from(url));

    console.log('[API] Task created:', filename);
    res.json({ status: 'queued', filename: filename });
});

app.get('/download/:filename', async (req, res) => {
    const filename = req.params.filename;
    const htmlPath = `${TASK_FOLDER}/${filename}.html`;

    try {
        const data = await disk.readFile(htmlPath);
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(data);
    } catch (error) {
        res.status(404).send('Not found');
    }
});

app.delete('/delete/:filename', async (req, res) => {
    const filename = req.params.filename;
    const htmlPath = `${TASK_FOLDER}/${filename}.html`;

    await disk.deleteFile(htmlPath);
    res.json({ status: 'deleted' });
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN Cache</title>
            <style>
                body { font-family: Arial; padding: 50px; text-align: center; }
                h1 { color: #4CAF50; }
                .status { background: #f5f5f5; padding: 20px; border-radius: 10px; }
            </style>
        </head>
        <body>
            <h1>🚀 Axius WRN Cache Server</h1>
            <div class="status">
                <p>✅ Сервер работает</p>
                <p>📁 Папка: ${TASK_FOLDER}</p>
                <p>🔑 Токен: ${YANDEX_TOKEN ? 'Установлен' : 'НЕ УСТАНОВЛЕН'}</p>
            </div>
        </body>
        </html>
    `);
});

app.listen(PORT, () => {
    console.log(`=== Server running on port ${PORT} ===`);
});
