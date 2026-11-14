// 미리보기 모드: 주소 끝에 ?preview 를 붙이면 입장 없이 화면을 볼 수 있어요.
//   /class?preview    학생 수업 화면
//   /teacher?preview  선생님 공간 (비밀번호 없이)
// 서버에는 아무것도 저장하지 않고, 예시 데이터만 보여 줍니다.

(function () {
  if (!new URLSearchParams(location.search).has('preview')) return;

  const STEP_COUNT = (window.STEPS || []).length || 8;
  const now = Date.now();
  const room = { code: '123456', title: '미리보기 수업', currentStep: Math.min(2, STEP_COUNT - 1), open: true, count: 24 };
  let me = { id: 'preview', name: '미리보기', number: '1', step: 0, completed: [], help: false };
  const names = ['반짝별', '하늘콩', '도레미', '코딩왕', '초록잎', '구름빵'];
  const students = names.map((name, i) => ({
    id: 's' + i,
    name,
    number: String(i + 1),
    step: Math.min(i, STEP_COUNT - 1),
    completed: Array.from({ length: Math.min(i, STEP_COUNT) }, (_, k) => k),
    help: i === 3,
    seen: now - i * 50000,
    created: now - 3600000,
  }));

  // 입장 정보 대신 예시 값을 돌려줍니다 (실제 저장된 값은 건드리지 않아요).
  const realStoreGet = store.get;
  store.get = (key) => (key === 'codeclass.personalCode' ? 'MIRI-BOGI' : realStoreGet(key));
  const realSessionGet = session.get;
  session.get = (key) => (key === 'codeclass.teacher' ? 'preview' : realSessionGet(key));

  window.api = async function (path, { method = 'GET', data } = {}) {
    const url = new URL(path, location.origin);
    switch (method + ' ' + url.pathname) {
      case 'GET /api/state':
        return { me, room };
      case 'POST /api/progress': {
        const done = new Set(me.completed);
        if (Number.isInteger(data.step)) {
          me.step = data.step;
          if (data.done === true) done.add(data.step);
          if (data.done === false) done.delete(data.step);
        }
        if (typeof data.help === 'boolean') me.help = data.help;
        me = { ...me, completed: [...done].sort((a, b) => a - b) };
        return { me };
      }
      case 'GET /api/teacher/rooms':
        return { rooms: [{ ...room, count: students.length, created: now }] };
      case 'POST /api/teacher/rooms':
        return { room };
      case 'GET /api/teacher/room':
        return { room: { ...room, count: students.length }, students };
      case 'POST /api/teacher/room':
        if (Number.isInteger(data.currentStep)) room.currentStep = data.currentStep;
        if (typeof data.open === 'boolean') room.open = data.open;
        return { room: { ...room, count: students.length }, students };
      case 'POST /api/teacher/student':
        return { ok: true, personalCode: 'NEWC-ODE2', name: '예시 학생' };
    }
    return {};
  };

  // 링크를 눌러도 미리보기가 이어지도록
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/"]');
    if (a && !a.href.includes('preview')) a.href += (a.href.includes('?') ? '&' : '?') + 'preview';
  });

  const badge = document.createElement('div');
  badge.textContent = '미리보기 모드 · 저장되지 않아요';
  badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:60;padding:6px 12px;border-radius:99px;'
    + 'background:#2e231c;color:#fff;font-size:12px;opacity:.85;pointer-events:none';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(badge));
  if (document.body) document.body.appendChild(badge);
})();
