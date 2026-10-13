(function () {
  'use strict';

  const STORAGE_KEY_IP = 'darkpaw.pi.ip';
  const STORAGE_KEY_INSTALL_DISMISS = 'darkpaw.install.dismiss.v1';
  const WS_PORT = 8888;
  const HTTP_PORT = 5000;
  const WS_USER = 'admin';
  const WS_PASS = '123456';
  const INFO_INTERVAL_MS = 3000;
  const STOP_CMDS = ['DS', 'TS'];

  const state = {
    ws: null,
    wsReady: false,
    authDone: false,
    infoTimer: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    ip: localStorage.getItem(STORAGE_KEY_IP) || '',
    pendingQueue: [],
    stickyState: new Map(),
    deferredPrompt: null,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    connDot: $('conn-dot'),
    connText: $('conn-text'),
    btnSettings: $('btn-settings'),
    btnInstall: $('btn-install'),
    btnInstall2: $('btn-install2'),
    installBanner: $('install-banner'),
    warnBanner: $('warn-banner'),
    videoFeed: $('video-feed'),
    videoPlaceholder: $('video-placeholder'),
    cpuTemp: $('cpu-temp'),
    cpuUse: $('cpu-use'),
    ramUse: $('ram-use'),
    settingsModal: $('settings-modal'),
    inputIp: $('input-ip'),
    btnSettingsSave: $('btn-settings-save'),
    btnSettingsCancel: $('btn-settings-cancel'),
  };

  const setConnState = (stateName, text) => {
    el.connDot.classList.remove('connected', 'connecting', 'disconnected');
    el.connDot.classList.add(stateName);
    el.connText.textContent = text;
  };

  const showWarn = (message) => {
    if (!message) {
      el.warnBanner.classList.add('hidden');
      el.warnBanner.textContent = '';
      return;
    }
    el.warnBanner.textContent = message;
    el.warnBanner.classList.remove('hidden');
  };

  const isIos = () => {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  };
  const isStandalone = () =>
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    (window.navigator && window.navigator.standalone === true);

  const isValidIp = (s) => {
    if (!s) return false;
    return /^[a-zA-Z0-9.-]+$/.test(s);
  };

  const buildWsUrl = (ip) => `ws://${ip}:${WS_PORT}`;
  const buildVideoUrl = (ip) => `http://${ip}:${HTTP_PORT}/video_feed`;

  const sendCmdRaw = (data) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.authDone) {
      state.pendingQueue.push(data);
      if (state.pendingQueue.length > 50) state.pendingQueue.shift();
      return false;
    }
    try {
      state.ws.send(typeof data === 'string' ? JSON.stringify(data) : JSON.stringify(data));
      return true;
    } catch (e) {
      state.pendingQueue.push(data);
      return false;
    }
  };

  const flushPendingQueue = () => {
    while (state.pendingQueue.length > 0 && state.ws && state.ws.readyState === WebSocket.OPEN && state.authDone) {
      const item = state.pendingQueue.shift();
      try {
        state.ws.send(typeof item === 'string' ? JSON.stringify(item) : JSON.stringify(item));
      } catch (e) {
        state.pendingQueue.unshift(item);
        break;
      }
    }
  };

  const emergencyStop = () => {
    let ok = true;
    STOP_CMDS.forEach((cmd) => {
      const sent = sendCmdRaw(cmd);
      if (!sent) ok = false;
    });
    if (!ok) {
      showWarn('⚠ 通信断絶：停止コマンドを送信できませんでした。再接続を試みます。');
    } else {
      showWarn('');
    }
  };

  const requestInfo = () => {
    sendCmdRaw('get_info');
  };

  const connectWs = (ip) => {
    if (state.ws) {
      try { state.ws.close(); } catch (_) {}
      state.ws = null;
    }
    state.wsReady = false;
    state.authDone = false;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    const url = buildWsUrl(ip);
    setConnState('connecting', '接続中…');

    try {
      const ws = new WebSocket(url);
      state.ws = ws;

      ws.addEventListener('open', () => {
        state.reconnectAttempts = 0;
        setConnState('connecting', '認証中…');
        try {
          ws.send(`${WS_USER}:${WS_PASS}`);
        } catch (e) {
          setConnState('disconnected', '認証送信失敗');
        }
      });

      ws.addEventListener('message', (evt) => {
        const text = typeof evt.data === 'string' ? evt.data : '';
        if (!state.authDone) {
          if (text.indexOf('congratulation') >= 0 || text.indexOf('connect with server') >= 0) {
            state.authDone = true;
            state.wsReady = true;
            setConnState('connected', `接続中 (${ip})`);
            showWarn('');
            flushPendingQueue();
            if (state.infoTimer) clearInterval(state.infoTimer);
            state.infoTimer = setInterval(requestInfo, INFO_INTERVAL_MS);
            requestInfo();
          } else if (text.indexOf('sorry') >= 0) {
            setConnState('disconnected', '認証失敗');
            showWarn('⚠ WebSocket認証に失敗しました。');
            try { ws.close(); } catch (_) {}
          }
          return;
        }
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.title === 'get_info' && Array.isArray(parsed.data) && parsed.data.length >= 3) {
            el.cpuTemp.textContent = String(parsed.data[0] ?? '--');
            el.cpuUse.textContent = String(parsed.data[1] ?? '--');
            el.ramUse.textContent = String(parsed.data[2] ?? '--');
          }
        } catch (_) {}
      });

      ws.addEventListener('close', () => {
        state.wsReady = false;
        state.authDone = false;
        if (state.infoTimer) {
          clearInterval(state.infoTimer);
          state.infoTimer = null;
        }
        emergencyStop();
        setConnState('disconnected', '切断されました');
        if (state.ip) {
          state.reconnectAttempts += 1;
          const delay = Math.min(3000 * state.reconnectAttempts, 15000);
          if (!state.reconnectTimer) {
            state.reconnectTimer = setTimeout(() => {
              state.reconnectTimer = null;
              if (state.ip && (!state.ws || state.ws.readyState === WebSocket.CLOSED)) {
                connectWs(state.ip);
              }
            }, delay);
          }
        }
      });

      ws.addEventListener('error', () => {
        setConnState('disconnected', '接続エラー');
      });
    } catch (e) {
      setConnState('disconnected', 'WS作成エラー');
    }
  };

  const applyVideo = (ip) => {
    if (!ip) {
      el.videoFeed.removeAttribute('src');
      el.videoPlaceholder.classList.remove('hidden');
      el.videoPlaceholder.querySelector('span').textContent = '📹 接続先IPを設定してください';
      return;
    }
    const src = buildVideoUrl(ip);
    el.videoFeed.src = src;
    el.videoFeed.alt = `ライブ映像 (${src})`;
    el.videoPlaceholder.classList.add('hidden');
    const onError = () => {
      el.videoPlaceholder.classList.remove('hidden');
      el.videoPlaceholder.querySelector('span').textContent = '📹 映像を受信できません（IP/ポート/起動状態を確認）';
    };
    el.videoFeed.removeEventListener('error', onError);
    el.videoFeed.addEventListener('error', onError, { once: true });
  };

  const saveIpAndConnect = (ip) => {
    const clean = (ip || '').trim();
    if (!isValidIp(clean)) {
      showWarn('⚠ 有効なIPアドレスまたはホスト名を入力してください。');
      return false;
    }
    state.ip = clean;
    localStorage.setItem(STORAGE_KEY_IP, clean);
    applyVideo(clean);
    connectWs(clean);
    return true;
  };

  const openSettings = () => {
    el.inputIp.value = state.ip;
    el.settingsModal.classList.remove('hidden');
    setTimeout(() => el.inputIp.focus(), 50);
  };
  const closeSettings = () => {
    el.settingsModal.classList.add('hidden');
    showWarn('');
  };

  el.btnSettings.addEventListener('click', openSettings);
  el.btnSettingsCancel.addEventListener('click', closeSettings);
  el.btnSettingsSave.addEventListener('click', () => {
    const ok = saveIpAndConnect(el.inputIp.value);
    if (ok) closeSettings();
  });
  el.inputIp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.btnSettingsSave.click();
  });

  const setPressedCls = (btn, pressed) => {
    if (pressed) btn.classList.add('pressed'); else btn.classList.remove('pressed');
  };

  const bindHoldButton = (btn) => {
    const press = btn.getAttribute('data-cmd-press');
    const release = btn.getAttribute('data-cmd-release');
    const onDown = (e) => {
      e.preventDefault();
      if (press) sendCmdRaw(press);
      setPressedCls(btn, true);
    };
    const onUp = (e) => {
      e.preventDefault();
      if (release) sendCmdRaw(release);
      setPressedCls(btn, false);
    };
    btn.addEventListener('touchstart', onDown, { passive: false });
    btn.addEventListener('touchend', onUp, { passive: false });
    btn.addEventListener('touchcancel', onUp, { passive: false });
    btn.addEventListener('mousedown', onDown);
    btn.addEventListener('mouseup', onUp);
    btn.addEventListener('mouseleave', onUp);
  };

  const bindTapButton = (btn) => {
    const tap = btn.getAttribute('data-cmd-tap');
    const fire = (e) => {
      e.preventDefault();
      if (tap) sendCmdRaw(tap);
    };
    btn.addEventListener('click', fire);
  };

  const bindStickyButton = (btn) => {
    const onCmd = btn.getAttribute('data-cmd-on');
    const offCmd = btn.getAttribute('data-cmd-off');
    const key = onCmd + '|' + offCmd;
    const toggle = (e) => {
      e.preventDefault();
      const cur = !!state.stickyState.get(key);
      const next = !cur;
      state.stickyState.set(key, next);
      sendCmdRaw(next ? onCmd : offCmd);
      if (next) btn.classList.add('active'); else btn.classList.remove('active');
    };
    btn.addEventListener('click', toggle);
  };

  document.querySelectorAll('[data-cmd-press]').forEach(bindHoldButton);
  document.querySelectorAll('[data-cmd-tap]').forEach(bindTapButton);
  document.querySelectorAll('[data-sticky]').forEach(bindStickyButton);

  // --------------------
  // PWA install UX
  // --------------------
  const hideInstallBanner = () => {
    if (el.installBanner) el.installBanner.classList.add('hidden');
  };
  const showInstallBannerIfNeeded = () => {
    if (!el.installBanner) return;
    if (isStandalone()) { hideInstallBanner(); return; }
    try {
      if (localStorage.getItem(STORAGE_KEY_INSTALL_DISMISS) === '1') return;
    } catch (_) {}
    if (state.deferredPrompt) {
      el.installBanner.classList.remove('hidden');
      el.btnInstall.hidden = false;
      return;
    }
    if (isIos() && !window.navigator.standalone) {
      el.installBanner.classList.remove('hidden');
      const t = el.installBanner.querySelector('.install-text b');
      if (t) t.textContent = 'iOS: 共有 → ホーム画面に追加';
      const s = el.installBanner.querySelector('.install-text span');
      if (s) s.textContent = 'Safariの共有ボタンから「ホーム画面に追加」を選んでください。';
      if (el.btnInstall2) el.btnInstall2.style.display = 'none';
      return;
    }
    if (window.isSecureContext) {
      el.installBanner.classList.remove('hidden');
      const t = el.installBanner.querySelector('.install-text b');
      if (t) t.textContent = 'ブラウザからインストールして使いましょう';
      const s = el.installBanner.querySelector('.install-text span');
      if (s) s.textContent = 'アドレスバー横のインストールアイコンをクリックするか、下のボタンを押してください。';
    }
  };

  const triggerInstall = async () => {
    if (state.deferredPrompt) {
      try {
        state.deferredPrompt.prompt();
        const choice = await state.deferredPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          hideInstallBanner();
          try { localStorage.removeItem(STORAGE_KEY_INSTALL_DISMISS); } catch (_) {}
        }
      } catch (_) {}
      state.deferredPrompt = null;
      try { window.__deferredPrompt = null; } catch (_) {}
      el.btnInstall.hidden = true;
      return;
    }
    if (isIos()) {
      alert('iOSへの追加方法：\nSafari の共有ボタン → 「ホーム画面に追加」を選択してください。');
      return;
    }
    alert('ブラウザからのインストール手順：\nアドレスバー右端の「インストール」アイコン（円に下向き矢印）をクリックしてください。\nアイコンが見当たらない場合は、メニュー（…）→「DarkPaw Controller をインストール」を選んでください。');
  };
  if (el.btnInstall) el.btnInstall.addEventListener('click', triggerInstall);
  if (el.btnInstall2) el.btnInstall2.addEventListener('click', triggerInstall);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredPrompt = e;
    try { window.__deferredPrompt = e; } catch (_) {}
    showInstallBannerIfNeeded();
  });

  window.addEventListener('appinstalled', () => {
    state.deferredPrompt = null;
    try { window.__deferredPrompt = null; } catch (_) {}
    hideInstallBanner();
    el.btnInstall.hidden = true;
  });

  // --------------------
  // Service Worker
  // --------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          if (reg.waiting) {
            try {
              if (confirm('アプリの更新版があります。今すぐ更新しますか？')) {
                reg.waiting.postMessage('SKIP_WAITING');
                location.reload();
              }
            } catch (_) {}
          }
          reg.addEventListener('updatefound', () => {
            const nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', () => {
              if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                try {
                  if (confirm('アプリの更新版がダウンロードされました。今すぐ更新しますか？')) {
                    nw.postMessage('SKIP_WAITING');
                    location.reload();
                  }
                } catch (_) {}
              }
            });
          });
          setInterval(() => { try { reg.update(); } catch (_) {} }, 60 * 60 * 1000);
        })
        .catch((err) => {
          const hint = window.isSecureContext
            ? '（SW登録失敗: ' + (err && err.message ? err.message : err) + '）'
            : '（HTTPS/localhost でないため Service Worker 未登録。PWAインストールは localhost または HTTPS 環境で実行してください。）';
          console.warn('SW登録失敗:', err, hint);
          if (!window.isSecureContext && !isStandalone()) {
            showWarn('⚠ PWAインストールには HTTPS または localhost が必要です。現在のオリジンではSWが動作しません。');
          }
        });

      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
    });
  } else {
    showWarn('⚠ お使いのブラウザは Service Worker に対応していません。PWAインストールできません。');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) emergencyStop();
  });
  window.addEventListener('pagehide', () => emergencyStop());
  window.addEventListener('beforeunload', () => emergencyStop());

  if (location.hash === '#settings') {
    setTimeout(openSettings, 400);
    history.replaceState(null, '', location.pathname + location.search);
  }

  if (state.ip) {
    el.inputIp.value = state.ip;
    applyVideo(state.ip);
    connectWs(state.ip);
  } else {
    setConnState('disconnected', '未接続');
    setTimeout(openSettings, 300);
  }

  setTimeout(showInstallBannerIfNeeded, 1500);
})();
