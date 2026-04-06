# OneWay Backend

## Git Deploy Workflow

This backend is meant to be deployed from git instead of zip uploads.

### First-time VM setup

```bash
cd ~
mv oneway-backend oneway-backend.bak-$(date +%F-%H%M) 2>/dev/null || true
git clone https://github.com/munkhjargalbs12-sys/oneway-backend.git oneway-backend
cd oneway-backend
cp ../oneway-backend.bak-*/.env .env 2>/dev/null || true
npm install --omit=dev
pm2 start ecosystem.config.js --only oneway-api
pm2 save
```

If `.env` was not copied from a backup, create it manually before starting PM2.

### Regular deploy

Run this on the VM after pushing new commits:

```bash
cd ~/oneway-backend
bash scripts/deploy.sh
```

### Notes

- `sql/init.sql` is safe to re-run for compatibility updates because it uses `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`.
- Keep `.env` only on the VM. Do not commit it.
- If you need to deploy another branch, run `bash scripts/deploy.sh your-branch-name`.
