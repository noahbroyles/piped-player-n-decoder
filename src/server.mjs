// piped-player-n-decoder: deciphers YouTube streaming URLs for the Piped backend.
//
// YouTube's streaming URLs carry an obfuscated `n` parameter that only YouTube's own
// player JavaScript can turn into the right value, and googlevideo rejects SABR
// requests without it. Running that JavaScript needs a JS engine, so this little
// service does it with youtubei.js and the backend asks it over HTTP.
//
//   GET  /sts       -> { signatureTimestamp }  (put this in the player request)
//   POST /decipher  { url, signatureTimestamp? } -> { url }
//   GET  /healthz   -> ok

import http from 'node:http';
import vm from 'node:vm';
import { Innertube, Platform } from 'youtubei.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

// YouTube ships a new player every so often, so grab a fresh one hourly
const REFRESH_MS = Number(process.env.PLAYER_REFRESH_MINUTES || 60) * 60_000;

// Keep a few older players around for URLs fetched just before a refresh
const KEEP_PLAYERS = 3;

// A URL is a few KB at most; anything bigger is not a request we want
const MAX_BODY_BYTES = 64 * 1024;

// Only YouTube's own streaming hosts are worth deciphering
const ALLOWED_HOST = /(^|\.)(googlevideo\.com|youtube\.com)$/;

// youtubei.js pastes n into the source of the script it runs, so it must never contain anything
// that could close the string literal. Real values are short base64url strings.
const VALID_N = /^[A-Za-z0-9_-]{1,128}$/;

function isAllowedUrl(url) {
    return url.protocol === 'https:' && ALLOWED_HOST.test(url.hostname);
}

// youtubei.js leaves running the player script to us. It is code from YouTube, so it runs
// in an empty context: no require, no process, no fetch, nothing from this process.
// (node:vm is not a hard security boundary, but it keeps the script away from Node's APIs;
// the Docker image also runs as an unprivileged user with nothing to steal.)
Platform.shim.eval = async (data) => {
    const context = vm.createContext(Object.create(null));
    return vm.runInContext(`(function () {\n${data.output}\n})()`, context, { timeout: 5000 });
};

/** @type {Map<number, Innertube>} players by signature timestamp, oldest first */
const players = new Map();
let current = null; // { sts, createdAt }
let loading = null; // Promise of the player being fetched right now, so requests share it

async function loadPlayer() {
    const yt = await Innertube.create({ retrieve_player: true, generate_session_locally: true });
    const sts = yt.session.player?.signature_timestamp;
    if (!sts) throw new Error('Could not load the YouTube player');

    players.delete(sts); // re-insert so it counts as the newest
    players.set(sts, yt);
    while (players.size > KEEP_PLAYERS) players.delete(players.keys().next().value);

    current = { sts, createdAt: Date.now() };
    console.log(`Loaded player ${yt.session.player.player_id} (sts ${sts})`);
    return sts;
}

/** Returns the signature timestamp of the current player, fetching a new one when it's stale. */
async function currentSts() {
    if (current && Date.now() - current.createdAt < REFRESH_MS) return current.sts;
    if (!loading) {
        loading = loadPlayer().finally(() => (loading = null));
    }
    try {
        return await loading;
    } catch (e) {
        // A stale player beats no player at all
        if (current) {
            console.error('Player refresh failed, keeping the old one:', e.message);
            return current.sts;
        }
        throw e;
    }
}

async function decipher(url, sts) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new HttpError(400, 'Invalid URL');
    }
    if (!isAllowedUrl(parsed)) {
        throw new HttpError(400, 'Not a YouTube streaming URL');
    }

    // youtubei.js would decipher a nested url= parameter instead of the URL itself, skipping the
    // host check above. Streaming URLs never have one.
    if (parsed.searchParams.has('url')) {
        throw new HttpError(400, 'Nested URLs are not accepted');
    }

    const n = parsed.searchParams.get('n');
    if (n !== null && !VALID_N.test(n)) {
        throw new HttpError(400, 'Invalid n parameter');
    }

    // Use the player the URL was requested with, if we still have it
    const yt = players.get(Number(sts)) || players.get(await currentSts());
    const deciphered = yt.session.player.decipher(url);

    // Belt and braces: never hand back a URL for a host we wouldn't have accepted
    if (!isAllowedUrl(new URL(await deciphered))) {
        throw new HttpError(500, 'Deciphering produced an unexpected URL');
    }
    return deciphered;
}

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large');
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new HttpError(400, 'Invalid JSON');
    }
}

function send(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
    try {
        const path = new URL(req.url, 'http://localhost').pathname;

        if (req.method === 'GET' && path === '/healthz') {
            return send(res, 200, { ok: true });
        }

        if (req.method === 'GET' && path === '/sts') {
            return send(res, 200, { signatureTimestamp: await currentSts() });
        }

        if (req.method === 'POST' && path === '/decipher') {
            const { url, signatureTimestamp } = await readJson(req);
            if (typeof url !== 'string') throw new HttpError(400, 'Missing url');
            return send(res, 200, { url: await decipher(url, signatureTimestamp) });
        }

        send(res, 404, { error: 'Not found' });
    } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        if (status === 500) console.error(e);
        send(res, status, { error: e.message });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`piped-player-n-decoder listening on ${HOST}:${PORT}`);
    // Warm up, so the first real request doesn't wait for the player download
    currentSts().catch((e) => console.error('Initial player load failed:', e.message));
});

// Docker sends SIGTERM on stop; don't make it wait 10 seconds for a SIGKILL
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
