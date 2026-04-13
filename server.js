const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/plain', limit: '10mb' }));

const YANDEX_TOKEN = process.env.YANDEX_TOKEN;
const TASK_FOLDER = 'app:/tasks';
const PORT = process.env.PORT || 3000;

console.log('=== Axius WRN Cache Server Starting ===');
console.log('YANDEX_TOKEN:', YANDEX_TOKEN ? 'SET' : 'NOT SET!');

class YandexDisk {
    constructor(token) {
        this.token = token;
    }

    async fileExists(path) {
        try {
            const url = `https://cloud-api.yandex.net/v1/disk/resources?path=${path}`;
            await axios.get(url, { 
                headers: { 'Authorization': `OAuth ${this.token}` },
                timeout: 5000
            });
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

    async listTaskFiles() {
        try {
            const url = `https://cloud-api.yandex.net/v1/disk/resources?path=${TASK_FOLDER}&limit=100`;
            const response = await axios.get(url, {
                headers: { 'Authorization': `OAuth ${this.token}` }
            });
            const items = response.data._embedded?.items || [];
            return items.filter(f => f.name.endsWith('.task'));
        } catch (e) {
            return [];
        }
    }
}

const disk = new YandexDisk(YANDEX_TOKEN);

function urlToFilename(url) {
    return url
        .replace(/^https?:\/\//, '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .substring(0, 50);
}

// Главная страница
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Axius WRN</title>
            <style>
                body { font-family: Arial; padding: 50px; text-align: center; background: #f5f5f5; }
                h1 { color: #4CAF50; }
                .status { background: white; padding: 20px; border-radius: 10px; max-width: 400px; margin: 20px auto; }
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

// Проверить наличие кэша
app.get('/check/:url', async (req, res) => {
    try {
        const url = decodeURIComponent(req.params.url);
        const filename = urlToFilename(url);
        const htmlPath = `${TASK_FOLDER}/${filename}.html`;
        const taskPath = `${TASK_FOLDER}/${filename}.task`;
        const processingPath = `${TASK_FOLDER}/${filename}.processing`;

        const exists = await disk.fileExists(htmlPath);
        const processing = await disk.fileExists(processingPath);
        const queued = await disk.fileExists(taskPath);

        res.json({ exists, processing, queued });
    } catch (e) {
        res.json({ exists: false, processing: false, queued: false, error: e.message });
    }
});

// Создать задачу
app.post('/request', async (req, res) => {
    try {
        const url = req.body.trim();
        if (!url.startsWith('http')) {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const filename = urlToFilename(url);
        const taskPath = `${TASK_FOLDER}/${filename}.task`;

        await disk.writeFile(taskPath, Buffer.from(url));
        console.log('[API] Task created:', filename);

        res.json({ status: 'queued', filename: filename });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Скачать результат
app.get('/download/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const htmlPath = `${TASK_FOLDER}/${filename}`;

        const data = await disk.readFile(htmlPath);
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(data);
    } catch (e) {
        res.status(404).send('Not found');
    }
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`=== Server running on port ${PORT} ===`);
});

// Воркер для обработки задач (запускается каждые 3 секунды)
async function processTasks() {
    try {
        const taskFiles = await disk.listTaskFiles();
        
        for (const taskFile of taskFiles) {
            const taskName = taskFile.name;
            const baseName = taskName.replace('.task', '');
            const taskPath = `${TASK_FOLDER}/${taskName}`;
            const processingPath = `${TASK_FOLDER}/${baseName}.processing`;
            const resultPath = `${TASK_FOLDER}/${baseName}.html`;

            // Пропускаем если уже обрабатывается
            const isProcessing = await disk.fileExists(processingPath);
            if (isProcessing) continue;

            console.log('[Worker] Processing:', baseName);

            try {
                // Читаем URL
                const taskData = await disk.readFile(taskPath);
                const url = taskData.toString('utf8').trim();

                if (!url.startsWith('http')) {
                    throw new Error('Invalid URL: ' + url);
                }

                // Создаём .processing
                await disk.writeFile(processingPath, Buffer.from('processing'));

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

                // Удаляем .task и .processing
                await disk.deleteFile(taskPath);
                await disk.deleteFile(processingPath);
            }
        }
    } catch (error) {
        console.error('[Worker] Loop error:', error.message);
    }
}

// Запускаем воркер каждые 3 секунды
setInterval(processTasks, 3000);
processTasks(); // Первый запуск сразу

console.log('=== Worker started ===');
