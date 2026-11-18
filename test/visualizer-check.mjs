#!/usr/bin/env node
// Headless test harness for ai-gateway-flow.html
//
// Usage: node test/visualizer-check.mjs
//
// Executes the visualizer's inline <script> with DOM/canvas stubs and asserts:
//   1. The full script executes with no undefined references
//   2. Every inspector function is callable at every step of its version×flow
//   3. Every step produces a step-specific inspector label (no stale labels —
//      the label after step i must be non-empty and must change when the step
//      text changes)
//   4. Step numbering (badge/num/label prefix) is sequential
//   5. No flow step references a node hidden in the active version scene
//   6. populateFlowSelect keeps flow-select.value === activeFlow
//   7. Every tips key has a node; version summaries exist for all versions
//
// Exit code 0 = all green.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ai-gateway-flow.html'), 'utf8');
const js = [...html.matchAll(/<script>(.*?)<\/script>/gs)].map(m => m[1]).join('\n');

// ---------- DOM/canvas stubs ----------
const ctx2d = new Proxy({}, {
  get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}),
  set: () => true,
});
const elements = new Map();
const mkEl = () => new Proxy({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} }, {
  get: (t, k) => {
    if (k in t) return t[k];
    if (['addEventListener', 'appendChild', 'remove', 'insertAdjacentHTML', 'scrollIntoView', 'removeChild', 'querySelector', 'closest', 'setAttribute', 'showModal'].includes(k)) return () => {};
    if (k === 'getContext') return () => ctx2d;
    return undefined;
  },
  set: (t, k, v) => { t[k] = v; return true; },
});
global.document = new Proxy({}, {
  get: (t, k) => {
    if (k === 'getElementById') return (id) => { if (!elements.has(id)) elements.set(id, mkEl()); return elements.get(id); };
    if (k === 'querySelectorAll') return () => [];
    if (k === 'querySelector') return (sel) => { if (!elements.has(sel)) elements.set(sel, mkEl()); return elements.get(sel); };
    if (k === 'createElement') return () => mkEl();
    return undefined;
  },
});
global.addEventListener = () => {};
global.window = { innerWidth: 1400, innerHeight: 900, addEventListener() {}, devicePixelRatio: 1 };
global.innerWidth = 1400; global.innerHeight = 900;
global.requestAnimationFrame = () => 0;
global.alert = () => {};

// ---------- execute ----------
let failures = 0;
const log = (m) => { console.log(m); failures++; };

try {
  (0, eval)(js + `
    ;globalThis.__H = {
      inspFns, flowSets, initInspector, N, hiddenByScene, inspStep,
      flowMapFor, versionMeta, versionChangeSummary, setVersion,
      populateFlowSelect, activeFlowRef: () => activeFlow, setFlow: (v, f) => { version = v; activeFlow = f; flow = flowSets[v][f]; },
      lastLabel: () => inspStepLabel,
    };`);
} catch (e) {
  console.error('EXEC FAIL:', e.message);
  process.exit(1);
}
const H = globalThis.__H;
const { inspFns, flowSets, initInspector, N, hiddenByScene, inspStep, flowMapFor, versionMeta, versionChangeSummary } = H;

// ---------- checks ----------
for (const [v, fm] of Object.entries(flowSets)) {
  const hidden = new Set(hiddenByScene[v] || []);
  for (const [f, steps] of Object.entries(fm)) {
    if (!inspFns[v][f]) { log(`${v}/${f}: NO INSPECTOR FUNCTION`); continue; }
    H.setFlow(v, f);
    initInspector();
    let prevLabel = null;
    let prevDerived = null;
    for (let i = 1; i <= steps.length; i++) {
      // (2) callable at every step
      try { inspStep(i); } catch (e) { log(`${v}/${f} insp step ${i}: ${e.message}`); break; }
      // (3) step-specific label: non-empty, and must change when the step text changes
      const derived = steps[i - 1].t.replace(/^\d+\.\s*/, '');
      const label = H.lastLabel();
      if (!label) log(`${v}/${f} step ${i}: EMPTY inspector label`);
      if (prevLabel !== null && prevDerived !== derived && label === prevLabel) {
        log(`${v}/${f} step ${i}: STALE label "${label}" (step text changed)`);
      }
      prevLabel = label; prevDerived = derived;
      // (4) numbering
      const expect = i;
      if (steps[i - 1].badge !== undefined && steps[i - 1].badge !== expect && steps[i - 1].badge !== '✗') log(`${v}/${f} step ${expect}: badge ${steps[i - 1].badge}`);
      if (steps[i - 1].num !== undefined && steps[i - 1].num !== expect) log(`${v}/${f} step ${expect}: num ${steps[i - 1].num}`);
      if (!steps[i - 1].t.startsWith(`${expect}.`)) log(`${v}/${f}: bad label prefix "${steps[i - 1].t.slice(0, 20)}"`);
      // (5) hidden nodes
      for (const key of [steps[i - 1].target, steps[i - 1].f, steps[i - 1].to, steps[i - 1].glow]) {
        if (key && !N[key]) log(`${v}/${f}: missing node ${key}`);
        if (key && hidden.has(key)) log(`${v}/${f}: step ${i} touches node hidden in scene: ${key}`);
      }
    }
  }
}

// (6) populateFlowSelect keeps the dropdown in sync with the active flow
{
  for (const v of Object.keys(flowSets)) {
    try { H.setVersion(v); } catch (e) { log(`setVersion(${v}): ${e.message}`); }
    const select = elements.get('flow-select');
    if (select && select.value !== H.activeFlowRef()) {
      log(`version ${v}: flow-select.value (${select.value}) !== activeFlow (${H.activeFlowRef()})`);
    }
    for (const k of Object.keys(flowMapFor(v))) {
      if (!inspFns[v][k]) log(`${v}: flow ${k} has no inspector`);
    }
  }
}

// (7) tips ↔ nodes; version summaries
const tipsKeys = [...js.matchAll(/^  (\w+): \{ t:/gm)].map(m => m[1]);
for (const k of tipsKeys) if (!N[k]) log(`tip without node: ${k}`);
if (typeof versionChangeSummary !== 'function') log('versionChangeSummary missing');
for (const v of Object.keys(versionMeta)) {
  const s = versionChangeSummary(v);
  if (!s || s.length < 20) log(`versionChangeSummary(${v}) empty`);
}

console.log(failures ? `${failures} FAILURES` : 'ALL CHECKS PASS');
process.exit(failures ? 1 : 0);
