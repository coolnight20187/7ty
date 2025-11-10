// scripts/migrate.js
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function run() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      console.log('Applying', file);
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('Applied', file);
    }
    console.log('All migrations applied');
    await client.end();
  } catch (e) {
    console.error('Migration failed', e);
    try { await client.query('ROLLBACK'); } catch (er) {}
    await client.end();
    process.exit(1);
  }
}

run();
