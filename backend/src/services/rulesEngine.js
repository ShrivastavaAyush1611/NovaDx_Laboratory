

const VALID_TYPES = ['range', 'index_limit', 'delta', 'instrument_flag'];
const VALID_ACTIONS = ['HOLD', 'REJECT'];

const OUTCOME_ORDER = { RELEASED: 0, HELD: 1, REJECTED: 2 };

function actionToOutcome(action) {
  if (action === 'REJECT') return 'REJECTED';
  return 'HELD';
}

function checkRule(rule, result, previous) {
  if (rule.type === 'range') {
    if (rule.low !== undefined && result.value < rule.low) {
      return 'value ' + result.value + ' is below ' + rule.low;
    }
    if (rule.high !== undefined && result.value > rule.high) {
      return 'value ' + result.value + ' is above ' + rule.high;
    }
    return null;
  }

  if (rule.type === 'index_limit') {
    const indexValue = result[rule.index];
    if (indexValue > rule.max) {
      return rule.index + ' ' + indexValue + ' is above ' + rule.max;
    }
    return null;
  }

  if (rule.type === 'instrument_flag') {
    const flags = result.instrument_flags || [];
    if (flags.length > 0) {
      return 'instrument flags: ' + flags.join(', ');
    }
    return null;
  }

  if (rule.type === 'delta') {
    if (!previous) return null; 
    const hoursApart = (new Date(result.collected_at) - new Date(previous.collected_at)) / 3600000;
    if (rule.within_hours !== undefined && hoursApart > rule.within_hours) {
      return null; 
    }
    const change = Math.abs(result.value - previous.value);
    if (rule.max_abs_change !== undefined && change > rule.max_abs_change) {
      return 'changed by ' + change.toFixed(2) + ' (previous ' + previous.value + '), limit ' + rule.max_abs_change;
    }
    if (rule.max_percent_change !== undefined && previous.value !== 0) {
      const percent = (change / Math.abs(previous.value)) * 100;
      if (percent > rule.max_percent_change) {
        return 'changed by ' + percent.toFixed(1) + '% (previous ' + previous.value + '), limit ' + rule.max_percent_change + '%';
      }
    }
    return null;
  }

  return null;
}


function evaluate(result, previous, ruleSet) {
  const config = ruleSet.config;
  const triggered = [];
  let outcome = 'RELEASED';

  const rulesForAnalyte = config.rules.filter(function (r) {
    return r.analyte === result.analyte;
  });
  const rulesForAll = config.rules.filter(function (r) {
    return r.analyte === '*';
  });

  if (rulesForAnalyte.length === 0) {
    const action = config.unknown_analyte_action || 'HOLD';
    triggered.push({ id: 'UNKNOWN-ANALYTE', name: 'No rules configured for analyte ' + result.analyte, action: action, message: 'no rules for this analyte' });
    outcome = actionToOutcome(action);
  }

  const allRules = rulesForAll.concat(rulesForAnalyte);
  for (const rule of allRules) {
    const message = checkRule(rule, result, previous);
    if (message) {
      triggered.push({ id: rule.id, name: rule.name, action: rule.action, message: message });
      const ruleOutcome = actionToOutcome(rule.action);
      if (OUTCOME_ORDER[ruleOutcome] > OUTCOME_ORDER[outcome]) {
        outcome = ruleOutcome;
      }
    }
  }

  let reason = 'All rules passed';
  if (triggered.length > 0) {
    reason = triggered.map(function (t) { return t.id + ': ' + t.message; }).join('; ');
  }

  return {
    outcome: outcome,
    triggered_rules: triggered,
    reason: reason,
    rule_set_version: ruleSet.version
  };
}

function validateRuleSetConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return ['config must be an object'];
  }
  if (!Array.isArray(config.rules) || config.rules.length === 0) {
    return ['config.rules must be a non-empty list'];
  }
  if (config.unknown_analyte_action && !VALID_ACTIONS.includes(config.unknown_analyte_action)) {
    errors.push('unknown_analyte_action must be HOLD or REJECT');
  }
  const ids = {};
  config.rules.forEach(function (rule, i) {
    const where = 'rule #' + (i + 1) + (rule.id ? ' (' + rule.id + ')' : '');
    if (!rule.id) errors.push(where + ': id is missing');
    if (ids[rule.id]) errors.push(where + ': id is used twice');
    ids[rule.id] = true;
    if (!rule.analyte) errors.push(where + ': analyte is missing (use "*" for all)');
    if (!VALID_TYPES.includes(rule.type)) errors.push(where + ': type must be one of ' + VALID_TYPES.join(', '));
    if (!VALID_ACTIONS.includes(rule.action)) errors.push(where + ': action must be HOLD or REJECT');

    if (rule.type === 'range') {
      if (typeof rule.low !== 'number' && typeof rule.high !== 'number') errors.push(where + ': range needs low and/or high');
      if (typeof rule.low === 'number' && typeof rule.high === 'number' && rule.low > rule.high) errors.push(where + ': low is bigger than high');
    }
    if (rule.type === 'index_limit') {
      if (!['h_index', 'i_index', 'l_index'].includes(rule.index)) errors.push(where + ': index must be h_index, i_index or l_index');
      if (typeof rule.max !== 'number') errors.push(where + ': max must be a number');
    }
    if (rule.type === 'delta') {
      if (typeof rule.max_abs_change !== 'number' && typeof rule.max_percent_change !== 'number') {
        errors.push(where + ': delta needs max_abs_change or max_percent_change');
      }
    }
  });
  return errors;
}

module.exports = { evaluate, validateRuleSetConfig, OUTCOME_ORDER };
