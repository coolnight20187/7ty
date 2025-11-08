/**
 * scripts/create-admin.js
 *
 * Small CLI helper to generate a bcrypt-hashed password and optionally output
 * a SQL INSERT or call Supabase REST to create an admin user.
 *
 * Usage:
 *  - Node only script (Node >= 18 recommended)
 *  - Install dev dep: npm install bcrypt readline-sync node-fetch --save-dev
 *  - Run: node scripts/create-admin.js
 *
 * Features:
 *  - Prompts for username (default 'admin') and password (hidden)
 *  - Generates bcrypt hash (cost 10 by default, configurable)
 *  - Prints SQL ready INSERT statement (safe to paste into migrations/002_seed_admin.sql)
 *  - Optionally posts to Supabase REST /rest/v1/employees when SUPABASE_URL + SUPABASE_SERVICE_ROLE present
 *  - Does not store secrets; it's a local helper for operator use
 *
 * Notes:
 *  - Never run this in an environment where stdin is exposed to untrusted users
 *  - Keep the printed bcrypt hash secret until inserted into DB with restricted access
 */

import bcrypt from 'bcrypt';
import readline from 'readline';
import fetch from 'node-fetch';

const DEFAULT_COST = 10;

function questionPrompt(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!hidden) {
      rl.question(question, answer => { rl.close(); resolve(answer); });
      return;
    }
    // hide input by muting output
    const stdin = process.stdin;
    const onDataHandler = (char) => {
      char = char + '';
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.pause();
          break;
        default:
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(question + Array(rl.line.length + 1).join('*'));
          break;
      }
    };
    process.stdin.on('data', onDataHandler);
    rl.question(question, answer => {
      process.stdin.removeListener('data', onDataHandler);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function run() {
  try {
    console.log('\n== Create Admin Helper ==\n');

    const usernameInput = await questionPrompt('Username (default "admin"): ');
    const username = (usernameInput && usernameInput.trim()) ? usernameInput.trim() : 'admin';

    const pass = await questionPrompt('Password (input hidden): ', true);
    if (!pass || String(pass).trim().length < 6) {
      console.error('Password must be at least 6 characters. Aborting.');
      process.exit(1);
    }

    const costInput = await questionPrompt(`Bcrypt cost/work factor (default ${DEFAULT_COST}): `);
    const cost = Number.isFinite(Number(costInput)) && Number(costInput) >= 6 ? Number(costInput) : DEFAULT_COST;

    console.log('\nHashing password (this may take a few seconds)...');
    const hash = await bcrypt.hash(pass, cost);

    const now = new Date().toISOString();
    const safeUsername = username.replace(/'/g, "''");
    const safeFullName = 'Quản Trị Viên';

    const sql = `INSERT INTO employees (username, password_hash, role, full_name, created_at)
VALUES ('${safeUsername}', '${hash}', 'admin', '${safeFullName}', '${now}');`;

    console.log('\n=== SQL INSERT (paste into migration or run in psql) ===\n');
    console.log(sql);
    console.log('\n=== End SQL ===\n');

    // Optionally call Supabase REST if env present
    const SUPABASE_URL = process.env.SUPABASE_URL || '';
    const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || '';

    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE) {
      const doPush = await questionPrompt('Detected SUPABASE env. Create admin in Supabase now? (y/N): ');
      if ((doPush || '').toLowerCase().startsWith('y')) {
        try {
          const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/employees`;
          const payload = {
            username,
            password_hash: hash,
            role: 'admin',
            full_name: safeFullName,
            created_at: now
          };
          console.log('Calling Supabase REST to create admin (this requires SUPABASE_SERVICE_ROLE env to be set)...');
          const resp = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_SERVICE_ROLE,
              'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
              'Prefer': 'return=representation'
            },
            body: JSON.stringify(payload)
          });
          if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            console.error('Supabase insert failed:', resp.status, txt.slice(0, 1000));
            process.exit(1);
          }
          const data = await resp.json();
          console.log('Supabase insert succeeded. Response:');
          console.log(JSON.stringify(data, null, 2));
        } catch (err) {
          console.error('Supabase create admin error:', err);
        }
      }
    }

    console.log('\nDone. Keep the bcrypt hash secret until you insert it into your DB.');
    process.exit(0);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(2);
  }
}

// If invoked directly with node
if (require.main === module) {
  run();
}

export default run;
