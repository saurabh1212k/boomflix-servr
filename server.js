const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('Boomflix Proxy is Online! (Fast Chunk Mode)'));

app.get('/extract', async (req, res) => {
    const { tmdbId, type, season, episode } = req.query;
    if (!tmdbId) return res.status(400).json({ error: "Missing ID" });

    let targetUrl = `https://www.vidking.net/embed/movie/${tmdbId}`;
    if (type === 'tv') {
        targetUrl = `https://www.vidking.net/embed/tv/${tmdbId}/${season || 1}/${episode || 1}`;
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        let m3u8Url = null;

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = request.url();
            if (url.includes('.m3u8')) m3u8Url = url;
            request.continue();
        });

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 3000));

        for (let i = 0; i < 4; i++) {
            try {
                await page.mouse.click(page.viewport().width / 2, page.viewport().height / 2);
                await new Promise(r => setTimeout(r, 1000));
            } catch(e) {}
        }

        let waitLoops = 0;
        while (!m3u8Url && waitLoops < 10) {
            await new Promise(r => setTimeout(r, 1000));
            waitLoops++;
        }

        await browser.close();

        if (m3u8Url) {
            const proxyUrl = `https://${req.get('host')}/proxy-playlist?url=${encodeURIComponent(m3u8Url)}`;
            res.json({ success: true, streamUrl: proxyUrl });
        } else {
            res.status(404).json({ error: "Could not find video stream." });
        }
    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ error: error.message });
    }
});

// Proxy Playlist
app.get('/proxy-playlist', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No url provided");

    try {
        const response = await axios.get(targetUrl, { headers: { 'Referer': 'https://www.vidking.net/' } });
        const baseURL = new URL(targetUrl);
        let playlist = response.data;
        
        const lines = playlist.split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line.length === 0) continue;
            
            if (line.includes('URI="')) {
                line = line.replace(/URI="([^"]+)"/, (match, uri) => {
                    const absoluteUri = new URL(uri, baseURL.href).href;
                    // Routes nested m3u8 back to this playlist proxy
                    if (absoluteUri.includes('.m3u8')) {
                         return `URI="https://${req.get('host')}/proxy-playlist?url=${encodeURIComponent(absoluteUri)}"`;
                    }
                    return `URI="https://${req.get('host')}/proxy-chunk?url=${encodeURIComponent(absoluteUri)}"`;
                });
            } else if (!line.startsWith('#')) {
                const absoluteUri = new URL(line, baseURL.href).href;
                line = `https://${req.get('host')}/proxy-chunk?url=${encodeURIComponent(absoluteUri)}`;
            }
            lines[i] = line;
        }

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(lines.join('\n'));
    } catch (error) {
        res.status(500).send("Proxy error");
    }
});

// FAST CHUNK PROXY (Uses your Render Bandwidth but loads instantly)
app.get('/proxy-chunk', async (req, res) => {
    try {
        const response = await axios({
            method: 'get',
            url: req.query.url,
            responseType: 'stream',
            headers: { 'Referer': 'https://www.vidking.net/' }
        });
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send("Chunk error");
    }
});

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
