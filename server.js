const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('Boomflix Proxy is Online!'));

// ==========================================
// 1. HELPER: STREAMWISH DECODER
// ==========================================
function unpack(packed) {
    const regex = /eval\(function\(p,a,c,k,e,d\).*?return p\}\('(.*?)', *(\d+), *(\d+), *'(.*?)'\.split\('\|'\).*?\)\)/;
    const match = packed.match(regex);
    if (!match) return null;
    let p = match[1];
    let a = parseInt(match[2]);
    let c = parseInt(match[3]);
    let k = match[4].split('|');
    const e = function(c) {
        return (c < a ? '' : e(parseInt(c / a))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
    };
    while (c--) { if (k[c]) { p = p.replace(new RegExp('\\b' + e(c) + '\\b', 'g'), k[c]); } }
    return p;
}


// ==========================================
// 2. EXISTING ROUTE: VIDKING EXTRACTOR
// ==========================================
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
            if (url.includes('.m3u8')) {
                m3u8Url = url;
            }
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
            res.status(404).json({ error: "Could not find video stream. Blocked by ads or captcha." });
        }
    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ error: error.message });
    }
});


// ==========================================
// 3. NEW ROUTE: 2EMBED / STREAMWISH EXTRACTOR
// ==========================================
app.get('/extract-2embed', async (req, res) => {
    const { tmdbId, type = 'movie', season = 1, episode = 1 } = req.query;
    if (!tmdbId) return res.status(400).json({ success: false, error: 'tmdbId is required' });

    try {
        const embedUrl = type === 'tv' 
            ? `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}` 
            : `https://www.2embed.cc/embed/${tmdbId}`;
            
        const { data: embedHtml } = await axios.get(embedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const swishMatch = embedHtml.match(/swish\?id=([a-zA-Z0-9]+)/);
        if (!swishMatch) return res.status(404).json({ success: false, error: 'StreamWish source not found' });
        
        const lockerUrl = `https://2vcdn.skin/e/${swishMatch[1]}`;
        const { data: lockerHtml } = await axios.get(lockerUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': embedUrl }
        });

        const unpackedCode = unpack(lockerHtml);
        if (!unpackedCode) return res.status(500).json({ success: false, error: 'Failed to unpack script' });

        const fileMatch = unpackedCode.match(/["'](https?:\/\/[^"']+\.m3u8(?:[^"']+)?)["']/);
        if (!fileMatch) return res.status(500).json({ success: false, error: 'Could not find .m3u8' });

        return res.json({
            success: true,
            streamUrl: fileMatch[1],
            source: 'streamwish',
            provider: '2embed'
        });

    } catch (err) {
        return res.status(500).json({ success: false, error: 'Scraping failed: ' + err.message });
    }
});


// ==========================================
// 4. EXISTING ROUTE: PROXY ENDPOINTS
// ==========================================
app.get('/proxy-playlist', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No url provided");

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'Referer': 'https://www.vidking.net/' }
        });
        
        const baseURL = new URL(targetUrl);
        let playlist = response.data;
        
        const lines = playlist.split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line.length === 0) continue;
            
            if (line.includes('URI="')) {
                line = line.replace(/URI="([^"]+)"/, (match, uri) => {
                    const absoluteUri = new URL(uri, baseURL.href).href;
                    return `URI="https://${req.get('host')}/proxy-chunk?url=${encodeURIComponent(absoluteUri)}"`;
                });
            }
            else if (!line.startsWith('#')) {
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

// START SERVER
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
