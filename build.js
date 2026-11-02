/* Builds dist/kccc-kit.html: the student kit as one self-contained HTML file (logos inlined).
   Usage: node build.js [https://your-server.example]
   The optional URL is the deployed backend; enquiries and analytics are sent there.
   That server must list the page's origin in ALLOWED_ORIGINS. */
'use strict';
const fs = require('fs');
const path = require('path');

const api = (process.argv[2] || process.env.KCCC_API || '').replace(/\/$/, '');
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const logos = fs.readFileSync(path.join(__dirname, 'public', 'assets', 'logos.js'), 'utf8');
const tag = '<script src="assets/logos.js"></script>';
if (html.indexOf(tag) < 0) throw new Error('logos script tag not found in public/index.html');

const out = html.replace(tag, () => '<script>window.KCCC_API=' + JSON.stringify(api) + ';</script>\n<script>' + logos.trim() + '</script>');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const file = path.join(__dirname, 'dist', 'kccc-kit.html');
fs.writeFileSync(file, out);
console.log('Wrote ' + path.relative(__dirname, file) + ' (' + Math.round(out.length / 1024) + ' KB)' + (api ? ', API: ' + api : ', API: same origin'));
