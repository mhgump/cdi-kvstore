'use strict';

// ── Infrastructure constants (injected by CDI framework via environment) ──────

const PORT          = Number(process.env.PORT)          || 8080;
const CLUSTER_NAME  = process.env.CLUSTER_NAME          || 'local';
const INSTANCE_ID   = process.env.INSTANCE_ID           || require('os').hostname();

const POSTGRES_HOST     = process.env.POSTGRES_HOST     || null;
const POSTGRES_USER     = process.env.POSTGRES_USER     || 'postgres';
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || '';
const POSTGRES_DB       = process.env.POSTGRES_DB       || 'postgres';
const POSTGRES_SCHEMA   = process.env.POSTGRES_SCHEMA   || 'public';

const REDIS_HOST   = process.env.REDIS_HOST   || '127.0.0.1';
const REDIS_PORT   = Number(process.env.REDIS_PORT) || 6379;
const REDIS_PREFIX = process.env.REDIS_PREFIX || '';

// Derived constants
const KV_TABLE   = `"${POSTGRES_SCHEMA}"."kv_store"`;
const redisKey   = (k) => `${REDIS_PREFIX}kv:${k}`;
const REDIS_CHAN  = `${REDIS_PREFIX}broadcast`;

// ── Imports ───────────────────────────────────────────────────────────────────

const http    = require('http');
const path    = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Pool }  = require('pg');
const Redis     = require('ioredis');

// ── PostgreSQL ────────────────────────────────────────────────────────────────

let pgPool = null;

async function pgInit() {
  if (!POSTGRES_HOST) {
    console.warn('[pg] POSTGRES_HOST not set — running without Postgres persistence');
    return;
  }
  pgPool = new Pool({
    host:     POSTGRES_HOST,
    user:     POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DB,
    ssl:      { rejectUnauthorized: false },
    max:      10,
  });
  await pgPool.query(`CREATE SCHEMA IF NOT EXISTS "${POSTGRES_SCHEMA}"`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS ${KV_TABLE} (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log(`[pg] Ready — schema: ${POSTGRES_SCHEMA}, table: kv_store`);
}

async function pgGetAll() {
  if (!pgPool) return [];
  const { rows } = await pgPool.query(
    `SELECT key, value FROM ${KV_TABLE} ORDER BY key`
  );
  return rows;
}

async function pgSet(key, value) {
  if (!pgPool) return;
  await pgPool.query(
    `INSERT INTO ${KV_TABLE} (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

async function pgDelete(key) {
  if (!pgPool) return;
  await pgPool.query(`DELETE FROM ${KV_TABLE} WHERE key = $1`, [key]);
}

// ── Redis ─────────────────────────────────────────────────────────────────────

const redisPub = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
const redisSub = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
let redisReady = false;

const wsClients = new Set();

function broadcastLocal(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(raw);
  }
}

async function redisInit() {
  await Promise.race([
    new Promise(resolve => redisPub.once('ready', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);

  if (redisPub.status === 'ready') {
    redisReady = true;
    await redisSub.subscribe(REDIS_CHAN);
    redisSub.on('message', (_ch, raw) => {
      try { broadcastLocal(JSON.parse(raw)); } catch {}
    });
    console.log(`[redis] Ready — prefix: "${REDIS_PREFIX}", channel: ${REDIS_CHAN}`);
  } else {
    console.warn('[redis] Not available — falling back to local-only broadcast');
    redisPub.disconnect();
    redisSub.disconnect();
  }
}

async function publish(msg) {
  const raw = JSON.stringify(msg);
  if (redisReady) {
    await redisPub.publish(REDIS_CHAN, raw);
  } else {
    broadcastLocal(msg);
  }
}

async function rCacheSet(key, value) {
  if (redisReady) await redisPub.set(redisKey(key), value);
}

async function rCacheDel(key) {
  if (redisReady) await redisPub.del(redisKey(key));
}

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) =>
  res.json({ ok: true, instance: INSTANCE_ID, cluster: CLUSTER_NAME })
);

// ── WebSocket ─────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', async (ws) => {
  wsClients.add(ws);
  console.log(`[ws] connect (clients: ${wsClients.size})`);

  try {
    const entries = await pgGetAll();
    ws.send(JSON.stringify({ type: 'init', instanceId: INSTANCE_ID, entries }));
  } catch (e) {
    console.error('[ws] init error:', e.message);
    ws.send(JSON.stringify({ type: 'init', instanceId: INSTANCE_ID, entries: [] }));
  }

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const key = String(msg.key || '').trim();
    if (!key) return;

    try {
      if (msg.type === 'set') {
        const value = String(msg.value ?? '');
        await pgSet(key, value);
        await rCacheSet(key, value);
        await publish({ type: 'set', key, value });
      } else if (msg.type === 'delete') {
        await pgDelete(key);
        await rCacheDel(key);
        await publish({ type: 'delete', key });
      }
    } catch (e) {
      console.error(`[ws] handler error (${msg.type} "${key}"):`, e.message);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[ws] disconnect (clients: ${wsClients.size})`);
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  await pgInit();
  await redisInit();
  server.listen(PORT, () =>
    console.log(`[server] :${PORT}  instance=${INSTANCE_ID}  cluster=${CLUSTER_NAME}`)
  );
})();
