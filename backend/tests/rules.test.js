const { evaluate, validateRuleSetConfig } = require('../src/services/rulesEngine');
const ruleConfig = require('../config/rules/ruleset_v1.json');

const ruleSet = { version: 1, config: ruleConfig };

function result(overrides) {
  return Object.assign({
    analyte: 'K', value: 4.1, unit: 'mmol/L', h_index: 10, i_index: 2, l_index: 5,
    instrument_flags: [], collected_at: '2026-03-04T09:00:00+05:30'
  }, overrides);
}

function check(overrides, previous) {
  return evaluate(result(overrides), previous || null, ruleSet);
}

function ids(decision) {
  return decision.triggered_rules.map(function (r) { return r.id; });
}

describe('critical range (K 2.8 - 6.2, HOLD outside)', function () {
  test.each([
    [6.1, 'RELEASED'],  
    [6.2, 'RELEASED'],  
    [6.3, 'HELD'],      
    [2.9, 'RELEASED'],
    [2.8, 'RELEASED'],  
    [2.7, 'HELD']
  ])('K = %s -> %s', function (value, expected) {
    expect(check({ value: value }).outcome).toBe(expected);
  });
});

describe('reportable range (K 1.0 - 10.0, REJECT outside)', function () {
  test.each([
    [9.9, 'HELD'],      
    [10.0, 'HELD'],     
    [10.1, 'REJECTED'], 
    [1.1, 'HELD'],
    [1.0, 'HELD'],
    [0.9, 'REJECTED']
  ])('K = %s -> %s', function (value, expected) {
    expect(check({ value: value }).outcome).toBe(expected);
  });

  test('REJECT wins over HOLD when both fire', function () {
    const d = check({ value: 10.5 });
    expect(d.outcome).toBe('REJECTED');
    expect(ids(d)).toEqual(expect.arrayContaining(['K-REPORTABLE', 'K-CRITICAL']));
  });
});

describe('sample quality index limits (K hemolysis max 50)', function () {
  test.each([
    [49, 'RELEASED'],
    [50, 'RELEASED'],
    [51, 'HELD']
  ])('h_index = %s -> %s', function (h, expected) {
    expect(check({ h_index: h }).outcome).toBe(expected);
  });

  test('lipemia limit for glucose (max 500)', function () {
    expect(check({ analyte: 'GLU', value: 5.5, l_index: 500 }).outcome).toBe('RELEASED');
    expect(check({ analyte: 'GLU', value: 5.5, l_index: 501 }).outcome).toBe('HELD');
  });
});

describe('delta check', function () {
  const previous = { value: 4.0, collected_at: '2026-03-03T09:00:00+05:30' }; 

  test('no previous result -> no delta problem', function () {
    expect(check({ value: 5.5 }, null).outcome).toBe('RELEASED');
  });

  test.each([
    [4.9, 'RELEASED'],  
    [5.0, 'RELEASED'],  
    [5.1, 'HELD'],      
    [3.0, 'RELEASED'],  
    [2.9, 'HELD']      
  ])('previous 4.0, now %s -> %s', function (value, expected) {
    const d = check({ value: value }, previous);
    expect(d.outcome).toBe(expected);
    if (expected === 'HELD') expect(ids(d)).toContain('K-DELTA');
  });

  test('previous result older than the delta window (72 h) is ignored', function () {
    const old = { value: 4.0, collected_at: '2026-02-28T09:00:00+05:30' };
    expect(check({ value: 5.5 }, old).outcome).toBe('RELEASED');
  });

  test('previous result exactly 72 h ago is still compared', function () {
    const edge = { value: 4.0, collected_at: '2026-03-01T09:00:00+05:30' };
    expect(check({ value: 5.5 }, edge).outcome).toBe('HELD');
  });

  test('glucose delta check (limit 8 mmol/L within 24 h)', function () {
    const prev = { value: 6.0, collected_at: '2026-03-04T01:00:00+05:30' };
    expect(check({ analyte: 'GLU', value: 14.0 }, prev).outcome).toBe('RELEASED'); 
    expect(check({ analyte: 'GLU', value: 14.1 }, prev).outcome).toBe('HELD');    
  });

  test('percent delta check (a rule type a quality engineer can use)', function () {
    const config = { rules: [{ id: 'GLU-DELTA-PCT', analyte: 'GLU', type: 'delta', max_percent_change: 50, within_hours: 72, action: 'HOLD' }] };
    const rs = { version: 9, config: config };
    const prev = { value: 10, collected_at: '2026-03-03T09:00:00+05:30' };
    expect(evaluate(result({ analyte: 'GLU', value: 15 }), prev, rs).outcome).toBe('RELEASED'); 
    expect(evaluate(result({ analyte: 'GLU', value: 15.1 }), prev, rs).outcome).toBe('HELD');  
    expect(evaluate(result({ analyte: 'GLU', value: 4.9 }), prev, rs).outcome).toBe('HELD');    
  });
});

describe('other rules', function () {
  test('instrument fault flag -> HELD', function () {
    const d = check({ instrument_flags: ['CLOT_DETECTED'] });
    expect(d.outcome).toBe('HELD');
    expect(ids(d)).toContain('ALL-INSTRUMENT-FLAG');
  });

  test('analyte without rules -> HELD (can not be auto-verified)', function () {
    const d = check({ analyte: 'XYZ', unit: 'g/L' });
    expect(d.outcome).toBe('HELD');
    expect(ids(d)).toContain('UNKNOWN-ANALYTE');
  });

  test('a new analyte can be added only with configuration', function () {
    const newConfig = JSON.parse(JSON.stringify(ruleConfig));
    newConfig.rules.push({ id: 'CL-CRITICAL', name: 'Chloride critical', analyte: 'CL', type: 'range', low: 80, high: 120, action: 'HOLD' });
    const rs = { version: 2, config: newConfig };
    expect(evaluate(result({ analyte: 'CL', value: 100 }), null, rs).outcome).toBe('RELEASED');
    expect(evaluate(result({ analyte: 'CL', value: 121 }), null, rs).outcome).toBe('HELD');
  });

  test('decision remembers the rule set version', function () {
    expect(check({}).rule_set_version).toBe(1);
  });
});

describe('rule set validation', function () {
  test('the shipped rule set is valid', function () {
    expect(validateRuleSetConfig(ruleConfig)).toEqual([]);
  });

  test('broken rules are refused with a reason', function () {
    const errors = validateRuleSetConfig({
      rules: [
        { id: 'A', analyte: 'K', type: 'range', low: 5, high: 1, action: 'HOLD' },
        { id: 'A', analyte: 'K', type: 'magic', action: 'DELETE' },
        { id: 'C', analyte: 'K', type: 'delta', action: 'HOLD' }
      ]
    });
    expect(errors.join(' ')).toMatch(/low is bigger than high/);
    expect(errors.join(' ')).toMatch(/id is used twice/);
    expect(errors.join(' ')).toMatch(/type must be one of/);
    expect(errors.join(' ')).toMatch(/action must be HOLD or REJECT/);
    expect(errors.join(' ')).toMatch(/delta needs/);
  });
});
