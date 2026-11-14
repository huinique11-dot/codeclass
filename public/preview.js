// 미리보기 모드: 주소 끝에 ?preview 를 붙이면 입장 없이 화면을 볼 수 있어요.
//   /class?preview    참여자 화면
//   /teacher?preview  강사 공간 (비밀번호 없이)
// 서버에는 아무것도 저장하지 않고, 예시 데이터만 보여 줍니다.

(function () {
  if (!new URLSearchParams(location.search).has('preview')) return;

  const STEP_COUNT = typeof flatSteps === 'function' ? flatSteps().length : 23;
  const now = Date.now();
  const room = { code: '123456', title: '미리보기 연수방', currentStep: 3, open: true, activeQuestion: 'q1', count: 6, created: now };
  let me = { id: 'me', name: '미리보기', subject: '음악', step: 0, completed: [], help: false, memo: {} };

  const names = [['봄햇살', '국어'], ['하늘콩', '수학'], ['도레미', '음악'], ['초록잎', '과학'], ['구름빵', '영어'], ['별빛', '미술']];
  const students = names.map(([name, subject], i) => ({
    id: 's' + i, name, subject,
    step: Math.min(i * 4, STEP_COUNT - 1),
    completed: Array.from({ length: Math.min(i * 4, STEP_COUNT) }, (_, k) => k),
    help: i === 2, memo: {}, seen: now - i * 50000, created: now - 3600000, submitted: i === 5,
  }));
  const questions = [
    { id: 'q1', title: '오늘, AI와 만들고 싶은 수업자료는?', type: 'word', options: [], position: 0,
      results: [{ word: '퀴즈', count: 4 }, { word: '활동지', count: 3 }, { word: '감상문', count: 2 }, { word: '게임', count: 2 }, { word: '투표', count: 1 }] },
    { id: 'q2', title: '바이브코딩, 어느 정도 익숙하신가요?', type: 'choice', position: 1,
      options: ['오늘 처음 들어요', '이름은 들어 봤어요', '만들어 본 적 있어요', '수업에 활용하고 있어요'],
      results: [3, 2, 1, 0] },
  ];
  const mine = {};
  const gallery = [{ studentId: 's5', name: '별빛', subject: '미술', title: '우리 반 감상 갤러리', note: '작품을 보고 한 줄 감상을 남기는 사이트예요.',
    url: 'https://example.com/', repoUrl: '', created: now }];

  function questionView() {
    return questions.map((q) => {
      const results = q.type === 'choice'
        ? q.options.map((option, i) => ({ option, count: q.results[i] + (mine[q.id] === option ? 1 : 0) }))
        : (mine[q.id] ? [...q.results, { word: mine[q.id], count: 1 }] : q.results);
      const responses = q.type === 'choice' ? results.reduce((a, r) => a + r.count, 0) : results.reduce((a, r) => a + r.count, 0);
      return { ...q, results, responses, mine: mine[q.id] || null };
    });
  }
  const teacherView = () => ({ room: { ...room }, students, questions: questionView(), gallery });

  // 입장 정보 대신 예시 값을 돌려줍니다 (실제 저장된 값은 건드리지 않아요).
  const realStoreGet = store.get;
  store.get = (key) => (key === 'codeclass.personalCode' ? 'MIRI-BOGI' : realStoreGet(key));
  const realStoreSet = store.set;
  store.set = (key, value) => { if (key !== 'codeclass.personalCode') realStoreSet(key, value); };
  const realSessionGet = session.get;
  session.get = (key) => (key === 'codeclass.teacher' ? 'preview' : realSessionGet(key));

  window.api = async function (path, { method = 'GET', data = {} } = {}) {
    const url = new URL(path, location.origin);
    switch (method + ' ' + url.pathname) {
      case 'GET /api/state':
        return { me, room, questions: questionView(), gallery, mySubmission: gallery.find((g) => g.studentId === 'me') || null };
      case 'POST /api/progress': {
        const done = new Set(me.completed);
        if (Number.isInteger(data.step)) {
          me.step = data.step;
          if (data.done === true) done.add(data.step);
          if (data.done === false) done.delete(data.step);
        }
        if (typeof data.help === 'boolean') me.help = data.help;
        if (data.memo) me.memo = { ...me.memo, ...data.memo };
        me = { ...me, completed: [...done].sort((a, b) => a - b) };
        return { me };
      }
      case 'POST /api/answer':
        mine[data.questionId] = data.value;
        return { ok: true };
      case 'POST /api/submit': {
        const i = gallery.findIndex((g) => g.studentId === 'me');
        const item = { studentId: 'me', name: me.name, subject: me.subject, title: data.title, url: data.url, repoUrl: data.repoUrl, note: data.note, created: Date.now() };
        if (i >= 0) gallery[i] = item; else gallery.push(item);
        return { ok: true };
      }
      case 'GET /api/teacher/rooms':
        return { rooms: [{ ...room, count: students.length }] };
      case 'POST /api/teacher/rooms':
        return { room };
      case 'GET /api/teacher/room':
        return teacherView();
      case 'POST /api/teacher/room':
        if (Number.isInteger(data.currentStep)) room.currentStep = data.currentStep;
        if (typeof data.open === 'boolean') room.open = data.open;
        if (data.activeQuestion !== undefined) room.activeQuestion = data.activeQuestion;
        if (data.title) room.title = data.title;
        return teacherView();
      case 'POST /api/teacher/question': {
        if (data.action === 'create') {
          const id = 'q' + (questions.length + 1) + now;
          const options = data.type === 'choice' ? String(data.options || '').split('\n').map((s) => s.trim()).filter(Boolean) : [];
          questions.push({ id, title: data.title, type: data.type, options, position: questions.length, results: data.type === 'choice' ? options.map(() => 0) : [] });
          room.activeQuestion = id;
        }
        const i = questions.findIndex((q) => q.id === data.id);
        if (data.action === 'delete' && i >= 0) questions.splice(i, 1);
        if (data.action === 'update' && i >= 0) questions[i].title = data.title || questions[i].title;
        if (data.action === 'move' && i >= 0) {
          const j = data.dir === 'up' ? i - 1 : i + 1;
          if (j >= 0 && j < questions.length) [questions[i], questions[j]] = [questions[j], questions[i]];
        }
        return teacherView();
      }
      case 'POST /api/teacher/student':
        return { ok: true, personalCode: 'NEWC-ODE2', name: '예시 참여자' };
      case 'POST /api/teacher/room/delete':
        return { ok: true };
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
  badge.style.cssText = 'position:fixed;left:50%;bottom:100px;transform:translateX(-50%);z-index:90;white-space:nowrap;padding:6px 12px;border-radius:99px;'
    + 'background:#2e231c;color:#fff;font-size:12px;opacity:.85;pointer-events:none';
  const add = () => document.body && !badge.isConnected && document.body.appendChild(badge);
  add();
  document.addEventListener('DOMContentLoaded', add);
})();
