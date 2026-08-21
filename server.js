const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const axios = require('axios');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => res.send('Boomflix Proxy is Online!'));

// 1. Scraper Route: Find the hidden .m3u8 link
app.get('/extract', async (req, res) => {
    const tmdbId = req.query.tmdbId;
    if (!tmdbId) return res.status(400).json({ error: "Missing tmdbId" });

    // The VidKing embed URL we want to scrape
    const targetUrl = `https://www.vidking.net/embed/movie/${tmdbId}`;
    
    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        let m3u8Url = null;

        // Sniff network traffic for the video playlist
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (request.url().includes('.m3u8')) {
                m3u8Url = request.url();
            }
            request.continue();
        });

        // Go to the embed page and wait for scripts to load
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });
        await browser.close();

        if (m3u8Url) {
            // Rewrite the URL so it goes through our proxy route below
            const proxyUrl = `https://${req.get('host')}/proxy-playlist?url=${encodeURIComponent(m3u8Url)}`;
            res.json({ success: true, streamUrl: proxyUrl });
        } else {
            res.status(404).json({ error: "Could not find video stream." });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Proxy Route: Bypass CORS & spoof the Referer
app.get('/proxy-playlist', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No url provided");

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'Referer': 'https://www.vidking.net/' } // Spoof the origin!
        });
        
        let playlist = response.data;
        // Rewrite chunk links to also route through our proxy if needed
        playlist = playlist.replace(/(https?:\/\/[^\s]+)/g, match => {
            return `https://${req.get('host')}/proxy-chunk?url=${encodeURIComponent(match)}`;
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(playlist);
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

app.listen(PORT, () => console.log(`API running on port ${PORT}`));
