// Set the WhatsApp Cloud API profile photo (dp) + about text on your number.
//
// Usage:
//   node scripts/set-profile.js <imagePath> <appId> ["about text"]
// e.g.
//   node scripts/set-profile.js ./dp.jpg 1943062553192180 "Personal training"
//
// Reads WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID from .env. Run on a network
// that can reach graph.facebook.com (your hotspot).
import 'dotenv/config';
import fs from 'node:fs';

const GRAPH = 'https://graph.facebook.com/v25.0';
const token = (process.env.WHATSAPP_TOKEN || '').trim();
const phoneId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
const imgPath = process.argv[2];
const appId = (process.argv[3] || process.env.WHATSAPP_APP_ID || '').trim();
const about = process.argv[4] || '';

if (!token || !phoneId) {
  console.error('❌ Need WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env');
  process.exit(1);
}
if (!imgPath) {
  console.error('Usage: node scripts/set-profile.js <imagePath> <appId> ["about text"]');
  process.exit(1);
}
if (!appId) {
  console.error('❌ Need the App ID as the 2nd argument (or WHATSAPP_APP_ID in .env).');
  process.exit(1);
}

const file = fs.readFileSync(imgPath);
const type = imgPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

// 1) Create a resumable upload session.
let r = await fetch(
  `${GRAPH}/${appId}/uploads?file_length=${file.length}&file_type=${encodeURIComponent(type)}&access_token=${token}`,
  { method: 'POST' }
);
let j = await r.json();
if (!r.ok) { console.error('❌ upload session error:', JSON.stringify(j)); process.exit(1); }
const uploadId = j.id; // "upload:XXXX"

// 2) Upload the bytes → get a file handle.
r = await fetch(`${GRAPH}/${uploadId}`, {
  method: 'POST',
  headers: { Authorization: `OAuth ${token}`, file_offset: '0' },
  body: file,
});
j = await r.json();
if (!r.ok || !j.h) { console.error('❌ upload error:', JSON.stringify(j)); process.exit(1); }
const handle = j.h;

// 3) Set the business profile (photo + optional about).
const body = { messaging_product: 'whatsapp', profile_picture_handle: handle };
if (about) body.about = about;
r = await fetch(`${GRAPH}/${phoneId}/whatsapp_business_profile`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
j = await r.json();
if (!r.ok) { console.error('❌ set profile error:', JSON.stringify(j)); process.exit(1); }
console.log('✅ Profile updated (dp' + (about ? ' + about' : '') + '). Response:', JSON.stringify(j));
