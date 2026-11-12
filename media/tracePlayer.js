// Trace Player panel: controls, timeline, open traces and the records around the cursor.
// Plain JavaScript without a build step; src/trace/player.ts sends it `state` messages and runs what it asks.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('player');
  let state = null;
  let dragging = false;

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'className') el.className = v;
      // Through the CSSOM: the panel's Content-Security-Policy blocks style attributes.
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }
  const send = (type, extra) => vscode.postMessage({ type, ...extra });
  const button = (label, title, onclick, extra = {}) => h('button', { className: 'btn', title, onclick, ...extra }, label);
  // Line icons in the style of the editor's toolbar (media/editor.js), after VS Code's Restart, Step Back and Step Over.
  const I = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICONS = {
    first: I('<path d="M6.3 6.3A8 8 0 1 1 4 12"/><path d="M6 2v4.5h4.5"/>'),
    stepBack: I('<path d="M19 13a7 7 0 00-14 0"/><path d="M2 10l3 3 3-3"/><circle cx="12" cy="19" r="2" fill="currentColor" stroke="none"/>'),
    stepOver: I('<path d="M5 13a7 7 0 0114 0"/><path d="M16 10l3 3 3-3"/><circle cx="12" cy="19" r="2" fill="currentColor" stroke="none"/>'),
  };
  const iconButton = (icon, title, onclick, extra = {}) => {
    const b = button('', title, onclick, { className: 'btn icon', ...extra });
    b.innerHTML = ICONS[icon];
    return b;
  };

  // Kept across renders: rebuilding it would end a drag on its first move (each move seeks, which renders).
  const slider = h('input', {
    type: 'range', className: 'slider', min: '-1', max: '0', value: '-1',
    oninput: (e) => send('seek', { index: Number(e.target.value) }),
    onpointerdown: () => (dragging = true),
    onchange: () => (dragging = false),
  });
  const barHost = h('div');
  const rest = h('div', { className: 'rest' });

  function render() {
    if (!state || !state.traces.length) {
      root.replaceChildren(
        h('div', { className: 'empty' },
          h('p', {}, 'Replay a log of your state machines on their diagrams: the active states, the transitions taken and the branches chosen at choices and junctions.'),
          button('Open Log…', 'Open one or more log files', () => send('open'), { className: 'btn primary' })),
      );
      return;
    }
    const none = !state.count;
    const atEnd = state.cursor >= state.count - 1;
    barHost.replaceChildren(h('div', { className: 'bar' },
      button('Open Log…', 'Open more log files', () => send('open')),
      h('span', { className: 'sep' }),
      iconButton('first', 'First record', () => send('first'), { disabled: none }),
      iconButton('stepBack', 'Previous record', () => send('step', { delta: -1 }), { disabled: state.cursor < 0 }),
      state.playing
        ? button('⏸', 'Pause', () => send('pause'))
        : button('▶', 'Play from here (from the start at the end)', () => send('play'), { disabled: none }),
      iconButton('stepOver', 'Next record', () => send('step', { delta: 1 }), { disabled: atEnd }),
      state.canFollow ? button('● Live', 'Follow the last record as the files grow', () => send('live'), { className: `btn live${state.live ? ' on' : ''}` }) : null,
      speedSelect(),
      h('span', { className: 'pos' }, none ? 'No records yet' : `${state.cursor + 1} / ${state.count}${state.time ? ` · ${state.time}` : ''}`),
    ));
    slider.max = String(Math.max(state.count - 1, 0));
    if (!dragging) slider.value = String(state.cursor);
    slider.disabled = none;
    rest.replaceChildren(...[traces(), problems(), records()].filter(Boolean));
    if (root.firstChild !== barHost) root.replaceChildren(barHost, slider, rest);
    const cur = rest.querySelector('tr.current');
    if (cur && !dragging) cur.scrollIntoView({ block: 'nearest' });
  }

  function speedSelect() {
    const sel = h('select', { title: 'Playing speed', onchange: (e) => send('speed', { speed: Number(e.target.value) }) },
      ...[0.25, 0.5, 1, 2, 5, 10].map((s) => h('option', { value: String(s), selected: s === state.speed }, `${s}×`)));
    return sel;
  }

  function traces() {
    return h('div', { className: 'traces' }, ...state.traces.map((t, i) =>
      h('div', { className: `trace${t.error ? ' error' : ''}`, title: t.path },
        h('span', { className: 'swatch', style: `--i:${i}` }),
        h('span', { className: 'name' }, t.name),
        h('select', { title: 'Format of the lines', onchange: (e) => send('format', { trace: i, format: e.target.value }) },
          ...state.formats.map((f) => h('option', { value: f, selected: f === t.format }, f))),
        t.needsMachine
          ? button(t.machine || 'Choose machine…', 'State machine of the lines that name none: click to choose it', () => send('machine', { trace: i }), { className: `btn machine${t.machine ? '' : ' primary'}` })
          : null,
        h('span', { className: 'muted' }, t.error || `${t.records} record${t.records === 1 ? '' : 's'}`),
        button('×', 'Close this trace', () => send('close', { trace: i }), { className: 'btn close' }),
      )));
  }

  function problems() {
    if (!state.problems.length) return null;
    return h('div', { className: 'problems' }, ...state.problems.map((p) => h('div', {}, `⚠ ${p}`)));
  }

  function records() {
    const rows = state.rows.map((r) =>
      h('tr', { className: `${r.index === state.cursor ? 'current' : ''}${r.index > state.cursor ? ' future' : ''}${r.resolved ? '' : ' unresolved'}`, onclick: () => send('seek', { index: r.index }) },
        h('td', { className: 'time' }, r.time),
        h('td', {}, h('span', { className: 'swatch', style: `--i:${r.trace}` })),
        h('td', { className: 'machine' },
          r.color >= 0 ? h('span', { className: `inst ic${r.color % 6}`, title: 'Color of this instance in the diagram' }, '● ') : null,
          r.machine),
        h('td', { className: `kind k-${r.kind}` }, r.kind),
        h('td', { className: 'what' }, r.name)));
    return h('div', { className: 'records' }, h('table', {}, h('tbody', {}, ...rows)));
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data;
      render();
    }
  });
  window.addEventListener('pointerup', () => (dragging = false));
  send('ready');
})();
