// 여러 화면이 함께 쓰는 도구들

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};

const session = {
  get(key) { try { return sessionStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, value); } catch {} },
  remove(key) { try { sessionStorage.removeItem(key); } catch {} },
};

async function api(path, { method = 'GET', data, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
    body: data ? JSON.stringify(data) : undefined,
  });
  let payload = {};
  try { payload = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(payload.error || '연결에 문제가 있어요. 잠시 후 다시 시도해 주세요.');
    err.status = res.status;
    throw err;
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function toast(message, kind = 'ok') {
  let box = document.querySelector('.toast');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
  }
  box.dataset.kind = kind;
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(box._timer);
  box._timer = setTimeout(() => box.classList.remove('show'), 2800);
}

async function copyText(value, message = '복사했어요. 붙여넣을 곳에서 Ctrl+V(맥은 ⌘V)를 누르세요.') {
  try {
    await navigator.clipboard.writeText(value);
    toast(message);
  } catch {
    toast('자동 복사가 막혀 있어요. 글자를 직접 선택해서 복사해 주세요.', 'warn');
  }
}

function downloadText(filename, content, type = 'text/plain') {
  const blob = new Blob(['﻿' + content], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 30) return '방금';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + '분 전';
  if (s < 86400) return Math.round(s / 3600) + '시간 전';
  return Math.round(s / 86400) + '일 전';
}

// course.js 의 차시·단계를 한 줄로 펼친 목록
function flatSteps() {
  const list = [];
  (window.COURSE || []).forEach((mod, m) => {
    mod.steps.forEach((step, s) => {
      list.push({ ...step, module: mod, m, s, code: (m + 1) + '-' + String(s + 1).padStart(2, '0') });
    });
  });
  return list;
}

function applyClassInfo() {
  const info = window.CLASS_INFO || {};
  document.querySelectorAll('.class-name').forEach((el) => { el.textContent = info.name || '수업 공방'; });
  document.querySelectorAll('.class-english').forEach((el) => { el.textContent = info.english || ''; });
  document.querySelectorAll('.class-motto').forEach((el) => { el.textContent = info.motto || ''; });
  document.querySelectorAll('.total-time').forEach((el) => { el.textContent = info.totalTime || ''; });
}

const ICONS = {
  code: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  flag: '<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function icon(name) {
  return '<span class="icon"><svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[name] || '') + '</svg></span>';
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]:not([data-icon-done])').forEach((el) => {
    el.insertAdjacentHTML(el.dataset.iconPos === 'end' ? 'beforeend' : 'afterbegin', icon(el.dataset.icon));
    el.dataset.iconDone = '1';
  });
}
hydrateIcons();

// 워드클라우드: 많이 나온 단어일수록 크게
function wordCloudHtml(results) {
  if (!results.length) return '<p class="empty-cloud">첫 단어를 기다리고 있어요.<br><small>응답이 모일수록 생각의 연결이 커져요.</small></p>';
  const max = results[0].count;
  const tones = ['#b5502a', '#587548', '#a8701a', '#7a4e8c', '#2f6f86', '#93401f'];
  return '<div class="cloud">' + results.map((r, i) => {
    const size = 15 + Math.round((r.count / max) * 30);
    return '<span style="font-size:' + size + 'px;color:' + tones[i % tones.length] + '" title="' + r.count + '명">'
      + escapeHtml(r.word) + '</span>';
  }).join('') + '</div>';
}

function pollHtml(results, total, mine) {
  return '<div class="poll">' + results.map((r) => {
    const pct = total ? Math.round((r.count / total) * 100) : 0;
    return '<div class="poll-row' + (mine === r.option ? ' mine' : '') + '"><div class="poll-label"><span>' + escapeHtml(r.option)
      + '</span><span>' + r.count + '명 · ' + pct + '%</span></div><div class="poll-bar"><span style="width:' + pct + '%"></span></div></div>';
  }).join('') + '</div>';
}
