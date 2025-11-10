#!/usr/bin/env node
// scripts/check-env.js
const required = [
  'DATABASE_URL',
  'NEW_API_BASE_URL',
  'NEW_API_PATH',
  'SESSION_SECRET'
];

const missing = required.filter(k => !process.env[k] || String(process.env[k]).trim() === '');

if (missing.length) {
  console.error('Missing required environment variables:', missing.join(', '));
  console.error('Please create a .env file or set these vars in your environment (see .env.example).');
  process.exit(1);
}

console.log('All required environment variables are set.');
process.exit(0);
