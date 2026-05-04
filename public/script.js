const slides = [...document.querySelectorAll('.slide')];
const dotsEl = document.getElementById('dots');
const counter = document.getElementById('counter');
const notesEl = document.getElementById('notes');
const notesBody = document.getElementById('notesBody');
const pairBadge = document.getElementById('pairBadge');
const pairCode = document.getElementById('pairCode');
const pairLink = document.getElementById('pairLink');
const remoteApp = document.getElementById('remoteApp');
const remoteJoin = document.getElementById('remoteJoin');
const remoteJoinForm = document.getElementById('remoteJoinForm');
const sessionInput = document.getElementById('sessionInput');
const remoteControls = document.getElementById('remoteControls');
const remoteButtons = document.getElementById('remoteButtons');
const remoteCounter = document.getElementById('remoteCounter');
const remoteStatus = document.getElementById('remoteStatus');
const remoteNotes = document.getElementById('remoteNotes');
const remoteAlert = document.getElementById('remoteAlert');
const url = new URL(window.location.href);
const pathSession = url.pathname.match(/^\/([A-Z2-9]{6})$/i)?.[1]?.toUpperCase() || '';
const isRemote = Boolean(pathSession) || url.searchParams.get('remote') === '1';
const role = isRemote ? 'remote' : 'presenter';
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const initialSession = pathSession || (url.searchParams.get('s') || '').trim().toUpperCase();
const reconnectDelayMs = 1200;
let i = 0;
let sessionCode = initialSession;
let socket = null;
let reconnectTimer = null;
let controlsBound = false;

slides.forEach((_,n)=>{
  const b = document.createElement('b');
  b.title = 'Slide ' + (n+1);
  b.addEventListener('click',()=>go(n));
  dotsEl.appendChild(b);
});

function render(){
  slides.forEach((s,n)=> {
    const active = n===i;
    s.classList.remove('active');
    if (active){
      void s.offsetWidth;
      s.classList.add('active');
      const items = s.querySelectorAll('[data-anim]');
      items.forEach((el, idx)=>{
        if (!el.style.animationDelay) el.style.animationDelay = (idx*40) + 'ms';
      });
    }
  });
  [...dotsEl.children].forEach((d,n)=> d.classList.toggle('on', n===i));
  counter.textContent = (i+1) + ' / ' + slides.length;
  const currentNotes = slides[i].dataset.notes || '';
  notesBody.innerHTML = currentNotes.replace(/\n/g,'<br/>');
  remoteCounter.textContent = (i+1) + ' / ' + slides.length;
  remoteNotes.textContent = currentNotes || 'Notes empty';
  if (window.lucide && lucide.createIcons) lucide.createIcons();
  if (!isRemote) syncPresenterState();
}
function go(n){ i = Math.max(0, Math.min(slides.length-1, n)); render(); }
function next(){ go(i+1) } function prev(){ go(i-1) }

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { next(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') prev();
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(slides.length-1);
  else if (e.key.toLowerCase() === 'n') notesEl.classList.toggle('show');
  else if (e.key.toLowerCase() === 'f') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
});

document.getElementById('stage').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  (e.clientX - r.left) > r.width/2 ? next() : prev();
});

function boot(){
  if (window.lucide) { lucide.createIcons(); startApp(); }
  else setTimeout(boot, 30);
}

function startApp(){
  if (isRemote) {
    document.body.classList.add('remote-mode');
    if (sessionCode) {
      connectRemote(true);
    } else {
      remoteJoin.hidden = false;
      remoteControls.hidden = true;
      remoteButtons.hidden = true;
    }
    return;
  }

  ensurePresenterSession().then(() => {
    updatePairingBadge();
    connectSocket();
    render();
  });
}

async function ensurePresenterSession(){
  if (sessionCode) return;
  const response = await fetch('/api/session/new');
  const data = await response.json();
  sessionCode = data.session;
}

function updatePairingBadge(){
  const remoteUrl = new URL(`/${sessionCode}`, window.location.origin);
  pairCode.textContent = sessionCode;
  pairLink.textContent = remoteUrl.toString();
  pairLink.title = remoteUrl.toString();
  pairBadge.hidden = false;
}

async function connectRemote(initialLoad = false){
  const available = await checkRemoteAvailability();
  if (!available.ok) {
    remoteJoin.hidden = false;
    remoteControls.hidden = true;
    remoteButtons.hidden = true;
    sessionInput.value = sessionCode || '';
    setRemoteAlert(available.message);
    if (!initialLoad && !pathSession) sessionInput.focus();
    return;
  }

  setRemoteAlert('');
  remoteJoin.hidden = true;
  remoteControls.hidden = false;
  remoteButtons.hidden = false;
  connectSocket();
}

function connectSocket(){
  if (!sessionCode) return;
  clearTimeout(reconnectTimer);
  if (socket && socket.readyState <= WebSocket.OPEN) {
    socket.close();
  }

  const currentSocket = new WebSocket(`${wsProtocol}//${window.location.host}/api/ws?session=${encodeURIComponent(sessionCode)}&role=${role}`);
  socket = currentSocket;

  currentSocket.addEventListener('open', () => {
    if (socket !== currentSocket) return;
    currentSocket.send(JSON.stringify({ type: 'hello' }));
    if (!isRemote) syncPresenterState();
  });
  currentSocket.addEventListener('message', event => {
    if (socket !== currentSocket) return;
    try {
      handleMessage(JSON.parse(event.data));
    } catch {}
  });
  currentSocket.addEventListener('close', () => {
    if (socket !== currentSocket) return;
    scheduleReconnect();
  });
  currentSocket.addEventListener('error', () => {
    if (socket !== currentSocket) return;
    scheduleReconnect();
  });
}

function scheduleReconnect(){
  clearTimeout(reconnectTimer);
  if (isRemote) {
    setRemotePresence(false);
    reconnectTimer = setTimeout(() => connectRemote(), reconnectDelayMs);
    return;
  }

  reconnectTimer = setTimeout(connectSocket, reconnectDelayMs);
}

function handleMessage(message){
  if (message.type === 'state') {
    if (isRemote) {
      applyRemoteState(message.state);
      setRemotePresence(Boolean(message.presenterConnected));
    }
    return;
  }

  if (message.type === 'presence' && isRemote) {
    setRemotePresence(Boolean(message.presenterConnected));
    return;
  }

  if (message.type === 'control' && !isRemote) {
    if (message.action === 'next') next();
    else if (message.action === 'prev') prev();
    else if (message.action === 'first') go(0);
    else if (message.action === 'last') go(slides.length - 1);
    else if (message.action === 'go' && Number.isInteger(message.index)) go(message.index);
  }
}

function syncPresenterState(){
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'state',
    state: {
      slideIndex: i,
      slideCount: slides.length,
      notes: slides[i].dataset.notes || ''
    }
  }));
}

function applyRemoteState(state){
  const slideCount = Number.isFinite(state?.slideCount) ? state.slideCount : 0;
  const slideIndex = Number.isFinite(state?.slideIndex) ? state.slideIndex : 0;
  remoteCounter.textContent = `${slideIndex + 1} / ${slideCount || 1}`;
  remoteNotes.textContent = state?.notes || 'No notes for this slide.';
}

function setRemotePresence(online){
  remoteStatus.textContent = online ? 'Presenter online' : 'Presenter offline';
  remoteStatus.classList.toggle('online', online);
  remoteStatus.classList.toggle('offline', !online);
}

async function checkRemoteAvailability(){
  if (!sessionCode) {
    return { ok: false, message: 'Enter a 6-character code.' };
  }

  const response = await fetch(`/api/session/status?session=${encodeURIComponent(sessionCode)}`);
  if (!response.ok) {
    return { ok: false, message: 'That session code is invalid.' };
  }

  const status = await response.json();
  if (status.remoteConnected) {
    return { ok: false, message: 'A phone is already connected to this session.' };
  }

  return { ok: true };
}

function setRemoteAlert(message){
  remoteAlert.hidden = !message;
  remoteAlert.textContent = message || '';
}

if (remoteJoinForm) {
  remoteJoinForm.addEventListener('submit', event => {
    event.preventDefault();
    const nextSession = sessionInput.value.trim().toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
    if (nextSession.length !== 6) return;
    const remoteUrl = new URL(`/${nextSession}`, window.location.origin);
    window.location.href = remoteUrl.toString();
  });
}

if (remoteButtons && !controlsBound) {
  controlsBound = true;
  remoteButtons.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      type: 'control',
      action: button.dataset.action
    }));
  });
}

boot();
