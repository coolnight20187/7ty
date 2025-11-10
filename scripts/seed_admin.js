// scripts/seed_admin.js
const { Client } = require('pg');
const bcrypt = require('bcrypt');

async function main() {
  const db = process.env.DATABASE_URL;
  const plain = process.env.ADMIN_PASSWORD;
  if (!db) { console.error('DATABASE_URL missing'); process.exit(1); }
  if (!plain) { console.error('ADMIN_PASSWORD missing'); process.exit(1); }
  const hash = await bcrypt.hash(plain, 12);
  const client = new Client({ connectionString: db });
  await client.connect();
  try {
    const q = `
      INSERT INTO employees (username, password_hash, role, full_name)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (username) DO NOTHING
      RETURNING id, username;
    `;
    const res = await client.query(q, ['admin', hash, 'admin', 'Quản Trị Viên']);
    if (res.rows.length) console.log('Inserted admin:', res.rows[0]);
    else console.log('Admin already exists (no change).');
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await client.end();
  }
}
main();
