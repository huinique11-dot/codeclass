// 코드교실 서버 (Cloudflare Worker)
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
];

const MAX_STEPS = 200;
// 헷갈리는 글자(0/O, 1/I/L)는 뺐습니다.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
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

// ---------- 학생 ----------

function publicStudent(row) {
  return {
    id: row.id,
    name: row.name,
    number: row.number,
    step: row.step,
    completed: JSON.parse(row.completed || '[]'),
    help: !!row.help,
  };
}

async function studentFromRequest(request, env) {
  const auth = request.headers.get('authorization') || '';
  const code = normalizePersonalCode(auth.replace(/^Bearer\s+/i, ''));
  if (!code) throw new HttpError(401, '다시 입장해 주세요.');
  const row = await env.DB.prepare('SELECT * FROM students WHERE personal_code = ?').bind(code).first();
  if (!row) throw new HttpError(401, '개인코드를 찾을 수 없어요. 다시 입장해 주세요.');
  return row;
}

async function roomInfo(env, code) {
  const room = await env.DB.prepare('SELECT * FROM rooms WHERE code = ?').bind(code).first();
  if (!room) return null;
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM students WHERE room = ?').bind(code).first();
  return { code: room.code, title: room.title, currentStep: room.current_step, open: !!room.open, count: n };
}

async function join(request, env) {
  const data = await body(request);
  const roomCode = text(data.room, 6);
  const name = text(data.name, 24);
  const number = text(data.number, 12);
  if (!/^\d{6}$/.test(roomCode)) throw new HttpError(400, '참여코드 6자리를 확인해 주세요.');
  if (!name) throw new HttpError(400, '이름(별칭)을 적어 주세요.');

  const room = await env.DB.prepare('SELECT * FROM rooms WHERE code = ?').bind(roomCode).first();
  if (!room) throw new HttpError(404, '그런 참여코드는 없어요. 선생님께 다시 확인해 주세요.');
  if (!room.open) throw new HttpError(403, '지금은 입장이 닫혀 있어요. 선생님께 말씀해 주세요.');

  const now = Date.now();
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    const personalCode = newPersonalCode();
    try {
      await env.DB.prepare(
        'INSERT INTO students (id, room, name, number, personal_code, created, seen) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, roomCode, name, number, personalCode, now, now).run();
      return json({ personalCode, room: await roomInfo(env, roomCode) });
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
  if (!row) throw new HttpError(404, '그런 개인코드는 없어요. 잃어버렸다면 선생님께 재발급을 부탁하세요.');
  await env.DB.prepare('UPDATE students SET seen = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return json({ personalCode: code, room: await roomInfo(env, row.room) });
}

async function state(request, env) {
  const row = await studentFromRequest(request, env);
  await env.DB.prepare('UPDATE students SET seen = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return json({ me: publicStudent(row), room: await roomInfo(env, row.room) });
}

async function progress(request, env) {
  const row = await studentFromRequest(request, env);
  const data = await body(request);
  const completed = new Set(JSON.parse(row.completed || '[]'));
  let step = row.step;
  let help = row.help;

  if (Number.isInteger(data.step) && data.step >= 0 && data.step < MAX_STEPS) {
    step = data.step;
    if (data.done === true) completed.add(data.step);
    if (data.done === false) completed.delete(data.step);
  }
  if (typeof data.help === 'boolean') help = data.help ? 1 : 0;

  const list = [...completed].sort((a, b) => a - b);
  await env.DB.prepare('UPDATE students SET step = ?, completed = ?, help = ?, seen = ? WHERE id = ?')
    .bind(step, JSON.stringify(list), help, Date.now(), row.id)
    .run();
  return json({ me: { ...publicStudent(row), step, completed: list, help: !!help } });
}

// ---------- 선생님 ----------

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function requireTeacher(request, env) {
  if (!env.TEACHER_PASSWORD) {
    throw new HttpError(503, '아직 선생님 비밀번호(TEACHER_PASSWORD)가 설정되지 않았어요. README를 확인해 주세요.');
  }
  const given = await sha256(request.headers.get('x-teacher-password') || '');
  const expected = await sha256(env.TEACHER_PASSWORD);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given[i] ^ expected[i];
  if (diff !== 0) throw new HttpError(401, '선생님 비밀번호가 맞지 않아요.');
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
  const title = text(data.title, 40);
  if (!title) throw new HttpError(400, '수업 이름을 적어 주세요.');
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
  if (!room) throw new HttpError(404, '수업을 찾을 수 없어요.');
  const { results } = await env.DB.prepare('SELECT * FROM students WHERE room = ? ORDER BY created').bind(code).all();
  return json({
    room,
    students: results.map((s) => ({ ...publicStudent(s), seen: s.seen, created: s.created })),
  });
}

async function updateRoom(request, env) {
  const data = await body(request);
  const code = text(data.code, 6);
  const room = await env.DB.prepare('SELECT * FROM rooms WHERE code = ?').bind(code).first();
  if (!room) throw new HttpError(404, '수업을 찾을 수 없어요.');
  const currentStep = Number.isInteger(data.currentStep) && data.currentStep >= 0 && data.currentStep < MAX_STEPS
    ? data.currentStep : room.current_step;
  const open = typeof data.open === 'boolean' ? (data.open ? 1 : 0) : room.open;
  const title = text(data.title, 40) || room.title;
  await env.DB.prepare('UPDATE rooms SET current_step = ?, open = ?, title = ? WHERE code = ?')
    .bind(currentStep, open, title, code).run();
  return roomDetail(env, code);
}

async function studentAction(request, env) {
  const data = await body(request);
  const row = await env.DB.prepare('SELECT * FROM students WHERE id = ?').bind(text(data.id, 64)).first();
  if (!row) throw new HttpError(404, '학생을 찾을 수 없어요.');

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
    await env.DB.prepare('DELETE FROM students WHERE id = ?').bind(row.id).run();
    return json({ ok: true });
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
  }

  if (url.pathname.startsWith('/api/teacher/')) {
    await requireTeacher(request, env);
    switch (key) {
      case 'GET /api/teacher/rooms': return teacherRooms(env);
      case 'POST /api/teacher/rooms': return createRoom(request, env);
      case 'GET /api/teacher/room': return roomDetail(env, text(url.searchParams.get('code'), 6));
      case 'POST /api/teacher/room': return updateRoom(request, env);
      case 'POST /api/teacher/student': return studentAction(request, env);
    }
  }
  throw new HttpError(404, '없는 주소예요.');
}
