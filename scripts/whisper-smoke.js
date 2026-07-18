// Whisper smoke test. Run with: node scripts/whisper-smoke.js
//
// Generates a 3-second 440 Hz tone WAV (real audio, not silence), then:
//   1. Saves it to scripts/test.wav so you can play it and confirm it's valid.
//   2. Posts it via node:http (the same path the app uses).
//   3. Posts it via curl (if available on PATH) to cross-check.
// Prints the exact response body from each.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:9000/inference';
const OUT_WAV = path.join(__dirname, 'test.wav');

// ---- Build a 3-second, 16 kHz mono, 16-bit PCM WAV with a 440 Hz tone ----
function makeWav() {
  const sampleRate = 16000;
  const seconds = 3;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.3;
    const int16 = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
    buf.writeInt16LE(int16, 44 + i * 2);
  }
  return buf;
}

function buildMultipart(wav) {
  const boundary = '----smokeBoundary' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  const parts = [];
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="test.wav"${CRLF}` +
    `Content-Type: audio/wav${CRLF}${CRLF}`
  ));
  parts.push(wav);
  parts.push(Buffer.from(
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="temperature"${CRLF}${CRLF}0` +
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}json` +
    `${CRLF}--${boundary}--${CRLF}`
  ));
  return { body: Buffer.concat(parts), boundary };
}

function postNode(url, wav) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const { body, boundary } = buildMultipart(wav);
    console.log(`[node] POST ${url}  body=${body.length}B`);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        'Connection': 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        console.log(`[node] HTTP ${res.statusCode} — ${text.slice(0, 400)}`);
        resolve();
      });
    });
    req.on('error', (e) => { console.log(`[node] ERROR ${e.code || ''} ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

function postCurl(url, wavPath) {
  console.log(`[curl] POST ${url}  file=${wavPath}`);
  try {
    const out = execSync(
      `curl -sS -X POST "${url}" -F "file=@${wavPath}" -F "temperature=0" -F "response_format=json"`,
      { encoding: 'utf8', timeout: 30000 }
    );
    console.log(`[curl] response: ${out.slice(0, 400)}`);
  } catch (e) {
    console.log(`[curl] ERROR ${e.status || ''} ${e.stderr || e.message}`);
  }
}

(async () => {
  const wav = makeWav();
  fs.writeFileSync(OUT_WAV, wav);
  console.log(`Wrote test WAV: ${OUT_WAV} (${wav.length} bytes)`);
  console.log(`Whisper URL:    ${WHISPER_URL}`);
  console.log('');
  console.log('---- Attempt 1: node:http (same path as the app) ----');
  await postNode(WHISPER_URL, wav);
  console.log('');
  console.log('---- Attempt 2: curl ----');
  postCurl(WHISPER_URL, OUT_WAV);
  console.log('');
  console.log('Done. If curl works but node fails, it is our HTTP layer.');
  console.log('If both fail identically, it is the server / URL / WAV format.');
})();
