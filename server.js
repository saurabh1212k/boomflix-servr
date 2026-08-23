const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('Boomflix Proxy is Online! (Optimized for Zero Bandwidth)'));

// 1. Scraper Route (Includes TV Show support and aggressive clicking)
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

        // Use domcontentloaded to prevent timing out on ads
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
        
        // Wait 3 seconds for the page structure to settle
        await new Promise(r => setTimeout(r, 3000));

        // AGGRESSIVE CLICKING: Click the center of the screen 4 times with a delay 
        // to smash through any invisible pop-up ad overlays!
        for (let i = 0; i < 4; i++) {
            try {
                await page.mouse.click(page.viewport().width / 2, page.viewport().height / 2);
                await new Promise(r => setTimeout(r, 1000));
            } catch(e) {}
        }

        // Wait up to 10 extra seconds specifically for the m3u8 request to fire
        let waitLoops = 0;
        while (!m3u8Url && waitLoops < 10) {
            await new Promise(r => setTimeout(r, 1000));
            waitLoops++;
        }

        await browser.close();

        if (m3u8Url) {
            // ONLY proxy the text playlist through our server
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

// 2. Proxy Route - Rewritten to use Public CORS Proxy for heavy video chunks
app.get('/proxy-playlist', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No url provided");

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'Referer': 'https://www.vidking.net/' }
        });
        
        const baseURL = new URL(targetUrl);
        let playlist = response.data;
        
        // Smarter rewriting: handles relative URLs
        const lines = playlist.split('\n');
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line.length === 0) continue;
            
            // Rewrite URI="..." links (often embedded playlists or keys)
            if (line.includes('URI="')) {
                line = line.replace(/URI="([^"]+)"/, (match, uri) => {
                    const absoluteUri = new URL(uri, baseURL.href).href;
                    // If it's a nested .m3u8, keep it on OUR server so we can parse it
                    if (absoluteUri.includes('.m3u8')) {
                        return `URI="https://${req.get('host')}/proxy-playlist?url=${encodeURIComponent(absoluteUri)}"`;
                    }
                    // If it's a key or chunk, send it to the public proxy
                    return `URI="https://corsproxy.io/?url=${encodeURIComponent(absoluteUri)}"`;
                });
            }
            // Rewrite direct video chunk links (.ts files)
            else if (!line.startsWith('#')) {
                const absoluteUri = new URL(line, baseURL.href).href;
                // SEND CHUNKS TO PUBLIC PROXY (Saves 99.9% of your server bandwidth!)
                line = `https://corsproxy.io/?url=${encodeURIComponent(absoluteUri)}`;
            }
            
            lines[i] = line;
        }

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(lines.join('\n'));
    } catch (error) {
        res.status(500).send("Proxy error");
    }
});

// NOTE: The old `/proxy-chunk` route is completely deleted to save bandwidth!

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
