// Gravador de telas — sem dependências externas (o MediaPipe fica em libs/).
import { createCameraProcessor, drawCameraOverlay, cameraBox, EFFECTS, BACKGROUNDS } from './camera-fx.js';
import { loadSettings, saveSettings, kv, recordings, chunks, log, allLogs, usage, askPersistent } from './storage.js';

const $ = (sel) => document.querySelector(sel);

const el = {
  alert: $('#alert'),
  preview: $('#preview'),
  placeholder: $('#placeholder'),
  countdown: $('#countdown'),
  recBadge: $('#recBadge'),
  recLabel: $('#recLabel'),
  timer: $('#timer'),
  recordBtn: $('#recordBtn'),
  pauseBtn: $('#pauseBtn'),
  switchBtn: $('#switchBtn'),
  stopBtn: $('#stopBtn'),
  sysAudio: $('#sysAudio'),
  micAudio: $('#micAudio'),
  micDevice: $('#micDevice'),
  camDevice: $('#camDevice'),
  camBtn: $('#camBtn'),
  floatBtn: $('#floatBtn'),
  camVideo: $('#camVideo'),
  camBtnLabel: $('#camBtnLabel'),
  camLayer: $('#camLayer'),
  camBubble: $('#camBubble'),
  camBubbleCap: $('#camBubbleCap'),
  camPending: $('#camPending'),
  camGoLive: $('#camGoLive'),
  camCancel: $('#camCancel'),
  camSizeOut: $('#camSizeOut'),
  camInVideo: $('#camInVideo'),
  camBg: $('#camBg'),
  camBgFile: $('#camBgFile'),
  camEffect: $('#camEffect'),
  camMirror: $('#camMirror'),
  camStatus: $('#camStatus'),
  camSize: $('#camSize'),
  camShapes: [...document.querySelectorAll('input[name="camShape"]')],
  camCaption: $('#camCaption'),
  micBtn: $('#micBtn'),
  exportBtn: $('#exportBtn'),
  usage: $('#usage'),
  appVersion: $('#appVersion'),
  micLabel: $('#micLabel'),
  format: $('#format'),
  quality: $('#quality'),
  fps: $('#fps'),
  useCountdown: $('#useCountdown'),
  list: $('#list'),
  emptyList: $('#emptyList'),
  itemTpl: $('#itemTpl'),
  installBtn: $('#installBtn'),
  areaRadios: [...document.querySelectorAll('input[name="area"]')],
  bgField: $('#bgField'),
  bg: $('#bg'),
  selector: $('#selector'),
  selStage: $('#selStage'),
  selVideo: $('#selVideo'),
  selCanvas: $('#selCanvas'),
  selHint: $('#selHint'),
  selSize: $('#selSize'),
  selOk: $('#selOk'),
  selRedo: $('#selRedo'),
  selCancel: $('#selCancel'),
  selFull: $('#selFull'),
};

// Formatos em ordem de preferência. MP4 abre em qualquer player/editor;
// o WebM gerado pelo MediaRecorder não traz duração e alguns players não deixam avançar.
const FORMATS = [
  { label: 'MP4 (mais compatível)', mime: 'video/mp4;codecs=avc1,opus', ext: 'mp4' },
  { label: 'MP4 (mais compatível)', mime: 'video/mp4;codecs=avc1,mp4a.40.2', ext: 'mp4' },
  { label: 'MP4 (mais compatível)', mime: 'video/mp4', ext: 'mp4' },
  { label: 'WebM', mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { label: 'WebM', mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { label: 'WebM', mime: 'video/webm', ext: 'webm' },
];

const state = {
  phase: 'idle', // idle | preparing | selecting | countdown | recording | paused
  displayStream: null,
  mixer: null, // { ctx, dest } — áudio da gravação
  micNode: null,
  crop: null, // { track, stop } quando grava só uma área
  cancelSelection: null,
  micStream: null,
  recorder: null,
  chunks: [],
  format: null,
  elapsedMs: 0,
  segmentStart: 0,
  timerId: null,
  cancelCountdown: null,
  camStream: null, // câmera já processada (fundo + efeitos)
  camRaw: null,
  camFx: null,
  pipWindow: null,
  wakeLock: null,
  recordings: 0,
  unsaved: 0, // gravações que não couberam no navegador (só existem nesta aba)
  recId: null,
  pendingWrites: [],
  persistAsked: false,
};

// ---------- utilidades ----------

function showAlert(msg, kind = 'error') {
  el.alert.textContent = msg;
  el.alert.className = 'alert' + (kind === 'warn' ? ' warn' : '');
  el.alert.hidden = false;
  log(kind === 'warn' ? 'aviso' : 'erro', { mensagem: msg });
}
function hideAlert() { el.alert.hidden = true; }

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
function fileName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `gravacao-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}
function elapsed() {
  return state.elapsedMs + (state.phase === 'recording' ? performance.now() - state.segmentStart : 0);
}
function stopStream(s) { s?.getTracks().forEach((t) => t.stop()); }

// ---------- suporte do navegador ----------

const supported = !!(navigator.mediaDevices?.getDisplayMedia && window.MediaRecorder);
if (!supported) {
  showAlert('Seu navegador não permite gravar a tela. Use Chrome, Edge, Firefox ou Safari em um computador.');
  el.recordBtn.disabled = true;
}

const isOk = (mime) => !!window.MediaRecorder?.isTypeSupported?.(mime);
// Um item por rótulo (ex.: só a primeira variante de MP4 H.264 que o navegador aceitar).
const available = FORMATS.filter(
  (f, i, arr) => isOk(f.mime) && arr.findIndex((o) => o.label === f.label && isOk(o.mime)) === i,
);
for (const f of available) el.format.add(new Option(f.label, f.mime));
if (!available.length) el.format.add(new Option('Padrão do navegador', ''));

// ---------- áudio ----------

// Mixador: tudo vira uma única faixa (o MediaRecorder grava uma só e não aceita
// faixas novas depois de começar). Assim o microfone pode entrar e sair durante a gravação.
function createMixer(displayStream) {
  const ctx = new AudioContext();
  ctx.resume().catch(() => {});
  const dest = ctx.createMediaStreamDestination();
  // Sinal inaudível (−80 dB) que mantém a faixa de áudio sempre "viva": com a faixa
  // vazia (sem áudio da tela nem microfone), o Chrome corta o MP4 pela metade.
  const keepAlive = ctx.createOscillator();
  const quiet = ctx.createGain();
  quiet.gain.value = 0.0001;
  keepAlive.connect(quiet).connect(dest);
  keepAlive.start();
  const mixer = {
    ctx,
    dest,
    sysNode: null,
    // Liga (ou troca) o áudio da tela/aba compartilhada.
    setSystem(stream) {
      mixer.sysNode?.disconnect();
      mixer.sysNode = null;
      const sys = stream.getAudioTracks();
      if (sys.length) (mixer.sysNode = ctx.createMediaStreamSource(new MediaStream(sys))).connect(dest);
    },
  };
  mixer.setSystem(displayStream);
  return mixer;
}

const micOn = () => (state.phase === 'idle' ? el.micAudio.checked : !!state.micNode);

function updateMicBtn() {
  const on = micOn();
  el.micBtn.classList.toggle('off', !on);
  el.micBtn.setAttribute('aria-pressed', String(on));
  el.micBtn.title = on ? 'Desligar microfone (M)' : 'Ligar microfone (M)';
  el.micLabel.textContent = on ? 'Mic ligado' : 'Mic desligado';
}

// Liga/desliga o microfone. Durante a gravação, entra/sai do mixador na hora.
async function setMic(on) {
  el.micAudio.checked = on;
  if (state.phase === 'idle' || !state.mixer) { updateMicBtn(); return; }
  if (on && !state.micNode) {
    try {
      state.micStream = await openMic();
      refreshDevices();
    } catch {
      el.micAudio.checked = false;
      showAlert('Sem acesso ao microfone — gravando sem ele.', 'warn');
      updateMicBtn();
      return;
    }
    if (!state.mixer) { stopStream(state.micStream); state.micStream = null; return; } // parou enquanto pedia
    state.micNode = state.mixer.ctx.createMediaStreamSource(state.micStream);
    state.micNode.connect(state.mixer.dest);
  } else if (!on && state.micNode) {
    state.micNode.disconnect();
    state.micNode = null;
    stopStream(state.micStream); // solta o microfone de verdade (some o indicador do sistema)
    state.micStream = null;
  }
  updateMicBtn();
}

// ---------- escolha de câmera e microfone ----------
// Sem permissão, o navegador esconde os nomes dos dispositivos. Nesse caso a lista ganha
// a opção "Mostrar todos…", que pede acesso uma vez e preenche os nomes.

const ASK = '__ask';
const wantedDevice = { camDevice: '', micDevice: '' }; // escolha salva (vale mesmo se o aparelho estiver desconectado)
const MIC_OPTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function fillDevices(select, devices, noun, askLabel) {
  const want = wantedDevice[select.id];
  const real = devices.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const named = real.some((d) => d.label);
  select.replaceChildren(new Option('Padrão do sistema', ''));
  real.forEach((d, i) => select.add(new Option(d.label || `${noun} ${i + 1}`, d.deviceId)));
  if (!named) select.add(new Option(askLabel, ASK));
  if (want && !real.some((d) => d.deviceId === want)) select.add(new Option(`${noun} escolhido (desconectado)`, want));
  select.value = want;
  select.title = select.selectedOptions[0]?.text || '';
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let devices;
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  fillDevices(el.camDevice, devices.filter((d) => d.kind === 'videoinput'), 'Câmera', 'Mostrar todas as câmeras…');
  fillDevices(el.micDevice, devices.filter((d) => d.kind === 'audioinput'), 'Microfone', 'Mostrar todos os microfones…');
}

// Pede acesso só para o navegador liberar os nomes; solta o dispositivo na hora.
async function revealDevices(kind) {
  try {
    stopStream(await navigator.mediaDevices.getUserMedia({ [kind]: true }));
  } catch (err) {
    showAlert(`Sem permissão para listar os dispositivos: ${err.message}`, 'warn');
  }
  await refreshDevices();
}

// Abre o dispositivo escolhido; se ele sumiu, cai no padrão do sistema e avisa.
async function openDevice(kind, id, base) {
  const gum = (c) => navigator.mediaDevices.getUserMedia({ [kind]: c, [kind === 'audio' ? 'video' : 'audio']: false });
  if (!id) return gum(base);
  try {
    return await gum({ ...base, deviceId: { exact: id } });
  } catch (err) {
    if (!['NotFoundError', 'OverconstrainedError', 'NotReadableError'].includes(err.name)) throw err;
    showAlert(`${kind === 'audio' ? 'O microfone' : 'A câmera'} escolhid${kind === 'audio' ? 'o' : 'a'} não está disponível — usando o padrão do sistema.`, 'warn');
    return gum(base);
  }
}
const openMic = () => openDevice('audio', el.micDevice.value, MIC_OPTS);
const openCam = () => openDevice('video', el.camDevice.value, { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' });

// Troca o microfone no meio da gravação sem cortar o áudio: liga o novo e só então solta o antigo.
async function switchMic() {
  if (!state.micNode) return;
  let stream;
  try { stream = await openMic(); } catch (err) { showAlert(`Não foi possível trocar o microfone: ${err.message}`, 'warn'); return; }
  if (!state.mixer || !state.micNode) { stopStream(stream); return; }
  const node = state.mixer.ctx.createMediaStreamSource(stream);
  node.connect(state.mixer.dest);
  state.micNode.disconnect();
  stopStream(state.micStream);
  Object.assign(state, { micNode: node, micStream: stream });
  log('microfone trocado', { dispositivo: stream.getAudioTracks()[0]?.label || '' });
}

async function onDeviceChange(select) {
  if (select.value === ASK) {
    select.value = wantedDevice[select.id];
    await revealDevices(select === el.camDevice ? 'video' : 'audio');
    return;
  }
  wantedDevice[select.id] = select.value;
  select.title = select.selectedOptions[0]?.text || '';
  scheduleSave();
  if (select === el.micDevice) await switchMic();
  else await switchCamera();
}

// ---------- área de gravação (seleção com o mouse) ----------
// A seleção é guardada em coordenadas normalizadas (0–1) em relação ao quadro capturado,
// assim continua certa mesmo se a janela compartilhada mudar de tamanho.

const SHAPE_HINT = {
  rect: 'Arraste para selecionar um retângulo',
  square: 'Arraste para selecionar um quadrado',
  circle: 'Arraste para selecionar um círculo',
  lasso: 'Segure o botão e desenhe o contorno da área',
};

const areaMode = () => el.areaRadios.find((r) => r.checked).value;
const clamp01 = (n) => Math.min(1, Math.max(0, n));

// Desenha o contorno da seleção num contexto onde o quadro inteiro mede W × H.
function tracePath(ctx, sel, W, H) {
  ctx.beginPath();
  if (sel.shape === 'lasso') {
    sel.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    ctx.closePath();
  } else if (sel.shape === 'circle') {
    ctx.ellipse((sel.x + sel.w / 2) * W, (sel.y + sel.h / 2) * H, (sel.w * W) / 2, (sel.h * H) / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.rect(sel.x * W, sel.y * H, sel.w * W, sel.h * H);
  }
}

function selectArea(stream, shape) {
  return new Promise((resolve) => {
    const { selVideo: video, selCanvas: cv } = el;
    const ctx = cv.getContext('2d');
    let box = { width: 1, height: 1 }; // tamanho do vídeo na tela, em px CSS
    let sel = null;
    let start = null;
    let pts = null;

    el.selHint.textContent = SHAPE_HINT[shape];
    el.selector.hidden = false;
    video.srcObject = stream;
    video.play().catch(() => {});

    // Encaixa vídeo e canvas no palco mantendo a proporção da captura.
    function layout() {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw) return;
      const stage = el.selStage.getBoundingClientRect();
      const s = Math.min(stage.width / vw, stage.height / vh);
      const w = vw * s;
      const h = vh * s;
      box = { width: w, height: h };
      const pos = { left: `${(stage.width - w) / 2}px`, top: `${(stage.height - h) / 2}px`, width: `${w}px`, height: `${h}px` };
      Object.assign(video.style, pos);
      Object.assign(cv.style, pos);
      const dpr = devicePixelRatio || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    function draw() {
      ctx.clearRect(0, 0, box.width, box.height);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, box.width, box.height);
      const cur = sel ?? (pts?.length > 1 ? { shape: 'lasso', points: pts } : null);
      if (!cur) return;
      ctx.save();
      tracePath(ctx, cur, box.width, box.height);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fill();
      ctx.restore();
      tracePath(ctx, cur, box.width, box.height);
      ctx.strokeStyle = '#a855f7';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    function refresh() {
      el.selOk.disabled = !sel;
      el.selRedo.disabled = !sel;
      el.selSize.textContent = sel
        ? `${Math.round(sel.w * video.videoWidth)} × ${Math.round(sel.h * video.videoHeight)} px`
        : '';
    }

    const pointAt = (e) => {
      const r = cv.getBoundingClientRect();
      return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
    };

    // Retângulo / quadrado / círculo a partir do ponto inicial e atual.
    function shapeFrom([ax, ay], [bx, by]) {
      const { width: bw, height: bh } = box;
      let dx = (bx - ax) * bw;
      let dy = (by - ay) * bh;
      if (shape === 'square' || shape === 'circle') {
        const maxX = dx >= 0 ? (1 - ax) * bw : ax * bw;
        const maxY = dy >= 0 ? (1 - ay) * bh : ay * bh;
        const s = Math.min(Math.max(Math.abs(dx), Math.abs(dy)), maxX, maxY);
        dx = (dx >= 0 ? 1 : -1) * s;
        dy = (dy >= 0 ? 1 : -1) * s;
      }
      return {
        shape,
        x: Math.min(ax, ax + dx / bw),
        y: Math.min(ay, ay + dy / bh),
        w: Math.abs(dx) / bw,
        h: Math.abs(dy) / bh,
      };
    }

    function lassoFrom(points) {
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { shape: 'lasso', points, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }

    cv.onpointerdown = (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch { /* sem captura, segue */ }
      sel = null;
      start = pointAt(e);
      pts = shape === 'lasso' ? [start] : null;
      refresh();
      draw();
    };
    cv.onpointermove = (e) => {
      if (!start) return;
      const p = pointAt(e);
      if (shape === 'lasso') {
        const last = pts.at(-1);
        if (Math.hypot((p[0] - last[0]) * box.width, (p[1] - last[1]) * box.height) > 3) pts.push(p);
      } else {
        sel = shapeFrom(start, p);
        refresh();
      }
      draw();
    };
    cv.onpointerup = () => {
      if (!start) return;
      start = null;
      if (shape === 'lasso') {
        sel = pts.length > 2 ? lassoFrom(pts) : null;
        pts = null;
      }
      if (sel && (sel.w * box.width < 12 || sel.h * box.height < 12)) sel = null; // clique sem arrastar
      refresh();
      draw();
    };

    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) finish(null);
      else if (e.key === 'Enter' && sel) finish(sel);
    };
    const ro = new ResizeObserver(layout);

    function finish(result) {
      ro.disconnect();
      video.removeEventListener('resize', layout);
      window.removeEventListener('keydown', onKey);
      cv.onpointerdown = cv.onpointermove = cv.onpointerup = null;
      el.selOk.onclick = el.selRedo.onclick = el.selCancel.onclick = el.selFull.onclick = null;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      video.srcObject = null;
      el.selector.hidden = true;
      el.selSize.textContent = '';
      state.cancelSelection = null;
      resolve(result);
    }

    el.selOk.onclick = () => sel && finish(sel);
    el.selCancel.onclick = () => finish(null);
    el.selRedo.onclick = () => { sel = null; refresh(); draw(); };
    el.selFull.onclick = () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else el.selector.requestFullscreen?.().catch(() => {});
    };
    window.addEventListener('keydown', onKey);
    video.addEventListener('resize', layout); // dispara ao carregar e se a captura mudar de tamanho
    ro.observe(el.selStage);
    state.cancelSelection = () => finish(null);
    refresh();
  });
}

const even = (n) => Math.max(2, Math.floor(Math.round(n) / 2) * 2); // H.264 exige dimensões pares

// Retângulo da área em pixels inteiros do quadro (evita reamostrar e borrar o texto).
function pixelRect(sel, W, H) {
  const sw = Math.min(even(sel.w * W), W - (W % 2));
  const sh = Math.min(even(sel.h * H), H - (H % 2));
  const sx = Math.min(Math.round(sel.x * W), W - sw);
  const sy = Math.min(Math.round(sel.y * H), H - sh);
  return { sx, sy, sw, sh };
}

// Tamanho final do vídeo recortado (limitado a 4K).
function outputSize(sel, W, H) {
  const { sw, sh } = pixelRect(sel, W, H);
  const k = Math.min(1, 3840 / sw, 2160 / sh);
  return { width: even(sw * k), height: even(sh * k) };
}

const FULL = { shape: 'rect', x: 0, y: 0, w: 1, h: 1 }; // "área" = quadro inteiro

// Recorta cada quadro na área escolhida; fora de círculo/laço pinta com a cor de fundo.
// overlay(ctx, W, H) desenha por cima (ex.: a câmera dentro do vídeo).
function makeRenderer(sel, bg, createCanvas, overlay) {
  let canvas;
  let ctx;
  const render = (source, W, H) => {
    const { sx, sy, sw, sh } = pixelRect(sel, W, H);
    if (!canvas) {
      const { width, height } = outputSize(sel, W, H);
      canvas = createCanvas(width, height); // tamanho fixo durante a gravação
      ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
    }
    // Normalmente 1:1 (cópia exata dos pixels). Se a janela mudar de tamanho ou a tela for
    // trocada, encaixa mantendo a proporção (sobra vira faixa na cor de fundo).
    const k = Math.min(canvas.width / sw, canvas.height / sh);
    const dx = (canvas.width - sw * k) / 2;
    const dy = (canvas.height - sh * k) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.setTransform(k, 0, 0, k, dx - sx * k, dy - sy * k);
    if (sel.shape === 'circle' || sel.shape === 'lasso') {
      tracePath(ctx, sel, W, H);
      ctx.clip();
    }
    ctx.drawImage(source, sx, sy, sw, sh, sx, sy, sw, sh);
    ctx.restore();
    try { overlay?.(ctx, canvas.width, canvas.height); } catch { /* não derruba a gravação */ }
    return canvas;
  };
  render.setSel = (s) => { sel = s; };
  return render;
}

// Gera a faixa final: recorte da área (ou quadro inteiro) + sobreposições.
// setSource(track, sel) troca a tela de origem sem interromper a faixa gravada.
function composeTrack(srcTrack, sel, bg, fps, overlay) {
  // Chrome/Edge: processa os quadros conforme chegam — continua gravando
  // normalmente mesmo com esta aba em segundo plano.
  if ('MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window) {
    const render = makeRenderer(sel, bg, (w, h) => new OffscreenCanvas(w, h), overlay);
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    generator.contentHint = 'detail';
    const writer = generator.writable.getWriter();
    const step = Math.round(1e6 / fps);
    let current = null; // leitor da tela atual
    let offset = 0; // ajusta o relógio da tela nova para continuar de onde a anterior parou
    let lastTs = null;
    let rebase = false;
    const pump = async (track) => {
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      current = reader;
      for (;;) {
        let r;
        try { r = await reader.read(); } catch { return; }
        if (r.done) return;
        const frame = r.value;
        if (current !== reader) { frame.close(); reader.cancel().catch(() => {}); return; }
        let out = null;
        try {
          if (rebase || lastTs === null) { offset = lastTs === null ? 0 : lastTs + step - frame.timestamp; rebase = false; }
          const ts = Math.max(frame.timestamp + offset, lastTs === null ? 0 : lastTs + 1);
          out = new VideoFrame(render(frame, frame.displayWidth, frame.displayHeight), {
            timestamp: ts,
            ...(frame.duration != null && { duration: frame.duration }),
          });
          lastTs = ts;
        } catch { /* quadro ruim: pula */ } finally {
          frame.close();
        }
        if (out) {
          try { await writer.write(out); } catch { return; } // faixa encerrada
        }
      }
    };
    pump(srcTrack);
    return {
      track: generator,
      setSource(track, newSel) {
        render.setSel(newSel);
        rebase = true;
        const old = current;
        pump(track);
        old?.cancel().catch(() => {});
      },
      stop: () => {
        current?.cancel().catch(() => {});
        current = null;
        generator.stop();
      },
    };
  }

  // Outros navegadores: canvas + captureStream, com o relógio num Worker
  // (timers de Worker não são congelados quando a aba fica em segundo plano).
  const video = document.createElement('video');
  Object.assign(video, { muted: true, playsInline: true, srcObject: new MediaStream([srcTrack]) });
  video.play().catch(() => {});
  const canvasEl = document.createElement('canvas');
  const render = makeRenderer(sel, bg, (w, h) => Object.assign(canvasEl, { width: w, height: h }), overlay);
  const { width, height } = srcTrack.getSettings();
  if (width && height) render(canvasEl, width, height); // fixa o tamanho antes de gravar
  const out = canvasEl.captureStream(fps);
  out.getVideoTracks()[0].contentHint = 'detail';
  const tickUrl = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${Math.round(1000 / fps)})`], { type: 'text/javascript' }));
  const worker = new Worker(tickUrl);
  worker.onmessage = () => video.videoWidth && render(video, video.videoWidth, video.videoHeight);
  return {
    track: out.getVideoTracks()[0],
    setSource(track, newSel) {
      render.setSel(newSel);
      video.srcObject = new MediaStream([track]);
      video.play().catch(() => {});
    },
    stop: () => {
      worker.terminate();
      URL.revokeObjectURL(tickUrl);
      stopStream(out);
      video.srcObject = null;
    },
  };
}

// Bitrate proporcional ao tamanho do vídeo: o valor de "qualidade" é bits por pixel por quadro.
// Ex.: Alta (0,2) → 1080p30 ≈ 12 Mbps; 1440p30 ≈ 22 Mbps; uma área 600×400 ≈ 1,4 Mbps.
function bitrateFor(width, height, fps) {
  const bpp = Number(el.quality.value);
  return Math.round(Math.min(40e6, Math.max(1e6, width * height * fps * bpp)));
}

// ---------- gravação ----------

function pickDisplay(wantSys) {
  return navigator.mediaDevices.getDisplayMedia({
    // Resolução nativa da tela (até 4K), sem o navegador reduzir por conta própria.
    video: { frameRate: { ideal: Number(el.fps.value) }, width: { max: 3840 }, height: { max: 2160 } },
    audio: wantSys
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }
      : false,
    systemAudio: wantSys ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  });
}

const surfaceName = (track) => ({ monitor: 'tela inteira', window: 'janela', browser: 'aba' }[track?.getSettings().displaySurface] ?? 'tela');

// Troca a tela/janela/aba no meio da gravação. Pausa enquanto você escolhe e,
// se a área não for a tela toda, pede para marcar a área de novo na tela nova.
async function switchScreen() {
  if (!(state.phase === 'recording' || state.phase === 'paused') || state.switching || !state.crop) return;
  state.switching = true;
  const resume = state.phase === 'recording';
  if (resume) togglePause();
  setPhase(state.phase);
  let next = null;
  try {
    try {
      next = await pickDisplay(state.wantSys);
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') showAlert(`Não foi possível trocar a tela: ${err.message}`);
      return;
    }
    const track = next.getVideoTracks()[0];
    track.contentHint = 'detail';
    let sel = FULL;
    if (state.area !== 'full') {
      showAlert('Marque a área na tela nova. A gravação está pausada enquanto isso.', 'warn');
      sel = await selectArea(next, state.area);
      hideAlert();
      if (!sel) return; // cancelou: continua na tela anterior
    }
    if (!state.crop || track.readyState === 'ended') return; // parou enquanto escolhia
    const old = state.displayStream;
    old?.getVideoTracks()[0]?.removeEventListener('ended', stopRecording);
    state.crop.setSource(track, sel);
    state.mixer?.setSystem(next);
    track.addEventListener('ended', stopRecording);
    state.displayStream = next;
    next = null; // agora é a tela em uso
    stopStream(old);
    if (state.wantSys && !state.displayStream.getAudioTracks().length) {
      showAlert('A tela nova não compartilhou áudio — o áudio da tela parou. Para gravá-lo, escolha uma aba e marque “Compartilhar áudio”.', 'warn');
    }
    log('tela trocada', { tipo: surfaceName(track), resolucao: `${track.getSettings().width}x${track.getSettings().height}` });
  } finally {
    stopStream(next); // escolheu e desistiu, ou a gravação acabou no meio
    state.switching = false;
    if (resume && state.phase === 'paused') togglePause();
    else setPhase(state.phase);
  }
}

async function startRecording() {
  hideAlert();
  const wantSys = el.sysAudio.checked;
  const wantMic = el.micAudio.checked;

  try {
    state.displayStream = await pickDisplay(wantSys);
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
      showAlert(`Não foi possível capturar a tela: ${err.message}`);
    }
    return;
  }

  state.mixer = createMixer(state.displayStream);
  setPhase('preparing');
  if (wantMic) await setMic(true);
  if (!state.displayStream) return; // compartilhamento encerrado enquanto pedia o microfone

  if (wantSys && !state.displayStream.getAudioTracks().length) {
    showAlert('O áudio da tela não foi compartilhado. Para gravá-lo, escolha uma aba e marque “Compartilhar áudio”.', 'warn');
  }

  // Usuário clicou em "Parar compartilhamento" na barra do navegador.
  const screenTrack = state.displayStream.getVideoTracks()[0];
  screenTrack.addEventListener('ended', stopRecording);
  // "detail" = conteúdo com texto: sob carga, o Chrome reduz fps em vez de resolução.
  screenTrack.contentHint = 'detail';
  if (screenTrack.readyState === 'ended') { cleanup(); return; }

  let videoTrack = screenTrack;
  const fps = Number(el.fps.value);
  const { width: W = 1920, height: H = 1080, frameRate } = screenTrack.getSettings();
  let out = { width: W, height: H };
  const mode = areaMode();
  let sel = null;
  if (mode !== 'full') {
    setPhase('selecting');
    sel = await selectArea(state.displayStream, mode);
    if (!sel || !state.displayStream) { cleanup(); return; }
  }
  // O vídeo é sempre recomposto: assim dá para ligar a câmera e trocar a tela no meio
  // da gravação sem interromper o arquivo (o MediaRecorder não aceita trocar de faixa).
  const now = screenTrack.getSettings();
  out = outputSize(sel ?? FULL, now.width || W, now.height || H);
  state.crop = composeTrack(screenTrack, sel ?? FULL, el.bg.value, fps, cameraOverlay);
  videoTrack = state.crop.track;
  state.area = mode;
  state.wantSys = wantSys;

  const stream = new MediaStream([videoTrack, ...state.mixer.dest.stream.getAudioTracks()]);

  el.preview.srcObject = stream;
  el.preview.play().catch(() => {});
  el.placeholder.hidden = true;

  const mime = el.format.value;
  state.format = FORMATS.find((f) => f.mime === mime) ?? { mime: '', ext: 'webm' };
  try {
    state.recorder = new MediaRecorder(stream, {
      ...(mime && { mimeType: mime }),
      videoBitsPerSecond: bitrateFor(out.width, out.height, Math.min(fps, frameRate || fps)),
      audioBitsPerSecond: 128000,
      // Quadro-chave a cada 2 s: em tela parada o encoder quase não gera quadros-chave, e o MP4
      // só entrega pedaços neles — sem isso, salvar durante a gravação (recuperação) não funciona.
      videoKeyFrameIntervalDuration: 2000,
    });
  } catch (err) {
    showAlert(`O navegador recusou o formato escolhido: ${err.message}`);
    cleanup();
    return;
  }
  state.chunks = [];
  state.pendingWrites = [];
  state.recId = `rec-${Date.now()}`;
  let seq = 0;
  // Cada pedaço (1 s) vai para a memória e para o navegador: se a página recarregar, dá para recuperar.
  state.recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    state.chunks.push(e.data);
    state.pendingWrites.push(chunks.add(state.recId, seq++, e.data).catch(() => {}));
  };
  state.recorder.onstop = finalize;

  setPhase('countdown');
  if (el.useCountdown.checked && !(await countdown(3))) return; // cancelado

  const name = fileName(state.format.ext);
  kv.set(`meta:${state.recId}`, { name, type: state.recorder.mimeType || state.format.mime, created: Date.now() }).catch(() => {});
  log('gravação iniciada', {
    id: state.recId,
    area: mode,
    resolucao: `${out.width}x${out.height}`,
    formato: state.recorder.mimeType || mime,
    qualidade: el.quality.selectedOptions[0].text,
    fps,
    audio_tela: el.sysAudio.checked,
    microfone: !!state.micNode,
    camera: state.camStream ? camLayout.mode : 'desligada',
  });
  state.elapsedMs = 0;
  state.segmentStart = performance.now();
  state.recorder.start(1000);
  setPhase('recording');
  state.timerId = setInterval(() => (el.timer.textContent = fmtTime(elapsed())), 250);
  requestWakeLock();
}

function countdown(n) {
  return new Promise((resolve) => {
    el.countdown.hidden = false;
    el.countdown.textContent = n;
    const id = setInterval(() => {
      n -= 1;
      if (n > 0) { el.countdown.textContent = n; return; }
      clearInterval(id);
      el.countdown.hidden = true;
      state.cancelCountdown = null;
      resolve(true);
    }, 1000);
    state.cancelCountdown = () => {
      clearInterval(id);
      el.countdown.hidden = true;
      state.cancelCountdown = null;
      resolve(false);
    };
  });
}

function togglePause() {
  const rec = state.recorder;
  if (state.phase === 'recording') {
    rec.pause();
    state.elapsedMs += performance.now() - state.segmentStart;
    setPhase('paused');
  } else if (state.phase === 'paused') {
    rec.resume();
    state.segmentStart = performance.now();
    setPhase('recording');
  }
}

function stopRecording() {
  if (state.phase === 'preparing') { cleanup(); return; }
  if (state.phase === 'selecting') {
    state.cancelSelection?.(); // startRecording faz o cleanup
    return;
  }
  if (state.phase === 'countdown') {
    state.cancelCountdown?.();
    cleanup();
    return;
  }
  if (!el.selector.hidden) state.cancelSelection?.(); // marcando a área da tela nova
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.elapsedMs = elapsed();
    state.recorder.stop(); // dispara finalize()
  }
}

function finalize() {
  const duration = state.elapsedMs;
  const type = state.recorder.mimeType || state.format.mime || 'video/webm';
  const blob = new Blob(state.chunks, { type });
  const ext = type.includes('mp4') ? 'mp4' : state.format.ext;
  const { recId: id, pendingWrites } = state;
  cleanup();
  if (!blob.size) { chunks.clear(id).catch(() => {}); return; }
  persistRecording({ id, name: fileName(ext), created: Date.now(), duration, size: blob.size, type, blob }, pendingWrites);
}

function cleanup() {
  clearInterval(state.timerId);
  state.crop?.stop();
  state.crop = null;
  stopStream(state.displayStream);
  stopStream(state.micStream);
  state.micNode?.disconnect();
  state.mixer?.ctx.close().catch(() => {});
  state.wakeLock?.release().catch(() => {});
  Object.assign(state, { displayStream: null, micStream: null, micNode: null, mixer: null, recorder: null, chunks: [], wakeLock: null });
  el.preview.srcObject = null;
  el.placeholder.hidden = false;
  el.timer.textContent = '00:00';
  setPhase('idle');
}

function setPhase(phase) {
  state.phase = phase;
  // Fora da gravação a prévia já mostra o resultado: a câmera em prévia passa a valer.
  if (phase === 'idle' && state.camStream) state.camLive = true;
  const busy = phase !== 'idle';
  el.recordBtn.disabled = busy || !supported;
  el.pauseBtn.disabled = !(phase === 'recording' || phase === 'paused') || !!state.switching;
  el.switchBtn.disabled = !(phase === 'recording' || phase === 'paused') || !!state.switching;
  el.stopBtn.disabled = !busy;
  el.pauseBtn.textContent = phase === 'paused' ? 'Continuar' : 'Pausar';
  el.recBadge.hidden = !(phase === 'recording' || phase === 'paused');
  el.recBadge.classList.toggle('paused', phase === 'paused');
  el.recLabel.textContent = phase === 'paused' ? 'PAUSADO' : 'REC';
  for (const c of [el.sysAudio, el.micAudio, el.format, el.quality, el.fps, el.useCountdown, el.bg, ...el.areaRadios]) c.disabled = busy;
  updateMicBtn();
  layoutBubble();
  document.title = phase === 'recording' ? '● Gravando — Gravador de telas' : 'Gravador de telas';
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* opcional */ }
}

// ---------- lista de gravações ----------

// rec = { id, name, created, duration, size, type, blob, recovered?, width?, height? }
// saved = false quando não deu para guardar no navegador (aí só existe nesta aba).
function addRecording(rec, saved = true) {
  const url = URL.createObjectURL(rec.blob);
  const li = el.itemTpl.content.firstElementChild.cloneNode(true);
  li.querySelector('video').src = url;
  li.querySelector('.rec-name').textContent = rec.name;
  const info = li.querySelector('.rec-info');
  const when = new Date(rec.created).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const tags = [rec.recovered && 'recuperada', !saved && 'não salva — baixe antes de fechar'].filter(Boolean);
  const render = (dims) => {
    info.textContent = [when, rec.duration ? fmtTime(rec.duration) : null, dims, fmtSize(rec.size), ...tags]
      .filter(Boolean).join(' · ');
  };
  render(rec.width ? `${rec.width}×${rec.height}` : null);
  li.querySelector('video').addEventListener('loadedmetadata', async (e) => {
    const { videoWidth: width, videoHeight: height } = e.target;
    render(`${width}×${height}`);
    if (saved && !rec.width && width) { // guarda as dimensões para o histórico
      Object.assign(rec, { width, height });
      recordings.put(rec).catch(() => {});
    }
  }, { once: true });
  const a = li.querySelector('.rec-download');
  a.href = url;
  a.download = rec.name;
  li.querySelector('.rec-delete').addEventListener('click', async () => {
    if (!confirm('Excluir esta gravação? Ela será apagada deste navegador e não poderá ser recuperada.')) return;
    try { await recordings.del(rec.id); } catch { /* não estava salva */ }
    log('gravação excluída', { id: rec.id, nome: rec.name });
    URL.revokeObjectURL(url);
    li.remove();
    state.recordings -= 1;
    if (!saved) state.unsaved -= 1;
    el.emptyList.hidden = state.recordings > 0;
    showUsage();
  });
  el.list.prepend(li);
  state.recordings += 1;
  if (!saved) state.unsaved += 1;
  el.emptyList.hidden = true;
}

// Guarda a gravação terminada no navegador e apaga os pedaços temporários.
async function persistRecording(rec, pendingWrites) {
  let saved = true;
  try {
    await Promise.allSettled(pendingWrites);
    await recordings.put(rec);
    await chunks.clear(rec.id);
    await kv.del(`meta:${rec.id}`);
    if (!state.persistAsked) { state.persistAsked = true; askPersistent(); }
  } catch {
    saved = false;
    showAlert('Não foi possível salvar a gravação no navegador (sem espaço ou modo privado). Baixe-a antes de fechar a página.', 'warn');
  }
  addRecording(rec, saved);
  log('gravação concluída', { id: rec.id, nome: rec.name, duracao_s: Math.round(rec.duration / 1000), tamanho_bytes: rec.size, salva: saved });
  showUsage();
}

// Ao abrir a página: recupera gravações interrompidas e lista as salvas.
async function loadRecordings() {
  try {
    for (const id of await chunks.pendingIds()) {
      const parts = await chunks.of(id);
      const meta = (await kv.get(`meta:${id}`)) ?? {};
      if (parts.length) {
        const type = meta.type || parts[0].type || 'video/webm';
        const blob = new Blob(parts, { type });
        await recordings.put({
          id, blob, type, size: blob.size, recovered: true,
          name: meta.name || `gravacao-recuperada-${id}.${type.includes('mp4') ? 'mp4' : 'webm'}`,
          created: meta.created || Date.now(), duration: 0,
        });
        log('gravação recuperada', { id, nome: meta.name, pedacos: parts.length });
      }
      await chunks.clear(id);
      await kv.del(`meta:${id}`);
    }
    const all = await recordings.all();
    all.sort((a, b) => a.created - b.created).forEach((r) => addRecording(r));
  } catch {
    el.emptyList.textContent = 'Este navegador não permite guardar gravações (modo privado?). Baixe cada vídeo antes de fechar a página.';
  }
  showUsage();
}

async function showUsage() {
  const u = await usage();
  el.usage.textContent = u && u.quota
    ? `Espaço usado neste navegador: ${fmtSize(u.used)} de ${fmtSize(u.quota)} disponíveis.`
    : '';
}

// Exporta configurações, lista de gravações (sem os vídeos) e histórico em JSON.
async function exportJson() {
  let recs = [];
  try { recs = await recordings.all(); } catch { /* sem banco */ }
  const data = {
    app: 'Gravador de telas',
    versao: self.APP_VERSION || '0.0.0',
    exportado_em: new Date().toISOString(),
    configuracoes: currentSettings(),
    gravacoes: recs.map(({ blob, ...meta }) => meta),
    historico: await allLogs(),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `gravador-historico-${fileName('json').slice(9)}` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- câmera ----------

for (const [value, label] of Object.entries(BACKGROUNDS)) el.camBg.add(new Option(label, value));
for (const [value, { label }] of Object.entries(EFFECTS)) el.camEffect.add(new Option(label, value));

let customImage = null;
let lastBg = 'none';
const camOptions = () => ({
  background: el.camBg.value,
  effect: el.camEffect.value,
  mirror: el.camMirror.checked,
  customImage,
});
function camStatus(msg) {
  el.camStatus.textContent = msg;
  el.camStatus.hidden = !msg;
}

// A câmera é desenhada dentro do vídeo. Na prévia, uma bolha mostra exatamente onde
// ela vai sair; arraste para mover e use a rodinha para mudar o tamanho.
// size = fração da menor dimensão do vídeo; cx/cy = centro da câmera (0–1).
const camLayout = { mode: 'video', shape: 'circle', size: 0.28, cx: 1, cy: 1, caption: '' };

function readCamLayout() {
  Object.assign(camLayout, {
    mode: el.camInVideo.checked ? 'video' : 'float',
    shape: el.camShapes.find((r) => r.checked)?.value ?? 'circle',
    size: Number(el.camSize.value) / 100,
    caption: el.camCaption.value.trim(),
  });
  el.camSizeOut.textContent = `${el.camSize.value}%`;
  layoutBubble();
  updatePip();
}

// Área do vídeo dentro da prévia (o vídeo usa object-fit: contain).
function contentRect() {
  const box = el.preview.parentElement.getBoundingClientRect();
  const { videoWidth: vw, videoHeight: vh } = el.preview;
  const ratio = el.preview.srcObject && vw && vh ? vw / vh : 16 / 9;
  let width = box.width;
  let height = width / ratio;
  if (height > box.height) { height = box.height; width = height * ratio; }
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

// Posiciona a bolha na prévia com a mesma conta usada na gravação (cameraBox).
function layoutBubble() {
  const show = !!state.camStream && camLayout.mode === 'video';
  el.camLayer.hidden = !show;
  el.camPending.hidden = !show || state.camLive;
  if (!show) return;
  const r = contentRect();
  Object.assign(el.camLayer.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  const b = cameraBox(r.width, r.height, camLayout);
  Object.assign(el.camBubble.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px` });
  el.camBubble.style.setProperty('--cam-h', `${b.h}px`); // variável CSS só funciona via setProperty
  el.camBubble.dataset.shape = camLayout.shape;
  el.camBubbleCap.textContent = b.caption;
  el.camBubbleCap.hidden = !b.caption;
  Object.assign(el.camBubbleCap.style, { fontSize: `${b.fs}px`, height: `${b.pillH}px`, marginTop: `${b.gap}px` });
  // Gravando: a câmera de verdade já está no vídeo da prévia; a bolha vira só um contorno para arrastar.
  // Em prévia (ligada no meio da gravação), mostra a imagem de verdade até você confirmar.
  el.camBubble.classList.toggle('ghost', !!state.crop && state.camLive);
  el.camBubble.classList.toggle('pending', !state.camLive);
}

// Liga a câmera no meio da gravação: até confirmar, ela aparece só na prévia.
function goLiveCamera() {
  if (!state.camStream || state.camLive) return;
  state.camLive = true;
  log('câmera colocada no vídeo', { formato: camLayout.shape, tamanho: `${Math.round(camLayout.size * 100)}%` });
  layoutBubble();
}

let camDrag = null;
el.camBubble.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  try { el.camBubble.setPointerCapture(e.pointerId); } catch { /* segue sem captura */ }
  const br = el.camBubble.getBoundingClientRect();
  const frameH = parseFloat(el.camBubble.style.getPropertyValue('--cam-h')) || br.width;
  camDrag = { dx: e.clientX - (br.left + br.width / 2), dy: e.clientY - (br.top + frameH / 2) };
  el.camBubble.classList.add('dragging');
});
el.camBubble.addEventListener('pointermove', (e) => {
  if (!camDrag) return;
  const lr = el.camLayer.getBoundingClientRect();
  camLayout.cx = clamp01((e.clientX - camDrag.dx - lr.left) / lr.width);
  camLayout.cy = clamp01((e.clientY - camDrag.dy - lr.top) / lr.height);
  layoutBubble();
});
const endCamDrag = () => {
  if (!camDrag) return;
  camDrag = null;
  el.camBubble.classList.remove('dragging');
  // guarda a posição já "encaixada" dentro do quadro
  const lr = el.camLayer.getBoundingClientRect();
  const b = cameraBox(lr.width, lr.height, camLayout);
  camLayout.cx = (b.x + b.w / 2) / lr.width;
  camLayout.cy = (b.y + b.h / 2) / lr.height;
  scheduleSave();
};
el.camBubble.addEventListener('pointerup', endCamDrag);
el.camBubble.addEventListener('pointercancel', endCamDrag);
el.camBubble.addEventListener('wheel', (e) => {
  e.preventDefault();
  const step = e.deltaY < 0 ? 2 : -2;
  el.camSize.value = Math.min(60, Math.max(10, Number(el.camSize.value) + step));
  readCamLayout();
  scheduleSave();
}, { passive: false });
new ResizeObserver(layoutBubble).observe(el.preview.parentElement);
el.preview.addEventListener('resize', layoutBubble);
el.preview.addEventListener('loadedmetadata', layoutBubble);

// Chamado a cada quadro da gravação (ver composeTrack).
function cameraOverlay(ctx, W, H) {
  if (camLayout.mode !== 'video' || !state.camFx || !state.camLive) return;
  const src = state.camFx.source();
  if (src) drawCameraOverlay(ctx, W, H, src, camLayout);
}

async function toggleCamera() {
  if (state.camStream) { stopCamera(); return; }
  try {
    state.camRaw = await openCam();
    refreshDevices();
  } catch (err) {
    showAlert(`Não foi possível acessar a câmera: ${err.message}`);
    return;
  }
  // A imagem que aparece (prévia e janela flutuante) já sai com fundo e efeitos.
  state.camFx = createCameraProcessor(state.camRaw.getVideoTracks()[0], camOptions(), camStatus);
  state.camStream = new MediaStream([state.camFx.track]);
  // Parado: a prévia já é o que vai sair. Gravando: fica só na prévia até "Colocar no vídeo".
  state.camLive = !(state.phase === 'recording' || state.phase === 'paused');
  el.camVideo.srcObject = state.camStream;
  el.camBtnLabel.textContent = 'Remover câmera do vídeo';
  el.camBtn.classList.add('active');
  el.floatBtn.disabled = false;
  readCamLayout();
}

// Troca a câmera ao vivo (inclusive gravando): a gravação lê sempre state.camFx a cada quadro.
async function switchCamera() {
  if (!state.camStream) return;
  let raw;
  try { raw = await openCam(); } catch (err) { showAlert(`Não foi possível trocar a câmera: ${err.message}`, 'warn'); return; }
  if (!state.camStream) { stopStream(raw); return; } // desligou enquanto abria
  const old = { fx: state.camFx, raw: state.camRaw, stream: state.camStream };
  const fx = createCameraProcessor(raw.getVideoTracks()[0], camOptions(), camStatus);
  const stream = new MediaStream([fx.track]);
  Object.assign(state, { camFx: fx, camRaw: raw, camStream: stream });
  el.camVideo.srcObject = stream;
  const pipVideo = state.pipWindow?.document.querySelector('video');
  if (pipVideo) pipVideo.srcObject = stream;
  old.fx?.stop();
  stopStream(old.raw);
  stopStream(old.stream);
  log('câmera trocada', { dispositivo: raw.getVideoTracks()[0]?.label || '' });
}

function stopCamera() {
  state.pipWindow?.close();
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  state.camFx?.stop();
  stopStream(state.camRaw);
  stopStream(state.camStream);
  Object.assign(state, { camFx: null, camRaw: null, camStream: null, camLive: false });
  camStatus('');
  el.camVideo.srcObject = null;
  el.camBtnLabel.textContent = 'Mostrar câmera no vídeo';
  el.camBtn.classList.remove('active');
  el.floatBtn.disabled = true;
  layoutBubble();
}

const PIP_CSS = `
html,body{margin:0;height:100%;overflow:hidden;background:#0d0e1c}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:10px;box-sizing:border-box}
video{display:block;object-fit:cover;background:#000;min-height:0;max-width:100%}
.circle video,.square video{flex:1 1 0;aspect-ratio:1/1;border:3px solid #fff}
.circle video{border-radius:50%}
.square video{border-radius:14%}
.rect video{width:100%;aspect-ratio:16/9;border-radius:12px}
.cap{flex:none;max-width:100%;padding:6px 14px;border-radius:999px;background:rgba(17,14,40,.85);color:#fff;
  font:600 15px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cap:empty{display:none}`;

// Atualiza formato e legenda da janela flutuante, se aberta.
function updatePip() {
  const win = state.pipWindow;
  if (!win) return;
  win.document.body.className = camLayout.shape;
  win.document.querySelector('.cap').textContent = camLayout.caption;
}

async function floatCamera() {
  if (!state.camStream) return;
  try {
    // Document Picture-in-Picture (Chrome/Edge 116+): janela sempre no topo e sem controles.
    if ('documentPictureInPicture' in window) {
      if (state.pipWindow) { state.pipWindow.close(); return; }
      const rect = camLayout.shape === 'rect';
      const win = await documentPictureInPicture.requestWindow({
        width: rect ? 400 : 280,
        height: (rect ? 225 : 280) + (camLayout.caption ? 44 : 0),
      });
      const style = win.document.createElement('style');
      style.textContent = PIP_CSS;
      win.document.head.append(style);
      win.document.title = 'Câmera';
      const v = win.document.createElement('video');
      Object.assign(v, { autoplay: true, muted: true, playsInline: true, srcObject: state.camStream });
      const cap = win.document.createElement('div');
      cap.className = 'cap';
      win.document.body.append(v, cap);
      win.addEventListener('pagehide', () => { state.pipWindow = null; el.floatBtn.textContent = 'Abrir janela flutuante'; });
      state.pipWindow = win;
      updatePip();
      el.floatBtn.textContent = 'Fechar janela flutuante';
    } else if (document.pictureInPictureEnabled) {
      // Fallback: Picture-in-Picture clássico do elemento <video>.
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.camVideo.requestPictureInPicture();
    } else {
      showAlert('Seu navegador não suporta janela flutuante. Use Chrome ou Edge.', 'warn');
    }
  } catch (err) {
    showAlert(`Não foi possível abrir a janela flutuante: ${err.message}`);
  }
}

// ---------- eventos ----------

el.recordBtn.addEventListener('click', startRecording);
el.pauseBtn.addEventListener('click', togglePause);
el.switchBtn.addEventListener('click', switchScreen);
el.camGoLive.addEventListener('click', goLiveCamera);
el.camCancel.addEventListener('click', stopCamera);
el.stopBtn.addEventListener('click', stopRecording);
el.camBtn.addEventListener('click', toggleCamera);
el.camBg.addEventListener('change', () => {
  if (el.camBg.value === 'custom') {
    el.camBgFile.click(); // escolhe a imagem; se cancelar, volta ao fundo anterior
    el.camBg.value = customImage ? 'custom' : lastBg;
    if (!customImage) return;
  }
  lastBg = el.camBg.value;
  state.camFx?.setOptions(camOptions());
});
el.camBgFile.addEventListener('change', async () => {
  const file = el.camBgFile.files[0];
  el.camBgFile.value = '';
  if (!file) return;
  try {
    customImage = await createImageBitmap(file);
  } catch {
    showAlert('Não foi possível abrir essa imagem.', 'warn');
    return;
  }
  el.camBg.value = lastBg = 'custom';
  kv.set('customBg', file).catch(() => {}); // lembra a imagem para a próxima vez
  scheduleSave();
  state.camFx?.setOptions(camOptions());
});
el.camEffect.addEventListener('change', () => state.camFx?.setOptions(camOptions()));
el.camMirror.addEventListener('change', () => state.camFx?.setOptions(camOptions()));
el.floatBtn.addEventListener('click', floatCamera);
for (const c of [el.camInVideo, ...el.camShapes]) c.addEventListener('change', readCamLayout);
for (const c of [el.camSize, el.camCaption]) c.addEventListener('input', readCamLayout);
el.micBtn.addEventListener('click', () => setMic(!micOn()));
el.micAudio.addEventListener('change', updateMicBtn);
for (const c of [el.camDevice, el.micDevice]) c.addEventListener('change', () => onDeviceChange(c));
navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
// Atalho: M liga/desliga o microfone (fora de campos de texto).
window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'm' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, select, textarea') || !el.selector.hidden) return;
  setMic(!micOn());
});
el.exportBtn.addEventListener('click', exportJson);

// ---------- ajuda ----------
// "?" de cada parte abre um balão com o resumo (o .help-short da seção do guia);
// "Ajuda" no topo (ou ? / F1) abre o guia completo. Um texto só, nos dois lugares.

const help = {
  dialog: $('#helpDialog'),
  pop: $('#helpPop'),
  btn: null, // botão "?" com o balão aberto
};

function openHelp(key) {
  closeHelpPop();
  if (!help.dialog.open) help.dialog.showModal();
  const sec = key && document.getElementById(`ajuda-${key}`);
  const body = help.dialog.querySelector('.help-body');
  if (sec) {
    body.scrollTo({ top: sec.offsetTop - body.offsetTop, behavior: 'instant' });
    sec.classList.add('flash');
    setTimeout(() => sec.classList.remove('flash'), 1200);
  } else {
    body.scrollTo({ top: 0, behavior: 'instant' });
  }
  log('ajuda aberta', { secao: key || 'geral' });
}

function closeHelpPop() {
  help.pop.hidden = true;
  help.btn?.setAttribute('aria-expanded', 'false');
  help.btn = null;
}

function toggleHelpPop(btn) {
  if (help.btn === btn) { closeHelpPop(); return; }
  closeHelpPop();
  const sec = document.getElementById(`ajuda-${btn.dataset.help}`);
  if (!sec) { openHelp(); return; }
  help.pop.querySelector('.help-pop-title').textContent = sec.querySelector('h3').textContent;
  help.pop.querySelector('.help-pop-body').replaceChildren(sec.querySelector('.help-short').cloneNode(true));
  help.pop.querySelector('.help-pop-more').onclick = () => openHelp(btn.dataset.help);
  help.pop.hidden = false;
  // abaixo do botão; se não couber, acima
  const r = btn.getBoundingClientRect();
  const w = help.pop.offsetWidth;
  const h = help.pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  const top = r.bottom + 8 + h > innerHeight ? Math.max(8, r.top - 8 - h) : r.bottom + 8;
  Object.assign(help.pop.style, { left: `${left}px`, top: `${top}px` });
  btn.setAttribute('aria-expanded', 'true');
  help.btn = btn;
  help.pop.querySelector('.help-pop-more').focus({ preventScroll: true });
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('.help-btn');
  if (b) { e.preventDefault(); toggleHelpPop(b); return; }
  if (help.btn && !help.pop.contains(e.target)) closeHelpPop();
});
$('#helpBtn').addEventListener('click', () => openHelp());
$('#helpClose').addEventListener('click', () => help.dialog.close());
help.dialog.addEventListener('click', (e) => { if (e.target === help.dialog) help.dialog.close(); }); // clique fora
help.dialog.querySelector('.help-nav').addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#ajuda-"]');
  if (!a) return;
  e.preventDefault(); // não mexe na URL da página
  openHelp(a.getAttribute('href').slice('#ajuda-'.length));
});
addEventListener('scroll', closeHelpPop, { passive: true });
addEventListener('resize', closeHelpPop);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && help.btn) { const b = help.btn; closeHelpPop(); b.focus(); return; }
  if (e.target.closest?.('input, select, textarea') || !el.selector.hidden) return;
  if (e.key === 'F1' || (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey)) {
    e.preventDefault();
    openHelp();
  }
});

// ---------- configurações salvas ----------

const FIELDS = {
  sysAudio: 'checked', micAudio: 'checked', useCountdown: 'checked', camMirror: 'checked',
  format: 'value', quality: 'value', fps: 'value', bg: 'value',
  camBg: 'value', camEffect: 'value', camSize: 'value', camCaption: 'value', camInVideo: 'checked',
};

function currentSettings() {
  const s = Object.fromEntries(Object.entries(FIELDS).map(([id, prop]) => [id, el[id][prop]]));
  s.area = areaMode();
  s.camShape = camLayout.shape;
  s.camX = Math.round(camLayout.cx * 1000) / 1000;
  s.camY = Math.round(camLayout.cy * 1000) / 1000;
  Object.assign(s, wantedDevice);
  return s;
}

async function applySettings(s) {
  for (const [id, prop] of Object.entries(FIELDS)) {
    if (!(id in s)) continue;
    const c = el[id];
    if (c.tagName === 'SELECT' && ![...c.options].some((o) => o.value === s[id])) continue; // opção não existe aqui
    if (c.type === 'range' && !Number.isFinite(Number(s[id]))) continue; // valor de versão antiga
    c[prop] = s[id];
  }
  for (const r of el.areaRadios) r.checked = r.value === (s.area ?? 'full');
  for (const r of el.camShapes) r.checked = r.value === (s.camShape ?? 'circle');
  for (const k of Object.keys(wantedDevice)) if (typeof s[k] === 'string' && s[k] !== ASK) wantedDevice[k] = s[k];
  if (Number.isFinite(s.camX)) camLayout.cx = s.camX;
  if (Number.isFinite(s.camY)) camLayout.cy = s.camY;
  if (s.camBg === 'custom') {
    try {
      const file = await kv.get('customBg');
      customImage = file ? await createImageBitmap(file) : null;
    } catch { customImage = null; }
    if (!customImage) el.camBg.value = 'none';
  }
  lastBg = el.camBg.value;
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(currentSettings()), 300);
}
document.addEventListener('change', (e) => e.target !== el.camBgFile && scheduleSave());
el.camCaption.addEventListener('input', scheduleSave);

// ---------- inicialização ----------

// Versão vem do version.js (gerado pelo publicar.sh); 0.0.0 = cópia local não publicada.
function showVersion() {
  const v = self.APP_VERSION || '0.0.0';
  const pill = el.appVersion;
  if (v === '0.0.0') {
    pill.textContent = 'dev';
    pill.title = 'Cópia local, ainda não publicada';
  } else {
    pill.textContent = `v${v}`;
    const when = self.APP_RELEASED ? ` · publicada em ${new Date(self.APP_RELEASED).toLocaleDateString('pt-BR')}` : '';
    pill.title = `Versão ${v}${when} — ver no GitHub`;
    pill.href = `https://github.com/soaresnetoh/gravador-de-telas/releases/tag/v${v}`;
  }
  pill.hidden = false;
}

(async () => {
  showVersion();
  await applySettings(loadSettings());
  el.bgField.hidden = !['circle', 'lasso'].includes(areaMode());
  document.querySelector('#audioHint').hidden = !el.sysAudio.checked;
  readCamLayout();
  updateMicBtn();
  refreshDevices();
  loadRecordings();
})();
for (const r of el.areaRadios) {
  r.addEventListener('change', () => (el.bgField.hidden = !['circle', 'lasso'].includes(areaMode())));
}
el.sysAudio.addEventListener('change',() => (document.querySelector('#audioHint').hidden = !el.sysAudio.checked));

window.addEventListener('beforeunload', (e) => {
  if (state.phase !== 'idle' || state.unsaved > 0) e.preventDefault();
});

// ---------- PWA ----------

let installPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  el.installBtn.hidden = false;
});
el.installBtn.addEventListener('click', async () => {
  el.installBtn.hidden = true;
  await installPrompt?.prompt();
  installPrompt = null;
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
