// 수업 공방 서버 (Cloudflare Worker)
// - /api/* 요청은 여기서 처리하고, 나머지는 public 폴더의 화면을 보여 줍니다.
// - 기록은 D1(DB)에 저장합니다. 표는 처음 요청 때 자동으로 만들어집니다.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    current_step INTEGER NOT NULL DEFAULT 0,
    open INTEGER NOT NULL DEFAULT 1,
    created INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    name TEXT NOT NULL,
    number TEXT NOT NULL DEFAULT '',
    personal_code TEXT NOT NULL UNIQUE,
    step INTEGER NOT NULL DEFAULT 0,
    completed TEXT NOT NULL DEFAULT '[]',
    help INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    seen INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS students_room ON students(room)`,
  `CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS questions_room ON questions(room)`,
  `CREATE TABLE IF NOT EXISTS answers (
    question_id TEXT NOT NULL,
    student_id TEXT NOT NULL,
    value TEXT NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (question_id, student_id)
  )`,
  `CREATE TABLE IF NOT EXISTS submissions (
    student_id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    repo_url TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS submissions_room ON submissions(room)`,
];

// 처음 버전에서 만든 표에 새 칸을 더합니다. 이미 있으면 그냥 넘어갑니다.
const MIGRATIONS = [
  `ALTER TABLE students ADD COLUMN subject TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE students ADD COLUMN memo TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE rooms ADD COLUMN active_question TEXT`,
];

const MAX_STEPS = 200;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O, 1/I/L은 뺐어요.

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  for (const sql of MIGRATIONS) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      if (!/duplicate column/i.test(String(err))) throw err;
    }
  }
  schemaReady = true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    try {
      await ensureSchema(env.DB);
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: '서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요.' }, 500);
    }
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function parse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function randomFrom(chars, length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function newPersonalCode() {
  const raw = randomFrom(CODE_CHARS, 8);
  return raw.slice(0, 4) + '-' + raw.slice(4);
}

function normalizePersonalCode(value) {
  const raw = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : '';
}

function httpsUrl(value, max = 300) {
  const v = text(value, max);
  if (!v) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// ---------- 공통으로 읽는 정보 ----------

function publicStudent(row) {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject || row.number || '',
    step: row.step,
    completed: parse(row.completed, []),
    help: !!row.help,
    memo: parse(row.memo, {}),
  };
}

async function roomInfo(env, code) {
  const room = await env.DB.prepare('SELECT * FROM rooms WHERE code = ?').bind(code).first();
  if (!room) return null;
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM students WHERE room = ?').bind(code).first();
  return {
    code: room.code,
    title: room.title,
    currentStep: room.current_step,
    open: !!room.open,
    activeQuestion: room.active_question || null,
    count: n,
    created: room.created,
  };
}

async function questionsFor(env, code, studentId) {
  const { results: qs } = await env.DB.prepare('SELECT * FROM questions WHERE room = ? ORDER BY position, created')
    .bind(code).all();
  if (!qs.length) return [];
  const { results: ans } = await env.DB.prepare(
    `SELECT a.question_id, a.student_id, a.value FROM answers a
     JOIN questions q ON q.id = a.question_id WHERE q.room = ?`
  ).bind(code).all();

  return qs.map((q) => {
    const options = parse(q.options, []);
    const mine = ans.find((a) => a.question_id === q.id && a.student_id === studentId);
    const list = ans.filter((a) => a.question_id === q.id);
    let results;
    if (q.type === 'choice') {
      results = options.map((option) => ({ option, count: list.filter((a) => a.value === option).length }));
    } else {
      const counts = new Map();
      for (const a of list) {
        const key = a.value.trim();
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      results = [...counts].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count);
    }
    return {
      id: q.id, title: q.title, type: q.type, options, position: q.position,
      responses: list.length, results, mine: mine ? mine.value : null,
    };
  });
}

async function galleryFor(env, code) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, st.name, st.subject, st.number FROM submissions s
     JOIN students st ON st.id = s.student_id WHERE s.room = ? ORDER BY s.created`
  ).bind(code).all();
  return results.map((r) => ({
    studentId: r.student_id, title: r.title, url: r.url, repoUrl: r.repo_url, note: r.note,
    created: r.created, name: r.name, subject: r.subject || r.number || '',
  }));
}

// ---------- 참여자 ----------

async function studentFromRequest(request, env) {
  const auth = request.headers.get('authorization') || '';
  const code = normalizePersonalCode(auth.replace(/^Bearer\s+/i, ''));
  if (!code) throw new HttpError(401, '다시 입장해 주세요.');
  const row = await env.DB.prepare('SELECT * FROM students WHERE personal_code = ?').bind(code).first();
  if (!row) throw new HttpError(401, '입장 정보가 만료되었거나 연수방이 삭제되었어요. 개인코드로 다시 입장해 주세요.');
  return row;
}

async function join(request, env) {
  const data = await body(request);
  const roomCode = text(data.room, 6);
  const name = text(data.name, 24);
  const subject = text(data.subject, 30);
  if (!/^\d{6}$/.test(roomCode)) throw new HttpError(400, '참여코드 6자리를 확인해 주세요.');
  if (!name) throw new HttpError(400, '나를 부를 별칭을 적어 주세요.');

  const room = await env.DB.prepare('SELECT * FROM rooms WHERE code = ?').bind(roomCode).first();
  if (!room) throw new HttpError(404, '그런 참여코드는 없어요. 강사에게 다시 확인해 주세요.');
  if (!room.open) throw new HttpError(403, '지금은 새 입장이 닫혀 있어요. 강사에게 말씀해 주세요.');

  const now = Date.now();
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    const personalCode = newPersonalCode();
    try {
      await env.DB.prepare(
        `INSERT INTO students (id, room, name, subject, personal_code, created, seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, roomCode, name, subject, personalCode, now, now).run();
      return json({ personalCode, name, room: await roomInfo(env, roomCode) });
    } catch (err) {
      if (!String(err).includes('UNIQUE')) throw err;
    }
  }
  throw new HttpError(500, '개인코드를 만들지 못했어요. 다시 시도해 주세요.');
}

async function rejoin(request, env) {
  const data = await body(request);
  const code = normalizePersonalCode(data.personalCode);
  if (!code) throw new HttpError(400, '개인코드 8자리를 확인해 주세요.');
  const row = await env.DB.prepare('SELECT * FROM students WHERE personal_code = ?').bind(code).first();
  if (!row) throw new HttpError(404, '그런 개인코드는 없어요. 잃어버렸다면 강사에게 재발급을 요청하세요.');
  await env.DB.prepare('UPDATE students SET seen = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return json({ personalCode: code, room: await roomInfo(env, row.room) });
}

async function state(request, env) {
  const row = await studentFromRequest(request, env);
  await env.DB.prepare('UPDATE students SET seen = ? WHERE id = ?').bind(Date.now(), row.id).run();
  const gallery = await galleryFor(env, row.room);
  return json({
    me: publicStudent(row),
    room: await roomInfo(env, row.room),
    questions: await questionsFor(env, row.room, row.id),
    gallery,
    mySubmission: gallery.find((g) => g.studentId === row.id) || null,
  });
}

async function progress(request, env) {
  const row = await studentFromRequest(request, env);
  const data = await body(request);
  const completed = new Set(parse(row.completed, []));
  let step = row.step;
  let help = row.help;
  let memo = parse(row.memo, {});

  if (Number.isInteger(data.step) && data.step >= 0 && data.step < MAX_STEPS) {
    step = data.step;
    if (data.done === true) completed.add(data.step);
    if (data.done === false) completed.delete(data.step);
  }
  if (typeof data.help === 'boolean') help = data.help ? 1 : 0;
  if (data.memo && typeof data.memo === 'object') {
    for (const [key, value] of Object.entries(data.memo).slice(0, 20)) {
      memo[text(key, 40)] = text(value, 500);
    }
  }

  const list = [...completed].sort((a, b) => a - b);
  await env.DB.prepare('UPDATE students SET step = ?, completed = ?, help = ?, memo = ?, seen = ? WHERE id = ?')
    .bind(step, JSON.stringify(list), help, JSON.stringify(memo), Date.now(), row.id)
    .run();
  return json({ me: { ...publicStudent(row), step, completed: list, help: !!help, memo } });
}

async function answer(request, env) {
  const row = await studentFromRequest(request, env);
  const data = await body(request);
  const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND room = ?')
    .bind(text(data.questionId, 64), row.room).first();
  if (!q) throw new HttpError(404, '질문을 찾을 수 없어요.');
  let value = text(data.value, q.type === 'word' ? 20 : 100);
  if (!value) throw new HttpError(400, q.type === 'word' ? '단어 하나를 적어 주세요.' : '보기를 골라 주세요.');
  if (q.type === 'choice' && !parse(q.options, []).includes(value)) throw new HttpError(400, '보기에서 골라 주세요.');
  await env.DB.prepare(
    `INSERT INTO answers (question_id, student_id, value, updated) VALUES (?, ?, ?, ?)
     ON CONFLICT(question_id, student_id) DO UPDATE SET value = excluded.value, updated = excluded.updated`
  ).bind(q.id, row.id, value, Date.now()).run();
  return json({ ok: true });
}

async function submit(request, env) {
  const row = await studentFromRequest(request, env);
  const data = await body(request);
  const title = text(data.title, 60);
  const url = httpsUrl(data.url);
  const repoUrl = httpsUrl(data.repoUrl);
  const note = text(data.note, 500);
  if (!title) throw new HttpError(400, '사이트 제목을 적어 주세요.');
  if (!url) throw new HttpError(400, '발행 주소를 https:// 로 시작하는 주소로 적어 주세요.');
  if (repoUrl === null) throw new HttpError(400, 'GitHub 주소는 https:// 로 시작해야 해요.');
  await env.DB.prepare(
    `INSERT INTO submissions (student_id, room, title, url, repo_url, note, created) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(student_id) DO UPDATE SET title = excluded.title, url = excluded.url,
       repo_url = excluded.repo_url, note = excluded.note`
  ).bind(row.id, row.room, title, url, repoUrl || '', note, Date.now()).run();
  return json({ ok: true });
}

// ---------- 강사 ----------

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function requireTeacher(request, env) {
  if (!env.TEACHER_PASSWORD) {
    throw new HttpError(503, '아직 강사 비밀번호(TEACHER_PASSWORD)가 설정되지 않았어요. README를 확인해 주세요.');
  }
  const given = await sha256(request.headers.get('x-teacher-password') || '');
  const expected = await sha256(env.TEACHER_PASSWORD);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given[i] ^ expected[i];
  if (diff !== 0) throw new HttpError(401, '강사 비밀번호가 맞지 않아요.');
}

async function teacherRooms(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM students s WHERE s.room = r.code) AS count
     FROM rooms r ORDER BY r.created DESC`
  ).all();
  return json({
    rooms: results.map((r) => ({
      code: r.code, title: r.title, currentStep: r.current_step, open: !!r.open, count: r.count, created: r.created,
    })),
  });
}

async function createRoom(request, env) {
  const data = await body(request);
  const title = text(data.title, 60);
  if (!title) throw new HttpError(400, '연수 이름을 적어 주세요.');
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomFrom('0123456789', 6);
    if (code.startsWith('0')) continue;
    const exists = await env.DB.prepare('SELECT 1 FROM rooms WHERE code = ?').bind(code).first();
    if (exists) continue;
    await env.DB.prepare('INSERT INTO rooms (code, title, created) VALUES (?, ?, ?)').bind(code, title, Date.now()).run();
    return json({ room: await roomInfo(env, code) });
  }
  throw new HttpError(500, '참여코드를 만들지 못했어요. 다시 시도해 주세요.');
}

async function roomDetail(env, code) {
  const room = await roomInfo(env, code);
  if (!room) throw new HttpError(404, '연수방을 찾을 수 없어요.');
  const { results } = await env.DB.prepare('SELECT * FROM students WHERE room = ? ORDER BY created').bind(code).all();
  const gallery = await galleryFor(env, code);
  const submitted = new Set(gallery.map((g) => g.studentId));
  return json({
    room,
    students: results.map((s) => ({ ...publicStudent(s), seen: s.seen, created: s.created, submitted: submitted.has(s.id) })),
    questions: await questionsFor(env, code, null),
    gallery,
  });
}

async function requireRoom(env, code) {
  const room = await env.DB.prepare('SELECT * FROM rooms WHERE code = ?').bind(text(code, 6)).first();
  if (!room) throw new HttpError(404, '연수방을 찾을 수 없어요.');
  return room;
}

async function updateRoom(request, env) {
  const data = await body(request);
  const room = await requireRoom(env, data.code);
  const currentStep = Number.isInteger(data.currentStep) && data.currentStep >= 0 && data.currentStep < MAX_STEPS
    ? data.currentStep : room.current_step;
  const open = typeof data.open === 'boolean' ? (data.open ? 1 : 0) : room.open;
  const title = text(data.title, 60) || room.title;
  let active = room.active_question;
  if (data.activeQuestion === null) active = null;
  if (typeof data.activeQuestion === 'string') active = text(data.activeQuestion, 64);
  await env.DB.prepare('UPDATE rooms SET current_step = ?, open = ?, title = ?, active_question = ? WHERE code = ?')
    .bind(currentStep, open, title, active, room.code).run();
  return roomDetail(env, room.code);
}

async function deleteRoom(request, env) {
  const data = await body(request);
  const room = await requireRoom(env, data.code);
  if (text(data.confirm, 6) !== room.code) throw new HttpError(400, '확인을 위해 참여코드를 정확히 입력해 주세요.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM answers WHERE question_id IN (SELECT id FROM questions WHERE room = ?)').bind(room.code),
    env.DB.prepare('DELETE FROM questions WHERE room = ?').bind(room.code),
    env.DB.prepare('DELETE FROM submissions WHERE room = ?').bind(room.code),
    env.DB.prepare('DELETE FROM students WHERE room = ?').bind(room.code),
    env.DB.prepare('DELETE FROM rooms WHERE code = ?').bind(room.code),
  ]);
  return json({ ok: true });
}

async function studentAction(request, env) {
  const data = await body(request);
  const row = await env.DB.prepare('SELECT * FROM students WHERE id = ?').bind(text(data.id, 64)).first();
  if (!row) throw new HttpError(404, '참여자를 찾을 수 없어요.');

  if (data.action === 'reissue') {
    for (let attempt = 0; attempt < 5; attempt++) {
      const personalCode = newPersonalCode();
      try {
        await env.DB.prepare('UPDATE students SET personal_code = ? WHERE id = ?').bind(personalCode, row.id).run();
        return json({ personalCode, name: row.name });
      } catch (err) {
        if (!String(err).includes('UNIQUE')) throw err;
      }
    }
    throw new HttpError(500, '개인코드를 만들지 못했어요.');
  }
  if (data.action === 'clear-help') {
    await env.DB.prepare('UPDATE students SET help = 0 WHERE id = ?').bind(row.id).run();
    return json({ ok: true });
  }
  if (data.action === 'remove') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM answers WHERE student_id = ?').bind(row.id),
      env.DB.prepare('DELETE FROM submissions WHERE student_id = ?').bind(row.id),
      env.DB.prepare('DELETE FROM students WHERE id = ?').bind(row.id),
    ]);
    return json({ ok: true });
  }
  throw new HttpError(400, '알 수 없는 요청이에요.');
}

function cleanOptions(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split('\n'))
    .map((o) => text(o, 60)).filter(Boolean);
  return [...new Set(list)].slice(0, 8);
}

async function questionAction(request, env) {
  const data = await body(request);
  const room = await requireRoom(env, data.code);

  if (data.action === 'create') {
    const title = text(data.title, 160);
    const type = data.type === 'choice' ? 'choice' : 'word';
    const options = type === 'choice' ? cleanOptions(data.options) : [];
    if (!title) throw new HttpError(400, '질문을 적어 주세요.');
    if (type === 'choice' && options.length < 2) throw new HttpError(400, '보기를 2개 이상 적어 주세요.');
    const { m } = await env.DB.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM questions WHERE room = ?').bind(room.code).first();
    const id = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO questions (id, room, title, type, options, position, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, room.code, title, type, JSON.stringify(options), m + 1, Date.now()),
      env.DB.prepare('UPDATE rooms SET active_question = ? WHERE code = ?').bind(id, room.code),
    ]);
    return roomDetail(env, room.code);
  }

  const q = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND room = ?').bind(text(data.id, 64), room.code).first();
  if (!q) throw new HttpError(404, '질문을 찾을 수 없어요.');

  if (data.action === 'update') {
    const title = text(data.title, 160) || q.title;
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM answers WHERE question_id = ?').bind(q.id).first();
    let options = parse(q.options, []);
    if (q.type === 'choice' && data.options !== undefined) {
      const next = cleanOptions(data.options);
      if (next.length < 2) throw new HttpError(400, '보기를 2개 이상 적어 주세요.');
      if (n > 0) {
        const { results } = await env.DB.prepare('SELECT DISTINCT value FROM answers WHERE question_id = ?').bind(q.id).all();
        const missing = results.map((r) => r.value).filter((v) => !next.includes(v));
        if (missing.length) throw new HttpError(400, '이미 선택된 보기(' + missing.join(', ') + ')는 지울 수 없어요.');
      }
      options = next;
    }
    await env.DB.prepare('UPDATE questions SET title = ?, options = ? WHERE id = ?').bind(title, JSON.stringify(options), q.id).run();
    return roomDetail(env, room.code);
  }

  if (data.action === 'delete') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM answers WHERE question_id = ?').bind(q.id),
      env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(q.id),
      env.DB.prepare('UPDATE rooms SET active_question = NULL WHERE code = ? AND active_question = ?').bind(room.code, q.id),
    ]);
    return roomDetail(env, room.code);
  }

  if (data.action === 'move') {
    const { results } = await env.DB.prepare('SELECT id FROM questions WHERE room = ? ORDER BY position, created').bind(room.code).all();
    const ids = results.map((r) => r.id);
    const i = ids.indexOf(q.id);
    const j = data.dir === 'up' ? i - 1 : i + 1;
    if (j >= 0 && j < ids.length) {
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await env.DB.batch(ids.map((id, pos) => env.DB.prepare('UPDATE questions SET position = ? WHERE id = ?').bind(pos, id)));
    }
    return roomDetail(env, room.code);
  }
  throw new HttpError(400, '알 수 없는 요청이에요.');
}

// ---------- 길 안내 ----------

async function route(request, env, url) {
  const key = request.method + ' ' + url.pathname;
  switch (key) {
    case 'POST /api/join': return join(request, env);
    case 'POST /api/rejoin': return rejoin(request, env);
    case 'GET /api/state': return state(request, env);
    case 'POST /api/progress': return progress(request, env);
    case 'POST /api/answer': return answer(request, env);
    case 'POST /api/submit': return submit(request, env);
  }

  if (url.pathname.startsWith('/api/teacher/')) {
    await requireTeacher(request, env);
    switch (key) {
      case 'GET /api/teacher/rooms': return teacherRooms(env);
      case 'POST /api/teacher/rooms': return createRoom(request, env);
      case 'GET /api/teacher/room': return roomDetail(env, text(url.searchParams.get('code'), 6));
      case 'POST /api/teacher/room': return updateRoom(request, env);
      case 'POST /api/teacher/room/delete': return deleteRoom(request, env);
      case 'POST /api/teacher/student': return studentAction(request, env);
      case 'POST /api/teacher/question': return questionAction(request, env);
    }
  }
  throw new HttpError(404, '없는 주소예요.');
}
