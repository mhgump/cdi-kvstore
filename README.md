# Key/Value Store

A lightweight web app providing a global key/value store persisted in Postgres and cached in Redis, with real-time sync across all running instances via WebSocket + Redis pub/sub.

## Stack

- **Node.js 20** — Express HTTP server + `ws` WebSocket server
- **PostgreSQL** — persistent storage (`kv_store` table, auto-created on startup)
- **Redis** — write-through cache and pub/sub broadcast channel
- **Docker** — single-image deployment, port 8080

Both Postgres and Redis are optional. The app starts and runs without them; see [Graceful degradation](#graceful-degradation) below.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket listen port |
| `INSTANCE_ID` | hostname | Identifier shown in the UI header |
| `CLUSTER_NAME` | `local` | Logical cluster name (returned by `/health`) |
| `POSTGRES_HOST` | *(none)* | Postgres host — omit to disable persistence |
| `POSTGRES_USER` | `postgres` | Postgres user |
| `POSTGRES_PASSWORD` | *(empty)* | Postgres password |
| `POSTGRES_DB` | `postgres` | Postgres database name |
| `POSTGRES_SCHEMA` | `public` | Schema to create `kv_store` table in |
| `REDIS_HOST` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PREFIX` | *(empty)* | Key/channel prefix (e.g. `cluster:kvstore:`) |

---

## Local Development

### No external dependencies

```bash
cd cdi-kvstore
npm install
PORT=3000 node server.js
```

Open `http://localhost:3000`. Data is in-memory only (lost on restart). Changes are broadcast only to tabs connected to the same process.

### With Postgres and Redis

```bash
docker run -d -p 6379:6379 redis:7
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:15

POSTGRES_HOST=127.0.0.1 POSTGRES_USER=postgres POSTGRES_PASSWORD=dev \
POSTGRES_DB=postgres POSTGRES_SCHEMA=dev \
REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_PREFIX=dev: \
PORT=3000 node server.js
```

---

## Docker

### Build

```bash
docker build -t kvstore .
```

### Run

```bash
docker run -p 8080:8080 \
  -e POSTGRES_HOST=<host> \
  -e POSTGRES_USER=<user> \
  -e POSTGRES_PASSWORD=<password> \
  -e POSTGRES_DB=<db> \
  -e POSTGRES_SCHEMA=<schema> \
  -e REDIS_HOST=<host> \
  -e REDIS_PREFIX=<prefix> \
  -e INSTANCE_ID=<id> \
  kvstore
```

---

## Deploy Requirements

The app is a single stateless container. To deploy it:

1. **Build and push the image** to your container registry.
2. **Run one or more instances** — each needs the env vars above.
3. **Point instances at the same Postgres and Redis** — this is what enables cross-instance sync and persistence.
4. **Put a load balancer in front** if running multiple instances.

Schema and table are created automatically on first startup. No migration step needed.

### Health endpoint

```
GET /health
→ { "ok": true, "instance": "<INSTANCE_ID>", "cluster": "<CLUSTER_NAME>" }
```

---

## Graceful Degradation

| Missing service | Behaviour |
|---|---|
| No `POSTGRES_HOST` | In-memory store only — data lost on restart |
| Redis unreachable at startup | Local broadcast only — changes not synced across instances |

The app logs which services connected successfully at startup.

---

## Testing

### Basic CRUD

- **Add** a key: fill in the Key and Value fields, press **Add**.
- **Edit** a value: click the value cell, change it, press Enter or click away. The border flashes green on save.
- **Delete** a row: click **Delete** on the right.

### Persistence

Restart a container and reload the browser — all keys should reappear (loaded from Postgres on reconnect).

### Redis cache

```bash
redis-cli -h $REDIS_HOST -p 6379
KEYS "<REDIS_PREFIX>kv:*"
GET  "<REDIS_PREFIX>kv:mykey"
```

### Cross-instance broadcast

Open the app in two browser tabs connected to different instances. Add or delete a key in one tab — the other should update in real time without a page reload.

### Postgres schema

```sql
-- Connect to your Postgres instance
\dn                                        -- confirm schema exists
SELECT * FROM <POSTGRES_SCHEMA>.kv_store;  -- inspect stored keys
```
