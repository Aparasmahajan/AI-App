// Renderer: UI, audio pipeline, OCR, LLM.
// Passthrough (click-through) is now handled entirely by main-process cursor polling,
// so this file no longer touches setIgnoreMouseEvents.

const DEFAULTS = {
  provider: 'groq',   // 'ollama' | 'groq' | 'openai' | 'openrouter' | 'gemini' | 'custom'
  apiKeys: {},        // per-provider keys: { groq: '...', openai: '...', gemini: '...', ... }
  apiBase: '',        // only used for 'custom'; other providers are hardcoded
  ollamaUrl: 'http://127.0.0.1:11434',
  whisperUrl: 'http://127.0.0.1:9000/inference',
  model: 'llama-3.3-70b-versatile',
  systemPrompt: 'You are a concise study/teaching assistant master of JAVA, SQL, DSA, System Design and Kafka. Give a direct, correct and human like answer not bookish one. Also be ware to give a crisp a concise answer along with summary at last. For coding question add an understandable comments too where ever required. Give answer such that i can see easily during quick fire round. when ever i ask for eg or anything just make sure to check previous prompt too.',
  fontScale: 1,
  appOpacity: 0.82,
  maxTokens: 400,
  contextChars: 2000,
  layout: 'cards',
  scrollMode: 'medium',   // 'line' | 'slow' | 'medium' | 'fast'
  theme: 'dark',          // 'dark' | 'light'
  textColor: 'default',   // 'default' | 'red' | 'black' | 'white'
  textBold: false,
};

// Pixels-per-second for each paced scroll mode. `fast` = snap.
const SCROLL_SPEEDS = {
  line:   20,   // ~1 line/sec at default font
  slow:   80,   // ~4 lines/sec
  medium: 250,  // ~12 lines/sec
  fast:   Infinity,
};

// Provider registry. Everything except gemini uses OpenAI-compatible /chat/completions.
// `models` = curated recommended list for each provider. User can still type any model id.
const PROVIDERS = {
  ollama: {
    label: 'Ollama (local)', needsKey: false, defaultModel: 'llama3.2:3b',
    // Ollama models are auto-loaded from local `ollama list`; this fallback is used only if none pulled.
    models: ['llama3.2:3b', 'llama3.2:1b', 'qwen2.5:3b', 'phi3:mini', 'gemma2:2b'],
  },
  groq: {
    label: 'Groq (fast + free)', needsKey: true, base: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'llama3-70b-8192',
      'llama3-8b-8192',
      'qwen-2.5-32b',
      'qwen-2.5-coder-32b',
      'deepseek-r1-distill-llama-70b',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
    ],
  },
  openai: {
    label: 'OpenAI', needsKey: true, base: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini', 'o3-mini', 'gpt-3.5-turbo'],
  },
  openrouter: {
    label: 'OpenRouter', needsKey: true, base: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    models: [
      'meta-llama/llama-3.3-70b-instruct:free',
      'deepseek/deepseek-r1:free',
      'deepseek/deepseek-chat:free',
      'google/gemini-2.0-flash-exp:free',
      'qwen/qwen-2.5-72b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o-mini',
    ],
  },
  gemini: {
    label: 'Google Gemini (free)', needsKey: true, base: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.0-flash',
    models: [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-1.5-flash-8b',
      'gemini-1.5-pro',
      'gemini-exp-1206',
    ],
  },
  custom: {
    label: 'Custom OpenAI-compat', needsKey: true, defaultModel: '',
    models: [],
  },
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
  historyHeader: document.getElementById('history-header'),
  historyCount: document.getElementById('history-count'),
  clearAll: document.getElementById('clear-all'),
  search: document.getElementById('search'),
  matchNav: document.getElementById('match-nav'),
  matchCount: document.getElementById('match-count'),
  matchPrev: document.getElementById('match-prev'),
  matchNext: document.getElementById('match-next'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  mode: document.getElementById('mode'),
  listen: document.getElementById('listen'),
  status: document.getElementById('status'),
  gear: document.getElementById('gear'),
  collapse: document.getElementById('collapse'),
  settings: document.getElementById('settings'),
  cfgProvider: document.getElementById('cfg-provider'),
  cfgApiKey: document.getElementById('cfg-apikey'),
  cfgApiBase: document.getElementById('cfg-apibase'),
  cfgApiBaseRow: document.getElementById('cfg-apibase-row'),
  cfgModel: document.getElementById('cfg-model'),
  cfgModelText: document.getElementById('cfg-model-text'),
  cfgRefresh: document.getElementById('cfg-refresh'),
  cfgSystem: document.getElementById('cfg-system'),
  cfgOllama: document.getElementById('cfg-ollama'),
  cfgWhisper: document.getElementById('cfg-whisper'),
  cfgSave: document.getElementById('cfg-save'),
  cfgReset: document.getElementById('cfg-reset'),
  cfgTest: document.getElementById('cfg-test'),
  cfgTokens: document.getElementById('cfg-tokens'),
  cfgCtx: document.getElementById('cfg-ctx'),
  cfgLayout: document.getElementById('cfg-layout'),
  cfgScroll: document.getElementById('cfg-scroll'),
  cfgTheme: document.getElementById('cfg-theme'),
  transcriptWrap: document.getElementById('transcript-wrap'),
  transcript: document.getElementById('transcript'),
  txClear: document.getElementById('tx-clear'),
  mic: document.getElementById('mic'),
};

// ---------- Tap-to-record → whisper-cli → fill Ask input ----------
// Independent of the Ctrl+Shift+L continuous-listening flow. Click mic to start
// recording, click again to stop and transcribe. Result goes into the prompt.
let micRecording = false;
let micStream = null;
let micCtx = null;
let micProcessor = null;
let micSource = null;
let micSamples = new Float32Array(0);
const MIC_SAMPLE_RATE = 16000;
const MIC_MAX_SECONDS = 60; // safety cap
els.mic.addEventListener('click', () => (micRecording ? stopMicRecording() : startMicRecording()));

async function startMicRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setStatus(`mic denied: ${e.message}`);
    setTimeout(() => setStatus(''), 3000);
    return;
  }
  micCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
  micSource = micCtx.createMediaStreamSource(micStream);
  micProcessor = micCtx.createScriptProcessor(4096, 1, 1);
  micSamples = new Float32Array(0);
  micProcessor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const merged = new Float32Array(micSamples.length + input.length);
    merged.set(micSamples);
    merged.set(input, micSamples.length);
    micSamples = merged;
    if (micSamples.length > MIC_SAMPLE_RATE * MIC_MAX_SECONDS) stopMicRecording();
  };
  micSource.connect(micProcessor);
  micProcessor.connect(micCtx.destination);

  micRecording = true;
  els.mic.textContent = '■';
  els.mic.classList.add('recording');
  setStatus('recording', true);
}

async function stopMicRecording() {
  if (!micRecording) return;
  micRecording = false;
  els.mic.classList.remove('recording');
  els.mic.classList.add('transcribing');
  els.mic.textContent = '…';
  setStatus('transcribing', true);

  try { micProcessor.disconnect(); } catch {}
  try { micSource.disconnect(); } catch {}
  try { micStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { micCtx.close(); } catch {}

  const samples = micSamples;
  micSamples = new Float32Array(0);
  if (samples.length < MIC_SAMPLE_RATE * 0.3) {
    setStatus('too short'); setTimeout(() => setStatus(''), 1500);
    els.mic.classList.remove('transcribing');
    els.mic.textContent = '🎙';
    return;
  }

  const wav = encodeWAV(samples, MIC_SAMPLE_RATE);
  const result = await window.api.transcribe(wav);
  els.mic.classList.remove('transcribing');
  els.mic.textContent = '🎙';

  if (result.error) {
    setStatus(`whisper: ${result.error}`);
    setTimeout(() => setStatus(''), 4000);
    return;
  }
  const text = (result.text || '').trim();
  if (!text) { setStatus('no speech detected'); setTimeout(() => setStatus(''), 1500); return; }

  // Append (with a space) if there's already text in the input, so user can dictate additions.
  els.prompt.value = els.prompt.value ? `${els.prompt.value} ${text}` : text;
  els.prompt.focus();
  setStatus('done'); setTimeout(() => setStatus(''), 1000);
}

els.txClear.addEventListener('click', () => {
  transcriptEntries = [];
  transcriptBuffer = '';
  els.transcript.textContent = '';
  // Also collapse the strip and shrink the window back — empty transcript = no reason to keep space.
  showTranscript(false);
});

// Show/hide transcript AND grow/shrink the OS window so it doesn't steal from answer.
const TRANSCRIPT_HEIGHT_DELTA = 118; // strip height + border
let transcriptShown = false;
function showTranscript(show) {
  if (show === transcriptShown) return;
  transcriptShown = show;
  els.transcriptWrap.hidden = !show;
  window.api.growWindow(show ? TRANSCRIPT_HEIGHT_DELTA : -TRANSCRIPT_HEIGHT_DELTA);
}

// Manual resize — main-process cursor polling does the actual work; we just tell
// it when to start and stop. This keeps working when the cursor is dragged
// outside the window bounds (which stops renderer mousemove events).
const resizeGrip = document.getElementById('resize-grip');
resizeGrip.addEventListener('mousedown', (e) => {
  e.preventDefault();
  window.api.startResize();
});
window.addEventListener('mouseup', () => window.api.endResize());
// Safety: also end if the pointer leaves the window entirely.
window.addEventListener('blur', () => window.api.endResize());

// Transcript entries with timestamps so we can auto-expire old ones.
const TRANSCRIPT_TTL_MS = 60000; // 60 s
let transcriptEntries = []; // [{ text, ts }]
let transcriptBuffer = '';  // rolling derived view of non-expired text (used as LLM context)
function pruneTranscript() {
  const cutoff = Date.now() - TRANSCRIPT_TTL_MS;
  const before = transcriptEntries.length;
  transcriptEntries = transcriptEntries.filter((e) => e.ts >= cutoff);
  if (transcriptEntries.length !== before) rebuildTranscriptView();
}
function rebuildTranscriptView() {
  transcriptBuffer = transcriptEntries.map((e) => e.text).join(' ').trim();
  // Render each entry as a row with copy / → Ask actions on hover.
  const html = transcriptEntries.map((e, i) => {
    const safe = escapeHtml(e.text);
    return `<div class="tx-line" data-i="${i}">
      <span class="tx-text">${safe}</span>
      <span class="tx-actions">
        <button class="tx-btn" data-act="copy" data-i="${i}">copy</button>
        <button class="tx-btn" data-act="toask" data-i="${i}">→ Ask</button>
      </span>
    </div>`;
  }).join('');
  els.transcript.innerHTML = html;
  els.transcript.scrollTop = els.transcript.scrollHeight;
  els.transcript.querySelectorAll('.tx-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const i = parseInt(btn.dataset.i, 10);
      const entry = transcriptEntries[i];
      if (!entry) return;
      if (btn.dataset.act === 'copy') {
        navigator.clipboard.writeText(entry.text);
        setStatus('copied'); setTimeout(() => setStatus(''), 800);
      } else if (btn.dataset.act === 'toask') {
        els.prompt.value = els.prompt.value ? `${els.prompt.value} ${entry.text}` : entry.text;
        els.prompt.focus();
      }
    });
  });
}
setInterval(pruneTranscript, 3000);

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

// ---------- Custom dropdowns (native <select> popups bypass content protection) ----------
function enhanceSelect(sel) {
  const wrap = document.createElement('div');
  wrap.className = 'dd-wrap';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dd-trigger';
  const panel = document.createElement('div');
  panel.className = 'dd-panel';
  panel.hidden = true;
  wrap.appendChild(trigger);
  wrap.appendChild(panel);
  sel.parentNode.insertBefore(wrap, sel);

  function render() {
    trigger.textContent = sel.options[sel.selectedIndex]?.textContent || '(select…)';
    panel.innerHTML = '';
    for (const opt of Array.from(sel.options)) {
      const item = document.createElement('div');
      item.className = 'dd-item' + (opt.value === sel.value ? ' selected' : '');
      item.textContent = opt.textContent;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        panel.hidden = true;
        render();
      });
      panel.appendChild(item);
    }
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close any other open dd panels
    document.querySelectorAll('.dd-panel').forEach((p) => { if (p !== panel) p.hidden = true; });
    panel.hidden = !panel.hidden;
  });
  document.addEventListener('click', () => { panel.hidden = true; });

  // Watch for changes made programmatically (populateModels, etc.)
  new MutationObserver(render).observe(sel, { childList: true, attributes: true, subtree: true });
  render();
}

// Kill the right-click context menu — it also opens as a native OS popup.
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Config ----------
// Primary source of truth: JSON file in Electron's userData dir (via main process).
// LocalStorage is kept as a fallback for legacy installs but the file wins on read.
function loadConfig() {
  const fromDisk = window.api.getInitialConfig() || {};
  let fromLocal = {};
  try { fromLocal = JSON.parse(localStorage.getItem('cfg') || '{}'); } catch {}
  const merged = { ...DEFAULTS, ...fromLocal, ...fromDisk };
  // Migrate legacy single `apiKey` field into the per-provider map.
  if (merged.apiKey && (!merged.apiKeys || !merged.apiKeys[merged.provider])) {
    merged.apiKeys = { ...(merged.apiKeys || {}), [merged.provider]: merged.apiKey };
  }
  delete merged.apiKey; // don't persist the legacy field going forward
  merged.apiKeys = merged.apiKeys || {};
  return merged;
}
let cfg = loadConfig();
function currentApiKey() { return cfg.apiKeys?.[cfg.provider] || ''; }
async function saveConfig(next) {
  cfg = { ...cfg, ...next };
  localStorage.setItem('cfg', JSON.stringify(cfg));   // legacy mirror
  const ok = await window.api.persistConfig(cfg);      // authoritative on-disk copy
  if (!ok) console.warn('[config] persist returned false — check terminal for reason');
  return ok;
}
function applyVisualConfig() {
  document.documentElement.style.setProperty('--font-scale', cfg.fontScale);
  document.documentElement.setAttribute('data-theme', cfg.theme || 'dark');
  window.api.setWindowOpacity(cfg.appOpacity);
  applyTextStyle();
}
function applyTextStyle() {
  const body = document.getElementById('answer-body');
  if (!body) return;
  if (cfg.textColor && cfg.textColor !== 'default') body.setAttribute('data-text-color', cfg.textColor);
  else body.removeAttribute('data-text-color');
  body.setAttribute('data-text-bold', String(!!cfg.textBold));
  // Update palette + bold button UI state
  document.querySelectorAll('.color-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.color === (cfg.textColor || 'default'));
  });
  const boldBtn = document.getElementById('bold-toggle');
  if (boldBtn) boldBtn.classList.toggle('on', !!cfg.textBold);
}
applyVisualConfig();

// Color palette + bold in the title bar — click to set/toggle, persists immediately.
document.querySelectorAll('.color-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    saveConfig({ textColor: btn.dataset.color });
    applyTextStyle();
  });
});
document.getElementById('bold-toggle').addEventListener('click', () => {
  saveConfig({ textBold: !cfg.textBold });
  applyTextStyle();
});

// Warm up the local model so the first Ollama request doesn't pay cold-load cost.
// No-op for cloud providers (they're always warm).
async function warmModel() {
  if (cfg.provider !== 'ollama') return;
  try {
    await fetch(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model, prompt: 'hi', stream: false,
        keep_alive: '30m', options: { num_predict: 1 },
      }),
    });
  } catch (e) { console.warn('model warmup failed:', e.message); }
}
warmModel();

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
els.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    askFromInput();
    // Blur so subsequent ↑ / PageUp / etc. reach the global scroll handler
    // (otherwise they'd move the caret inside the empty input and do nothing useful).
    els.prompt.blur();
    els.answer.focus();
  }
});
// Even while typing in the prompt, ↑ / PageUp / PageDown / Home / End should
// scroll the answer — they don't do anything useful in a single-line input.
els.prompt.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
    // For a text input, Home/End move the caret — keep that unless input is empty.
    if ((e.key === 'Home' || e.key === 'End') && els.prompt.value.length > 0) return;
    if (handleScrollKey(e.key, e.shiftKey)) e.preventDefault();
  }
});
els.collapse.addEventListener('click', toggleCollapse);

function toggleCollapse() {
  collapsed = !collapsed;
  els.app.classList.toggle('collapsed', collapsed);
  els.collapse.textContent = collapsed ? '+' : '–';
  window.api.setCollapsed(collapsed);
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
  const r = await window.api.testWhisper();
  els.cfgTest.textContent = 'test';
  if (r.ok) setStatus(`whisper ok (HTTP ${r.status})`, true);
  else setStatus(`whisper: ${r.error}`, false);
  setTimeout(() => setStatus(''), 4000);
});
els.cfgSave.addEventListener('click', async () => {
  // Prefer the text-entered model over the dropdown selection (lets you type any model id).
  const modelValue = els.cfgModelText.value.trim() || els.cfgModel.value || DEFAULTS.model;
  const selectedProvider = els.cfgProvider.value || DEFAULTS.provider;
  const nextKeys = { ...(cfg.apiKeys || {}), [selectedProvider]: els.cfgApiKey.value };
  const ok = await saveConfig({
    provider: selectedProvider,
    apiKeys: nextKeys,
    apiBase: els.cfgApiBase.value.trim(),
    ollamaUrl: els.cfgOllama.value.trim() || DEFAULTS.ollamaUrl,
    whisperUrl: els.cfgWhisper.value.trim() || DEFAULTS.whisperUrl,
    model: modelValue,
    systemPrompt: els.cfgSystem.value.trim() || DEFAULTS.systemPrompt,
    maxTokens: parseInt(els.cfgTokens.value, 10) || DEFAULTS.maxTokens,
    contextChars: parseInt(els.cfgCtx.value, 10) || DEFAULTS.contextChars,
    layout: els.cfgLayout.value || DEFAULTS.layout,
    scrollMode: els.cfgScroll.value || DEFAULTS.scrollMode,
    theme: els.cfgTheme.value || DEFAULTS.theme,
  });
  transcribeErrorShown = false; // re-arm the whisper warning for new URL
  setStatus(ok ? 'saved to disk' : 'save failed — see terminal');
  setTimeout(() => setStatus(''), 1500);
  if (ok) els.settings.hidden = true;
  warmModel(); // pre-load the (possibly new) model
});
els.cfgReset.addEventListener('click', () => {
  saveConfig({ ...DEFAULTS });
  hydrateSettings();
  applyVisualConfig();
  setStatus('reset');
  setTimeout(() => setStatus(''), 1000);
});

function hydrateSettings() {
  els.cfgProvider.value = cfg.provider;
  els.cfgApiKey.value = currentApiKey();
  els.cfgApiKey.placeholder = `paste ${PROVIDERS[cfg.provider]?.label || cfg.provider} key`;
  els.cfgApiBase.value = cfg.apiBase;
  els.cfgApiBaseRow.hidden = cfg.provider !== 'custom';
  els.cfgOllama.value = cfg.ollamaUrl;
  els.cfgWhisper.value = cfg.whisperUrl;
  els.cfgSystem.value = cfg.systemPrompt;
  els.cfgTokens.value = String(cfg.maxTokens);
  els.cfgCtx.value = String(cfg.contextChars);
  els.cfgLayout.value = cfg.layout;
  els.cfgScroll.value = cfg.scrollMode;
  els.cfgTheme.value = cfg.theme;
  els.cfgModelText.value = cfg.model;
  populateModels();
}

// Show/hide custom base URL row when provider changes; pre-fill default model,
// swap the API key input to that provider's saved key, refresh model dropdown.
els.cfgProvider.addEventListener('change', () => {
  const p = els.cfgProvider.value;
  els.cfgApiBaseRow.hidden = p !== 'custom';
  const def = PROVIDERS[p]?.defaultModel;
  if (def) els.cfgModelText.value = def;
  els.cfgApiKey.value = cfg.apiKeys?.[p] || '';
  els.cfgApiKey.placeholder = `paste ${PROVIDERS[p]?.label || p} key`;
  populateModels();
});

// Live layout switch — re-renders instantly, no need to Save.
els.cfgLayout && els.cfgLayout.addEventListener('change', () => {
  saveConfig({ layout: els.cfgLayout.value });
  document.body.classList.toggle('layout-bubbles', cfg.layout === 'bubbles');
  renderHistory();
});
// Apply layout class on load
document.body.classList.toggle('layout-bubbles', cfg.layout === 'bubbles');
async function populateModels() {
  const provider = els.cfgProvider.value || cfg.provider;
  let models;
  if (provider === 'ollama') {
    els.cfgModel.innerHTML = '<option>loading...</option>';
    const list = await window.api.listOllamaModels();
    models = list.length ? list : (PROVIDERS.ollama.models || [cfg.model]);
  } else {
    models = PROVIDERS[provider]?.models || [];
  }
  els.cfgModel.innerHTML = '';
  if (!models.length) {
    els.cfgModel.innerHTML = '<option value="">(type model id →)</option>';
    return;
  }
  if (!models.includes(cfg.model)) models = [cfg.model, ...models].filter(Boolean);
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    if (m === cfg.model) opt.selected = true;
    els.cfgModel.appendChild(opt);
  }
}

// Picking from the dropdown fills the text input so you can see / edit / save what you picked.
els.cfgModel.addEventListener('change', () => {
  if (els.cfgModel.value) els.cfgModelText.value = els.cfgModel.value;
});

// Live theme swap on change — no need to hit Save.
els.cfgTheme.addEventListener('change', () => {
  document.documentElement.setAttribute('data-theme', els.cfgTheme.value);
});

// Sync every <select>'s displayed value to what cfg says, BEFORE wrapping —
// otherwise the custom-dropdown trigger reads the HTML default (first option)
// instead of the user's saved / pinned value.
els.cfgProvider.value = cfg.provider;
els.cfgTokens.value = String(cfg.maxTokens);
els.cfgCtx.value = String(cfg.contextChars);
els.cfgLayout.value = cfg.layout;
els.cfgScroll.value = cfg.scrollMode;
els.cfgTheme.value = cfg.theme;

// Wrap every native <select> with a custom dropdown that renders inside the window.
[els.cfgProvider, els.cfgTokens, els.cfgCtx, els.cfgLayout, els.cfgScroll, els.cfgTheme, els.cfgModel].forEach(enhanceSelect);

// ---------- Cancel — always resets state ----------
function cancelAll() {
  if (currentAbort) { try { currentAbort.abort(); } catch {} }
  currentAbort = null;
  setGenerating(false);
  setStatus('cancelled');
  setTimeout(() => setStatus(''), 1000);
}

// ---------- LLM ----------
function buildContext(userPrompt, extraContext) {
  const parts = [
    transcriptBuffer && `# Recent conversation transcript\n${transcriptBuffer.slice(-cfg.contextChars)}`,
    extraContext && `# On-screen text\n${extraContext.slice(-cfg.contextChars)}`,
  ].filter(Boolean).join('\n\n');
  return { userMessage: parts ? `${parts}\n\n# Question\n${userPrompt}` : userPrompt };
}

// Router — dispatches to the right adapter based on cfg.provider.
async function askAI(userPrompt, extraContext, onToken, signal) {
  const p = cfg.provider;
  if (p === 'ollama') return askOllama(userPrompt, extraContext, onToken, signal);
  if (p === 'gemini') return askGemini(userPrompt, extraContext, onToken, signal);
  return askOpenAICompat(p, userPrompt, extraContext, onToken, signal);
}

async function askOllama(userPrompt, extraContext, onToken, signal) {
  const { userMessage } = buildContext(userPrompt, extraContext);
  const fullPrompt = `${cfg.systemPrompt}\n\n${userMessage}\n\n# Answer`;
  const res = await fetch(`${cfg.ollamaUrl.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      prompt: fullPrompt,
      stream: true,
      keep_alive: '30m',
      options: { num_predict: cfg.maxTokens, num_ctx: 2048, temperature: 0.3, top_k: 40, top_p: 0.9 },
    }),
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

// OpenAI-compatible: Groq, OpenAI, OpenRouter, custom. All use /chat/completions with SSE.
async function askOpenAICompat(provider, userPrompt, extraContext, onToken, signal) {
  const meta = PROVIDERS[provider] || {};
  const base = (provider === 'custom' ? cfg.apiBase : meta.base) || '';
  if (!base) throw new Error(`No API base URL configured for ${provider}`);
  const key = currentApiKey();
  if (!key) throw new Error(`API key missing — open ⚙ and paste your ${meta.label || provider} key`);

  const { userMessage } = buildContext(userPrompt, extraContext);
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: cfg.systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: cfg.maxTokens,
      temperature: 0.3,
      stream: true,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${meta.label || provider} HTTP ${res.status} — ${body.slice(0, 200)}`);
  }

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
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return full;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onToken(full); }
      } catch {}
    }
  }
  return full;
}

// Google Gemini — different API shape. Streams via streamGenerateContent SSE.
async function askGemini(userPrompt, extraContext, onToken, signal) {
  const key = currentApiKey();
  if (!key) throw new Error('API key missing — open ⚙ and paste your Gemini key');
  const { userMessage } = buildContext(userPrompt, extraContext);
  const base = PROVIDERS.gemini.base;
  const url = `${base}/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { role: 'system', parts: [{ text: cfg.systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: cfg.maxTokens, temperature: 0.3 },
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status} — ${body.slice(0, 200)}`);
  }
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
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      try {
        const j = JSON.parse(payload);
        const delta = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('');
        if (delta) { full += delta; onToken(full); }
      } catch {}
    }
  }
  return full;
}

// ---------- Q&A history model ----------
// Each entry: { id, source: 'typed'|'screen'|'heard', question, answer, timestamp, streaming, error }
let history = [];
let currentEntryId = null;
const PLACEHOLDER_HTML = els.answerBody.innerHTML; // capture the hotkeys hint

function newEntryId() { return Date.now() + '-' + Math.random().toString(36).slice(2, 6); }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function renderMarkdown(text) {
  return escapeHtml(text)
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br/>');
}
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Search state. Format: optional prefix `typed:` / `screen:` / `heard:` + keywords.
let searchQuery = '';
let searchSource = null;  // null | 'typed' | 'screen' | 'heard'
let searchKeywords = '';  // remainder after source filter

function parseSearch(raw) {
  const q = (raw || '').trim().toLowerCase();
  // `typed:foo` or `typed foo` → source filter + keyword
  const m = q.match(/^(typed|screen|heard)[:\s]+(.*)$/);
  if (m) return { source: m[1], keywords: m[2] };
  // Bare `typed` / `screen` / `heard` → source filter only
  if (['typed', 'screen', 'heard'].includes(q)) return { source: q, keywords: '' };
  return { source: null, keywords: q };
}

function entryMatchesSearch(entry) {
  if (searchSource && entry.source !== searchSource) return false;
  if (!searchKeywords) return true;
  const hay = ((entry.question || '') + ' ' + (entry.answer || '')).toLowerCase();
  return hay.includes(searchKeywords);
}

function highlight(text, needle) {
  if (!needle) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(re, (m) => `<mark>${m}</mark>`);
}

// Chat-bubble layout (option A): question on the right, answer on the left.
function renderBubble(entry) {
  const label = { typed: 'TYPED', screen: 'SCREEN', heard: 'HEARD' }[entry.source] || entry.source.toUpperCase();
  const hidden = !entryMatchesSearch(entry) ? ' hidden-by-search' : '';
  const questionHtml = highlight(entry.question || '', searchKeywords);
  const answerHtml = entry.error
    ? `<span style="color:#ff7070">Error: ${escapeHtml(entry.error)}</span>`
    : renderMarkdownWithHighlight(entry.answer || (entry.streaming ? '…' : ''), searchKeywords);
  return `
    <div class="bubble-pair${hidden}" data-id="${entry.id}">
      <div class="bubble bubble-q source-${entry.source}">
        <div class="bubble-head">
          <span class="badge badge-${entry.source}">${label}</span>
          <span class="ts">${formatTime(entry.timestamp)}</span>
        </div>
        <div>${questionHtml}</div>
      </div>
      <div class="bubble bubble-a${entry.streaming ? ' streaming' : ''}${entry.error ? ' error' : ''}">
        <div>${answerHtml}</div>
        <div class="bubble-actions">
          <button class="card-btn copy" data-action="copy" data-id="${entry.id}">copy</button>
          <button class="card-btn del" data-action="delete" data-id="${entry.id}">×</button>
        </div>
      </div>
    </div>
  `;
}

// To switch to bubble-style (option A), replace this function.
function renderCard(entry) {
  const label = { typed: 'TYPED', screen: 'SCREEN', heard: 'HEARD' }[entry.source] || entry.source.toUpperCase();
  const hidden = !entryMatchesSearch(entry) ? ' hidden-by-search' : '';
  const questionHtml = highlight(entry.question || '', searchKeywords);
  const answerRaw = entry.error
    ? null
    : (entry.answer || (entry.streaming ? '…' : ''));
  const answerHtml = entry.error
    ? `<span style="color:#ff7070">Error: ${escapeHtml(entry.error)}</span>`
    : renderMarkdownWithHighlight(answerRaw, searchKeywords);
  return `
    <article class="card${entry.streaming ? ' streaming' : ''}${entry.error ? ' error' : ''}${hidden}" data-id="${entry.id}">
      <div class="card-head">
        <span class="badge badge-${entry.source}">${label}</span>
        <span class="ts">${formatTime(entry.timestamp)}</span>
        <button class="card-btn copy" data-action="copy" data-id="${entry.id}">copy</button>
        <button class="card-btn del" data-action="delete" data-id="${entry.id}">×</button>
      </div>
      <div class="card-q">${questionHtml}</div>
      <div class="card-a">${answerHtml}</div>
    </article>
  `;
}

// Render markdown, then walk text nodes to wrap matches in <mark> tags.
// Doing it via DOM traversal avoids injecting marks inside tags or code blocks.
function renderMarkdownWithHighlight(text, needle) {
  const html = renderMarkdown(text);
  if (!needle) return html;
  const container = document.createElement('div');
  container.innerHTML = html;
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  for (const node of targets) {
    re.lastIndex = 0;
    if (!re.test(node.nodeValue)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(node.nodeValue))) {
      if (m.index > last) frag.appendChild(document.createTextNode(node.nodeValue.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = re.lastIndex;
    }
    if (last < node.nodeValue.length) frag.appendChild(document.createTextNode(node.nodeValue.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  return container.innerHTML;
}

function renderHistory() {
  if (!history.length) {
    els.answerBody.classList.add('placeholder');
    els.answerBody.innerHTML = PLACEHOLDER_HTML;
    els.historyHeader.hidden = true;
    return;
  }
  els.answerBody.classList.remove('placeholder');
  const renderer = cfg.layout === 'bubbles' ? renderBubble : renderCard;
  els.answerBody.innerHTML = history.map(renderer).join('');
  updateHistoryCount();
  refreshMatches();
  els.historyHeader.hidden = false;

  // Re-bind per-card action buttons (innerHTML wipes listeners each render)
  els.answerBody.querySelectorAll('.card-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const { action, id } = btn.dataset;
      if (action === 'copy') copyEntry(id);
      else if (action === 'delete') deleteEntry(id);
    });
  });
}

function startEntry(source, question) {
  const entry = { id: newEntryId(), source, question, answer: '', timestamp: Date.now(), streaming: true, error: null };
  history.push(entry);
  currentEntryId = entry.id;
  renderHistory();
  scrollToBottom();
}
function updateStreamingAnswer(text) {
  const e = history.find((x) => x.id === currentEntryId);
  if (!e) return;
  e.answer = text;
  renderHistory();
  if (!userScrolledUp) scrollToBottom();
}
function finishEntry(errMsg = null) {
  const e = history.find((x) => x.id === currentEntryId);
  if (e) { e.streaming = false; if (errMsg) e.error = errMsg; }
  currentEntryId = null;
  renderHistory();
}
function copyEntry(id) {
  const e = history.find((x) => x.id === id);
  if (!e) return;
  navigator.clipboard.writeText(e.answer || '');
  setStatus('copied'); setTimeout(() => setStatus(''), 800);
}
function deleteEntry(id) {
  history = history.filter((x) => x.id !== id);
  renderHistory();
}
els.clearAll.addEventListener('click', () => { history = []; currentEntryId = null; renderHistory(); });

// Chip filter (source only). When a chip is active, that overrides the search text's source prefix.
let chipSource = ''; // '' | 'typed' | 'screen' | 'heard'
document.querySelectorAll('#source-chips .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#source-chips .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    chipSource = chip.dataset.source;
    applySearch();
  });
});

function applySearch() {
  const parsed = parseSearch(searchQuery);
  searchSource = chipSource || parsed.source;
  searchKeywords = parsed.keywords;
  renderHistory();
}

// Search — filter cards by keyword. Source filter comes from chip or `typed:` prefix.
els.search.addEventListener('input', () => {
  searchQuery = els.search.value;
  currentMatchIdx = 0; // jump to first match on new query
  applySearch();
});
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { els.search.value = ''; els.search.dispatchEvent(new Event('input')); els.search.blur(); }
});
// Ctrl+F focuses the search box (like Chrome). Local-only shortcut so we can
// listen in the renderer without a global-shortcut round-trip.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    els.search.focus();
    els.search.select();
  }
});

function updateHistoryCount() {
  const visible = history.filter(entryMatchesSearch).length;
  els.historyCount.textContent = (searchQuery ? `${visible}/${history.length}` : history.length);
}

// ---------- Chrome-style match navigation (Enter / Shift+Enter / ↑ ↓) ----------
let matchElements = [];
let currentMatchIdx = -1;

function refreshMatches() {
  matchElements = Array.from(els.answerBody.querySelectorAll('mark'));
  if (!matchElements.length) {
    els.matchNav.hidden = true;
    currentMatchIdx = -1;
    return;
  }
  els.matchNav.hidden = false;
  if (currentMatchIdx >= matchElements.length || currentMatchIdx < 0) currentMatchIdx = 0;
  highlightCurrent();
}

function highlightCurrent() {
  matchElements.forEach((m, i) => m.classList.toggle('current', i === currentMatchIdx));
  els.matchCount.textContent = `${currentMatchIdx + 1}/${matchElements.length}`;
  const cur = matchElements[currentMatchIdx];
  if (cur) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  els.matchPrev.disabled = matchElements.length < 2;
  els.matchNext.disabled = matchElements.length < 2;
}

function stepMatch(delta) {
  if (!matchElements.length) return;
  currentMatchIdx = (currentMatchIdx + delta + matchElements.length) % matchElements.length;
  highlightCurrent();
}

els.matchNext.addEventListener('click', () => stepMatch(+1));
els.matchPrev.addEventListener('click', () => stepMatch(-1));

// Enter in search box → next match; Shift+Enter → previous.
els.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : +1); }
});

// Paced auto-scroll — advances scrollTop at a configured pixels-per-second rate
// so text streaming faster than a human can read doesn't rocket past you.
// The rAF loop runs continuously while there's a scroll debt, so token bursts
// coalesce into smooth motion at the chosen speed.
let userScrolledUp = false;
let scrollRafId = null;
let lastScrollT = 0;

function scheduleScroll() {
  if (scrollRafId !== null || userScrolledUp) return;
  lastScrollT = performance.now();
  const step = (t) => {
    scrollRafId = null;
    if (userScrolledUp) return;
    const target = els.answer.scrollHeight - els.answer.clientHeight;
    const cur = els.answer.scrollTop;
    const remaining = target - cur;
    if (remaining <= 0.5) return; // caught up — stop the loop
    const pxPerSec = SCROLL_SPEEDS[cfg.scrollMode] ?? SCROLL_SPEEDS.medium;
    if (pxPerSec === Infinity) {
      els.answer.scrollTop = target;
      return;
    }
    const dt = Math.max(0, (t - lastScrollT) / 1000);
    lastScrollT = t;
    const advance = Math.min(remaining, pxPerSec * dt);
    els.answer.scrollTop = cur + advance;
    scrollRafId = requestAnimationFrame(step);
  };
  scrollRafId = requestAnimationFrame(step);
}
function scrollToBottom() { scheduleScroll(); }
function updateScrollLock() {
  const nearBottom = els.answer.scrollTop + els.answer.clientHeight >= els.answer.scrollHeight - 24;
  userScrolledUp = !nearBottom;
}
els.answer.addEventListener('wheel', () => setTimeout(updateScrollLock, 0));

// Click anywhere in the answer area (not on a button / link) → focus it so
// keyboard scroll works. This applies whether we're click-through or interactive.
els.answer.addEventListener('mousedown', (e) => {
  if (e.target.closest('button, a, input, textarea, select')) return;
  els.answer.focus();
});

// Global keydown — arrow / PageUp / PageDown / Home / End scroll the answer
// regardless of which part of the app has focus (title bar, empty area, etc.).
// We skip it when the user is typing in an input, textarea, or select.
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

  // Chrome-style "/" shortcut — focus the Ask input from anywhere (except while typing).
  if (!inField && e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    els.prompt.focus();
    els.prompt.select();
    return;
  }

  if (inField) return;
  // If the answer already has focus its own handler will run — don't double-scroll.
  if (document.activeElement === els.answer) return;
  if (handleScrollKey(e.key, e.shiftKey)) e.preventDefault();
});

// Arrow / PageUp / PageDown / Home / End → scroll the answer panel manually.
// Any "scroll up / away from bottom" key immediately pauses auto-scroll (like
// the mouse wheel). "End" jumps to bottom and re-arms auto-scroll.
function handleScrollKey(key, shift) {
  const step = 40;
  const page = els.answer.clientHeight * 0.9;
  let up = false, down = false;
  switch (key) {
    case 'ArrowDown': els.answer.scrollTop += step; down = true; break;
    case 'ArrowUp':   els.answer.scrollTop -= step; up = true; break;
    case 'PageDown':  els.answer.scrollTop += page; down = true; break;
    case 'PageUp':    els.answer.scrollTop -= page; up = true; break;
    case 'Home':      els.answer.scrollTop = 0;                up = true; break;
    case 'End':       els.answer.scrollTop = els.answer.scrollHeight; down = true; break;
    case ' ':         if (shift) { els.answer.scrollTop -= page; up = true; } else { els.answer.scrollTop += page; down = true; } break;
    default: return false;
  }
  // Explicit pause on any upward movement — don't rely on nearBottom tolerance.
  if (up) userScrolledUp = true;
  // Downward: re-check via updateScrollLock so we resume when reaching bottom.
  if (down) setTimeout(() => { updateScrollLock(); if (!userScrolledUp) scheduleScroll(); }, 0);
  return true;
}

els.answer.addEventListener('keydown', (e) => {
  if (handleScrollKey(e.key, e.shiftKey)) e.preventDefault();
});

async function ask(userPrompt, source, extraContext = '') {
  cancelAll();
  currentAbort = new AbortController();
  setGenerating(true);
  userScrolledUp = false;
  startEntry(source, userPrompt);
  setStatus('thinking', true);
  try {
    await askAI(userPrompt, extraContext, updateStreamingAnswer, currentAbort.signal);
    finishEntry();
    setStatus('done'); setTimeout(() => setStatus(''), 1000);
  } catch (e) {
    if (e.name === 'AbortError') { finishEntry(); }
    else { finishEntry(e.message); setStatus('error'); }
  } finally {
    setGenerating(false);
    currentAbort = null;
  }
}

async function askFromInput() {
  const q = els.prompt.value.trim();
  if (!q) return;
  els.prompt.value = '';
  await ask(q, 'typed');
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
  const q = els.prompt.value.trim() || 'Explain what is on screen and answer any visible question directly.';
  els.prompt.value = '';
  startEntry('screen', q);
  try {
    setStatus('capturing', true);
    const raw = await window.api.captureScreen();
    if (signal.aborted) { finishEntry(); return; }
    if (!raw) { finishEntry('could not capture screen'); return; }

    setStatus('shrinking', true);
    const small = await downscale(raw, OCR_MAX_WIDTH);
    if (signal.aborted) { finishEntry(); return; }

    setStatus('OCR', true);
    const worker = await getOcrWorker();
    if (signal.aborted) { finishEntry(); return; }
    const { data: { text } } = await worker.recognize(small);
    if (signal.aborted) { finishEntry(); return; }

    setStatus('thinking', true);
    await askAI(q, text, updateStreamingAnswer, signal);
    finishEntry();
    setStatus('done'); setTimeout(() => setStatus(''), 1000);
  } catch (e) {
    if (e.name === 'AbortError') { finishEntry(); }
    else { finishEntry(e.message); setStatus('error'); }
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
    showTranscript(true);
  } catch (e) {
    renderAnswer(`**Audio error:** ${e.message}`);
    listening = false;
  }
}

function stopListening() {
  listening = false;
  els.listen.textContent = 'idle';
  els.listen.className = 'pill dim';
  showTranscript(false);
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
  const level = rms(samples);
  if (level < VAD_RMS_THRESHOLD) {
    console.log(`[audio] chunk dropped (silence) rms=${level.toFixed(4)}`);
    return;
  }
  console.log(`[audio] chunk sent rms=${level.toFixed(4)} samples=${samples.length}`);
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
  const result = await window.api.transcribe(wavArrayBuffer);
  if (result.error) {
    console.warn(`[whisper] ERROR: ${result.error}`);
  } else {
    console.log(`[whisper] OK: "${(result.text || '').slice(0, 80)}"`);
  }
  if (result.error) {
    // "busy" is expected under CPU load — don't pester the user about it.
    if (result.error.startsWith('busy')) return;
    if (!transcribeErrorShown) {
      transcribeErrorShown = true;
      setStatus(`whisper: ${result.error}`, false);
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

  transcriptEntries.push({ text: cleaned, ts: Date.now() });
  // If the user cleared the strip earlier but is still listening, re-show it as new text arrives.
  if (listening && !transcriptShown) showTranscript(true);
  rebuildTranscriptView();
}
