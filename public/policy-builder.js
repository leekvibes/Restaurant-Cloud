(function () {
  // THE WORDS COME FROM THE PAGE, NOT FROM A SECOND LIST.
  //
  // These maps were written out again here, and they had drifted: no barback
  // among the recipients and no "total sales" among the bases, which are two of
  // the three things the evening policy is made of. The read-only description
  // said "Servers tip out 2% of their own total sales to the busser" and the
  // builder, one tap away, said "Busser gets 2% of undefined" — and a select
  // showing the wrong option is one stray click away from saving the wrong
  // rule. The page hands over its own vocabulary now (POLICY_VOCAB), so the two
  // cannot disagree, and `opts` keeps any value it does not recognise.
  var V = window.POLICY_VOCAB || {};
  var RECIPIENTS = V.roles || { kitchen: 'Kitchen', barista: 'Barista', bartender: 'Bartender', busser: 'Busser' };
  var BASES = V.bases || { food: 'food sales', coffee: 'coffee sales', alcohol: 'alcohol sales',
    total_sales: 'total sales', total_tips: 'total tips', remaining: 'tips left after the other tip-outs' };
  var SPLITS = V.splits || { hours: 'by hours worked', even: 'evenly', sales: 'by sales' };
  var SOURCES = V.sources || { jar: 'the cash tip jar', togo_card: 'to-go card tips', jar_togo: 'the cash jar + to-go card' };
  var AMONG = V.among || { all_support: 'all support (kitchen, busser, barista)', kitchen: 'kitchen only', foh: 'busser + barista' };
  var PAYOUTS = V.payouts || { weekly_cash: 'weekly, in cash', paycheck: 'on the paycheck', nightly_cash: 'nightly, in cash' };
  // Who can pool what their own guests leave them: the roles that ring their
  // own till. A busser has nothing of their own to pool.
  var SHARE_ROLES = { bartender: 'Bartenders', barista: 'Baristas', server: 'Servers' };
  // Two ways to divide a pool, not three. "By sales" is a way of splitting a
  // pot somebody else funded; there is no sales figure to weigh a pool of their
  // own tips by, and the engine would read it as hours — an option that quietly
  // means something else is worse than no option.
  var SHARE_SPLITS = { hours: 'by hours worked', even: 'evenly' };

  function fresh() { return (window.POLICY_RULES || []).map(function (r) { return Object.assign({}, r); }); }
  var rules = fresh();

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function label(map, k) { return map[k] || (k === 'pot' ? 'what is in the pot' : k); }
  function roleWord(x) { return RECIPIENTS[x] || SHARE_ROLES[x] || x; }
  function plural(x) { var w = roleWord(x); return /s$/i.test(w) ? w : w + 's'; }

  // The same sentence the read-only page uses, so the builder reads back what
  // was saved rather than a paraphrase of it.
  function payerPhrase(r) {
    if (r.from) return 'The ' + roleWord(r.from).toLowerCase() + ' pot pays';
    var who = r.paidBy ? (Array.isArray(r.paidBy) ? r.paidBy : [r.paidBy]) : ['server'];
    var names = who.map(function (x) { return plural(x).toLowerCase(); });
    var joined = names.length === 1 ? names[0]
      : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    return joined.charAt(0).toUpperCase() + joined.slice(1) + ' tip out';
  }

  function opts(map, sel) {
    var keys = Object.keys(map);
    // A value the page does not have a word for still has to be the one
    // selected. Without this the select shows the first option instead, and the
    // first change event writes it over what was saved.
    if (sel != null && sel !== '' && keys.indexOf(sel) < 0) keys.push(sel);
    return keys.map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === sel ? ' selected' : '') + '>' + esc(label(map, k)) + '</option>';
    }).join('');
  }

  function cardHTML(r, i) {
    if (r.type === 'tipout') {
      // A rule funded by another role's pot is shown and never edited here: the
      // builder has no control for `from`, and re-saving it through a select
      // would quietly turn it into a rule the servers pay.
      if (r.from) {
        return '<div class="rule-card"><div class="rule-head"><span class="rule-badge badge-tipout">Tip-out</span><button type="button" class="rule-x" data-del="' + i + '">✕</button></div>' +
          '<div class="rule-row">' + esc(payerPhrase(r)) + ' <b>' + r.percent + '%</b> of ' + esc(label(BASES, r.base)) +
          ' to the <b>' + esc(roleWord(r.recipient).toLowerCase()) + '</b>, split ' + esc(label(SPLITS, r.split)) + '.</div></div>';
      }
      return '<div class="rule-card"><div class="rule-head"><span class="rule-badge badge-tipout">Tip-out</span><button type="button" class="rule-x" data-del="' + i + '">✕</button></div>' +
        '<div class="rule-row"><b>' + esc(payerPhrase(r)) + '</b> ' +
        '<input class="inline num-in" type="number" step="0.1" min="0" data-i="' + i + '" data-f="percent" value="' + r.percent + '"> % of their ' +
        '<select class="inline" data-i="' + i + '" data-f="base">' + opts(BASES, r.base) + '</select> to the ' +
        '<select class="inline" data-i="' + i + '" data-f="recipient">' + opts(RECIPIENTS, r.recipient) + '</select>, split ' +
        '<select class="inline" data-i="' + i + '" data-f="split">' + opts(SPLITS, r.split) + '</select></div></div>';
    }
    if (r.type === 'share') {
      return '<div class="rule-card"><div class="rule-head"><span class="rule-badge badge-pool">Pooled tips</span><button type="button" class="rule-x" data-del="' + i + '">✕</button></div>' +
        '<div class="rule-row"><select class="inline" data-i="' + i + '" data-f="role">' + opts(SHARE_ROLES, r.role) + '</select> pool the tips their own guests leave them, split ' +
        '<select class="inline" data-i="' + i + '" data-f="split">' + opts(SHARE_SPLITS, r.split) + '</select> between themselves</div></div>';
    }
    // A pool that names its own roles is the same case as `from`: the list is
    // not editable here, so it is shown rather than offered up to a select.
    if (Array.isArray(r.among)) {
      return '<div class="rule-card"><div class="rule-head"><span class="rule-badge badge-pool">Shared pool</span><button type="button" class="rule-x" data-del="' + i + '">✕</button></div>' +
        '<div class="rule-row"><b>' + esc(label(SOURCES, r.source)) + '</b> — shared by the <b>' +
        esc(r.among.map(function (x) { return plural(x).toLowerCase(); }).join(' and the ')) + '</b>, split ' +
        esc(label(SPLITS, r.split)) + ', paid ' + esc(label(PAYOUTS, r.payout)) + '.</div></div>';
    }
    return '<div class="rule-card"><div class="rule-head"><span class="rule-badge badge-pool">Shared pool</span><button type="button" class="rule-x" data-del="' + i + '">✕</button></div>' +
      '<div class="rule-row">Pool: <select class="inline" data-i="' + i + '" data-f="source">' + opts(SOURCES, r.source) + '</select>, split ' +
      '<select class="inline" data-i="' + i + '" data-f="split">' + opts(SPLITS, r.split) + '</select> among ' +
      '<select class="inline" data-i="' + i + '" data-f="among">' + opts(AMONG, r.among) + '</select>, paid ' +
      '<select class="inline" data-i="' + i + '" data-f="payout">' + opts(PAYOUTS, r.payout) + '</select></div></div>';
  }

  function keepersLine() {
    // The same sentence the saved page opens with: who keeps what their own
    // guests leave them. A share rule alone makes that true of the bar, so the
    // line has to answer to the rules being built, not to a fixed string.
    var direct = { server: 1 };
    rules.forEach(function (r) {
      if (r.type === 'share' || r.paidBy || (r.type === 'pool' && Array.isArray(r.among))) {
        direct.server = 1; direct.bartender = 1; direct.barista = 1;
      }
    });
    var names = Object.keys(direct).map(function (x) { return plural(x).toLowerCase(); });
    var joined = names.length === 1 ? names[0]
      : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    var cap = joined.charAt(0).toUpperCase() + joined.slice(1);
    return names.length === 1 ? cap + ' keep the tips their own guests leave them.'
      : cap + ' each keep the tips their own guests leave them, and pay the percentages below out of their own sales.';
  }

  function summarize() {
    var items = [keepersLine()];
    rules.forEach(function (r) {
      if (r.type === 'tipout') {
        items.push('<b>' + esc(payerPhrase(r)) + '</b> <b>' + r.percent + '%</b>' + (r.from ? '' : ' of their own') +
          ' ' + esc(label(BASES, r.base)) + ' to the <b>' + esc(roleWord(r.recipient).toLowerCase()) +
          '</b>, split <b>' + esc(label(SPLITS, r.split)) + '</b>.');
      } else if (r.type === 'share') {
        items.push('<b>' + esc(plural(r.role || 'bartender')) + '</b> pool the tips their own guests leave them and split them <b>' +
          esc(SHARE_SPLITS[r.split] || SHARE_SPLITS.hours) + '</b> between themselves.');
      } else {
        var among = Array.isArray(r.among)
          ? 'the ' + r.among.map(function (x) { return plural(x).toLowerCase(); }).join(' and the ')
          : esc(label(AMONG, r.among));
        items.push('<b>' + esc(label(SOURCES, r.source)) + '</b> — shared by ' + among +
          ', split <b>' + esc(label(SPLITS, r.split)) + '</b>, paid <b>' + esc(label(PAYOUTS, r.payout)) + '</b>.');
      }
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
  var addS = document.getElementById('add-share');
  if (addS) addS.addEventListener('click', function () { rules.push({ type: 'share', role: 'bartender', split: 'hours' }); render(); });

  var editBtn = document.getElementById('edit-btn'), cancelBtn = document.getElementById('cancel-btn');
  var vr = document.getElementById('view-read'), ve = document.getElementById('view-edit');
  if (editBtn) editBtn.addEventListener('click', function () { vr.style.display = 'none'; ve.style.display = ''; render(); });
  if (cancelBtn) cancelBtn.addEventListener('click', function () { ve.style.display = 'none'; vr.style.display = ''; rules = fresh(); });

  var form = document.getElementById('policy-form');
  if (form) form.addEventListener('submit', function () { document.getElementById('rules_json').value = JSON.stringify(rules); });
})();
