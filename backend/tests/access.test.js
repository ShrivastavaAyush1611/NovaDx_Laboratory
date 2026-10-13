const request = require('supertest');
const { db, resetDatabase, addSecondLab, makeMessage, auth } = require('./helpers');
const app = require('../src/app');
const { ingestMessage } = require('../src/services/ingestService');
const alertService = require('../src/services/alertService');

let lab1ResultId;
let lab2ResultId;
let lab2HeldId;

beforeAll(async function () {
  await resetDatabase();
  await addSecondLab(); 
  lab1ResultId = (await ingestMessage(makeMessage({ instrument: 'INS-01' }), { skipQc: true })).result_id;
  lab2ResultId = (await ingestMessage(makeMessage({ instrument: 'INS-03', patient: 'P-2001' }), { skipQc: true })).result_id;
  lab2HeldId = (await ingestMessage(makeMessage({ instrument: 'INS-03', patient: 'P-2002', value: 7.0 }), { skipQc: true })).result_id;
});

afterAll(async function () {
  await db.pool.end();
});

describe('authentication', function () {
  test('no token -> 401', async function () {
    expect((await request(app).get('/api/results')).status).toBe(401);
  });
  test('wrong token -> 401', async function () {
    expect((await request(app).get('/api/results').set({ Authorization: 'Bearer nope' })).status).toBe(401);
  });
  test('login with password returns the token', async function () {
    const res = await request(app).post('/api/auth/login').send({ username: 'tech1', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('LabTechnician');
    const bad = await request(app).post('/api/auth/login').send({ username: 'tech1', password: 'wrong' });
    expect(bad.status).toBe(401);
  });
});

describe('laboratory separation', function () {
  test('a LAB-1 user can read a LAB-1 result', async function () {
    const res = await request(app).get('/api/results/' + lab1ResultId).set(auth('tech1'));
    expect(res.status).toBe(200);
  });

  test('a LAB-1 user can NOT read a LAB-2 result (404, as if it does not exist)', async function () {
    const res = await request(app).get('/api/results/' + lab2ResultId).set(auth('tech1'));
    expect(res.status).toBe(404);
    const rep = await request(app).get('/api/results/' + lab2ResultId + '/reproduce').set(auth('auditor1'));
    expect(rep.status).toBe(404);
  });

  test('result lists only contain the own lab', async function () {
    const res1 = await request(app).get('/api/results').set(auth('tech1'));
    const res2 = await request(app).get('/api/results').set(auth('tech2'));
    expect(res1.body.map(function (r) { return Number(r.id); })).toEqual([Number(lab1ResultId)]);
    expect(res2.body.length).toBe(2);
    expect(res2.body.every(function (r) { return r.instrument === 'INS-03'; })).toBe(true);
  });

  test('a LAB-1 supervisor can not review a LAB-2 result', async function () {
    const res = await request(app).post('/api/review/' + lab2HeldId).set(auth('super1')).send({ action: 'RELEASE' });
    expect(res.status).toBe(404);
    const queue = await request(app).get('/api/review/queue').set(auth('super1'));
    expect(queue.body.items.length).toBe(0);
  });

  test('a LAB-1 supervisor can not correct a LAB-2 result', async function () {
    const res = await request(app).post('/api/results/' + lab2ResultId + '/correct').set(auth('super1')).send({ value: 4, reason: 'x' });
    expect(res.status).toBe(404);
  });

  test('alerts of another lab are invisible', async function () {
    const { alert } = await alertService.raiseAlert({
      type: 'SHIFT', lab_id: 'LAB-2', instrument: 'INS-03', analyte: 'K', message: 'lab 2 problem', time: new Date().toISOString()
    });
    expect((await request(app).get('/api/alerts').set(auth('tech1'))).body.length).toBe(0);
    expect((await request(app).post('/api/alerts/' + alert.id + '/acknowledge').set(auth('tech1'))).status).toBe(404);
    expect((await request(app).get('/api/alerts').set(auth('tech2'))).body.length).toBe(1);
  });

  test('QC chart data only has the own instruments', async function () {
    const res = await request(app).get('/api/qc/moving-average?analyte=K&window=1').set(auth('tech1'));
    expect(Object.keys(res.body.series)).toEqual(['INS-01']);
  });
});

describe('roles', function () {
  test.each([
    ['tech1', 'post', '/api/review/1', 403],          
    ['qe1', 'post', '/api/review/1', 403],
    ['auditor1', 'post', '/api/review/1', 403],
    ['tech1', 'get', '/api/audit', 403],             
    ['super1', 'get', '/api/audit', 403],
    ['qe1', 'get', '/api/audit/verify', 403],
    ['auditor1', 'get', '/api/audit', 200],
    ['tech1', 'post', '/api/rules', 403],            
    ['super1', 'post', '/api/rules', 403],
    ['tech1', 'post', '/api/impact', 403],
    ['auditor1', 'post', '/api/impact', 403],
    ['auditor1', 'get', '/api/qc/moving-average', 403],
    ['tech1', 'put', '/api/settings', 403],
    ['qe1', 'put', '/api/settings', 403],
    ['tech1', 'get', '/api/review/queue', 403],
    ['super1', 'get', '/api/review/queue', 200]
  ])('%s %s %s -> %s', async function (user, method, url, expected) {
    const res = await request(app)[method](url).set(auth(user)).send({});
    expect(res.status).toBe(expected);
  });

  test('supervisor of the right lab can release a held result; it is then no longer held', async function () {
    const res = await request(app).post('/api/review/' + lab2HeldId).set(auth('super2')).send({ action: 'RELEASE', comment: 'phoned doctor' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('RELEASED');
    expect(res.body.seq).toBe(2);
    const again = await request(app).post('/api/review/' + lab2HeldId).set(auth('super2')).send({ action: 'REJECT' });
    expect(again.status).toBe(409);
    const detail = await request(app).get('/api/results/' + lab2HeldId).set(auth('tech2'));
    expect(detail.body.decisions.map(function (d) { return d.outcome; })).toEqual(['HELD', 'RELEASED']);
  });
});
