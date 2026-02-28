PostgreSQL local setup (docker-compose)
=====================================

This explains how to start a local PostgreSQL instance for the OneWay backend and apply `sql/init.sql`.

1) Copy env

   - From `oneway-backend` folder:

```bash
cd oneway-backend
cp .env.example .env
```

2) Start database

```bash
docker-compose up -d
```

- The `docker-compose.yml` mounts `./sql` into the Postgres image init directory (`/docker-entrypoint-initdb.d`).
- That means `init.sql` will be executed automatically on first startup when the Postgres data directory is empty.

3) Check DB is ready

```bash
docker-compose logs -f db
# or
docker ps
docker inspect --format='{{.State.Health.Status}}' $(docker ps -q -f name=oneway-backend_db)
```

4) Connect with a client

From your host machine you can connect using `psql` (if installed):

```bash
psql -h localhost -U oneway -d onewaydb -p 5432
```

If you used the example `.env`, the credentials are `oneway / onewaypass / onewaydb`.

5) Re-run `init.sql` (if you need to reset)

- The init script only runs when the DB data directory is empty. To force re-run:

```bash
docker-compose down -v
docker-compose up -d
```

6) Configure backend to use the DB

- Set environment variables for `oneway-backend` (for example in your shell or a `.env` file used by your start script):

```
DB_USER=oneway
DB_PASSWORD=onewaypass
DB_NAME=onewaydb
DB_HOST=localhost
DB_PORT=5432
```

- Then from `oneway-backend` run:

```bash
npm install
npm start
```

If your backend runs inside Docker and you use the same compose network, use `DB_HOST=db` instead of `localhost`.

Questions / next steps
- I can add a `docker-compose` service for the backend (optional), or add SQL indexes and constraints to `sql/init.sql`.
- Which would you like next?
