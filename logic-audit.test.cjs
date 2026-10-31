const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'seguimiento-personal.html');
const schemaPath = path.join(__dirname, '..', 'supabase-schema.sql');
const manifestPath = path.join(__dirname, '..', 'manifest.webmanifest');
const serviceWorkerPath = path.join(__dirname, '..', 'service-worker.js');
const html = fs.readFileSync(htmlPath, 'utf8');
const schema = fs.readFileSync(schemaPath, 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1]).join('\n');

function extractFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(inlineScripts);
  assert.ok(match, `No se encontró la función ${name}`);
  const start = match.index;
  const open = inlineScripts.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let regexLiteral = false;
  let regexClass = false;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;

  for (let index = open; index < inlineScripts.length; index += 1) {
    const char = inlineScripts[index];
    const next = inlineScripts[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (regexLiteral) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '[') regexClass = true;
      else if (char === ']') regexClass = false;
      else if (char === '/' && !regexClass) regexLiteral = false;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === '/') {
      const prefix = inlineScripts.slice(0, index).trimEnd();
      const previous = prefix[prefix.length - 1];
      const keyword = (prefix.match(/[A-Za-z_$][\w$]*$/) || [])[0];
      if ('=(:,![{;?&|'.includes(previous) || ['return', 'case', 'throw', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await'].includes(keyword)) {
        regexLiteral = true;
        regexClass = false;
        continue;
      }
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return inlineScripts.slice(start, index + 1);
  }
  throw new Error(`No se encontró el cierre de ${name}`);
}

function makeContext(functionNames, overrides = {}) {
  const base = {
    data: { activities: {}, workouts: {}, progress: {}, alarms: [], habitProfiles: [], exerciseProfiles: [], account: {} },
    currentUser: { id: 'user-a', email: 'a@example.test' },
    authStateVersion: 0,
    navigator: { onLine: true },
    cloudReadyUserId: 'user-a',
    USER_STORAGE_PREFIX: 'seguimiento_personal_v1:user:',
    syncMetaPrefix: 'seguimiento_personal_v1:sync:',
    localDataRevision: 0,
    syncWriteQueues: Object.create(null),
    syncConflictUserIds: Object.create(null),
    DAYS: ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'],
    today: new Date(2024, 1, 29),
    progressPeriod: 'month',
    progressAnchorDate: new Date(2024, 1, 29),
    activeUserWriteControllers: [],
    authFlowPromise: null,
    authFlowUserId: null,
    authFlowStateVersion: null,
    subtaskProgressStartPct: {},
    subtaskProgressStartTimers: {},
    subtaskCompletionFeedbackId: null,
    subtaskCompletionFeedbackTimer: null,
    completionFeedbackId: null,
    completionFeedbackTimer: null,
    expandedActivities: {},
    bootedUserId: null,
    bootPromise: null,
    bootPromiseUserId: null,
    welcomeAfterRegistrationUserId: null,
    passwordRecoveryPending: false,
    console: { error() {}, info() {}, warn() {} },
    localStorage: {
      values: new Map(),
      getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
      setItem(key, value) { this.values.set(key, String(value)); },
      removeItem(key) { this.values.delete(key); }
    },
    cacheSnapshot() { return this.data; },
    window: { crypto: { randomUUID: () => `test-${Math.random().toString(16).slice(2)}` } },
    document: { querySelectorAll: () => [], getElementById: () => null },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    alert() {},
    confirm: () => true,
    prompt: () => 'Perfil nuevo',
    JSON,
    Object,
    Array,
    Date,
    Math,
    Number,
    String,
    Error,
    AbortController
  };
  Object.assign(base, overrides);
  const context = vm.createContext(base);
  vm.runInContext(functionNames.map(extractFunction).join('\n'), context);
  return context;
}

const dateFunctions = ['pad2', 'fmtKey', 'addDays', 'startOfWeek', 'dayKeyFromDate'];

test('estados, snapshots y estadísticas conservan completadas, omitidas y pendientes', () => {
  const c = makeContext([...dateFunctions, 'activityState', 'dayStats', 'dateHasProgress']);
  c.data.activities.lunes = [{ id: 'new', name: 'Nueva tarea' }];
  c.data.progress['2024-02-26'] = {
    activitySnapshot: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    activities: { a: 'done', b: true, c: 'skipped', orphan: 'done' }
  };
  assert.deepEqual({ ...c.dayStats('2024-02-26', 'lunes') }, {
    done: 2, skipped: 1, pending: 1, total: 4, pct: 50, tracked: true, estimated: false
  });
  assert.equal(c.dateHasProgress('2024-02-26'), true);
  assert.equal(c.dayStats('2024-02-27', 'martes').tracked, false);
});

test('subtareas calculan porcentajes y alternan sin contar identificadores ajenos', () => {
  const c = makeContext(['getProgress', 'subtaskDoneMap', 'subtaskStats', 'isSubtaskDone', 'findActivityById', 'toggleSubtask']);
  const activity = { id: 'act-1', subtasks: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] };
  c.data.activities.lunes = [activity];
  c.data.progress.d = { subtasks: { 'act-1': { s1: true, orphan: true } } };
  c.findActivityById = (id) => c.data.activities.lunes.find((item) => item.id === id) || null;
  c.saveData = () => {};
  c.subtaskProgressStartTimers = {};
  c.subtaskProgressStartPct = {};
  c.subtaskCompletionFeedbackTimer = null;
  c.subtaskCompletionFeedbackId = null;
  assert.deepEqual({ ...c.subtaskStats('d', activity) }, { done: 1, total: 3, pct: 33 });
  c.toggleSubtask('d', activity.id, 's2');
  assert.deepEqual({ ...c.subtaskStats('d', activity) }, { done: 2, total: 3, pct: 67 });
  c.toggleSubtask('d', activity.id, 's2');
  assert.deepEqual({ ...c.subtaskStats('d', activity) }, { done: 1, total: 3, pct: 33 });
});

test('fechas cubren semana local, febrero bisiesto, año y transiciones', () => {
  const c = makeContext([...dateFunctions, 'progressRange']);
  c.progressPeriod = 'month'; c.progressAnchorDate = new Date(2024, 1, 29);
  let range = c.progressRange();
  assert.equal(c.fmtKey(range.start), '2024-02-01');
  assert.equal(c.fmtKey(range.end), '2024-02-29');
  c.progressPeriod = 'year'; range = c.progressRange();
  assert.equal(c.fmtKey(range.start), '2024-01-01');
  assert.equal(c.fmtKey(range.end), '2024-12-31');
  assert.equal(c.fmtKey(c.addDays(new Date(2024, 11, 31), 1)), '2025-01-01');
  assert.equal(c.fmtKey(c.startOfWeek(new Date(2024, 2, 3))), '2024-02-26');
});

test('racha usa días registrados al 60% y se rompe en un día fallido', () => {
  const c = makeContext([...dateFunctions, 'activityState', 'dayStats', 'dateHasProgress', 'computeStreak']);
  c.today = new Date(2024, 1, 29);
  for (let day = 26; day <= 29; day += 1) {
    const key = `2024-02-${String(day).padStart(2, '0')}`;
    c.data.progress[key] = { activitySnapshot: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }], activities: { a: 'done', b: 'done', c: 'done' } };
  }
  assert.equal(c.computeStreak(), 4);
  c.data.progress['2024-02-28'].activities = { a: 'done', b: 'skipped' };
  assert.equal(c.computeStreak(), 1);
});

test('niveles de cumplimiento aplican umbrales 40/60/70/90', () => {
  const c = makeContext(['progressLevel']);
  assert.equal(c.progressLevel(39).threshold, 0);
  assert.equal(c.progressLevel(40).threshold, 40);
  assert.equal(c.progressLevel(60).threshold, 60);
  assert.equal(c.progressLevel(70).threshold, 70);
  assert.equal(c.progressLevel(90).threshold, 90);
});

test('el control de estado de tareas es teclado-accesible y anuncia estado y acción', () => {
  assert.match(inlineScripts, /<button type="button" class="t-check/);
  assert.match(inlineScripts, /checkButton\.setAttribute\("aria-label", nextStateAction/);
  assert.match(html, /button:focus-visible[^\{]*\{ outline:/);
});

test('navegación lateral y días aceptan Enter/Espacio con semántica y estado anunciado', () => {
  const c = makeContext(['makeKeyboardButton']);
  const listeners = {};
  const attributes = {};
  let clicks = 0, prevented = 0;
  const element = {
    setAttribute(key, value) { attributes[key] = value; },
    addEventListener(name, callback) { listeners[name] = callback; },
    click() { clicks += 1; }
  };
  c.makeKeyboardButton(element);
  assert.equal(attributes.role, 'button');
  assert.equal(element.tabIndex, 0);
  listeners.keydown({ key: 'Enter', preventDefault() { prevented += 1; } });
  listeners.keydown({ key: ' ', preventDefault() { prevented += 1; } });
  listeners.keydown({ key: 'x', preventDefault() { prevented += 1; } });
  assert.equal(clicks, 2);
  assert.equal(prevented, 2);
  assert.match(inlineScripts, /makeKeyboardButton\(it\)/);
  assert.match(inlineScripts, /pill\.setAttribute\("aria-pressed", String\(isActive\)\)/);
  assert.match(inlineScripts, /setAttribute\("aria-current", "page"\)/);
});

test('contenido guardado se escapa antes de insertarse en HTML y los colores usan lista segura', () => {
  const c = makeContext(['escapeHtml', 'kindColor']);
  assert.equal(c.escapeHtml(`<img src=x onerror="alert(1)">`), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(c.escapeHtml("'&"), '&#39;&amp;');
  assert.equal(c.kindColor({ color: '#AABBCC' }), '#AABBCC');
  assert.equal(c.kindColor({ color: 'red; background:url(javascript:alert(1))' }), null);
  assert.match(inlineScripts, /'<div class="t-time">' \+ escapeHtml\(a\.time\)/);
});

test('IDs de actividad y subtarea se escapan y se consultan sin interpolar selectores', () => {
  const c = makeContext(['escapeHtml', 'subtaskDoneMap', 'isSubtaskDone', 'subtaskListOnlyHTML', 'subtaskToggleHTML', 'wireSubtaskBlock']);
  const activity = { id: 'act" onclick="bad', subtasks: [{ id: 'sub" onclick="bad', name: 'Paso' }] };
  c.data.progress = {};
  c.expandedActivities = {};
  c.subtaskCompletionFeedbackId = null;
  const block = c.subtaskListOnlyHTML('d', activity) + c.subtaskToggleHTML(activity, { done: 0, total: 1, pct: 0 });
  assert.match(block, /data-sub-list="act&quot; onclick=&quot;bad"/);
  assert.match(block, /data-sub-item="sub&quot; onclick=&quot;bad"/);
  assert.match(block, /data-sub-toggle="act&quot; onclick=&quot;bad"/);
  assert.match(inlineScripts, /querySelectorAll\("\[data-sub-toggle\]"\)/);
  assert.match(inlineScripts, /querySelectorAll\("\[data-sub-list\]"\)/);
});

test('el drag táctil ignora inputs y controles internos para evitar arrastres accidentales', () => {
  assert.match(inlineScripts, /var control = event\.target\.closest\("button,select,textarea,input"\);\s*if \(control\) return;/);
  assert.doesNotMatch(inlineScripts, /nameInputLongPress/);
});

test('el aviso de alarmas aclara almacenamiento local y límites con la pestaña cerrada', () => {
  assert.match(html, /recordatorios se guardan solo en este dispositivo y se comprueban mientras PASO A PASO está abierto/);
  assert.match(html, /No se sincronizan entre dispositivos/);
  assert.match(html, /no se garantiza que lleguen con la aplicación cerrada/);
});

test('Inicio conserva el orden manual de actividades de hoy', () => {
  const c = makeContext([...dateFunctions, 'todaysActivitiesInOrder']);
  c.today = new Date(2024, 1, 29);
  c.data.activities.jueves = [
    { id: 'late', time: '19:00' }, { id: 'early', time: '07:00' }
  ];
  assert.deepEqual(c.todaysActivitiesInOrder().map((item) => item.id), ['late', 'early']);
  assert.deepEqual(c.data.activities.jueves.map((item) => item.id), ['late', 'early']);
});

test('soltar una actividad actualiza el orden persistido de su perfil', () => {
  const c = makeContext(['finishActivityDrag']);
  const activities = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const rowA = { classList: { remove() {} }, style: {}, getAttribute: () => 'a' };
  const rowB = { classList: { contains: (name) => name === 'cust-row' } };
  const rowC = { classList: { contains: (name) => name === 'cust-row' } };
  const placeholder = { remove() {} };
  c.activityDrag = { row: rowA, active: true, moved: true, placeholder, longPressTimer: null };
  c.editingHabitProfile = { activities: { lunes: activities } };
  c.custDay = 'lunes';
  c.custList = { children: [rowA, rowB, rowC, placeholder] };
  c.saveData = () => {};
  c.renderCustomize = () => {};
  c.finishActivityDrag(true);
  assert.deepEqual(c.editingHabitProfile.activities.lunes.map((item) => item.id), ['b', 'c', 'a']);
});

test('perfiles impiden duplicación Free y conservan edición/borrado ante fallo remoto', async () => {
  const c = makeContext(['toggleProfileActive', 'duplicateProfile', 'deleteProfile']);
  const one = { id: 'h1', name: 'Horario', active: true, activities: { lunes: [{ id: 'a' }] } };
  const two = { id: 'h2', name: 'Alternativo', active: false, activities: {} };
  c.data.habitProfiles = [one, two];
  c.isPlus = () => false;
  let planInfo = 0;
  c.openPlanInfo = () => { planInfo += 1; };
  c.duplicateProfile(c.data.habitProfiles, 'h1', () => {});
  assert.equal(c.data.habitProfiles.length, 2);
  assert.equal(planInfo, 1);
  let saved = 0;
  c.applyActiveProfiles = () => {};
  c.saveData = () => { saved += 1; };
  c.toggleProfileActive(c.data.habitProfiles, 'h2');
  assert.equal(c.data.habitProfiles.filter((profile) => profile.active).length, 1);
  assert.equal(c.data.habitProfiles[1].active, true);
  c.deleteRemoteProfile = async () => { throw new Error('fallo de red'); };
  c.reportCloudError = () => {};
  await c.deleteProfile(c.data.habitProfiles, 'h1', () => {});
  assert.equal(c.data.habitProfiles.length, 2);
  assert.equal(saved, 1);
});

test('el último perfil no se elimina y el borrado remoto confirmado sí elimina el perfil elegido', async () => {
  const c = makeContext(['deleteProfile']);
  c.data.habitProfiles = [{ id: 'h1', active: true }];
  let remoteCalls = 0;
  c.deleteRemoteProfile = async () => { remoteCalls += 1; return { ok: true }; };
  c.alert = () => {};
  c.saveData = () => {};
  await c.deleteProfile(c.data.habitProfiles, 'h1', () => {});
  assert.equal(c.data.habitProfiles.length, 1);
  assert.equal(remoteCalls, 0);

  c.data.habitProfiles.push({ id: 'h2', active: false });
  await c.deleteProfile(c.data.habitProfiles, 'h2', () => {});
  assert.deepEqual(c.data.habitProfiles.map((profile) => profile.id), ['h1']);
  assert.equal(remoteCalls, 1);
});

test('crear y renombrar perfiles rechaza nombres vacíos y conserva perfiles editables', () => {
  const c = makeContext(['createHabitProfile', 'renameProfile']);
  c.data.habitProfiles = [];
  c.isPlus = () => false;
  c.openPlanInfo = () => { throw new Error('No debe bloquear la primera alta Free'); };
  c.buildDefaultActivities = () => ({ lunes: [] });
  c.uid = () => 'new-id';
  c.saveData = () => {};
  c.renderHabitProfiles = () => {};
  c.prompt = () => '   ';
  c.createHabitProfile();
  assert.equal(c.data.habitProfiles.length, 0);
  c.prompt = () => ' Mi horario ';
  c.createHabitProfile();
  assert.equal(c.data.habitProfiles[0].name, 'Mi horario');
  c.prompt = () => '   ';
  c.renameProfile(c.data.habitProfiles, 'new-id', () => {});
  assert.equal(c.data.habitProfiles[0].name, 'Mi horario');
  c.prompt = () => '  Rutina nueva ';
  c.renameProfile(c.data.habitProfiles, 'new-id', () => {});
  assert.equal(c.data.habitProfiles[0].name, 'Rutina nueva');
});

test('duplicar perfil Plus asigna UUID nuevos sin modificar el original', () => {
  const c = makeContext(['duplicateProfile']);
  const original = { id: 'h1', name: 'Horario', active: true, activities: { lunes: [{ id: 'a' }] } };
  c.data.habitProfiles = [original];
  c.isPlus = () => true; c.DAYS = ['lunes'];
  let id = 0; c.uid = () => `uuid-${++id}`;
  c.saveData = () => {};
  c.duplicateProfile(c.data.habitProfiles, 'h1', () => {});
  assert.equal(c.data.habitProfiles.length, 2);
  assert.equal(c.data.habitProfiles[0].id, 'h1');
  assert.equal(c.data.habitProfiles[0].activities.lunes[0].id, 'a');
  assert.equal(c.data.habitProfiles[1].id, 'uuid-1');
  assert.equal(c.data.habitProfiles[1].activities.lunes[0].id, 'uuid-2');
});

test('Free, Plus activo/inactivo, acceso temporal y Admin se separan del usuario autenticado', () => {
  const c = makeContext(['isAdmin', 'isPaidPlus', 'isDevelopmentPlus', 'isPlus']);
  c.data.account = { role: 'user', plan: 'free', subscription_status: 'inactive', plus_access: false };
  assert.equal(c.isPlus(), false);
  c.data.account = { role: 'user', plan: 'plus', subscription_status: 'inactive', plus_access: false };
  assert.equal(c.isPlus(), false);
  c.data.account.subscription_status = 'active';
  assert.equal(c.isPlus(), true);
  c.data.account = { role: 'user', plan: 'free', subscription_status: 'inactive', plus_access: true };
  assert.equal(c.isPlus(), true);
  c.data.account = { role: 'admin', plan: 'free', subscription_status: 'inactive', plus_access: false };
  assert.equal(c.isAdmin(), true);
  c.currentUser = null;
  assert.equal(c.isPlus(), false);
});

test('caché por usuario restaura únicamente su clave y no persiste permisos temporales', () => {
  const c = makeContext(['loadData', 'cacheSnapshot', 'userStorageKey']);
  c.uid = () => 'generated-id';
  c.buildDefaultActivities = () => ({ lunes: [{ id: 'default' }] });
  c.buildDefaultWorkouts = () => ({ lunes: { exercises: [] } });
  const cacheKey = 'seguimiento_personal_v1:user:user-a';
  c.localStorage.setItem(cacheKey, JSON.stringify({ activities: { lunes: [{ id: 'a' }] }, workouts: {}, progress: {}, account: { plan: 'plus', plus_access: true } }));
  c.localStorage.setItem('seguimiento_personal_v1', JSON.stringify({ activities: { lunes: [{ id: 'legacy' }] } }));
  const reads = [];
  const getItem = c.localStorage.getItem.bind(c.localStorage);
  c.localStorage.getItem = (key) => { reads.push(key); return getItem(key); };
  c.loadData(null);
  assert.deepEqual(reads, []);
  reads.length = 0;
  const restored = c.loadData(cacheKey);
  assert.deepEqual(reads, [cacheKey]);
  assert.equal(restored.activities.lunes[0].id, 'a');
  c.data = { account: { id: 'user-a', plan: 'free', plus_access: true, plus_access_available: false }, progress: {} };
  const snapshot = c.cacheSnapshot();
  assert.equal(snapshot.account.plus_access, undefined);
  assert.equal(snapshot.account.plus_access_available, undefined);
  assert.equal(c.localStorage.getItem('seguimiento_personal_v1').includes('legacy'), true);
  c.currentUser = { id: 'user-b' };
  assert.equal(c.userStorageKey(), 'seguimiento_personal_v1:user:user-b');
});

test('detecta datos globales antiguos para informar al usuario sin importarlos ni borrarlos', () => {
  const c = makeContext(['hasUnassignedLegacyCache']);
  c.STORAGE_KEY = 'seguimiento_personal_v1';
  c.localStorage.setItem(c.STORAGE_KEY, JSON.stringify({ activities: { lunes: [{ id: 'old' }] } }));
  const before = c.localStorage.getItem(c.STORAGE_KEY);
  assert.equal(c.hasUnassignedLegacyCache(), true);
  assert.equal(c.localStorage.getItem(c.STORAGE_KEY), before);
  c.localStorage.removeItem(c.STORAGE_KEY);
  assert.equal(c.hasUnassignedLegacyCache(), false);
  c.localStorage.setItem(c.STORAGE_KEY, '{contenido-incompleto');
  assert.equal(c.hasUnassignedLegacyCache(), true);
});

test('pull fallido no reemplaza datos y una respuesta tardía de otra sesión se descarta', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'hasSyncConflict', 'stableSyncJson', 'markSyncConflict', 'writeSyncMeta', 'setSyncStatus', 'pullFromSupabase']);
  c.data.progress = { local: { activities: { a: 'done' } } };
  const tableData = {
    profiles: { data: { id: 'user-a', plan: 'free', role: 'user', subscription_status: 'inactive' } },
    habit_profiles: { data: [] }, exercise_profiles: { data: [] }, progress: { data: [] }
  };
  c.sb = { from(table) {
    return { select() { return { eq() { return { maybeSingle: () => Promise.resolve(tableData[table]), then(resolve, reject) { return Promise.resolve(tableData[table]).then(resolve, reject); } }; } }; } };
  } };
  c.applyActiveProfiles = () => {};
  c.updatePlanMenuLabel = () => {};
  c.cacheSnapshot = () => c.data;
  c.scheduleSync = () => {};
  c.USER_STORAGE_PREFIX = 'cache:';
  c.authStateVersion = 3;
  c.sb.rpc = async () => ({ data: false, error: { message: 'RPC no instalado' } });
  tableData.profiles = { data: null, error: { message: 'offline' } };
  await assert.rejects(c.pullFromSupabase('user-a'), /profiles select/);
  assert.deepEqual({ ...c.data.progress.local.activities }, { a: 'done' });

  const resolvers = {};
  const pendingByTable = Object.fromEntries(['profiles', 'habit_profiles', 'exercise_profiles', 'progress'].map((table) => [
    table, new Promise((resolve) => { resolvers[table] = resolve; })
  ]));
  c.sb.from = (table) => ({ select() { return { eq() { return {
    maybeSingle: () => pendingByTable[table],
    then: (resolve, reject) => pendingByTable[table].then(resolve, reject)
  }; } }; } });
  const stalePull = c.pullFromSupabase('user-a');
  c.currentUser = { id: 'user-b', email: 'b@example.test' };
  c.authStateVersion += 1;
  resolvers.profiles({ data: { id: 'user-a', plan: 'free', role: 'user', subscription_status: 'inactive' }, error: null });
  resolvers.habit_profiles({ data: [], error: null });
  resolvers.exercise_profiles({ data: [], error: null });
  resolvers.progress({ data: [], error: null });
  await assert.rejects(stalePull, /sesión cambió/);
  assert.equal(c.data.account.id, undefined);
  assert.equal(c.data.progress.local.activities.a, 'done');
});

test('pull exitoso conserva progreso local en conflicto y un RPC caído no concede acceso temporal', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'hasSyncConflict', 'stableSyncJson', 'markSyncConflict', 'writeSyncMeta', 'setSyncStatus', 'pullFromSupabase', 'isAdmin', 'isPaidPlus', 'isDevelopmentPlus', 'isPlus']);
  c.authStateVersion = 2;
  c.data.progress = {
    '2024-02-29': { activities: { local: 'done' } }
  };
  c.data.account = { plus_access: true, plan: 'plus', role: 'admin' };
  const results = {
    profiles: { data: { id: 'user-a', display_name: 'A', role: 'user', plan: 'free', subscription_status: 'inactive', onboarding_completed: false }, error: null },
    habit_profiles: { data: [{ id: 'h1', name: 'Remote', active: true, data: { lunes: [] } }], error: null },
    exercise_profiles: { data: [], error: null },
    progress: { data: [
      { date: '2024-02-29', data: { activities: { remote: 'done' } } },
      { date: '2024-02-28', data: { activities: { old: 'done' } } }
    ], error: null }
  };
  c.sb = {
    from(table) { return { select() { return { eq() { return {
      maybeSingle: () => Promise.resolve(results[table]),
      then: (resolve, reject) => Promise.resolve(results[table]).then(resolve, reject)
    }; } }; } }; },
    rpc: async () => ({ data: null, error: { message: 'RPC no instalado' } })
  };
  c.applyActiveProfiles = () => {};
  c.updatePlanMenuLabel = () => {};
  c.cacheSnapshot = () => c.data;
  c.scheduleSync = () => {};
  c.USER_STORAGE_PREFIX = 'cache:';
  await c.pullFromSupabase('user-a');
  assert.equal(c.data.progress['2024-02-29'].activities.local, 'done');
  assert.equal(c.data.progress['2024-02-29'].activities.remote, undefined);
  assert.equal(c.data.progress['2024-02-28'].activities.old, 'done');
  assert.equal(c.data.habitProfiles[0].name, 'Remote');
  assert.equal(c.data.account.plus_access, false);
  assert.equal(c.data.account.plus_access_available, false);
  assert.equal(c.isPlus(), false);
});

test('push propaga errores de escritura y descarta el resultado si cambia la sesión', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'writeSyncMeta', 'hasSyncConflict', 'clearSyncPending', 'pushAllToSupabase', 'pushAllToSupabaseNow']);
  c.cacheSnapshot = () => c.data;
  c.data.account.display_name = 'Cuenta A';
  c.data.habitProfiles = [{ id: 'h1', name: 'Hábitos', active: true, activities: {} }];
  c.data.exerciseProfiles = [{ id: 'e1', name: 'Rutina', active: true, workouts: {} }];
  c.data.progress = { '2024-02-29': { activities: { a: 'done' } } };
  const makeQuery = (result) => ({ abortSignal() { return this; }, then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); } });
  c.sb = { from(table) {
    return {
      update() { return { eq() { return { select() { return makeQuery({ data: [{ id: 'user-a' }], error: null }); } }; } }; },
      upsert() { return makeQuery(table === 'habit_profiles' ? { data: null, error: { message: 'RLS' } } : { data: [], error: null }); }
    };
  } };
  await assert.rejects(c.pushAllToSupabase(), /habit_profiles/);

  let pendingResolvers = [];
  c.sb = { from(table) {
    const query = () => new Promise((resolve) => { pendingResolvers.push({ table, resolve }); });
    return {
      update() { return { eq() { return { select() { return makeQuery({ data: [{ id: 'user-a' }], error: null }); } }; } }; },
      upsert() { return { abortSignal() { return this; }, then(resolve, reject) { return query().then(resolve, reject); } }; }
    };
  } };
  const pendingPush = c.pushAllToSupabase();
  await new Promise((resolve) => setImmediate(resolve));
  c.currentUser = { id: 'user-b' };
  c.authStateVersion += 1;
  pendingResolvers.forEach(({ resolve }) => resolve({ data: [], error: null }));
  const result = await pendingPush;
  assert.equal(result.stale, true);
  assert.equal(result.completed.length, 0);
});

test('pull conserva la edición local si cambia mientras la respuesta remota está pendiente', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'hasSyncConflict', 'stableSyncJson', 'markSyncConflict', 'writeSyncMeta', 'setSyncStatus', 'pullFromSupabase']);
  c.USER_STORAGE_PREFIX = 'cache:';
  c.syncMetaPrefix = 'sync:';
  c.data.habitProfiles = [{ id: 'h1', name: 'Antes', active: true, activities: { lunes: [] } }];
  c.localStorage.setItem('cache:user-a', JSON.stringify(c.data));
  c.cacheSnapshot = () => c.data;
  c.applyActiveProfiles = () => {};
  c.updatePlanMenuLabel = () => {};
  c.scheduleSync = () => { throw new Error('No debe empujar datos en conflicto'); };
  let resolveRows;
  const pendingRows = new Promise((resolve) => { resolveRows = resolve; });
  const profileResult = { data: { id: 'user-a', display_name: 'A', role: 'user', plan: 'free', subscription_status: 'inactive', onboarding_completed: false }, error: null };
  c.sb = {
    from(table) { return { select() { return { eq() { return { maybeSingle: () => Promise.resolve(profileResult), then(resolve, reject) {
      const value = table === 'profiles' ? profileResult : table === 'habit_profiles' ? pendingRows : Promise.resolve({ data: [], error: null });
      return Promise.resolve(value).then(resolve, reject);
    } }; } }; } }; },
    rpc: async () => ({ data: false, error: null })
  };
  const pulling = c.pullFromSupabase('user-a');
  await new Promise((resolve) => setImmediate(resolve));
  c.data.habitProfiles = [{ id: 'h1', name: 'Editado localmente', active: true, activities: { lunes: [{ id: 'local' }] } }];
  c.localDataRevision += 1;
  resolveRows({ data: [{ id: 'h1', name: 'Antes', active: true, data: { lunes: [] } }], error: null });
  const result = await pulling;
  assert.equal(result.conflict, true);
  assert.equal(c.data.habitProfiles[0].name, 'Editado localmente');
  assert.equal(c.cloudReadyUserId, 'user-a');
  const conflict = JSON.parse(c.localStorage.getItem('sync:user-a:conflict'));
  assert.equal(conflict.local.habitProfiles[0].name, 'Editado localmente');
  assert.equal(conflict.remote.habitProfiles[0].name, 'Antes');
  assert.equal(c.localStorage.getItem('sync:user-a').includes('"conflict":true'), true);
});

test('pull bloquea sincronización cuando hábitos, ejercicio o progreso tienen versiones divergentes', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'hasSyncConflict', 'stableSyncJson', 'markSyncConflict', 'writeSyncMeta', 'setSyncStatus', 'pullFromSupabase']);
  c.USER_STORAGE_PREFIX = 'cache:';
  c.syncMetaPrefix = 'sync:';
  c.data.habitProfiles = [{ id: 'h1', name: 'Local', active: true, activities: { lunes: [] } }];
  c.data.exerciseProfiles = [{ id: 'e1', name: 'Rutina local', active: true, workouts: { a: 1 } }];
  c.data.progress = { '2024-02-29': { activities: { local: 'done' } } };
  c.localStorage.setItem('cache:user-a', JSON.stringify(c.data));
  c.cacheSnapshot = () => c.data;
  c.applyActiveProfiles = () => {};
  c.updatePlanMenuLabel = () => {};
  c.scheduleSync = () => { throw new Error('No debe empujar datos en conflicto'); };
  const results = {
    profiles: { data: { id: 'user-a', display_name: 'A', role: 'user', plan: 'free', subscription_status: 'inactive', onboarding_completed: false }, error: null },
    habit_profiles: { data: [{ id: 'h1', name: 'Remoto', active: true, data: { lunes: [] } }], error: null },
    exercise_profiles: { data: [{ id: 'e1', name: 'Rutina remota', active: true, data: { a: 2 } }], error: null },
    progress: { data: [{ date: '2024-02-29', data: { activities: { remote: 'done' } } }], error: null }
  };
  c.sb = {
    from(table) { return { select() { return { eq() { const value = Promise.resolve(results[table]); return { maybeSingle: () => value, then: (resolve, reject) => value.then(resolve, reject) }; } }; } }; },
    rpc: async () => ({ data: false, error: null })
  };
  c.localDataRevision = 4;
  const result = await c.pullFromSupabase('user-a');
  assert.equal(result.conflict, true);
  assert.equal(c.data.habitProfiles[0].name, 'Local');
  assert.equal(c.data.exerciseProfiles[0].name, 'Rutina local');
  assert.equal(c.data.progress['2024-02-29'].activities.local, 'done');
  assert.deepEqual([...result.reason], ['hábitos distintos', 'ejercicio distinto', 'progreso distinto en 2024-02-29']);
});

test('guardados simultáneos se serializan y la escritura posterior envía la versión local más nueva', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'writeSyncMeta', 'hasSyncConflict', 'clearSyncPending', 'pushAllToSupabase', 'pushAllToSupabaseNow']);
  c.cacheSnapshot = () => c.data;
  c.data.habitProfiles = [{ id: 'h1', name: 'Versión 1', active: true, activities: {} }];
  c.data.exerciseProfiles = [];
  c.data.progress = {};
  const upserts = [];
  const pending = [];
  let inFlight = 0;
  let maxInFlight = 0;
  c.sb = { from(table) { return { upsert(rows) {
    upserts.push({ table, rows: JSON.parse(JSON.stringify(rows)) });
    return { abortSignal() { return this; }, then(resolve, reject) {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((done) => pending.push((response) => { inFlight -= 1; done(response); })).then(resolve, reject);
    } };
  } }; } };
  const first = c.pushAllToSupabase();
  await new Promise((resolve) => setImmediate(resolve));
  c.data.habitProfiles[0].name = 'Versión 2';
  c.localDataRevision += 1;
  c.writeSyncMeta('user-a', { pending: true, revision: 1, conflict: false });
  const second = c.pushAllToSupabase();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(upserts.length, 1);
  pending.shift()({ data: null, error: null });
  const firstResult = await first;
  assert.equal(firstResult.pending, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(upserts.length, 2);
  assert.equal(upserts[1].rows[0].name, 'Versión 2');
  pending.shift()({ data: null, error: null });
  const secondResult = await second;
  assert.equal(secondResult.pending, false);
  assert.equal(maxInFlight, 1);
  assert.equal(c.readSyncMeta('user-a').pending, false);
});

test('un reintento de upsert conserva los IDs de perfil y no genera perfiles duplicados', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'writeSyncMeta', 'hasSyncConflict', 'clearSyncPending', 'pushAllToSupabase', 'pushAllToSupabaseNow']);
  c.cacheSnapshot = () => c.data;
  c.data.habitProfiles = [{ id: 'stable-profile-id', name: 'Mi horario', active: true, activities: {} }];
  c.data.exerciseProfiles = [];
  c.data.progress = {};
  const writtenIds = [];
  c.sb = { from(table) { return { upsert(rows) { writtenIds.push(rows.map((row) => row.id)); return Promise.resolve({ data: null, error: null }); } }; } };
  await c.pushAllToSupabase();
  await c.pushAllToSupabase();
  assert.deepEqual(writtenIds, [['stable-profile-id'], ['stable-profile-id']]);
});

test('un guardado posterior conserva el bloqueo si la cuenta ya tiene un conflicto', () => {
  const c = makeContext(['userStorageKey', 'readSyncMeta', 'writeSyncMeta', 'setSyncStatus', 'scheduleSync', 'saveData']);
  c.syncTimer = null;
  c.syncStatusTimer = null;
  c.sb = {};
  c.cloudReadyUserId = 'user-a';
  c.cacheSnapshot = () => c.data;
  c.localStorage.setItem('seguimiento_personal_v1:sync:user-a', JSON.stringify({ pending: true, conflict: true }));
  c.saveData();
  assert.equal(c.readSyncMeta('user-a').conflict, true);
  assert.equal(c.readSyncMeta('user-a').pending, true);
  assert.equal(c.syncTimer, null);
});

test('respuestas remotas vacías conservan datos locales y registran la divergencia', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'hasSyncConflict', 'stableSyncJson', 'markSyncConflict', 'writeSyncMeta', 'setSyncStatus', 'pullFromSupabase']);
  c.USER_STORAGE_PREFIX = 'cache:';
  c.syncMetaPrefix = 'sync:';
  c.data.habitProfiles = [{ id: 'h-local', name: 'Horario local', active: true, activities: { lunes: [] } }];
  c.data.exerciseProfiles = [{ id: 'e-local', name: 'Rutina local', active: true, workouts: {} }];
  c.data.progress = { '2024-03-01': { activities: { a: 'done' } } };
  c.localStorage.setItem('cache:user-a', JSON.stringify(c.data));
  c.cacheSnapshot = () => c.data;
  c.applyActiveProfiles = () => {};
  c.updatePlanMenuLabel = () => {};
  c.scheduleSync = () => {};
  c.sb = { from(table) { return { select() { return { eq() { const result = Promise.resolve(table === 'profiles'
    ? { data: { id: 'user-a', display_name: 'A', plan: 'free', role: 'user', subscription_status: 'inactive', onboarding_completed: false }, error: null }
    : { data: [], error: null }); return { maybeSingle: () => result, then: (resolve, reject) => result.then(resolve, reject) }; } }; } }; }, rpc: async () => ({ data: false, error: null }) };
  const result = await c.pullFromSupabase('user-a');
  assert.equal(result.conflict, true);
  assert.equal(c.data.habitProfiles[0].id, 'h-local');
  assert.equal(c.data.exerciseProfiles[0].id, 'e-local');
  assert.equal(c.data.progress['2024-03-01'].activities.a, 'done');
  const conflict = JSON.parse(c.localStorage.getItem('sync:user-a:conflict'));
  assert.deepEqual(Object.keys(conflict.remote.progress), []);
});

test('un guardado anterior no se presenta como sincronizado si hay una versión posterior pendiente', async () => {
  const c = makeContext(['readSyncMeta', 'setSyncStatus', 'scheduleSync']);
  const status = { style: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; } };
  c.document.getElementById = (id) => id === 'syncStatus' ? status : null;
  c.syncTimer = null;
  c.syncStatusTimer = null;
  c.sb = {};
  c.cloudReadyUserId = 'user-a';
  c.localDataRevision = 1;
  const timers = [];
  c.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  c.clearTimeout = () => {};
  c.pushAllToSupabase = async () => ({ ok: true, revision: 1, pending: true });
  c.scheduleSync();
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.attributes['data-state'], 'pending');
  assert.notEqual(status.textContent, 'Guardado');
});

test('fallo de escritura deja el estado pendiente y permite reintentar sin cambiar el ID', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'writeSyncMeta', 'hasSyncConflict', 'clearSyncPending', 'pushAllToSupabase', 'pushAllToSupabaseNow']);
  c.cacheSnapshot = () => c.data;
  c.data.habitProfiles = [{ id: 'retry-id', name: 'Horario', active: true, activities: {} }];
  c.data.exerciseProfiles = [];
  c.data.progress = {};
  let fail = true;
  const ids = [];
  c.sb = { from(table) { return { upsert(rows) { ids.push(rows[0].id); return Promise.resolve(fail
    ? { data: null, error: { message: 'network' } }
    : { data: null, error: null }); } }; } };
  c.writeSyncMeta('user-a', { pending: true, revision: 0, conflict: false });
  await assert.rejects(c.pushAllToSupabase(), /habit_profiles/);
  assert.equal(c.readSyncMeta('user-a').pending, true);
  fail = false;
  const retry = await c.pushAllToSupabase();
  assert.equal(retry.ok, true);
  assert.deepEqual(ids, ['retry-id', 'retry-id']);
  assert.equal(c.readSyncMeta('user-a').pending, false);
});

test('pull se recupera de un fallo de conexión en el siguiente intento', async () => {
  const c = makeContext(['assertSupabaseResult', 'readSyncMeta', 'hasSyncConflict', 'stableSyncJson', 'markSyncConflict', 'writeSyncMeta', 'setSyncStatus', 'pullFromSupabase']);
  c.USER_STORAGE_PREFIX = 'cache:';
  c.applyActiveProfiles = () => {};
  c.updatePlanMenuLabel = () => {};
  c.cacheSnapshot = () => c.data;
  c.scheduleSync = () => {};
  let fail = true;
  const values = {
    profiles: { data: { id: 'user-a', display_name: 'A', plan: 'free', role: 'user', subscription_status: 'inactive', onboarding_completed: false }, error: null },
    habit_profiles: { data: [], error: null }, exercise_profiles: { data: [], error: null }, progress: { data: [], error: null }
  };
  c.sb = { from(table) { return { select() { return { eq() { const query = Promise.resolve(fail ? { data: null, error: { message: 'offline' } } : values[table]); return { maybeSingle: () => query, then: (resolve, reject) => query.then(resolve, reject) }; } }; } }; }, rpc: async () => ({ data: false, error: null }) };
  await assert.rejects(c.pullFromSupabase('user-a'), /profiles select/);
  fail = false;
  const recovered = await c.pullFromSupabase('user-a');
  assert.equal(recovered.ok, true);
  assert.equal(c.data.account.id, 'user-a');
});

test('alarmas no se disparan dos veces para la misma alarma en el mismo minuto', () => {
  const fixedTime = new Date(2024, 2, 2, 9, 15, 20).getTime();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedTime])); }
    static now() { return fixedTime; }
  }
  const c = makeContext(['pad2', 'fmtKey', 'checkAlarms'], { Date: FixedDate });
  c.document.visibilityState = 'visible';
  c.data.alarms = [{ id: 'alarm-1', active: true, time: '09:15', days: [5], lastFiredKey: null }];
  let fireCount = 0, saveCount = 0;
  c.fireAlarm = () => { fireCount += 1; };
  c.saveData = () => { saveCount += 1; };
  c.checkAlarms(); c.checkAlarms();
  assert.equal(fireCount, 1);
  assert.equal(saveCount, 1);
  assert.equal(c.data.alarms[0].lastFiredKey, '2024-03-02T09:15');
});

test('arranque de sesión descarta validación tardía después de cambio de identidad', async () => {
  const c = makeContext(['enterAuthenticatedApp'], { currentUser: null });
  let resolveUser;
  c.getVerifiedUser = () => new Promise((resolve) => { resolveUser = resolve; });
  c.bootApp = async () => { throw new Error('No debe iniciar una sesión obsoleta'); };
  const entering = c.enterAuthenticatedApp('user-a');
  c.authStateVersion += 1;
  resolveUser({ id: 'user-a' });
  await assert.rejects(entering, /La sesión cambió/);
  assert.equal(c.currentUser, null);
});

test('IDs y referencias DOM estáticas no están duplicados ni rotos', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Los IDs del documento deben ser únicos');
  const references = [...inlineScripts.matchAll(/getElementById\("([^"]+)"\)/g)]
    .map((match) => match[1]);
  const idSet = new Set(ids);
  assert.deepEqual([...new Set(references)].filter((id) => !idSet.has(id)), []);
  const functionNames = [...inlineScripts.matchAll(/^\s*(?:async\s+)?function\s+([\w$]+)\s*\(/gm)]
    .map((match) => match[1]);
  assert.equal(new Set(functionNames).size, functionNames.length, 'No debe haber funciones globales duplicadas');
});

test('esquema local contiene las tablas, columnas y aislamiento requeridos por la aplicación', () => {
  assert.match(schema, /create table if not exists public\.profiles\s*\([\s\S]*?id\s+uuid primary key references auth\.users\(id\)/i);
  for (const column of ['role', 'plan', 'subscription_status', 'onboarding_completed']) {
    assert.match(schema, new RegExp(`\\b${column}\\b`, 'i'));
  }
  for (const table of ['habit_profiles', 'exercise_profiles', 'progress']) {
    assert.match(schema, new RegExp(`create table if not exists public\\.${table}`, 'i'));
    assert.match(schema, new RegExp(`on public\\.${table} for all[\\s\\S]*?user_id = auth\\.uid\\(\\)`, 'i'));
  }
  assert.match(schema, /create or replace function public\.handle_new_user/i);
  assert.match(schema, /create or replace function public\.protect_account_fields/i);
  assert.doesNotMatch(schema, /create table if not exists public\.plus_dev_access/i);
  assert.doesNotMatch(schema, /create or replace function public\.has_plus_access/i);
});


test('PWA declara instalación Android/iOS y sus iconos existen con tamaños válidos', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './seguimiento-personal.html');
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /serviceWorker\.register\("\.\/service-worker\.js"/);
  for (const icon of manifest.icons) {
    const asset = path.join(path.dirname(manifestPath), icon.src.replace(/^\.\//, ''));
    const bytes = fs.readFileSync(asset);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  assert.ok(fs.existsSync(path.join(path.dirname(manifestPath), 'icons', 'apple-touch-icon.png')));
});

test('service worker sirve el shell offline y no intercepta ni cachea datos privados Supabase', () => {
  const sw = fs.readFileSync(serviceWorkerPath, 'utf8');
  assert.match(sw, /caches\.match\("\.\/seguimiento-personal\.html"\)/);
  assert.match(sw, /url\.hostname\.endsWith\("supabase\.co"\)/);
  assert.match(sw, /url\.pathname\.includes\("\/auth\/v1\/"\)/);
  assert.match(sw, /url\.pathname\.includes\("\/rest\/v1\/"\)/);
  assert.match(sw, /if \(request\.method !== "GET"\) return/);
  assert.ok(sw.indexOf('if (url.hostname.endsWith("supabase.co")') < sw.indexOf('event.respondWith('));
  assert.match(sw, /Never intercept\/cache authenticated Supabase calls or user data/);
});

test('guardado offline queda pendiente localmente y no intenta subir a Supabase', () => {
  const c = makeContext(['scheduleSync', 'readSyncMeta']);
  c.navigator = { onLine: false };
  c.sb = {};
  c.currentUser = { id: 'user-a' };
  c.cloudReadyUserId = 'user-a';
  c.localDataRevision = 3;
  let state = null;
  c.setSyncStatus = (kind, message) => { state = { kind, message }; };
  c.pushAllToSupabase = () => { throw new Error('No debe intentar sincronizar offline'); };
  c.scheduleSync();
  assert.equal(state.kind, 'pending');
  assert.match(state.message, /Sin conexión/);
});
