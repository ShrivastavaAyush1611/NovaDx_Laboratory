const labsConfig = require('../config/labs.json');

function makeRandom(seed) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;

  function random() {            
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  }
  function normal() {            
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += random();
    return sum - 6;
  }
  function pick(list) {          
    return list[Math.floor(random() * list.length)];
  }
  return { random: random, normal: normal, pick: pick };
}

const ANALYTES = {
  K:   { unit: 'mmol/L', mean: 4.2, sd: 0.35, nightEffect: 0.15 },
  GLU: { unit: 'mmol/L', mean: 5.6, sd: 0.9, nightEffect: 0.8 }
};

const VOLUME = [0.25, 0.2, 0.2, 0.2, 0.25, 0.4, 0.7, 1.0, 1.3, 1.4, 1.4, 1.3,
  1.2, 1.2, 1.2, 1.1, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];

function formatLocal(timeMs) {
  const local = new Date(timeMs + 5.5 * 3600000);
  return local.toISOString().substring(0, 19) + '+05:30';
}

const LOT_SCHEDULE = {
  K: {
    'INS-01': [[0, 'LOT-K-101'], [4.3, 'LOT-K-102'], [10.2, 'LOT-K-103']],
    'INS-02': [[0, 'LOT-K-101'], [4.5, 'LOT-K-102'], [10.4, 'LOT-K-103']]
  },
  GLU: {
    'INS-01': [[0, 'LOT-GLU-201'], [4.2, 'LOT-GLU-202'], [9.5, 'LOT-GLU-203'], [12.5, 'LOT-GLU-204']],
    'INS-02': [[0, 'LOT-GLU-201'], [4.4, 'LOT-GLU-202'], [12.6, 'LOT-GLU-204']]
  }
};

function lotAt(analyte, instrument, day) {
  let lot = null;
  for (const entry of LOT_SCHEDULE[analyte][instrument]) {
    if (day >= entry[0]) lot = entry[1];
  }
  return lot;
}

function buildFaults(startMs) {
  function day(d) {
    return new Date(startMs + d * 86400000).toISOString();
  }
  return [
    {
      id: 'F1', type: 'DRIFT', instrument: 'INS-02', analyte: 'K',
      description: 'Slow upward drift of +0.0125 mmol/L per hour (reaches +0.6 mmol/L after 48 h), fixed by recalibration',
      start: day(5.25), end: day(7.25), ratePerHour: 0.0125
    },
    {
      id: 'F2', type: 'SHIFT', instrument: 'INS-01', analyte: 'K',
      description: 'Sudden shift of +0.6 mmol/L for 24 hours',
      start: day(8.4), end: day(9.4), amount: 0.6
    },
    {
      id: 'F3', type: 'LOT', reagent_lot: 'LOT-GLU-203', analyte: 'GLU', instruments: ['INS-01'],
      description: 'Faulty reagent lot LOT-GLU-203 reads 15% too low (used on INS-01)',
      start: day(9.5), end: day(12.5), factor: 0.85
    }
  ];
}

function applyFaults(faults, value, analyte, instrument, lot, timeMs) {
  for (const f of faults) {
    const start = Date.parse(f.start);
    const end = Date.parse(f.end);
    if (timeMs < start || timeMs >= end || f.analyte !== analyte) continue;

    if (f.type === 'DRIFT' && f.instrument === instrument) {
      const hours = (timeMs - start) / 3600000;
      value = value + f.ratePerHour * hours;     
    }
    if (f.type === 'SHIFT' && f.instrument === instrument) {
      value = value + f.amount;                  
    }
    if (f.type === 'LOT' && f.reagent_lot === lot) {
      value = value * f.factor;                  
    }
  }
  return value;
}


function generate(options) {
  options = options || {};
  const seed = options.seed || 42;
  const targetResults = options.results || 50000;
  const days = options.days || 14;
  const startMs = Date.parse('2026-03-01T00:00:00+05:30');
  const rnd = makeRandom(seed);
  const faults = options.faults === false ? [] : buildFaults(startMs);
  const instruments = labsConfig.instruments.map(function (i) { return i.id; });

  const patients = [];
  for (let i = 0; i < Math.round(targetResults / 12); i++) {
    const p = { id: 'P-' + (100001 + i), level: {} };
    for (const analyte of Object.keys(ANALYTES)) {
      p.level[analyte] = rnd.normal() * 0.8;
      if (rnd.random() < 0.06) p.level[analyte] += 3;
    }
    patients.push(p);
  }

  const results = [];
  let sampleNumber = 100000;
  const totalVolume = VOLUME.reduce(function (a, b) { return a + b; }, 0);
  const downStart = startMs + 3.4 * 86400000;
  const downEnd = downStart + 6 * 3600000;

  while (results.length < targetResults) {
    let r = rnd.random() * totalVolume;
    let hour = 0;
    while (r > VOLUME[hour]) {
      r -= VOLUME[hour];
      hour++;
    }
    const dayNumber = Math.floor(rnd.random() * days);
    const timeMs = startMs + dayNumber * 86400000 + hour * 3600000 + Math.floor(rnd.random() * 3600000);
    const isNight = hour < 6; 

    let instrument = rnd.pick(instruments);
    if (instrument === 'INS-02' && timeMs >= downStart && timeMs < downEnd) instrument = 'INS-01';

    const patient = rnd.pick(patients);
    sampleNumber++;

    const tests = [];
    if (rnd.random() < 0.75) tests.push('K');
    if (rnd.random() < 0.6) tests.push('GLU');
    if (tests.length === 0) tests.push('K');

    let h = Math.round(rnd.random() * 30);
    if (rnd.random() < 0.04) h = 60 + Math.round(rnd.random() * 300);   
    let ic = Math.round(rnd.random() * 20);
    if (rnd.random() < 0.02) ic = 150 + Math.round(rnd.random() * 250); 
    let l = Math.round(rnd.random() * 50);
    if (rnd.random() < 0.02) l = 300 + Math.round(rnd.random() * 500);  
    let flags = [];
    if (rnd.random() < 0.005) flags = [rnd.pick(['SHORT_SAMPLE', 'CLOT_DETECTED', 'REAGENT_LOW'])];

    tests.forEach(function (analyte, index) {
      const a = ANALYTES[analyte];
      let value = a.mean + (patient.level[analyte] + rnd.normal() * 0.6) * a.sd;
      if (isNight) value += a.nightEffect;
      if (analyte === 'K') value += h * 0.004; 

      const lot = lotAt(analyte, instrument, (timeMs - startMs) / 86400000);
      value = applyFaults(faults, value, analyte, instrument, lot, timeMs);
      if (value < 0.1) value = 0.1;

      const message = {
        sample_id: 'S-' + sampleNumber,
        patient: patient.id,
        analyte: analyte,
        value: Math.round(value * 10) / 10, 
        unit: a.unit,
        instrument: instrument,
        reagent_lot: lot,
        h_index: h,
        i_index: ic,
        l_index: l,
        timestamp: formatLocal(timeMs + index * 1000)
      };
      if (flags.length > 0) message.instrument_flags = flags;
      results.push(message);
    });
  }
  results.length = targetResults; 

  results.sort(function (a, b) { return Date.parse(a.timestamp) - Date.parse(b.timestamp); });

  const messages = [];
  const resendLater = []; 
  let duplicates = 0;
  for (let i = 0; i < results.length; i++) {
    messages.push(results[i]);
    const r = rnd.random();
    if (r < 0.02) {
      messages.push(Object.assign({}, results[i]));   
      duplicates++;
    } else if (r < 0.03) {
      resendLater.push({ at: messages.length + 50 + Math.floor(rnd.random() * 500), copy: Object.assign({}, results[i]) });
      duplicates++;
    }
  }
  resendLater.sort(function (a, b) { return b.at - a.at; });
  for (const item of resendLater) {
    messages.splice(Math.min(item.at, messages.length), 0, item.copy);
  }

 
  let late = 0;
  for (let i = 0; i < messages.length - 40; i++) {
    if (rnd.random() < 0.015) {
      const j = i + 1 + Math.floor(rnd.random() * 40);
      const temp = messages[i];
      messages[i] = messages[j];
      messages[j] = temp;
      late++;
    }
  }

  const breakers = [
    function (m) { delete m.value; return m; },                            
    function (m) { m.value = String(m.value) + 'x'; return m; },             
    function (m) { m.timestamp = m.timestamp.substring(0, 19); return m; }, 
    function (m) { m.instrument = 'INS-99'; return m; },                     
    function (m) { m.h_index = -5; return m; },                              
    function (m) { delete m.patient; return m; },                            
    function (m) { m.patient = 'Ramesh Kumar'; return m; },                  
    function (m) { delete m.reagent_lot; return m; },                        
    function (m) { m.value = 999999; return m; }                             
  ];
  const invalidCount = Math.round(results.length * 0.003);
  for (let k = 0; k < invalidCount; k++) {
    const bad = Object.assign({}, rnd.pick(results));
    bad.sample_id = bad.sample_id + '-BAD' + k;
    const position = Math.floor(rnd.random() * messages.length);
    messages.splice(position, 0, rnd.pick(breakers)(bad));
  }

  return {
    messages: messages,
    faults: faults,
    stats: {
      unique_results: results.length,
      total_messages: messages.length,
      duplicate_messages: duplicates,
      late_messages: late,
      invalid_or_odd_messages: invalidCount,
      seed: seed,
      days: days
    }
  };
}

module.exports = { generate };
