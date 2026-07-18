// Renderer: UI, audio pipeline, OCR, LLM.
// Passthrough (click-through) is now handled entirely by main-process cursor polling,
// so this file no longer touches setIgnoreMouseEvents.

const DEFAULTS = {
  ollamaUrl: 'http://127.0.0.1:11434',
  whisperUrl: 'http://127.0.0.1:9000/inference',
  model: 'llama3.2:3b',
  systemPrompt: 'You are a concise study/teaching assistant. Give a direct, correct answer.',
  fontScale: 1,
  appOpacity: 0.82,
};

const OCR_MAX_WIDTH = 1280;
const WHISPER_SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 3;
const CHUNK_OVERLAP_SECONDS = 0.5;
const VAD_RMS_THRESHOLD = 0.008;

const els = {
  app: document.getElementById('app'),
  answer: document.getElementById('answer'),
  answerBody: document.getElementById('answer-body'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  mode: document.getElementById('mode'),
  listen: document.getElementById('listen'),
  status: document.getElementById('status'),
  gear: document.getElementById('gear'),
  collapse: document.getElementById('collapse'),
  settings: document.getElementById('settings'),
  cfgModel: document.getElementById('cfg-model'),
  cfgRefresh: document.getElementById('cfg-refresh'),
  cfgSystem: document.getElementById('cfg-system'),
  cfgOllama: document.getElementById('cfg-ollama'),
  cfgWhisper: document.getElementById('cfg-whisper'),
  cfgSave: document.getElementById('cfg-save'),
  cfgReset: document.getElementById('cfg-reset'),
  cfgTest: document.getElementById('cfg-test'),
  transcriptWrap: document.getElementById('transcript-wrap'),
  transcript: document.getElementById('transcript'),
  txClear: document.getElementById('tx-clear'),
};

els.txClear.addEventListener('click', () => {
  transcriptBuffer = '';
  els.transcript.textContent = '';
});

let transcriptBuffer = '';  // kept in memory for LLM context; not shown
let listening = false;
let audioCtx = null;
let sourceNodes = [];
let processorNode = null;
let sampleBuffer = new Float32Array(0);
let currentAbort = null;
let ocrWorkerPromise = null;
let interactive = false;
let generating = false;
let collapsed = false;
let transcribeErrorShown = false; // only warn about whisper once per session

// ---------- Config ----------
function loadConfig() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem('cfg') || '{}')) }; }
  catch { return { ...DEFAULTS }; }
}
let cfg = loadConfig();
function saveConfig(next) {
  cfg = { ...cfg, ...next };
  localStorage.setItem('cfg', JSON.stringify(cfg));
}
function applyVisualConfig() {
  document.documentElement.style.setProperty('--font-scale', cfg.fontScale);
  window.api.setWindowOpacity(cfg.appOpacity);
}
applyVisualConfig();

// ---------- Status ----------
function setStatus(text, on = false) {
  els.status.textContent = text || '';
  els.status.className = 'pill ' + (on ? 'on' : 'dim');
}

function setGenerating(v) {
  generating = v;
  els.send.textContent = v ? 'Stop' : 'Ask';
  els.send.classList.toggle('stop', v);
}

// ---------- Hotkey / IPC wiring ----------
window.api.onInteractiveMode((v) => {
  interactive = v;
  els.mode.textContent = interactive ? 'interactive' : 'click-through';
  els.mode.className = 'pill ' + (interactive ? 'on' : 'dim');
});
window.api.onTriggerScreenAsk(() => askAboutScreen());
window.api.onToggleListen(() => (listening ? stopListening() : startListening()));
window.api.onCancelAll(() => cancelAll());
window.api.onToggleCollapse(() => toggleCollapse());
window.api.onFontDelta((d) => {
  cfg.fontScale = Math.max(0.7, Math.min(2.0, +(cfg.fontScale + d * 0.1).toFixed(2)));
  saveConfig({ fontScale: cfg.fontScale });
  applyVisualConfig();
  setStatus(`font ${Math.round(cfg.fontScale * 100)}%`);
  setTimeout(() => setStatus(''), 900);
});
window.api.onOpacityDelta((d) => {
  cfg.appOpacity = Math.max(0.2, Math.min(1.0, +(cfg.appOpacity + d).toFixed(2)));
  saveConfig({ appOpacity: cfg.appOpacity });
  applyVisualConfig();
  setStatus(`opacity ${Math.round(cfg.appOpacity * 100)}%`);
  setTimeout(() => setStatus(''), 900);
});

els.send.addEventListener('click', () => (generating ? cancelAll() : askFromInput()));
els.prompt.addEventListener('keydown', (e) => { if (e.key === 'Enter') askFromInput(); });
els.collapse.addEventListener('click', toggleCollapse);

function toggleCollapse() {
  collapsed = !collapsed;
  els.app.classList.toggle('collapsed', collapsed);
  els.collapse.textContent = collapsed ? '+' : '–';
}

// ---------- Settings panel ----------
els.gear.addEventListener('click', () => {
  const showing = els.settings.hidden;
  els.settings.hidden = !showing;
  if (showing) hydrateSettings();
});
els.cfgRefresh.addEventListener('click', populateModels);
els.cfgTest.addEventListener('click', async () => {
  els.cfgTest.textContent = '...';
  const r = await window.api.testWhisper(els.cfgWhisper.value.trim() || cfg.whisperUrl);
  els.cfgTest.textContent = 'test';
  if (r.ok) setStatus(`whisper ok (HTTP ${r.status})`, true);
  else setStatus(`whisper: ${r.error}`, false);
  setTimeout(() => setStatus(''), 4000);
});
els.cfgSave.addEventListener('click', () => {
  saveConfig({
    ollamaUrl: els.cfgOllama.value.trim() || DEFAULTS.ollamaUrl,
    whisperUrl: els.cfgWhisper.value.trim() || DEFAULTS.whisperUrl,
    model: els.cfgModel.value || DEFAULTS.model,
    systemPrompt: els.cfgSystem.value.trim() || DEFAULTS.systemPrompt,
  });
  transcribeErrorShown = false; // re-arm the whisper warning for new URL
  setStatus('saved');
  setTimeout(() => setStatus(''), 1200);
  els.settings.hidden = true;
});
els.cfgReset.addEventListener('click', () => {
  saveConfig({ ...DEFAULTS });
  hydrateSettings();
  applyVisualConfig();
  setStatus('reset');
  setTimeout(() => setStatus(''), 1000);
});

function hydrateSettings() {
  els.cfgOllama.value = cfg.ollamaUrl;
  els.cfgWhisper.value = cfg.whisperUrl;
  els.cfgSystem.value = cfg.systemPrompt;
  populateModels();
}
async function populateModels() {
  els.cfgModel.innerHTML = '<option>loading...</option>';
  const list = await window.api.listOllamaModels();
  els.cfgModel.innerHTML = '';
  const models = list.length ? list : [cfg.model];
  if (!models.includes(cfg.model)) models.unshift(cfg.model);
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (m === cfg.model) opt.selected = true;
    els.cfgModel.appendChild(opt);
  }
}

// ---------- Cancel — always resets state ----------
function cancelAll() {
  if (currentAbort) { try { currentAbort.abort(); } catch {} }
  currentAbort = null;
  setGenerating(false);
  setStatus('cancelled');
  setTimeout(() => setStatus(''), 1000);
}

// ---------- LLM ----------
async function askOllama(userPrompt, extraContext, onToken, signal) {
  const ctxParts = [
    transcriptBuffer && `# Recent conversation transcript\n${transcriptBuffer.slice(-2000)}`,
    extraContext && `# On-screen text\n${extraContext.slice(-2000)}`,
  ].filter(Boolean).join('\n\n');
  const fullPrompt = `${cfg.systemPrompt}\n\n${ctxParts}\n\n# Question\n${userPrompt}\n\n# Answer`;

  const res = await fetch(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, prompt: fullPrompt, stream: true }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status} — is 'ollama serve' running and '${cfg.model}' pulled?`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '', buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const j = JSON.parse(line); if (j.response) { full += j.response; onToken(full); } } catch {}
    }
  }
  return full;
}

// Auto-scroll: stick to bottom during generation unless the user actively scrolls up.
// We watch `wheel` and `keydown` (user intent) instead of `scroll` (fires for both
// user and programmatic — the latter breaks auto-scroll).
let userScrolledUp = false;

function updateScrollLock() {
  const nearBottom = els.answer.scrollTop + els.answer.clientHeight >= els.answer.scrollHeight - 24;
  userScrolledUp = !nearBottom;
}
els.answer.addEventListener('wheel', () => setTimeout(updateScrollLock, 0));
els.answer.addEventListener('keydown', (e) => {
  if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)) {
    setTimeout(updateScrollLock, 0);
  }
});

function renderAnswer(text) {
  els.answerBody.classList.remove('placeholder');
  const html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br/>');
  els.answerBody.innerHTML = html;
  if (!userScrolledUp) els.answer.scrollTop = els.answer.scrollHeight;
}

async function ask(userPrompt, extraContext = '') {
  cancelAll();
  currentAbort = new AbortController();
  setGenerating(true);
  userScrolledUp = false;
  setStatus('thinking', true);
  renderAnswer('...');
  try {
    await askOllama(userPrompt, extraContext, renderAnswer, currentAbort.signal);
    setStatus('done'); setTimeout(() => setStatus(''), 1000);
  } catch (e) {
    if (e.name !== 'AbortError') {
      renderAnswer(`**Error:** ${e.message}`);
      setStatus('error');
    }
  } finally {
    setGenerating(false);
    currentAbort = null;
  }
}

async function askFromInput() {
  const q = els.prompt.value.trim();
  if (!q) return;
  els.prompt.value = '';
  await ask(q);
}

// ---------- OCR ----------
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    setStatus('loading OCR', true);
    ocrWorkerPromise = Tesseract.createWorker('eng').then((w) => { setStatus(''); return w; });
  }
  return ocrWorkerPromise;
}
getOcrWorker().catch((e) => console.warn('OCR preload failed:', e));

async function downscale(dataUrl, maxW) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
  if (img.width <= maxW) return dataUrl;
  const scale = maxW / img.width;
  const canvas = document.createElement('canvas');
  canvas.width = maxW;
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

async function askAboutScreen() {
  cancelAll();
  currentAbort = new AbortController();
  setGenerating(true);
  userScrolledUp = false;
  const signal = currentAbort.signal;
  try {
    setStatus('capturing', true); renderAnswer('...capturing screen');
    const raw = await window.api.captureScreen();
    if (signal.aborted) return;
    if (!raw) { renderAnswer('**Error:** could not capture screen'); return; }

    setStatus('shrinking', true);
    const small = await downscale(raw, OCR_MAX_WIDTH);
    if (signal.aborted) return;

    setStatus('OCR', true); renderAnswer('...reading text');
    const worker = await getOcrWorker();
    if (signal.aborted) return;
    const { data: { text } } = await worker.recognize(small);
    if (signal.aborted) return;

    const q = els.prompt.value.trim() || 'Explain what is on screen and answer any visible question directly.';
    setStatus('thinking', true); renderAnswer('...');
    await askOllama(q, text, renderAnswer, signal);
    setStatus('done'); setTimeout(() => setStatus(''), 1000);
  } catch (e) {
    if (e.name !== 'AbortError') {
      renderAnswer(`**Error:** ${e.message}`);
      setStatus('error');
    }
  } finally {
    setGenerating(false);
    currentAbort = null;
  }
}

// ---------- Audio pipeline ----------
async function startListening() {
  try {
    let displayStream = null, micStream = null;
    try { displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
    catch (e) { console.warn('loopback capture failed:', e.message); }
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { console.warn('mic denied:', e.message); }

    if (!displayStream && !micStream) throw new Error('No audio sources. Check Windows Settings → Privacy → Microphone.');

    audioCtx = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
    const mixer = audioCtx.createGain();
    if (displayStream && displayStream.getAudioTracks().length) {
      const src = audioCtx.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks()));
      src.connect(mixer);
      sourceNodes.push({ node: src, stream: displayStream });
    }
    if (micStream) {
      const src = audioCtx.createMediaStreamSource(micStream);
      src.connect(mixer);
      sourceNodes.push({ node: src, stream: micStream });
    }

    processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const merged = new Float32Array(sampleBuffer.length + input.length);
      merged.set(sampleBuffer);
      merged.set(input, sampleBuffer.length);
      sampleBuffer = merged;

      const chunkSize = WHISPER_SAMPLE_RATE * CHUNK_SECONDS;
      const overlapSize = WHISPER_SAMPLE_RATE * CHUNK_OVERLAP_SECONDS;
      if (sampleBuffer.length >= chunkSize) {
        const chunk = sampleBuffer.slice(0, chunkSize);
        sampleBuffer = sampleBuffer.slice(chunkSize - overlapSize);
        dispatchChunk(chunk);
      }
    };
    mixer.connect(processorNode);
    processorNode.connect(audioCtx.destination);

    listening = true;
    transcribeErrorShown = false;
    els.listen.textContent = 'listening';
    els.listen.className = 'pill on';
    els.transcriptWrap.hidden = false;
  } catch (e) {
    renderAnswer(`**Audio error:** ${e.message}`);
    listening = false;
  }
}

function stopListening() {
  listening = false;
  els.listen.textContent = 'idle';
  els.listen.className = 'pill dim';
  if (processorNode) { try { processorNode.disconnect(); } catch {} processorNode = null; }
  for (const s of sourceNodes) {
    try { s.node.disconnect(); } catch {}
    try { s.stream.getTracks().forEach((t) => t.stop()); } catch {}
  }
  sourceNodes = [];
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
  sampleBuffer = new Float32Array(0);
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

async function dispatchChunk(samples) {
  if (rms(samples) < VAD_RMS_THRESHOLD) return;
  const wav = encodeWAV(samples, WHISPER_SAMPLE_RATE);
  transcribeChunk(wav);
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

async function transcribeChunk(wavArrayBuffer) {
  const result = await window.api.transcribe(cfg.whisperUrl, wavArrayBuffer);
  if (result.error) {
    // Show the error once via the status pill instead of spamming a transcript panel.
    if (!transcribeErrorShown) {
      transcribeErrorShown = true;
      setStatus(`whisper: ${result.error}`, false);
      console.warn('whisper transcription error:', result.error);
      setTimeout(() => setStatus(''), 5000);
    }
    return;
  }
  const text = result.text;
  if (!text) return;

  // Dedup the overlap
  const tail = transcriptBuffer.slice(-80).toLowerCase();
  const head = text.slice(0, 80).toLowerCase();
  let overlap = 0;
  for (let n = Math.min(tail.length, head.length); n > 4; n--) {
    if (tail.endsWith(head.slice(0, n))) { overlap = n; break; }
  }
  const cleaned = overlap ? text.slice(overlap) : text;
  if (!cleaned.trim()) return;

  transcriptBuffer += ' ' + cleaned;
  els.transcript.textContent = transcriptBuffer.slice(-2000);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}
