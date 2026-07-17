// Renderer: overlay UI, audio capture (loopback + mic), OCR, LLM calls.
// All heavy work talks to LOCAL services:
//   - Ollama at http://127.0.0.1:11434  (LLM)
//   - Whisper HTTP server at http://127.0.0.1:9000 (transcription) — see scripts/whisper-server.md

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
const OLLAMA_MODEL = 'llama3.2:3b';
const WHISPER_URL = 'http://127.0.0.1:9000/inference'; // whisper.cpp server endpoint

const els = {
  answer: document.getElementById('answer-body'),
  transcript: document.getElementById('transcript'),
  prompt: document.getElementById('prompt'),
  send: document.getElementById('send'),
  mode: document.getElementById('mode'),
  listen: document.getElementById('listen'),
};

let transcriptBuffer = ''; // rolling transcript from meeting audio
let recorder = null;
let listening = false;
let audioStream = null;

// ---------- UI state ----------
window.api.onInteractiveMode((interactive) => {
  els.mode.textContent = interactive ? 'interactive' : 'click-through';
  els.mode.className = 'pill ' + (interactive ? 'on' : 'dim');
});

window.api.onTriggerScreenAsk(() => askAboutScreen());
window.api.onToggleListen(() => (listening ? stopListening() : startListening()));

els.send.addEventListener('click', () => askFromInput());
els.prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') askFromInput();
});

// ---------- LLM ----------
async function askOllama(prompt, onToken) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: true }),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status} — is 'ollama serve' running and is '${OLLAMA_MODEL}' pulled?`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.response) {
          full += j.response;
          onToken(full);
        }
      } catch {}
    }
  }
  return full;
}

function renderAnswer(text) {
  els.answer.classList.remove('placeholder');
  // Minimal markdown: code fences + bold
  const html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c}</pre>`)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br/>');
  els.answer.innerHTML = html;
}

async function ask(userPrompt, extraContext = '') {
  const context = [
    transcriptBuffer && `# Recent conversation transcript\n${transcriptBuffer.slice(-2000)}`,
    extraContext && `# On-screen text\n${extraContext.slice(-2000)}`,
  ].filter(Boolean).join('\n\n');

  const prompt = `You are a concise study/teaching assistant. Give a direct, correct answer.\n\n${context}\n\n# Question\n${userPrompt}\n\n# Answer`;

  renderAnswer('...thinking');
  try {
    await askOllama(prompt, renderAnswer);
  } catch (e) {
    renderAnswer(`**Error:** ${e.message}`);
  }
}

async function askFromInput() {
  const q = els.prompt.value.trim();
  if (!q) return;
  els.prompt.value = '';
  await ask(q);
}

// ---------- OCR ----------
async function askAboutScreen() {
  renderAnswer('...reading screen');
  const dataUrl = await window.api.captureScreen();
  if (!dataUrl) return renderAnswer('**Error:** could not capture screen');

  const { createWorker } = await import('../../node_modules/tesseract.js/src/index.js').catch(() => require('tesseract.js'));
  const worker = await createWorker('eng');
  const { data: { text } } = await worker.recognize(dataUrl);
  await worker.terminate();

  const question = els.prompt.value.trim() || 'Explain what is on screen and answer any visible question.';
  await ask(question, text);
}

// ---------- Audio (loopback + mic) → Whisper ----------
async function startListening() {
  try {
    // getDisplayMedia is routed by main.js to loopback audio + primary screen.
    let displayStream = null;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      console.warn('display capture failed:', e.message);
    }

    // Mic capture (your own voice)
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn('mic denied:', e.message);
    }

    if (!displayStream && !micStream) {
      throw new Error('No audio sources available. Check Windows mic privacy settings: Settings → Privacy → Microphone → allow desktop apps.');
    }

    // Mix whatever we got into one stream
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    if (displayStream && displayStream.getAudioTracks().length) {
      ctx.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks())).connect(dest);
    }
    if (micStream) {
      ctx.createMediaStreamSource(micStream).connect(dest);
    }

    audioStream = { display: displayStream, mic: micStream, ctx };

    recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      chunks.length = 0;
      transcribeChunk(blob);
      if (listening) {
        recorder.start();
        setTimeout(() => recorder.state === 'recording' && recorder.stop(), 6000);
      }
    };

    listening = true;
    els.listen.textContent = 'listening';
    els.listen.className = 'pill on';
    recorder.start();
    setTimeout(() => recorder.state === 'recording' && recorder.stop(), 6000);
  } catch (e) {
    renderAnswer(`**Mic/audio error:** ${e.message}`);
    listening = false;
  }
}

function stopListening() {
  listening = false;
  els.listen.textContent = 'idle';
  els.listen.className = 'pill dim';
  if (recorder && recorder.state === 'recording') recorder.stop();
  audioStream?.display?.getTracks().forEach((t) => t.stop());
  audioStream?.mic?.getTracks().forEach((t) => t.stop());
  audioStream?.ctx?.close();
  audioStream = null;
}

async function transcribeChunk(blob) {
  try {
    const fd = new FormData();
    fd.append('file', blob, 'chunk.webm');
    fd.append('temperature', '0');
    fd.append('response_format', 'json');

    const res = await fetch(WHISPER_URL, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`Whisper HTTP ${res.status}`);
    const j = await res.json();
    const text = (j.text || '').trim();
    if (!text) return;
    transcriptBuffer += ' ' + text;
    els.transcript.textContent = transcriptBuffer.slice(-1200);
    els.transcript.scrollTop = els.transcript.scrollHeight;
  } catch (e) {
    els.transcript.textContent = `[transcription unavailable: ${e.message}] ` + els.transcript.textContent;
  }
}
