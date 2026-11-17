// Efeitos da câmera: plano de fundo (desfoque/imagem/cor) e filtros.
// O recorte da pessoa usa o MediaPipe Selfie Segmenter, rodando localmente no navegador.

const MP_DIR = new URL('./libs/mediapipe/', import.meta.url).href;

export const EFFECTS = {
  none: { label: 'Nenhum', filter: 'none' },
  bw: { label: 'Preto e branco', filter: 'grayscale(1) contrast(1.1)' },
  noir: { label: 'Noir', filter: 'grayscale(1) contrast(1.6) brightness(.9)' },
  sepia: { label: 'Sépia', filter: 'sepia(.85)' },
  vintage: { label: 'Vintage', filter: 'sepia(.4) contrast(1.1) saturate(.8) brightness(1.05)' },
  vivid: { label: 'Cores vivas', filter: 'saturate(1.6) contrast(1.1)' },
  warm: { label: 'Quente', filter: 'sepia(.25) saturate(1.3) hue-rotate(-10deg)' },
  cool: { label: 'Frio', filter: 'saturate(1.1) hue-rotate(15deg) brightness(1.05)' },
  bright: { label: 'Mais claro', filter: 'brightness(1.25) contrast(1.05)' },
};

export const BACKGROUNDS = {
  none: 'Original',
  blur: 'Desfocar',
  'blur-strong': 'Desfocar forte',
  studio: 'Estúdio',
  sunset: 'Pôr do sol',
  ocean: 'Oceano',
  bokeh: 'Luzes (bokeh)',
  chroma: 'Verde (chroma key)',
  custom: 'Minha imagem…',
};

// ---------- fundos desenhados (sem baixar imagens) ----------

function presetBackground(name) {
  const c = new OffscreenCanvas(1280, 720);
  const g = c.getContext('2d');
  const lin = (stops) => {
    const gr = g.createLinearGradient(0, 0, 0, 720);
    stops.forEach(([o, col]) => gr.addColorStop(o, col));
    return gr;
  };
  if (name === 'studio') {
    const gr = g.createRadialGradient(640, 300, 50, 640, 360, 800);
    gr.addColorStop(0, '#5a5f6b');
    gr.addColorStop(1, '#16181d');
    g.fillStyle = gr;
  } else if (name === 'sunset') {
    g.fillStyle = lin([[0, '#2b1055'], [0.5, '#d53369'], [1, '#ffb88c']]);
  } else if (name === 'ocean') {
    g.fillStyle = lin([[0, '#0f2027'], [0.5, '#203a43'], [1, '#2c7da0']]);
  } else if (name === 'chroma') {
    g.fillStyle = '#00b140';
  } else if (name === 'bokeh') {
    g.fillStyle = lin([[0, '#1a1a2e'], [1, '#16213e']]);
    g.fillRect(0, 0, 1280, 720);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.filter = 'blur(6px)';
    for (let i = 0; i < 45; i++) {
      g.fillStyle = `hsla(${30 + rnd() * 40}, 90%, ${55 + rnd() * 25}%, ${0.15 + rnd() * 0.35})`;
      g.beginPath();
      g.arc(rnd() * 1280, rnd() * 720, 20 + rnd() * 70, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }
  g.fillRect(0, 0, 1280, 720);
  return c;
}

// ---------- segmentação ----------

let segmenterPromise;
function loadSegmenter() {
  segmenterPromise ??= (async () => {
    const { FilesetResolver, ImageSegmenter } = await import(`${MP_DIR}vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP_DIR}wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: `${MP_DIR}selfie_segmenter.tflite`, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    try {
      return await ImageSegmenter.createFromOptions(fileset, opts('GPU'));
    } catch {
      return ImageSegmenter.createFromOptions(fileset, opts('CPU'));
    }
  })();
  segmenterPromise.catch(() => (segmenterPromise = null)); // permite tentar de novo
  return segmenterPromise;
}

// ---------- câmera dentro do vídeo ----------

/**
 * Posição e tamanho da câmera num quadro W × H — usado pelo vídeo gravado e pela bolha
 * arrastável na prévia, para os dois ficarem idênticos.
 * layout: { shape: 'circle'|'square'|'rect', size: fração da menor dimensão (0.1–0.6),
 *           cx, cy: centro da câmera (0–1), caption }
 */
export function cameraBox(W, H, layout) {
  const base = Math.max(8, Math.round(Math.min(W, H) * (layout.size || 0.28)));
  const h = base;
  const w = layout.shape === 'rect' ? Math.round((base * 16) / 9) : base;
  const margin = Math.round(Math.min(W, H) * 0.02);
  const caption = (layout.caption || '').trim();
  const fs = Math.max(10, Math.round(base * 0.1));
  const pillH = Math.round(fs * 1.9);
  const gap = Math.round(fs * 0.5);
  const blockH = h + (caption ? gap + pillH : 0);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const x = Math.round(clamp((layout.cx ?? 1) * W - w / 2, margin, W - margin - w));
  const y = Math.round(clamp((layout.cy ?? 1) * H - h / 2, margin, H - margin - blockH));
  return { x, y, w, h, base, margin, caption, fs, pillH, gap, blockH };
}

/** Desenha a câmera sobre o quadro da gravação (W × H). */
export function drawCameraOverlay(ctx, W, H, src, layout) {
  const sw = src.displayWidth ?? src.width;
  const sh = src.displayHeight ?? src.height;
  if (!sw || !sh) return;

  const { x, y, w, h, base, margin, caption, fs, pillH, gap } = cameraBox(W, H, layout);

  const path = () => {
    ctx.beginPath();
    if (layout.shape === 'circle') ctx.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2);
    else ctx.roundRect(x, y, w, h, Math.round(base * (layout.shape === 'square' ? 0.14 : 0.08)));
  };

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // sombra
  path();
  ctx.shadowColor = 'rgba(0,0,0,.45)';
  ctx.shadowBlur = Math.round(base * 0.08);
  ctx.shadowOffsetY = Math.round(base * 0.02);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.shadowColor = 'transparent';

  // imagem (preenche a forma, cortando as sobras)
  ctx.save();
  path();
  ctx.clip();
  const s = Math.max(w / sw, h / sh);
  const cw = w / s;
  const ch = h / s;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, x, y, w, h);
  ctx.restore();

  // borda
  path();
  ctx.lineWidth = Math.max(2, Math.round(base * 0.018));
  ctx.strokeStyle = 'rgba(255,255,255,.92)';
  ctx.stroke();

  // legenda
  if (caption) {
    ctx.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const maxText = Math.max(w * 1.4, base * 1.6) - fs * 1.6;
    let text = caption;
    if (ctx.measureText(text).width > maxText) {
      while (text.length > 1 && ctx.measureText(`${text}…`).width > maxText) text = text.slice(0, -1);
      text = `${text.trimEnd()}…`;
    }
    const pw = Math.round(ctx.measureText(text).width + fs * 1.6);
    let px = Math.round(x + w / 2 - pw / 2);
    px = Math.min(Math.max(px, margin), W - margin - pw);
    const py = y + h + gap;
    ctx.beginPath();
    ctx.roundRect(px, py, pw, pillH, pillH / 2);
    ctx.fillStyle = 'rgba(17,14,40,.82)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px + pw / 2, py + pillH / 2 + 1);
  }
  ctx.restore();
}

// ---------- processador ----------

/**
 * Recebe a faixa de vídeo da câmera e devolve uma nova faixa com os efeitos aplicados.
 * As opções podem mudar durante a gravação via setOptions().
 */
export function createCameraProcessor(srcTrack, initial, onStatus = () => {}) {
  let opts = { ...initial };
  let segmenter = null;
  let lastTs = 0;

  const SEG_W = 256; // a segmentação roda numa cópia pequena: rápido e com bordas suaves
  let out, octx, person, pctx, seg, sctx, mask, mctx, maskData, prevAlpha;
  let bgImage = null;

  function ensureCanvases(W, H) {
    if (out && out.width === W && out.height === H) return;
    out = new OffscreenCanvas(W, H);
    octx = out.getContext('2d');
    person = new OffscreenCanvas(W, H);
    pctx = person.getContext('2d');
    const segH = Math.max(1, Math.round((SEG_W * H) / W));
    seg = new OffscreenCanvas(SEG_W, segH);
    sctx = seg.getContext('2d', { willReadFrequently: true });
    mask = null;
  }

  function updateMask(source) {
    sctx.drawImage(source, 0, 0, seg.width, seg.height);
    const ts = Math.max(performance.now(), lastTs + 1); // precisa ser crescente
    lastTs = ts;
    segmenter.segmentForVideo(seg, ts, (res) => {
      const m = res.confidenceMasks?.[0];
      if (!m) return;
      const conf = m.getAsFloat32Array();
      if (!mask || mask.width !== m.width || mask.height !== m.height) {
        mask = new OffscreenCanvas(m.width, m.height);
        mctx = mask.getContext('2d');
        maskData = mctx.createImageData(m.width, m.height);
        prevAlpha = new Float32Array(conf.length);
      }
      const d = maskData.data;
      for (let i = 0; i < conf.length; i++) {
        // curva suave (corta ruído) + média com o quadro anterior (menos tremido)
        const t = Math.min(1, Math.max(0, (conf[i] - 0.25) / 0.5));
        const a = prevAlpha[i] * 0.4 + t * t * (3 - 2 * t) * 0.6;
        prevAlpha[i] = a;
        d[i * 4 + 3] = a * 255;
      }
      mctx.putImageData(maskData, 0, 0);
    });
  }

  function drawCover(img, W, H) {
    const s = Math.max(W / img.width, H / img.height);
    const w = img.width * s;
    const h = img.height * s;
    octx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  }

  function render(source, W, H) {
    ensureCanvases(W, H);
    const filter = EFFECTS[opts.effect]?.filter ?? 'none';
    const mirror = (ctx) => (opts.mirror ? ctx.setTransform(-1, 0, 0, 1, W, 0) : ctx.setTransform(1, 0, 0, 1, 0, 0));
    const wantsBg = opts.background !== 'none' && !(opts.background === 'custom' && !bgImage);

    if (wantsBg && segmenter) {
      try { updateMask(source); } catch { /* quadro perdido; usa a máscara anterior */ }
    }

    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = 'source-over';

    if (!wantsBg || !mask) {
      mirror(octx);
      octx.filter = filter;
      octx.drawImage(source, 0, 0, W, H);
      octx.filter = 'none';
      return out;
    }

    // 1) fundo
    if (opts.background.startsWith('blur')) {
      const b = Math.round((opts.background === 'blur-strong' ? 0.035 : 0.015) * W);
      mirror(octx);
      octx.filter = `blur(${b}px) ${filter === 'none' ? '' : filter}`;
      octx.drawImage(source, -b * 2, -b * 2, W + b * 4, H + b * 4); // maior, para não escurecer as bordas
    } else {
      octx.filter = filter;
      drawCover(bgImage, W, H); // fundo não é espelhado (textos na imagem ficam legíveis)
    }
    octx.filter = 'none';

    // 2) pessoa recortada pela máscara
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.globalCompositeOperation = 'copy';
    pctx.drawImage(source, 0, 0, W, H);
    pctx.globalCompositeOperation = 'destination-in';
    pctx.imageSmoothingQuality = 'high';
    pctx.filter = `blur(${Math.max(1, Math.round(W / 400))}px)`; // borda suave
    pctx.drawImage(mask, 0, 0, W, H);
    pctx.filter = 'none';

    mirror(octx);
    octx.filter = filter;
    octx.drawImage(person, 0, 0);
    octx.filter = 'none';
    return out;
  }

  async function applyOptions() {
    const bg = opts.background;
    bgImage = bg === 'custom' ? opts.customImage ?? null : bg in BACKGROUNDS && !bg.startsWith('blur') && bg !== 'none' ? presetBackground(bg) : null;
    if (bg !== 'none' && !segmenter) {
      onStatus('Carregando recorte de fundo… (só na primeira vez)');
      try {
        segmenter = await loadSegmenter();
        onStatus('');
      } catch (err) {
        onStatus(`Não foi possível carregar o recorte de fundo: ${err.message}`);
      }
    }
  }
  applyOptions();

  // ---------- pipeline ----------
  let track;
  let stop;
  let source; // último quadro já com efeitos (VideoFrame ou canvas)
  let latest = null;
  if ('MediaStreamTrackProcessor' in window && 'MediaStreamTrackGenerator' in window) {
    // Quadro a quadro: continua funcionando com a aba em segundo plano.
    const processor = new MediaStreamTrackProcessor({ track: srcTrack });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    processor.readable
      .pipeThrough(new TransformStream({
        transform(frame, controller) {
          try {
            const c = render(frame, frame.displayWidth, frame.displayHeight);
            const outFrame = new VideoFrame(c, {
              timestamp: frame.timestamp,
              ...(frame.duration != null && { duration: frame.duration }),
            });
            latest?.close();
            latest = outFrame.clone(); // usado para desenhar a câmera dentro da gravação
            controller.enqueue(outFrame);
          } catch {
            /* ignora o quadro */
          } finally {
            frame.close();
          }
        },
      }))
      .pipeTo(generator.writable)
      .catch(() => {});
    track = generator;
    source = () => latest;
    stop = () => {
      generator.stop();
      latest?.close();
      latest = null;
    };
  } else {
    // Outros navegadores: <video> + canvas, com o relógio num Worker.
    const fps = srcTrack.getSettings().frameRate || 30;
    const video = document.createElement('video');
    Object.assign(video, { muted: true, playsInline: true, srcObject: new MediaStream([srcTrack]) });
    video.play().catch(() => {});
    const canvasEl = document.createElement('canvas');
    const cctx = canvasEl.getContext('2d');
    const { width = 1280, height = 720 } = srcTrack.getSettings();
    Object.assign(canvasEl, { width, height });
    const outStream = canvasEl.captureStream(fps);
    const tickUrl = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${Math.round(1000 / fps)})`], { type: 'text/javascript' }));
    const worker = new Worker(tickUrl);
    worker.onmessage = () => {
      if (!video.videoWidth) return;
      const c = render(video, video.videoWidth, video.videoHeight);
      if (canvasEl.width !== c.width || canvasEl.height !== c.height) Object.assign(canvasEl, { width: c.width, height: c.height });
      cctx.drawImage(c, 0, 0);
    };
    track = outStream.getVideoTracks()[0];
    source = () => (video.videoWidth ? canvasEl : null);
    stop = () => {
      worker.terminate();
      URL.revokeObjectURL(tickUrl);
      outStream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    };
  }

  return {
    track,
    stop,
    source: () => source(),
    setOptions(next) {
      opts = { ...opts, ...next };
      applyOptions();
    },
  };
}
