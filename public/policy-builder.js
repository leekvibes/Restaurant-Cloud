(function () {
  var RECIPIENTS = { kitchen: 'Kitchen', barista: 'Barista', bartender: 'Bartender', busser: 'Busser' };
  var BASES = { food: "each server's food sales", coffee: "each server's coffee sales", alcohol: "each server's alcohol sales", total_tips: "each server's total tips", remaining: 'server tips left after other tip-outs' };
  var SPLITS = { hours: 'by hours worked', even: 'evenly', sales: 'by sales' };
  var SOURCES = { jar: 'the cash tip jar', togo_card: 'to-go card tips', jar_togo: 'the cash jar + to-go card' };
  var AMONG = { all_support: 'all support (kitchen, busser, barista)', kitchen: 'kitchen only', foh: 'busser + barista' };
  var PAYOUTS = { weekly_cash: 'weekly, in cash', paycheck: 'on the paycheck', nightly_cash: 'nightly, in cash' };

  function fresh() { return (window.POLICY_RULES || []).map(function (r) { return Object.assign({}, r); }); }
  var rules = fresh();

  function opts(map, sel) {
    return Object.keys(map).map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + map[k] + '</option>'; }).join('');
  }

  function cardHTML(r, i) {
    if (r.type === 'tipout') {
      return '<div class="rule-card"><div class="rule-head"><span class="rule-badge badge-tipout">Tip-out</span><button type="button" class="rule-x" data-del="' + i + '">✕</button></div>' +
        '<div class="rule-row"><select class="inline" data-i="' + i + '" data-f="recipient">' + opts(RECIPIENTS, r.recipient) + '</select> gets ' +
        '<input class="inline num-in" type="number" step="0.1" min="0" data-i="' + i + '" data-f="percent" value="' + r.percent + '"> % of ' +
        '<select class="inline" data-i="' + i + '" data-f="base">' + opts(BASES, r.base) + '</select>, split ' +
        '<select class="inline" data-i="' + i + '" data-f="split">' + opts(SPLITS, r.split) + '</select></div></div>';
    }
    return '<div class="rule-card"><div class="rule-head"><span class="rule-badge badge-pool">Shared pool</span><button type="button" class="rule-x" data-del="' + i + '">✕</button></div>' +
      '<div class="rule-row">Pool: <select class="inline" data-i="' + i + '" data-f="source">' + opts(SOURCES, r.source) + '</select>, split ' +
      '<select class="inline" data-i="' + i + '" data-f="split">' + opts(SPLITS, r.split) + '</select> among ' +
      '<select class="inline" data-i="' + i + '" data-f="among">' + opts(AMONG, r.among) + '</select>, paid ' +
      '<select class="inline" data-i="' + i + '" data-f="payout">' + opts(PAYOUTS, r.payout) + '</select></div></div>';
  }

  function summarize() {
    var items = ['Servers keep their own tips.'];
    rules.forEach(function (r) {
      if (r.type === 'tipout') items.push('<b>' + RECIPIENTS[r.recipient] + '</b> gets <b>' + r.percent + '%</b> of ' + BASES[r.base] + ', split <b>' + SPLITS[r.split] + '</b>.');
      else items.push('<b>' + SOURCES[r.source] + '</b> is pooled and split <b>' + SPLITS[r.split] + '</b> among <b>' + AMONG[r.among] + '</b>, paid <b>' + PAYOUTS[r.payout] + '</b>.');
    });
    document.getElementById('live-summary').innerHTML = items.map(function (x) { return '<li>' + x + '</li>'; }).join('');
  }

  function render() {
    var c = document.getElementById('builder-rules');
    c.innerHTML = rules.map(cardHTML).join('');
    c.querySelectorAll('[data-f]').forEach(function (el) {
      el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', function (e) {
        var i = +e.target.getAttribute('data-i'), f = e.target.getAttribute('data-f');
        rules[i][f] = f === 'percent' ? (parseFloat(e.target.value) || 0) : e.target.value;
        summarize();
      });
    });
    c.querySelectorAll('[data-del]').forEach(function (el) {
      el.addEventListener('click', function (e) { rules.splice(+e.currentTarget.getAttribute('data-del'), 1); render(); });
    });
    summarize();
  }

  var addT = document.getElementById('add-tipout'), addP = document.getElementById('add-pool');
  if (addT) addT.addEventListener('click', function () { rules.push({ type: 'tipout', recipient: 'kitchen', percent: 0, base: 'food', split: 'hours' }); render(); });
  if (addP) addP.addEventListener('click', function () { rules.push({ type: 'pool', source: 'jar_togo', split: 'hours', among: 'all_support', payout: 'weekly_cash' }); render(); });

  var editBtn = document.getElementById('edit-btn'), cancelBtn = document.getElementById('cancel-btn');
  var vr = document.getElementById('view-read'), ve = document.getElementById('view-edit');
  if (editBtn) editBtn.addEventListener('click', function () { vr.style.display = 'none'; ve.style.display = ''; render(); });
  if (cancelBtn) cancelBtn.addEventListener('click', function () { ve.style.display = 'none'; vr.style.display = ''; rules = fresh(); });

  var form = document.getElementById('policy-form');
  if (form) form.addEventListener('submit', function () { document.getElementById('rules_json').value = JSON.stringify(rules); });
})();
