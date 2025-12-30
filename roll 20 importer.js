// ===================== MV Importer (D&D 5E 2014 by Roll20) =====================
// Commands:
//   !mv import --handout "Name"
//   !mv import { ...json... }
//   !mv setimg <baseId>        (select a token with desired art)
//   !mv debug                 (toggle debug whispers)
//   !mv dumpactions           (select a token that represents the character)
//   !mv dumpactions --name "Character Name"
//
// Key fix:
// - We set repeating_npcaction_<row>_npc_action ourselves so clicking actions ALWAYS posts to chat,
//   even for non-attack (no to-hit) actions.
//
// Changes included:
// 1) Non-attack actions (e.g. kind:"save") now get a generated description, are visible on the sheet,
//    and print to chat when clicked.
// 2) Speeds now print ALL movement modes present and label ground as "ground" (never "speed").
//    Order: fly, swim, ground, burrow, climb, plus any other exported x/x_max pairs.

on('ready', () => {
  state.MV = state.MV || { imgByBaseId: {}, debug: false };
  sendChat('MV', '/w gm MV script loaded ✅  (!mv debug to toggle debug)');
  log('MV script loaded ✅');
});

// ------------------ helpers ------------------
function whisperGM(msg) {
  sendChat('MV', `/w gm ${msg}`);
}

function abilityMod(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  return Math.floor((n - 10) / 2);
}

function normalizeImgsrc(url) {
  if (!url) return null;
  let out = String(url);
  out = out.replace(/\/(thumb|med|original|max)\./, '/thumb.');
  return out;
}

function escapeBraces(s) {
  // avoid breaking roll templates if description contains }}
  return String(s || '').replace(/{{/g, '〔〔').replace(/}}/g, '〕〕');
}

// JSON extraction / handouts
function extractJSON(text) {
  const s = String(text || '').trim();
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  let start = -1;

  if (firstBrace === -1 && firstBracket === -1) return null;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);

  const lastBrace = s.lastIndexOf('}');
  const lastBracket = s.lastIndexOf(']');
  const end = Math.max(lastBrace, lastBracket);

  if (start < 0 || end < 0 || end <= start) return null;
  return s.slice(start, end + 1);
}

function stripHTML(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\u00A0/g, ' ');
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseExportJSON(rawText) {
  let t = String(rawText || '').trim();
  const looksHTML =
    t.startsWith('<') ||
    /<br\s*\/?>/i.test(t) ||
    /<\/(p|div|span|pre|code)>/i.test(t);

  if (looksHTML) t = stripHTML(t);
  t = decodeEntities(t).trim();

  const jsonText = extractJSON(t);
  if (!jsonText) return { ok: false, error: 'Could not find JSON in handout text.' };

  try { return { ok: true, data: JSON.parse(jsonText) }; }
  catch (e) { return { ok: false, error: `JSON parse error: ${e.message}` }; }
}

function getHandoutByName(name) {
  const all = findObjs({ type: 'handout' }) || [];
  const needle = String(name || '').trim().toLowerCase();
  return all.find(h => (h.get('name') || '').trim().toLowerCase() === needle) || null;
}

function findOrCreateCharacter(name) {
  let c = findObjs({ type: 'character', name })[0];
  if (!c) c = createObj('character', { name });

  try { c.set('archived', false); } catch (e) {}
  try { c.set('controlledby', 'all'); } catch (e) {}
  try { c.set('inplayerjournals', 'all'); } catch (e) {}

  return c;
}

function setAttr(charId, name, current, max) {
  let a = findObjs({ type: 'attribute', characterid: charId, name })[0];
  if (!a) a = createObj('attribute', { characterid: charId, name });
  if (current !== undefined) a.set('current', String(current));
  if (max !== undefined) a.set('max', String(max));
  return a;
}

function setMany(charId, names, current, max) {
  names.forEach(n => setAttr(charId, n, current, max));
}

function removeRepeating(charId, prefix) {
  const attrs = findObjs({ type: 'attribute', characterid: charId }) || [];
  attrs.forEach(a => {
    if ((a.get('name') || '').startsWith(prefix)) a.remove();
  });
}

function makeRowId() {
  return ('r' + Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20);
}

// ------------------ token utils ------------------
function getSelectedGraphic(msg) {
  const sel = (msg.selected || [])[0];
  if (!sel) return null;
  if (sel._type !== 'graphic') return null;
  return getObj('graphic', sel._id) || null;
}

function resolveSpawnPageId(msg) {
  const tok = getSelectedGraphic(msg);
  if (tok) return tok.get('_pageid');
  const camp = Campaign();
  return camp.get('playerpageid') || camp.get('lastpageid') || null;
}

function spawnToken(char, baseId, msg) {
  const pageId = resolveSpawnPageId(msg);
  if (!pageId) {
    whisperGM('Could not determine a page to spawn on. Select ANY token on the target page, then import.');
    return null;
  }

  const template = getSelectedGraphic(msg);

  let img = state.MV.imgByBaseId[baseId];
  if (!img && template) img = template.get('imgsrc');
  img = normalizeImgsrc(img);

  if (!img) {
    whisperGM(`No valid imgsrc available. Run: !mv setimg ${baseId} (select a token with the art first).`);
    return null;
  }

  const left = template ? template.get('left') + 70 : 140;
  const top = template ? template.get('top') : 140;
  const w = template ? template.get('width') : 70;
  const h = template ? template.get('height') : 70;

  const tok = createObj('graphic', {
    _pageid: pageId,
    _subtype: 'token',
    layer: 'objects',
    left: left,
    top: top,
    width: w,
    height: h,
    represents: char.id,
    name: char.get('name'),
    imgsrc: img
  });

  return tok || null;
}

// ------------------ formatting ------------------
function formatOneAction(a) {
  if (!a) return '';

  if (a.kind === 'attack') {
    const typ = (a.attackType === 'ranged' || a.type === 'ranged') ? 'Ranged Weapon Attack' : 'Melee Weapon Attack';
    const reach = a.reach ? ` reach ${a.reach},` : '';
    const range = a.range ? ` range ${a.range},` : '';
    const tgt = a.target || 'one target';
    const dmg = a.damage || '—';
    const extra = a.extra ? ` ${a.extra}` : '';
    return `${typ}: ${a.toHit >= 0 ? '+' : ''}${a.toHit} to hit,${reach}${range} hit ${tgt}. Hit: ${dmg}.${extra}`;
  }

  // ✅ Save-type actions (no to-hit)
  if (a.kind === 'save' && a.save) {
    const abil = a.save.ability || 'DEX';
    const dc = a.save.dc ?? '';
    const area = a.area ? ` Area: ${a.area}.` : '';
    const rng = a.range ? ` Range: ${a.range}.` : '';
    const fail = a.onFail ? ` Fail: ${a.onFail}.` : '';
    const onSave = a.onSave ? ` Save: ${a.onSave}.` : '';
    const notes = a.notes ? ` ${a.notes}` : '';
    return `Each creature must make a DC ${dc} ${abil} saving throw.${area}${rng}${fail}${onSave}${notes}`.trim();
  }

  return a.desc || a.description || a.text || a.notes || '';
}

function buildAttackRoll(name, attackBonus, rangeText, damageText, descriptionText) {
  const nm = escapeBraces(name || 'Attack');
  const rt = escapeBraces(rangeText || '');
  const dmg = escapeBraces(damageText || '');
  const desc = escapeBraces(descriptionText || '');

  return `&{template:npcaction} {{name=${nm}}} {{rname=${nm}}} {{attack=1}} {{r1=[[1d20+${attackBonus}]]}} {{always=1}}` +
    (rt ? ` {{range=${rt}}}` : '') +
    (dmg ? ` {{damage=1}} {{dmg1flag=1}} {{dmg1=[[${dmg}]]}}` : '') +
    (desc ? ` {{description=${desc}}}` : '');
}

function buildNonAttackRoll(name, descText) {
  const nm = escapeBraces(name || 'Action');
  const desc = escapeBraces(descText || '');
  return `&{template:npcaction} {{name=${nm}}} {{rname=${nm}}}` + (desc ? ` {{description=${desc}}}` : '');
}

function setNpcActionCommand(charId, rowId, cmdText) {
  // IMPORTANT: sheet action button uses *_npc_action
  setAttr(charId, `repeating_npcaction_${rowId}_npc_action`, cmdText);

  // Keep rollbase too as fallback for some sheet builds
  setAttr(charId, `repeating_npcaction_${rowId}_rollbase`, cmdText);
  setAttr(charId, `repeating_npcaction_${rowId}_rollbase_dmg`, cmdText);
}

function forceNpcActionShowDescription(charId, rowId) {
  // Different sheet versions respect different flags; setting all is safe.
  setAttr(charId, `repeating_npcaction_${rowId}_show_desc`, 1);
  setAttr(charId, `repeating_npcaction_${rowId}_desc_flag`, 1);
  setAttr(charId, `repeating_npcaction_${rowId}_description_flag`, 1);
  setAttr(charId, `repeating_npcaction_${rowId}_descflag`, 1);
}

// ------------------ importer core ------------------
function importTo2014Sheet(char, data) {
  const stats = data.stats || {};
  const mv = data.movement || {};

  const hp = stats.hp ?? '';
  const ac = stats.ac ?? '';

  // NPC toggle + name
  setMany(char.id, ['npc', 'is_npc'], 1);
  setMany(char.id, ['npc_name', 'name'], data.baseName || data.name || char.get('name'));

  // Defaults
  setAttr(char.id, 'npc_options-flag', '0');
  setAttr(char.id, 'npc', '1');

  // AC
  setMany(char.id, ['npc_ac', 'ac', 'npc_ac_base'], ac);

  // HP
  setAttr(char.id, 'npc_hp', hp, hp);
  setMany(char.id, ['npc_hpmax', 'npc_hp_max', 'npc_hpbase', 'hp_max', 'hpmax'], hp);
  setAttr(char.id, 'hp', hp, hp);

  // Abilities
  const str = stats.str ?? 10;
  const dex = stats.dex ?? 10;
  const con = stats.con ?? 10;

  const strMod = abilityMod(str);
  const dexMod = abilityMod(dex);
  const conMod = abilityMod(con);

  setMany(char.id, ['npc_str', 'strength', 'str'], str);
  setMany(char.id, ['npc_dex', 'dexterity', 'dex'], dex);
  setMany(char.id, ['npc_con', 'constitution', 'con'], con);

  setMany(char.id, ['npc_str_mod', 'strength_mod', 'str_mod'], strMod);
  setMany(char.id, ['npc_dex_mod', 'dexterity_mod', 'dex_mod'], dexMod);
  setMany(char.id, ['npc_con_mod', 'constitution_mod', 'con_mod'], conMod);

  // ---------------- Movement (ALL modes, never "speed"; ground is "ground") ----------------
  function addSpeedPart(parts, label, std, max) {
    const s = Number(std ?? 0) || 0;
    const m = Number(max ?? 0) || 0;
    if (!s && !m) return;

    const lab = String(label || '').toLowerCase();
    if (m && m !== s) parts.push({ key: lab, text: `${lab} ${s} ft. (max ${m} ft.)` });
    else parts.push({ key: lab, text: `${lab} ${s} ft.` });
  }

  const parts = [];

  // Primary mode (if present)
  const primaryModeRaw = String(mv.mode || '').toLowerCase();
  const primaryMode = (primaryModeRaw === 'speed') ? 'ground' : primaryModeRaw;
  if (primaryMode) addSpeedPart(parts, primaryMode, mv.standard, mv.max);

  // Preferred order
  addSpeedPart(parts, 'fly', mv.fly, mv.fly_max);
  addSpeedPart(parts, 'swim', mv.swim, mv.swim_max);
  addSpeedPart(parts, 'ground', mv.ground, mv.ground_max);
  addSpeedPart(parts, 'burrow', mv.burrow, mv.burrow_max);
  addSpeedPart(parts, 'climb', mv.climb, mv.climb_max);

  // Any other exported movement mode pairs x / x_max
  const reserved = new Set([
    'mode','standard','max',
    'fly','fly_max','swim','swim_max','ground','ground_max','burrow','burrow_max','climb','climb_max',
    'acceleration','climb_rate'
  ]);

  Object.keys(mv).forEach(k => {
    if (reserved.has(k)) return;
    if (k.endsWith('_max')) return;
    const maxKey = `${k}_max`;
    if (Object.prototype.hasOwnProperty.call(mv, maxKey)) {
      addSpeedPart(parts, k, mv[k], mv[maxKey]);
    }
  });

  // Deduplicate by key (keep first occurrence)
  const seen = new Set();
  const deduped = [];
  parts.forEach(p => {
    if (seen.has(p.key)) return;
    seen.add(p.key);
    deduped.push(p.text);
  });

  const speedText = deduped.length ? deduped.join('; ') : '—';
  setMany(char.id, ['npc_speed', 'speed', 'npc_speed_base'], speedText);

  // Extra stable attrs for macros / debugging
  setAttr(char.id, 'mv_move_mode', primaryMode || '');
  setAttr(char.id, 'mv_move_primary_standard', Number(mv.standard ?? 0) || 0);
  setAttr(char.id, 'mv_move_primary_max', Number(mv.max ?? 0) || 0);

  setAttr(char.id, 'mv_move_fly_standard', Number(mv.fly ?? 0) || 0);
  setAttr(char.id, 'mv_move_fly_max', Number(mv.fly_max ?? 0) || 0);

  setAttr(char.id, 'mv_move_swim_standard', Number(mv.swim ?? 0) || 0);
  setAttr(char.id, 'mv_move_swim_max', Number(mv.swim_max ?? 0) || 0);

  setAttr(char.id, 'mv_move_ground_standard', Number(mv.ground ?? 0) || 0);
  setAttr(char.id, 'mv_move_ground_max', Number(mv.ground_max ?? 0) || 0);

  setAttr(char.id, 'mv_move_burrow_standard', Number(mv.burrow ?? 0) || 0);
  setAttr(char.id, 'mv_move_burrow_max', Number(mv.burrow_max ?? 0) || 0);

  setAttr(char.id, 'mv_move_climb_standard', Number(mv.climb ?? 0) || 0);
  setAttr(char.id, 'mv_move_climb_max', Number(mv.climb_max ?? 0) || 0);

  // Clear repeating
  removeRepeating(char.id, 'repeating_npctrait_');
  removeRepeating(char.id, 'repeating_npcaction_');

  // Traits (objects or strings)
  const traits = Array.isArray(data.traits) ? data.traits : [];
  traits.forEach(t => {
    const row = makeRowId();
    const id = (t && typeof t === 'object') ? (t.id || t.name || '') : String(t);
    const nm = (t && typeof t === 'object') ? (t.name || t.id || '') : String(t);
    const desc = (t && typeof t === 'object') ? (t.desc || t.description || t.text || '') : String(t);

    setAttr(char.id, `repeating_npctrait_${row}_name`, nm || id);
    setAttr(char.id, `repeating_npctrait_${row}_desc`, desc || id);
    setAttr(char.id, `repeating_npctrait_${row}_description`, desc || id);
  });

  // Movement traits (Acceleration / Climb Rate / Agility)
  const accelTrait = mv.acceleration ?? '';
  const climbRate = mv.climb_rate ?? '';
  const agility = (stats.agility !== undefined && stats.agility !== null) ? stats.agility : '';

  if (accelTrait !== '' && accelTrait !== null && accelTrait !== undefined) {
    const row = makeRowId();
    setAttr(char.id, `repeating_npctrait_${row}_name`, 'Acceleration');
    setAttr(char.id, `repeating_npctrait_${row}_desc`, String(accelTrait));
    setAttr(char.id, `repeating_npctrait_${row}_description`, String(accelTrait));
  }

  if (climbRate !== '' && climbRate !== null && climbRate !== undefined) {
    const row = makeRowId();
    setAttr(char.id, `repeating_npctrait_${row}_name`, 'Climb Rate');
    setAttr(char.id, `repeating_npctrait_${row}_desc`, String(climbRate));
    setAttr(char.id, `repeating_npctrait_${row}_description`, String(climbRate));
  }

  if (agility !== '' && agility !== null && agility !== undefined) {
    const row = makeRowId();
    setAttr(char.id, `repeating_npctrait_${row}_name`, 'Agility');
    setAttr(char.id, `repeating_npctrait_${row}_desc`, String(agility));
    setAttr(char.id, `repeating_npctrait_${row}_description`, String(agility));
  }

  // Crew stats
  if (data.crewStats && typeof data.crewStats === 'object') {
    const lines = [];
    Object.keys(data.crewStats).forEach(groupId => {
      const c = data.crewStats[groupId] || {};
      const dexM = Number(c.dexMod ?? 0) || 0;
      const pb = Number(c.profBonus ?? 0) || 0;

      setAttr(char.id, `mv_crew_${groupId}_dexmod`, dexM);
      setAttr(char.id, `mv_crew_${groupId}_pb`, pb);

      const dexTxt = (dexM >= 0 ? `+${dexM}` : `${dexM}`);
      const pbTxt = (pb >= 0 ? `+${pb}` : `${pb}`);
      lines.push(`${groupId}: DEX ${dexTxt}, PB ${pbTxt}`);
    });

    if (lines.length) {
      const row = makeRowId();
      setAttr(char.id, `repeating_npctrait_${row}_name`, 'Crew');
      setAttr(char.id, `repeating_npctrait_${row}_desc`, lines.join('\n'));
      setAttr(char.id, `repeating_npctrait_${row}_description`, lines.join('\n'));
    }
  }

  // Mods (prefer data.mods with descriptions; fallback to modIds)
  const mods = Array.isArray(data.mods) ? data.mods : [];
  const modIds = Array.isArray(data.modIds) ? data.modIds : [];

  if (mods.length) {
    mods.forEach(m => {
      const row = makeRowId();
      const nm = (m && typeof m === 'object') ? (m.name || m.id || 'Mod') : String(m);
      const desc = (m && typeof m === 'object') ? (m.desc || m.description || '') : '';
      const id = (m && typeof m === 'object') ? (m.id || '') : String(m);

      setAttr(char.id, `repeating_npctrait_${row}_name`, `Mod: ${nm}`);
      setAttr(char.id, `repeating_npctrait_${row}_desc`, desc || id || nm);
      setAttr(char.id, `repeating_npctrait_${row}_description`, desc || id || nm);
    });
  } else if (modIds.length) {
    modIds.forEach(id => {
      const row = makeRowId();
      setAttr(char.id, `repeating_npctrait_${row}_name`, `Mod: ${id}`);
      setAttr(char.id, `repeating_npctrait_${row}_desc`, id);
      setAttr(char.id, `repeating_npctrait_${row}_description`, id);
    });
  }

  // Actions + Mounted weapons
  const npcActions = [];
  (Array.isArray(data.actions) ? data.actions : []).forEach(a => npcActions.push({ source: 'base', a }));
  // If acceleration exists but wasn't exported as an action (older exports),
  // add a rollable "Acceleration" npc action automatically.
  const accel = (data.movement && data.movement.acceleration) ? String(data.movement.acceleration).trim() : '';
  const hasAccelAction = (Array.isArray(data.actions) ? data.actions : []).some(x => (x && (x.name || '')).toLowerCase() === 'acceleration');
  if (accel && !hasAccelAction) {
    npcActions.push({ source: 'derived', a: { name: 'Acceleration', kind: 'text', text: `Acceleration: [[${accel}]]` } });
  }
  if (Array.isArray(data.mountedWeapons)) data.mountedWeapons.forEach(w => npcActions.push({ source: 'mounted', w }));

  npcActions.forEach(entry => {
    const row = makeRowId();

    if (entry.source === 'mounted') {
      const w = entry.w;

      const name = `Mounted: ${w.name}`;

      const isMelee = (String(w.attackType || '').toLowerCase() === 'melee') || !!w.reach;
      const attackLabel = isMelee ? 'Melee Weapon Attack' : 'Ranged Weapon Attack';

      const rangeText = isMelee
        ? `Reach ${w.reach || '5 ft'}`
        : (w.range ? `Range ${w.range}` : '');

      const reachOrRangeLine = isMelee
        ? `Reach: ${w.reach || '5 ft'}. `
        : (w.range ? `Range: ${w.range}. ` : '');

      const desc =
        `${w.name} ×${w.qty} (${w.arc}). ` +
        `${attackLabel}: +${w.attackBonus} to hit. ` +
        reachOrRangeLine +
        `Hit: ${w.damage}. ` +
        (Array.isArray(w.traits) && w.traits.length
          ? `Traits: ${w.traits.map(x => (x && typeof x === 'object') ? (x.name || x.id || '') : String(x)).join(', ')}.`
          : '');

      setAttr(char.id, `repeating_npcaction_${row}_name`, name);
      setAttr(char.id, `repeating_npcaction_${row}_description`, desc);
      setAttr(char.id, `repeating_npcaction_${row}_desc`, desc);

      forceNpcActionShowDescription(char.id, row);

      const cmd = buildAttackRoll(name, Number(w.attackBonus ?? 0) || 0, rangeText, w.damage || '', desc);
      setNpcActionCommand(char.id, row, cmd);
      return;
    }

    const a = entry.a;
    const nm = a.name || 'Action';
    const desc = formatOneAction(a);

    setAttr(char.id, `repeating_npcaction_${row}_name`, nm);
    setAttr(char.id, `repeating_npcaction_${row}_description`, desc);
    setAttr(char.id, `repeating_npcaction_${row}_desc`, desc);

    forceNpcActionShowDescription(char.id, row);

    if (a.kind === 'attack') {
      const atkBonus = Number(a.toHit ?? 0) || 0;
      const rangeText =
        a.range ? `Range ${a.range}` :
        a.reach ? `Reach ${a.reach}` : '';
      const dmg = a.damage || '';

      const cmd = buildAttackRoll(nm, atkBonus, rangeText, dmg, desc);
      setNpcActionCommand(char.id, row, cmd);
    } else {
      // ✅ Non-attack actions: show on sheet and print description to chat when clicked
      const cmd = buildNonAttackRoll(nm, desc);
      setNpcActionCommand(char.id, row, cmd);
    }
  });
}

// ------------------ command handler ------------------
function parseArgs(content) {
  // splits on spaces but keeps quoted strings
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(content)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

on('chat:message', msg => {
  if (msg.type !== 'api') return;
  if (!msg.content.startsWith('!mv')) return;

  const args = parseArgs(msg.content);
  const cmd = args[1] || '';

  // !mv debug
  if (cmd === 'debug') {
    state.MV.debug = !state.MV.debug;
    whisperGM(`Debug is now: ${state.MV.debug ? 'ON' : 'OFF'}`);
    return;
  }

  // !mv setimg <baseId>
  if (cmd === 'setimg') {
    const baseId = args[2];
    if (!baseId) return whisperGM('Usage: !mv setimg <baseId> (select a token first)');
    const tok = getSelectedGraphic(msg);
    if (!tok) return whisperGM('Select a token with the desired art first.');
    state.MV.imgByBaseId[baseId] = tok.get('imgsrc');
    whisperGM(`Stored img for ${baseId}.`);
    return;
  }

  // !mv dumpactions (debug helper)
  if (cmd === 'dumpactions') {
    let char = null;

    const byName = args.includes('--name');
    if (byName) {
      const i = args.indexOf('--name');
      const nm = args[i + 1];
      char = findObjs({ type: 'character', name: nm })[0];
      if (!char) return whisperGM(`No character named "${nm}".`);
    } else {
      const tok = getSelectedGraphic(msg);
      if (!tok) return whisperGM('Select a token that represents a character.');
      char = getObj('character', tok.get('represents'));
      if (!char) return whisperGM('Selected token does not represent a character.');
    }

    const attrs = findObjs({ type: 'attribute', characterid: char.id }) || [];
    const actions = attrs.filter(a => (a.get('name') || '').includes('repeating_npcaction_') && (a.get('name') || '').endsWith('_npc_action'));
    whisperGM(`Found ${actions.length} npc_action commands on "${char.get('name')}".`);
    return;
  }

  // !mv import ...
  if (cmd === 'import') {
    const useHandout = args.includes('--handout');

    if (useHandout) {
      const i = args.indexOf('--handout');
      const hName = args[i + 1];
      if (!hName) return whisperGM('Usage: !mv import --handout "Name"');

      const h = getHandoutByName(hName);
      if (!h) return whisperGM(`Could not find handout named "${hName}".`);

      h.get('notes', (notes) => {
        const parsed = parseExportJSON(notes);
        if (!parsed.ok) return whisperGM(parsed.error);

        const data = parsed.data || {};
        const baseId = data.baseId || 'mv_import';
        const cName = data.baseName || data.name || hName;

        const char = findOrCreateCharacter(cName);
        importTo2014Sheet(char, data);
        spawnToken(char, baseId, msg);

        whisperGM(`Imported from handout "${hName}" into character "${char.get('name')}".`);
      });

      return;
    }

    // raw JSON after "!mv import"
    const raw = msg.content.replace(/^!mv\s+import\s*/i, '');
    const parsed = parseExportJSON(raw);
    if (!parsed.ok) return whisperGM(parsed.error);

    const data = parsed.data || {};
    const baseId = data.baseId || 'mv_import';
    const cName = data.baseName || data.name || 'MV Import';

    const char = findOrCreateCharacter(cName);
    importTo2014Sheet(char, data);
    spawnToken(char, baseId, msg);

    whisperGM(`Imported JSON into character "${char.get('name')}".`);
    return;
  }

  whisperGM('Unknown command. Try: !mv import --handout "Name"');
});
