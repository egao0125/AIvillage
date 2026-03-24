#!/usr/bin/env node
/**
 * Export full AI Village log — all data from Supabase via REST API
 * No dependencies required — uses native fetch
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env manually — no external deps
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
const envVars = {};
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
  if (m) envVars[m[1]] = m[2];
}

const SUPABASE_URL = envVars.SUPABASE_URL;
const SUPABASE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
};

async function query(table, params = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${params}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Fetch all data ──────────────────────────────────────────────

async function fetchAll() {
  console.log('Fetching world state...');
  const worldRows = await query('world_state', 'id=eq.current&select=data,updated_at');
  const worldRow = worldRows[0] || null;

  console.log('Fetching agents...');
  const agentRows = await query('agents', 'select=id,data,created_at,updated_at');

  console.log('Fetching controllers...');
  const controllerRows = await query('agent_controllers', 'select=agent_id,data,updated_at');

  console.log('Fetching memories (all, paginated)...');
  let allMemories = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const batch = await query('memories', `select=*&order=timestamp.asc&offset=${offset}&limit=${PAGE}`);
    if (!batch || batch.length === 0) break;
    allMemories.push(...batch);
    offset += PAGE;
    console.log(`  ...fetched ${allMemories.length} memories`);
    if (batch.length < PAGE) break;
  }

  return { worldRow, agentRows: agentRows || [], controllerRows: controllerRows || [], memories: allMemories };
}

// ── Helpers ─────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function gameTime(day, hour) {
  return `Day ${day}, ${String(hour).padStart(2, '0')}:00`;
}

// ── Build HTML ──────────────────────────────────────────────────

function buildHTML({ worldRow, agentRows, controllerRows, memories }) {
  const world = worldRow?.data || {};
  const agents = agentRows.map(r => ({ id: r.id, ...r.data }));
  const controllerMap = new Map((controllerRows || []).map(r => [r.agent_id, r.data]));
  const agentNameMap = new Map(agents.map(a => [a.id, a.config?.name || a.id]));

  // Group memories by agent
  const memsByAgent = new Map();
  for (const m of memories) {
    if (!memsByAgent.has(m.agent_id)) memsByAgent.set(m.agent_id, []);
    memsByAgent.get(m.agent_id).push(m);
  }

  // Group memories by type
  const memsByType = new Map();
  for (const m of memories) {
    if (!memsByType.has(m.type)) memsByType.set(m.type, []);
    memsByType.get(m.type).push(m);
  }

  // Timeline: all memories sorted chronologically
  const timeline = [...memories].sort((a, b) => a.timestamp - b.timestamp);

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>AI Village — Full Log Export</title>
<style>
  @page { size: A4; margin: 1.5cm; }
  @media print { body { font-size: 7px; } table { font-size: 7px; } h1 { font-size: 18px; } h2 { font-size: 13px; } h3 { font-size: 10px; } }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace; font-size: 9px; line-height: 1.4; color: #1a1a1a; background: #fff; padding: 20px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 4px; border-bottom: 3px solid #000; padding-bottom: 6px; }
  h2 { font-size: 16px; margin-top: 24px; margin-bottom: 8px; border-bottom: 2px solid #333; padding-bottom: 4px; page-break-after: avoid; }
  h3 { font-size: 12px; margin-top: 16px; margin-bottom: 6px; color: #333; page-break-after: avoid; }
  .meta { color: #666; font-size: 8px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 8px; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th, td { border: 1px solid #ccc; padding: 3px 5px; text-align: left; vertical-align: top; word-break: break-word; }
  th { background: #f0f0f0; font-weight: bold; white-space: nowrap; }
  .tag { display: inline-block; padding: 1px 4px; border-radius: 2px; font-size: 7px; font-weight: bold; margin-right: 2px; }
  .tag-observation { background: #dbeafe; color: #1e40af; }
  .tag-reflection { background: #fef3c7; color: #92400e; }
  .tag-dialogue { background: #d1fae5; color: #065f46; }
  .tag-action { background: #fee2e2; color: #991b1b; }
  .tag-plan { background: #ede9fe; color: #5b21b6; }
  .tag-social { background: #fce7f3; color: #9d174d; }
  .tag-assessment { background: #e0e7ff; color: #3730a3; }
  .tag-system { background: #f3f4f6; color: #374151; }
  .core { background: #fef08a; }
  .agent-section { margin-left: 8px; margin-bottom: 16px; }
  .world-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .world-card { border: 1px solid #ddd; padding: 8px; border-radius: 4px; }
  .world-card h4 { font-size: 10px; margin-bottom: 4px; }
  pre { white-space: pre-wrap; word-break: break-all; font-size: 8px; background: #f9f9f9; padding: 4px; border: 1px solid #eee; margin: 4px 0; }
  .personality-bar { display: inline-block; width: 60px; height: 8px; background: #eee; border-radius: 4px; overflow: hidden; vertical-align: middle; }
  .personality-fill { height: 100%; background: #4f46e5; border-radius: 4px; }
  .stat-row { display: flex; gap: 16px; flex-wrap: wrap; margin: 4px 0; }
  .stat-item { font-size: 9px; }
  .stat-label { color: #666; }
  .stat-value { font-weight: bold; }
  .toc { margin: 12px 0 20px; padding: 10px; background: #fafafa; border: 1px solid #ddd; }
  .toc a { color: #4f46e5; text-decoration: none; }
  .toc li { margin: 2px 0; }
</style>
</head>
<body>

<h1>AI Village — Complete Data Export</h1>
<div class="meta">
  Generated: ${new Date().toISOString()} &nbsp;|&nbsp;
  Current game time: ${gameTime(world.time?.day || '?', world.time?.hour || '?')} &nbsp;|&nbsp;
  Total agents: ${agents.length} &nbsp;|&nbsp;
  Total memories: ${memories.length} &nbsp;|&nbsp;
  Weather: ${esc(world.weather?.current || '?')} (${esc(world.weather?.season || '?')}, ${world.weather?.temperature ?? '?'}°)
</div>

<div class="toc">
<strong>Table of Contents</strong>
<ol>
  <li><a href="#world">World State</a></li>
  <li><a href="#agents">Agent Profiles &amp; Status</a></li>
  <li><a href="#controllers">Agent Controllers (Runtime)</a></li>
  <li><a href="#timeline">Full Chronological Timeline (${memories.length} events)</a></li>
  <li><a href="#by-agent">Memories by Agent</a></li>
  <li><a href="#by-type">Memories by Type</a></li>
  <li><a href="#conversations">Conversations (Dialogue Memories)</a></li>
  <li><a href="#buildings">Buildings &amp; Infrastructure</a></li>
  <li><a href="#board">Community Board</a></li>
  <li><a href="#artifacts">Artifacts &amp; Publications</a></li>
  <li><a href="#stats">Statistics &amp; Summary</a></li>
</ol>
</div>

<!-- ═══════════════════════════════════════════════════════════ -->
<h2 id="world">1. World State</h2>

<div class="world-grid">
  <div class="world-card">
    <h4>Time &amp; Weather</h4>
    <div class="stat-row">
      <div class="stat-item"><span class="stat-label">Day:</span> <span class="stat-value">${world.time?.day || '?'}</span></div>
      <div class="stat-item"><span class="stat-label">Hour:</span> <span class="stat-value">${world.time?.hour || '?'}:${String(world.time?.minute || 0).padStart(2, '0')}</span></div>
      <div class="stat-item"><span class="stat-label">Total minutes:</span> <span class="stat-value">${world.time?.totalMinutes || '?'}</span></div>
    </div>
    <div class="stat-row">
      <div class="stat-item"><span class="stat-label">Weather:</span> <span class="stat-value">${esc(world.weather?.current)}</span></div>
      <div class="stat-item"><span class="stat-label">Season:</span> <span class="stat-value">${esc(world.weather?.season)}</span></div>
      <div class="stat-item"><span class="stat-label">Temp:</span> <span class="stat-value">${world.weather?.temperature}°</span></div>
      <div class="stat-item"><span class="stat-label">Season day:</span> <span class="stat-value">${world.weather?.seasonDay}</span></div>
    </div>
  </div>
  <div class="world-card">
    <h4>Resource Pools</h4>
    ${world.resourcePools ? Object.entries(world.resourcePools).map(([k,v]) => `<div class="stat-item"><span class="stat-label">${esc(k)}:</span> <span class="stat-value">${v}</span></div>`).join('') : '<em>none</em>'}
  </div>
</div>

<h3>Technologies Discovered</h3>
${world.technologies?.length ? `<table><tr><th>#</th><th>Technology</th></tr>${world.technologies.map((t,i) => `<tr><td>${i+1}</td><td>${esc(typeof t === 'string' ? t : JSON.stringify(t))}</td></tr>`).join('')}</table>` : '<p><em>None</em></p>'}

<h3>Cultural Names</h3>
${world.culturalNames && Object.keys(world.culturalNames).length ? `<pre>${esc(JSON.stringify(world.culturalNames, null, 2))}</pre>` : '<p><em>None</em></p>'}

<h3>Emergent World Objects</h3>
${world.worldObjects?.length ? `<table><tr><th>#</th><th>Object</th></tr>${world.worldObjects.map((o,i) => `<tr><td>${i+1}</td><td><pre>${esc(JSON.stringify(o, null, 1))}</pre></td></tr>`).join('')}</table>` : '<p><em>None</em></p>'}

<h3>Material Spawns</h3>
${world.materialSpawns?.length ? `<table><tr><th>#</th><th>Spawn Data</th></tr>${world.materialSpawns.map((s,i) => `<tr><td>${i+1}</td><td><pre>${esc(JSON.stringify(s, null, 1))}</pre></td></tr>`).join('')}</table>` : '<p><em>None</em></p>'}

<!-- ═══════════════════════════════════════════════════════════ -->
<h2 id="agents">2. Agent Profiles &amp; Current Status</h2>
`;

  for (const agent of agents) {
    const c = agent.config || {};
    const p = c.personality || {};
    const v = agent.vitals || {};
    const inv = agent.inventory || [];

    html += `
<h3>${esc(c.name)} — ${esc(c.occupation || 'unknown')}</h3>
<div class="agent-section">
  <div class="stat-row">
    <div class="stat-item"><span class="stat-label">State:</span> <span class="stat-value">${esc(agent.state)}</span></div>
    <div class="stat-item"><span class="stat-label">Mood:</span> <span class="stat-value">${esc(agent.mood)}</span></div>
    <div class="stat-item"><span class="stat-label">Action:</span> <span class="stat-value">${esc(agent.currentAction)}</span></div>
    <div class="stat-item"><span class="stat-label">Position:</span> <span class="stat-value">(${agent.position?.x}, ${agent.position?.y})</span></div>
    <div class="stat-item"><span class="stat-label">Currency:</span> <span class="stat-value">${agent.currency ?? 0}</span></div>
    <div class="stat-item"><span class="stat-label">Alive:</span> <span class="stat-value">${agent.alive !== false ? 'YES' : 'NO'}</span></div>
    <div class="stat-item"><span class="stat-label">Joined:</span> <span class="stat-value">Day ${agent.joinedDay ?? '?'}</span></div>
  </div>
  <div class="stat-row">
    <div class="stat-item"><span class="stat-label">Health:</span> <span class="stat-value">${v.health ?? '?'}</span></div>
    <div class="stat-item"><span class="stat-label">Hunger:</span> <span class="stat-value">${v.hunger ?? '?'}</span></div>
    <div class="stat-item"><span class="stat-label">Energy:</span> <span class="stat-value">${v.energy ?? '?'}</span></div>
  </div>
  <div class="stat-row">
    <div class="stat-item"><span class="stat-label">Inventory:</span> <span class="stat-value">${inv.length > 0 ? inv.map(i => `${i.resource}×${i.qty}`).join(', ') : 'empty'}</span></div>
  </div>

  <strong>Personality (Big Five):</strong><br>
  ${['openness','conscientiousness','extraversion','agreeableness','neuroticism'].map(t => {
    const val = p[t] ?? 0;
    return `<span style="display:inline-block;width:120px;">${t}:</span>
    <span class="personality-bar"><span class="personality-fill" style="width:${val*100}%"></span></span> ${(val*100).toFixed(0)}%<br>`;
  }).join('')}

  <strong>Soul:</strong> <em>${esc(c.soul || '—')}</em><br>
  <strong>Backstory:</strong> ${esc(c.backstory || '—')}<br>
  <strong>Goal:</strong> ${esc(c.goal || '—')}<br>
  <strong>Desires:</strong> ${esc(JSON.stringify(c.desires || []))}<br>
  <strong>Skills:</strong> ${esc(JSON.stringify(c.skills || []))}<br>

  ${agent.mentalModels?.length ? `
  <strong>Mental Models (relationships):</strong>
  <table>
    <tr><th>Target</th><th>Trust</th><th>Stance</th><th>Predicted Goal</th><th>Notes</th></tr>
    ${agent.mentalModels.map(m => `<tr>
      <td>${esc(agentNameMap.get(m.targetId) || m.targetId)}</td>
      <td>${m.trust}</td>
      <td>${esc(m.emotionalStance)}</td>
      <td>${esc(m.predictedGoal)}</td>
      <td>${esc((m.notes || []).join('; '))}</td>
    </tr>`).join('')}
  </table>` : ''}

  ${agent.drives ? `
  <strong>Drives:</strong>
  <div class="stat-row">
    ${Object.entries(agent.drives).map(([k,v]) => `<div class="stat-item"><span class="stat-label">${k}:</span> <span class="stat-value">${typeof v === 'number' ? v.toFixed(1) : v}</span></div>`).join('')}
  </div>` : ''}
</div>
`;
  }

  // ── Controllers ──────────────────────────────────────────────
  html += `
<h2 id="controllers">3. Agent Controllers (Runtime State)</h2>
<table>
  <tr><th>Agent</th><th>State</th><th>Intentions</th><th>Activity Timer</th><th>Conv CD</th><th>Wake/Sleep</th><th>Home</th></tr>
`;
  for (const agent of agents) {
    const ctrl = controllerMap.get(agent.id) || {};
    html += `<tr>
      <td>${esc(agent.config?.name)}</td>
      <td>${esc(ctrl.controllerState)}</td>
      <td>${esc((ctrl.intentions || []).join(' → '))}</td>
      <td>${ctrl.activityTimer ?? '—'}</td>
      <td>${ctrl.conversationCooldown ?? '—'}</td>
      <td>${ctrl.wakeHour ?? '?'}–${ctrl.sleepHour ?? '?'}</td>
      <td>${esc(ctrl.homeArea || '—')}</td>
    </tr>`;
  }
  html += `</table>`;

  // World views
  html += `<h3>Agent World Views</h3>`;
  for (const agent of agents) {
    const ctrl = controllerMap.get(agent.id) || {};
    if (ctrl.worldView) {
      html += `<h3>${esc(agent.config?.name)}'s World View</h3><pre>${esc(ctrl.worldView)}</pre>`;
    }
  }

  // ── Full Timeline ────────────────────────────────────────────
  html += `
<h2 id="timeline">4. Full Chronological Timeline (${timeline.length} events)</h2>
<table>
  <tr><th style="width:30px">#</th><th style="width:120px">Timestamp</th><th style="width:70px">Agent</th><th style="width:60px">Type</th><th style="width:15px">Imp</th><th>Content</th><th style="width:50px">Related</th></tr>
`;
  for (let i = 0; i < timeline.length; i++) {
    const m = timeline[i];
    const typeClass = `tag-${m.type || 'system'}`;
    const related = (m.related_agent_ids || []).map(id => agentNameMap.get(id) || id.slice(0,6)).join(', ');
    html += `<tr${m.is_core ? ' class="core"' : ''}>
      <td>${i + 1}</td>
      <td>${formatTimestamp(m.timestamp)}</td>
      <td>${esc(agentNameMap.get(m.agent_id) || m.agent_id?.slice(0,8))}</td>
      <td><span class="tag ${typeClass}">${esc(m.type)}</span></td>
      <td>${m.importance}</td>
      <td>${esc(m.content)}</td>
      <td>${esc(related)}</td>
    </tr>`;
  }
  html += `</table>`;

  // ── By Agent ─────────────────────────────────────────────────
  html += `<h2 id="by-agent">5. Memories by Agent</h2>`;
  for (const agent of agents) {
    const agentMems = memsByAgent.get(agent.id) || [];
    html += `<h3>${esc(agent.config?.name)} (${agentMems.length} memories)</h3>`;
    if (agentMems.length === 0) { html += '<p><em>No memories</em></p>'; continue; }

    const typeCounts = {};
    for (const m of agentMems) { typeCounts[m.type] = (typeCounts[m.type] || 0) + 1; }
    html += `<div class="stat-row">${Object.entries(typeCounts).map(([t,c]) => `<div class="stat-item"><span class="tag tag-${t}">${t}: ${c}</span></div>`).join('')}</div>`;

    html += `<table><tr><th>Time</th><th>Type</th><th>Imp</th><th>Content</th><th>Emo</th><th>Core</th></tr>`;
    for (const m of agentMems) {
      html += `<tr${m.is_core ? ' class="core"' : ''}><td>${formatTimestamp(m.timestamp)}</td><td>${esc(m.type)}</td><td>${m.importance}</td><td>${esc(m.content)}</td><td>${m.emotional_valence ?? '—'}</td><td>${m.is_core ? 'Y' : ''}</td></tr>`;
    }
    html += `</table>`;
  }

  // ── By Type ──────────────────────────────────────────────────
  html += `<h2 id="by-type">6. Memories by Type</h2>`;
  for (const [type, mems] of memsByType) {
    html += `<h3>${esc(type)} (${mems.length})</h3>`;
    html += `<table><tr><th>Time</th><th>Agent</th><th>Imp</th><th>Content</th></tr>`;
    for (const m of mems) {
      html += `<tr><td>${formatTimestamp(m.timestamp)}</td><td>${esc(agentNameMap.get(m.agent_id) || m.agent_id?.slice(0,8))}</td><td>${m.importance}</td><td>${esc(m.content)}</td></tr>`;
    }
    html += `</table>`;
  }

  // ── Conversations ────────────────────────────────────────────
  html += `<h2 id="conversations">7. Conversations (Dialogue Memories)</h2>`;
  const dialogues = memories.filter(m => m.type === 'dialogue' || m.type === 'social' || (m.content && (m.content.includes(' said ') || m.content.includes(' told ') || m.content.includes(' asked '))));
  if (dialogues.length === 0) {
    html += '<p><em>No dialogue memories found</em></p>';
  } else {
    html += `<p>${dialogues.length} dialogue/social entries</p>`;
    html += `<table><tr><th>Time</th><th>Speaker</th><th>Type</th><th>Content</th><th>Related</th></tr>`;
    for (const m of dialogues) {
      const related = (m.related_agent_ids || []).map(id => agentNameMap.get(id) || id.slice(0,6)).join(', ');
      html += `<tr><td>${formatTimestamp(m.timestamp)}</td><td>${esc(agentNameMap.get(m.agent_id) || m.agent_id?.slice(0,8))}</td><td>${esc(m.type)}</td><td>${esc(m.content)}</td><td>${esc(related)}</td></tr>`;
    }
    html += `</table>`;
  }

  // ── Buildings ────────────────────────────────────────────────
  html += `<h2 id="buildings">8. Buildings &amp; Infrastructure</h2>`;
  if (world.buildings && Object.keys(world.buildings).length) {
    html += `<table><tr><th>Name/ID</th><th>Details</th></tr>`;
    for (const [k, v] of Object.entries(world.buildings)) {
      html += `<tr><td>${esc(k)}</td><td><pre>${esc(JSON.stringify(v, null, 2))}</pre></td></tr>`;
    }
    html += `</table>`;
  } else {
    html += '<p><em>No buildings</em></p>';
  }

  // ── Board ────────────────────────────────────────────────────
  html += `<h2 id="board">9. Community Board</h2>`;
  if (world.board?.length) {
    html += `<table><tr><th>#</th><th>Post</th></tr>`;
    for (let i = 0; i < world.board.length; i++) {
      html += `<tr><td>${i+1}</td><td><pre>${esc(JSON.stringify(world.board[i], null, 2))}</pre></td></tr>`;
    }
    html += `</table>`;
  } else {
    html += '<p><em>No posts</em></p>';
  }

  // ── Artifacts ────────────────────────────────────────────────
  html += `<h2 id="artifacts">10. Artifacts &amp; Publications</h2>`;
  if (world.artifacts?.length) {
    html += `<table><tr><th>#</th><th>Artifact</th></tr>`;
    for (let i = 0; i < world.artifacts.length; i++) {
      html += `<tr><td>${i+1}</td><td><pre>${esc(JSON.stringify(world.artifacts[i], null, 2))}</pre></td></tr>`;
    }
    html += `</table>`;
  } else {
    html += '<p><em>No artifacts</em></p>';
  }

  // ── Statistics ───────────────────────────────────────────────
  html += `<h2 id="stats">11. Statistics &amp; Summary</h2>`;

  const typeBreakdown = {};
  for (const m of memories) { typeBreakdown[m.type] = (typeBreakdown[m.type] || 0) + 1; }

  const agentMemCounts = {};
  for (const m of memories) {
    const name = agentNameMap.get(m.agent_id) || m.agent_id;
    agentMemCounts[name] = (agentMemCounts[name] || 0) + 1;
  }

  const coreMems = memories.filter(m => m.is_core);
  const impDist = {};
  for (const m of memories) { impDist[m.importance] = (impDist[m.importance] || 0) + 1; }

  html += `
<div class="world-grid">
  <div class="world-card">
    <h4>Memory Type Breakdown</h4>
    <table><tr><th>Type</th><th>Count</th><th>%</th></tr>
    ${Object.entries(typeBreakdown).sort((a,b) => b[1]-a[1]).map(([t,c]) => `<tr><td>${esc(t)}</td><td>${c}</td><td>${(c/memories.length*100).toFixed(1)}%</td></tr>`).join('')}
    </table>
  </div>
  <div class="world-card">
    <h4>Memories per Agent</h4>
    <table><tr><th>Agent</th><th>Count</th><th>%</th></tr>
    ${Object.entries(agentMemCounts).sort((a,b) => b[1]-a[1]).map(([n,c]) => `<tr><td>${esc(n)}</td><td>${c}</td><td>${(c/memories.length*100).toFixed(1)}%</td></tr>`).join('')}
    </table>
  </div>
  <div class="world-card">
    <h4>Importance Distribution</h4>
    <table><tr><th>Importance</th><th>Count</th></tr>
    ${Object.entries(impDist).sort((a,b) => Number(a[0])-Number(b[0])).map(([i,c]) => `<tr><td>${i}</td><td>${c}</td></tr>`).join('')}
    </table>
  </div>
  <div class="world-card">
    <h4>Core Memories (importance >= 9)</h4>
    <p>${coreMems.length} core memories across ${new Set(coreMems.map(m => m.agent_id)).size} agents</p>
    <table><tr><th>Agent</th><th>Content</th></tr>
    ${coreMems.map(m => `<tr><td>${esc(agentNameMap.get(m.agent_id))}</td><td>${esc(m.content)}</td></tr>`).join('')}
    </table>
  </div>
</div>

<h3>Raw World Data</h3>
<h3>Elections</h3>
<pre>${esc(JSON.stringify(world.elections, null, 2))}</pre>
<h3>Properties</h3>
<pre>${esc(JSON.stringify(world.properties, null, 2))}</pre>
<h3>Institutions</h3>
<pre>${esc(JSON.stringify(world.institutions, null, 2))}</pre>
<h3>Secrets</h3>
<pre>${esc(JSON.stringify(world.secrets, null, 2))}</pre>
<h3>Reputation</h3>
<pre>${esc(JSON.stringify(world.reputation, null, 2))}</pre>
<h3>Items</h3>
<pre>${esc(JSON.stringify(world.items, null, 2))}</pre>
<h3>Conversations (active)</h3>
<pre>${esc(JSON.stringify(world.conversations, null, 2))}</pre>

</body>
</html>`;

  return html;
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  try {
    const data = await fetchAll();
    console.log(`\nData fetched:`);
    console.log(`  World state: ${data.worldRow ? 'YES' : 'NO'}`);
    console.log(`  Agents: ${data.agentRows.length}`);
    console.log(`  Controllers: ${data.controllerRows.length}`);
    console.log(`  Memories: ${data.memories.length}`);

    const html = buildHTML(data);
    const outDir = '/Users/ozawaegao/Downloads';
    const outPath = path.join(outDir, 'AI_Village_Full_Log.html');
    fs.writeFileSync(outPath, html, 'utf-8');
    console.log(`\n✅ Written to: ${outPath}`);
    console.log(`   Open in browser → Print → Save as PDF`);
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();
