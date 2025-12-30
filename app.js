let mounts = [];
let vehicles = [];
let saddles = [];
let weapons = [];
let mods = [];
let TRAITS = {};

const SIZE_ORDER = ["XS", "S", "M", "L", "XL"];
const SIZE_UNITS = { XS: 1, S: 2, M: 4, L: 8, XL: 16 };

const SIZE_CAPACITY_MULT = {
  Tiny: 0.5,
  Small: 1,
  Medium: 1,
  Large: 2,
  Huge: 4,
  Gargantuan: 8
};

let config = {
  base: null,
  mount: null,
  vehicle: null,
  saddle: null,

  // per mountpoint: { weaponId, qty }
  mounts: {},

  // per mountpoint: true/false proficient
  proficiencies: {},

  // crewGroupId -> { dexMod, profBonus }
  crewStats: {},

  // list of mod ids applied
  mods: []
};

/* ---------- SMALL HELPERS ---------- */

function abilityMod(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 0;
  return Math.floor((n - 10) / 2);
}

function capacity(base) {
  const sizeMult = SIZE_CAPACITY_MULT[base.size] || 1;
  const carryMult = base.carryMultiplier || 1;
  return (Number(base.strength) || 0) * 15 * sizeMult * carryMult;
}

function traitLabel(traitId) {
  return String(traitId)
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Some mounts (e.g. tentacles/limbs) must use the special NO_saddle only.
 * We treat any mount with:
 * - tag "tentacle", OR
 * - trait "no_saddle" or "no saddle"
 * as "NO_saddle-only".
 */
function isNoSaddleOnlyMount(mount) {
  if (!mount) return false;
  const tags = Array.isArray(mount.tags) ? mount.tags : [];
  const traits = Array.isArray(mount.traits) ? mount.traits : [];
  return tags.includes("tentacle") || traits.includes("no_saddle") || traits.includes("no saddle");
}

/**
 * Movement helpers:
 * Supports bases that define movement blocks like:
 *  - fly:    {standard, max}
 *  - ground: {standard, max}
 *  - swim:   {standard, max}
 *  - burrow: {standard, max}
 *  - climb:  {standard, max}
 */
function hasMoveBlock(x) {
  return x && typeof x === "object" && Number.isFinite(+x.standard);
}

function getMovementMode(base) {
  // Prefer fly if present (matches existing flying-combat default behavior)
  if (hasMoveBlock(base?.fly)) return "fly";
  if (hasMoveBlock(base?.ground)) return "ground";
  if (hasMoveBlock(base?.swim)) return "swim";
  if (hasMoveBlock(base?.burrow)) return "burrow";
  if (hasMoveBlock(base?.climb)) return "climb";
  return "none";
}

function getMovementBlock(base, mode) {
  if (!base) return { standard: 0, max: 0 };
  const blk = base?.[mode];
  if (hasMoveBlock(blk)) {
    return { standard: +blk.standard || 0, max: +blk.max || 0 };
  }
  return { standard: 0, max: 0 };
}

/**
 * Weapon restrictions:
 * If the derived base (vehicle/mount) has `weaponAllowlist: ["id1","id2",...]`,
 * only those weapon ids may be selected on any mounting point.
 */
function getWeaponAllowlist() {
  const derived = getDerivedBase?.() || config.base || {};
  const list = derived.weaponAllowlist;
  return Array.isArray(list) && list.length ? list : null;
}

function isWeaponAllowed(weaponId) {
  const allow = getWeaponAllowlist();
  if (!allow) return true;
  return allow.includes(weaponId);
}

function sanitizeIllegalSelections() {
  const allow = getWeaponAllowlist();
  if (!allow) return;

  for (const slot of Object.keys(config.mounts || {})) {
    const sel = config.mounts[slot];
    if (!sel) continue;
    if (sel.weaponId && sel.weaponId !== "none" && !allow.includes(sel.weaponId)) {
      sel.weaponId = "none";
      sel.qty = 0;
      config.proficiencies[slot] = false;
    }
  }
}

/* ---------- LOAD DATA ---------- */

async function loadData() {
  try {
    const mountsRes = await fetch("data/mounts.json"); if (!mountsRes.ok) throw new Error("mounts.json not found");
    const vehiclesRes = await fetch("data/vehicles.json"); if (!vehiclesRes.ok) throw new Error("vehicles.json not found");
    const saddlesRes = await fetch("data/saddles.json"); if (!saddlesRes.ok) throw new Error("saddles.json not found");
    const weaponsRes = await fetch("data/weapons.json"); if (!weaponsRes.ok) throw new Error("weapons.json not found");
    const traitsRes = await fetch("data/traits.json"); if (!traitsRes.ok) throw new Error("traits.json not found");
    const modsRes = await fetch("data/mods.json"); if (!modsRes.ok) throw new Error("mods.json not found");

    mounts = await mountsRes.json();
    vehicles = await vehiclesRes.json();
    saddles = await saddlesRes.json();
    weapons = await weaponsRes.json();
    mods = await modsRes.json();

    const traitsJson = await traitsRes.json();

    // Accept either:
    // 1) [{id,name,desc}, ...]
    // 2) {"hover":{name,desc}, ...}
    // 3) {"mountVehicleTraits": {...}}  (legacy)
    if (Array.isArray(traitsJson)) {
      TRAITS = Object.fromEntries(
        traitsJson
          .filter(t => t && t.id)
          .map(t => [t.id, { name: t.name || t.id, desc: t.desc || "" }])
      );
    } else if (traitsJson && typeof traitsJson === "object") {
      if (traitsJson.mountVehicleTraits && typeof traitsJson.mountVehicleTraits === "object") {
        TRAITS = traitsJson.mountVehicleTraits;
      } else {
        TRAITS = traitsJson;
      }
    } else {
      TRAITS = {};
    }

    init();
  } catch (e) {
    console.error("DATA LOAD ERROR:", e);
    const baseSelect = document.getElementById("baseSelect");
    if (baseSelect) baseSelect.innerHTML = `<option>(Failed to load data — check console)</option>`;
  }
}

/* ---------- INIT ---------- */

function init() {
  const select = document.getElementById("baseSelect");
  select.innerHTML = "";

  const allBases = [...mounts, ...vehicles];
  if (allBases.length === 0) {
    select.innerHTML = `<option>(No mounts/vehicles loaded)</option>`;
    return;
  }

  allBases.forEach(b => {
    select.innerHTML += `<option value="${b.id}">${b.name} (${b.type})</option>`;
  });

  select.onchange = () => selectBase(select.value);
  selectBase(allBases[0].id);
  render();
}

/* ---------- BASE SELECTION ---------- */

function selectBase(id) {
  config.mount = mounts.find(m => m.id === id) || null;
  config.vehicle = vehicles.find(v => v.id === id) || null;
  config.base = config.mount || config.vehicle;

  if (config.vehicle) config.saddle = null;

  config.mounts = {};
  config.proficiencies = {};
  config.crewStats = {};
  config.mods = [];

  const saddleSection = document.getElementById("saddleSection");
  if (saddleSection) saddleSection.style.display = config.mount ? "block" : "none";

  if (config.mount) setupMount();
  else setupVehicle();

  setupModsUI();
  render();
}

/* ---------- MOUNTS ---------- */

function setupMount() {
  const saddleSelect = document.getElementById("saddleSelect");
  if (!saddleSelect) return;

  saddleSelect.innerHTML = "";
  const mountTags = config.mount.tags || [];

  let validSaddles = saddles
    .filter(s => (s.allowedSizes || []).includes(config.mount.size))
    .filter(s => {
      const hasIds = Array.isArray(s.allowedMountIds) && s.allowedMountIds.length > 0;
      const hasTags = Array.isArray(s.allowedMountTags) && s.allowedMountTags.length > 0;
      if (!hasIds && !hasTags) return true;
      const byIdOk = hasIds && s.allowedMountIds.includes(config.mount.id);
      const byTagOk = hasTags && s.allowedMountTags.some(t => mountTags.includes(t));
      return byIdOk || byTagOk;
    });

  // Hard restriction: tentacles/limbs (NO_saddle-only mounts) may only use the NO_saddle saddle.
  if (isNoSaddleOnlyMount(config.mount)) {
    validSaddles = saddles.filter(s => s.id === "NO_saddle");
  }

  if (validSaddles.length === 0) {
    saddleSelect.innerHTML = `<option value="">(No valid saddles)</option>`;
    config.saddle = null;

    const weaponsUI = document.getElementById("weaponsUI");
    if (weaponsUI) weaponsUI.innerHTML = "<em>No saddle available for this mount.</em>";

    const crewUI = document.getElementById("crewUI");
    if (crewUI) crewUI.innerHTML = "";

    render();
    return;
  }

  validSaddles.forEach(s => {
    saddleSelect.innerHTML += `<option value="${s.id}">${s.name}</option>`;
  });

  saddleSelect.onchange = () => {
    selectSaddle(saddleSelect.value);
    setupModsUI();
    render();
  };

  selectSaddle(validSaddles[0].id);
  setupModsUI();
  render();
}

function selectSaddle(id) {
  config.saddle = saddles.find(s => s.id === id) || null;
  if (!config.saddle) return;

  setupCrewUI(getCrewGroups());
  setupWeapons(getDerivedMountingPoints());
}

/* ---------- VEHICLES ---------- */

function setupVehicle() {
  setupCrewUI(getCrewGroups());
  setupWeapons(getDerivedMountingPoints());
}

/* ---------- CREW ---------- */

function getCrewGroups() {
  // Vehicles can define their own crew groups
  if (config.vehicle && Array.isArray(config.vehicle.crewGroups) && config.vehicle.crewGroups.length) {
    return config.vehicle.crewGroups;
  }
  // Saddles can define their own crew groups; if the array is empty, fall back safely
  if (config.saddle && Array.isArray(config.saddle.crewGroups) && config.saddle.crewGroups.length) {
    return config.saddle.crewGroups;
  }
  return [{ id: "operator", label: "Operator" }];
}

function setupCrewUI(groups) {
  const crewUI = document.getElementById("crewUI");
  if (!crewUI) return;

  crewUI.innerHTML = "";

  groups.forEach(g => {
    if (!config.crewStats[g.id]) config.crewStats[g.id] = { dexMod: 0, profBonus: 0 };

    crewUI.innerHTML += `
      <strong>${g.label}</strong><br>
      DEX modifier:
      <input type="number" value="${config.crewStats[g.id].dexMod}" style="width:80px"
        onchange="setCrewDex('${g.id}', this.value)">
      Proficiency bonus:
      <input type="number" value="${config.crewStats[g.id].profBonus}" style="width:80px"
        onchange="setCrewPB('${g.id}', this.value)">
      <br><br>
    `;
  });
}

function setCrewDex(groupId, val) {
  config.crewStats[groupId] = config.crewStats[groupId] || { dexMod: 0, profBonus: 0 };
  config.crewStats[groupId].dexMod = +val;
  render();
}

function setCrewPB(groupId, val) {
  config.crewStats[groupId] = config.crewStats[groupId] || { dexMod: 0, profBonus: 0 };
  config.crewStats[groupId].profBonus = +val;
  render();
}

/* ---------- MODS ---------- */

function baseKind() { return config.vehicle ? "Vehicle" : "Mount"; }
function baseTags() { return (config.mount?.tags || config.vehicle?.tags || []); }
function baseId() { return config.base?.id || ""; }

function modById(id) {
  return mods.find(m => m.id === id) || null;
}

function isModAllowed(mod) {
  if (!mod) return false;
  const req = mod.requires || {};

  if (Array.isArray(req.baseType) && req.baseType.length) {
    if (!req.baseType.includes(baseKind())) return false;
  }
  if (Array.isArray(req.ids) && req.ids.length) {
    if (!req.ids.includes(baseId())) return false;
  }
  if (Array.isArray(req.tags) && req.tags.length) {
    const tags = baseTags();
    if (!req.tags.some(t => tags.includes(t))) return false;
  }
  return true;
}

function setupModsUI() {
  const modsSection = document.getElementById("modsSection");
  const modsSelect = document.getElementById("modsSelect");
  const modsList = document.getElementById("modsList");

  if (!modsSection || !modsSelect || !modsList) return;

  modsSection.style.display = "block";
  modsSelect.innerHTML = "";

  const available = mods.filter(isModAllowed);
  if (available.length === 0) {
    modsSelect.innerHTML = `<option value="">(No mods available)</option>`;
  } else {
    available.forEach(m => {
      modsSelect.innerHTML += `<option value="${m.id}">${m.name} (${m.points || 0} pts)</option>`;
    });
  }

  renderModsList();
  setupWeapons(getDerivedMountingPoints());
}

function addSelectedMod() {
  const sel = document.getElementById("modsSelect");
  if (!sel || !sel.value) return;

  const id = sel.value;
  if (config.mods.includes(id)) return;

  config.mods.push(id);
  renderModsList();
  setupWeapons(getDerivedMountingPoints());
  render();
}

function removeMod(id) {
  config.mods = config.mods.filter(x => x !== id);
  renderModsList();
  setupWeapons(getDerivedMountingPoints());
  render();
}

function renderModsList() {
  const modsList = document.getElementById("modsList");
  if (!modsList) return;

  if (!config.mods.length) {
    modsList.innerHTML = `<em>No mods selected.</em>`;
    return;
  }

  modsList.innerHTML = config.mods
    .map(id => {
      const m = modById(id);
      if (!m) return "";
      return `
        <div style="margin-bottom:6px;">
          <strong>${m.name}</strong> (${m.points || 0} pts)
          <button onclick="removeMod('${m.id}')" style="margin-left:8px;">Remove</button>
          ${m.desc ? `<div style="font-size:0.9em; opacity:0.9;">${m.desc}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

function applyModsToBase(base) {
  const b = JSON.parse(JSON.stringify(base || {}));
  b.traits = Array.isArray(b.traits) ? [...b.traits] : [];

  // Preserve movement blocks if present
  for (const mode of ["fly", "ground", "swim", "burrow", "climb"]) {
    if (hasMoveBlock(b[mode])) {
      b[mode] = { standard: +b[mode].standard || 0, max: +b[mode].max || 0 };
    }
  }

  // Preserve optional weapon allowlist if present
  if (Array.isArray(b.weaponAllowlist)) b.weaponAllowlist = [...b.weaponAllowlist];

  for (const id of config.mods) {
    const m = modById(id);
    if (!m || !isModAllowed(m)) continue;
    const fx = m.effects || {};

    if (Array.isArray(fx.addTraits)) {
      for (const t of fx.addTraits) if (t && !b.traits.includes(t)) b.traits.push(t);
    }

    if (fx.statBonuses && typeof fx.statBonuses === "object") {
      for (const k of Object.keys(fx.statBonuses)) {
        const delta = +fx.statBonuses[k];
        if (!Number.isFinite(delta)) continue;
        b[k] = (Number(b[k]) || 0) + delta;
      }
    }

    // Existing: flyBonus
    if (fx.flyBonus && typeof fx.flyBonus === "object") {
      if (!hasMoveBlock(b.fly)) b.fly = { standard: 0, max: 0 };
      if (Number.isFinite(+fx.flyBonus.standard)) b.fly.standard = (b.fly.standard || 0) + (+fx.flyBonus.standard);
      if (Number.isFinite(+fx.flyBonus.max)) b.fly.max = (b.fly.max || 0) + (+fx.flyBonus.max);
    }

    // Existing: groundBonus
    if (fx.groundBonus && typeof fx.groundBonus === "object") {
      if (!hasMoveBlock(b.ground)) b.ground = { standard: 0, max: 0 };
      if (Number.isFinite(+fx.groundBonus.standard)) b.ground.standard = (b.ground.standard || 0) + (+fx.groundBonus.standard);
      if (Number.isFinite(+fx.groundBonus.max)) b.ground.max = (b.ground.max || 0) + (+fx.groundBonus.max);
    }

    // Optional: swimBonus / burrowBonus / climbBonus (safe even if you don’t use them yet)
    if (fx.swimBonus && typeof fx.swimBonus === "object") {
      if (!hasMoveBlock(b.swim)) b.swim = { standard: 0, max: 0 };
      if (Number.isFinite(+fx.swimBonus.standard)) b.swim.standard = (b.swim.standard || 0) + (+fx.swimBonus.standard);
      if (Number.isFinite(+fx.swimBonus.max)) b.swim.max = (b.swim.max || 0) + (+fx.swimBonus.max);
    }
    if (fx.burrowBonus && typeof fx.burrowBonus === "object") {
      if (!hasMoveBlock(b.burrow)) b.burrow = { standard: 0, max: 0 };
      if (Number.isFinite(+fx.burrowBonus.standard)) b.burrow.standard = (b.burrow.standard || 0) + (+fx.burrowBonus.standard);
      if (Number.isFinite(+fx.burrowBonus.max)) b.burrow.max = (b.burrow.max || 0) + (+fx.burrowBonus.max);
    }
    if (fx.climbBonus && typeof fx.climbBonus === "object") {
      if (!hasMoveBlock(b.climb)) b.climb = { standard: 0, max: 0 };
      if (Number.isFinite(+fx.climbBonus.standard)) b.climb.standard = (b.climb.standard || 0) + (+fx.climbBonus.standard);
      if (Number.isFinite(+fx.climbBonus.max)) b.climb.max = (b.climb.max || 0) + (+fx.climbBonus.max);
    }

    if (fx.set && typeof fx.set === "object") {
      for (const k of Object.keys(fx.set)) b[k] = fx.set[k];
    }
  }

  return b;
}

function getDerivedBase() {
  return applyModsToBase(config.base);
}

function getDerivedMountingPoints() {
  let points = [];
  if (config.vehicle) points = (config.vehicle.mountingPoints || []).map(p => ({ ...p }));
  else if (config.saddle) points = (config.saddle.mountingPoints || []).map(p => ({ ...p }));

  for (const id of config.mods) {
    const m = modById(id);
    if (!m || !isModAllowed(m)) continue;
    const add = m.effects?.addMountingPoints;
    if (Array.isArray(add)) {
      for (const mp of add) {
        if (!mp || !mp.id) continue;
        const uniqueId = points.some(p => p.id === mp.id) ? `${mp.id}_${m.id}` : mp.id;
        points.push({ ...mp, id: uniqueId });
      }
    }
  }

  return points;
}

/* ---------- WEAPONS ---------- */

function weaponById(id) {
  return weapons.find(w => w.id === id) || null;
}

function maxQtyFor(mpSize, weaponSize) {
  const mpUnits = SIZE_UNITS[mpSize] ?? 0;
  const wUnits = SIZE_UNITS[weaponSize] ?? 999;
  if (mpUnits === 0 || wUnits === 0) return 0;
  return Math.floor(mpUnits / wUnits);
}


// Weapon kind support (ranged vs melee mounted weapons)
// - Weapons are considered "melee" if attackType/type === "melee" OR they define a "reach" field.
// - Mounting points can restrict what they accept via mp.weaponType:
//     "ranged" (default), "melee", or "both".
// - Melee mounted weapons DO NOT use the size-division quantity rule; they are always max 1 per mount (if they fit).

function weaponKind(w) {
  if (!w) return "ranged";
  const at = String(w.attackType || w.type || "").toLowerCase();
  if (at === "melee") return "melee";
  if (w.reach) return "melee";
  return "ranged";
}

function mountWeaponTypes(mp) {
  const t = mp && mp.weaponType !== undefined ? mp.weaponType : "ranged";
  if (Array.isArray(t)) return t.map(x => String(x).toLowerCase());
  const s = String(t).toLowerCase();
  return s === "both" ? ["melee", "ranged"] : [s];
}

function isWeaponCompatible(mp, w) {
  const mpTypes = mountWeaponTypes(mp);
  const wk = weaponKind(w);
  return mpTypes.includes(wk);
}

function maxQtyForMount(mp, w) {
  // Melee mounted weapons: max 1 per mount, as long as they fit (size <= mount size)
  if (weaponKind(w) === "melee") {
    const mpUnits = SIZE_UNITS[mp.size] ?? 0;
    const wUnits = SIZE_UNITS[w.size] ?? 999;
    return (mpUnits >= wUnits) ? 1 : 0;
  }
  // Ranged (legacy behavior): can subdivide by size
  return maxQtyFor(mp.size, w.size);
}


function setupWeapons(mountingPoints) {
  const ui = document.getElementById("weaponsUI");
  if (!ui) return;
  ui.innerHTML = "";

  // Enforce allowlist whenever we rebuild the UI (mods/base changes, etc.)
  sanitizeIllegalSelections();

  const allow = getWeaponAllowlist();

  mountingPoints.forEach(mp => {
    if (!config.mounts[mp.id]) config.mounts[mp.id] = { weaponId: "none", qty: 0 };
    if (config.proficiencies[mp.id] === undefined) config.proficiencies[mp.id] = false;

    const fittingWeapons = weapons
      .filter(w => maxQtyForMount(mp, w) >= 1)
      .filter(w => isWeaponCompatible(mp, w))
      .filter(w => !allow || allow.includes(w.id));

    const weaponOptions = fittingWeapons
      .map(w => `<option value="${w.id}" ${config.mounts[mp.id].weaponId === w.id ? "selected" : ""}>${w.name} (${w.points || 0} pts)</option>`)
      .join("");

    const currentWeapon = weaponById(config.mounts[mp.id].weaponId);
    let qtyOptions = `<option value="0">0</option>`;

    // If current selection is illegal under allowlist, clear it
    if (currentWeapon && currentWeapon.id !== "none" && !isWeaponAllowed(currentWeapon.id)) {
      config.mounts[mp.id].weaponId = "none";
      config.mounts[mp.id].qty = 0;
    }

    const refreshedWeapon = weaponById(config.mounts[mp.id].weaponId);

    if (refreshedWeapon && refreshedWeapon.id !== "none") {
      const maxQ = maxQtyForMount(mp, refreshedWeapon);
      if (config.mounts[mp.id].qty > maxQ) config.mounts[mp.id].qty = maxQ;
      if (config.mounts[mp.id].qty === 0) config.mounts[mp.id].qty = 1;

      qtyOptions = Array.from({ length: maxQ + 1 }, (_, i) =>
        `<option value="${i}" ${config.mounts[mp.id].qty === i ? "selected" : ""}>${i}</option>`
      ).join("");
    }

    const crewGroups = getCrewGroups();
    const crewGroupId = mp.crewGroup || crewGroups[0].id;
    const crewGroupLabel = (crewGroups.find(g => g.id === crewGroupId) || crewGroups[0]).label;

    const restrictionNote = allow
      ? `<div style="font-size:0.9em; opacity:0.85;"><em>Restricted Loadout:</em> this platform can only equip specific ordnance.</div>`
      : "";

    ui.innerHTML += `
      <strong>${mp.label} (${mp.arc})</strong><br>
      Crew: <em>${crewGroupLabel}</em><br>
      Weapon:
      <select onchange="setMountWeapon('${mp.id}', this.value)">
        <option value="none">— None —</option>
        ${weaponOptions}
      </select>
      Quantity:
      <select onchange="setMountQty('${mp.id}', this.value)">
        ${qtyOptions}
      </select><br>
      Proficiency:
      <select onchange="setProf('${mp.id}', this.value)">
        <option value="no" ${config.proficiencies[mp.id] ? "" : "selected"}>Not Proficient</option>
        <option value="yes" ${config.proficiencies[mp.id] ? "selected" : ""}>Proficient</option>
      </select>
      ${restrictionNote}
      <br><br>
    `;
  });
}

function setMountWeapon(slot, weaponId) {
  // Hard block: don’t allow selecting non-allowlisted weapons
  if (weaponId !== "none" && !isWeaponAllowed(weaponId)) {
    alert("That weapon cannot be equipped on this platform.");
    setupWeapons(getDerivedMountingPoints());
    return;
  }

  config.mounts[slot] = config.mounts[slot] || { weaponId: "none", qty: 0 };
  config.mounts[slot].weaponId = weaponId;

  if (weaponId === "none") config.mounts[slot].qty = 0;
  else config.mounts[slot].qty = Math.max(1, config.mounts[slot].qty || 1);

  setupWeapons(getDerivedMountingPoints());
  render();
}

function setMountQty(slot, qty) {
  config.mounts[slot] = config.mounts[slot] || { weaponId: "none", qty: 0 };
  config.mounts[slot].qty = +qty;
  render();
}

function setProf(slot, value) {
  config.proficiencies[slot] = (value === "yes");
  render();
}

/* ---------- WEIGHT ---------- */

function loadWeight() {
  let total = 0;
  if (config.saddle) total += (config.saddle.weight || 0);

  Object.values(config.mounts).forEach(sel => {
    const w = weaponById(sel.weaponId);
    if (!w || w.id === "none") return;
    total += (w.weight || 0) * (sel.qty || 0);
  });

  return total;
}

/* ---------- POINT COST ---------- */

function totalPoints() {
  let total = 0;
  if (config.base) total += (config.base.points || 0);
  if (config.saddle) total += (config.saddle.points || 0);

  for (const id of config.mods) {
    const m = modById(id);
    if (m) total += (m.points || 0);
  }

  Object.values(config.mounts).forEach(sel => {
    const w = weaponById(sel.weaponId);
    if (!w || w.id === "none") return;
    total += (w.points || 0) * (sel.qty || 0);
  });

  return total;
}

/* ---------- ENCUMBRANCE (single source of truth) ---------- */

function derivedEncumbrance(base) {
  const payload = loadWeight();
  const cap = capacity(base);

  let agility = base.agility;

  const mode = getMovementMode(base);
  const move = getMovementBlock(base, mode);
  let maxSpeed = move.max ?? 0;

  let enc = "Normal";

  if (payload > cap * 0.5) {
    enc = "Encumbered";
    agility = Math.ceil((base.agility || 0) / 2);
  }
  if (payload > cap) {
    enc = "Heavily Encumbered";
    maxSpeed = Math.max(0, (maxSpeed || 0) - 20);
  }
  if (payload > cap * 1.5) enc = "Overloaded";

  return { payload, cap, agility, maxSpeed, enc, moveMode: mode };
}

/* ---------- ACTION RENDERER ---------- */

function renderNativeAction(a) {
  if (!a || !a.name) return "";

  if (a.kind === "attack") {
    let out = `<strong>${a.name}.</strong> `;
    const label = (a.attackType === "ranged" || a.type === "ranged") ? "Ranged Weapon Attack" : "Melee Weapon Attack";
    out += `${label}: +${a.toHit} to hit, `;
    if (a.reach) out += `reach ${a.reach}, `;
    if (a.range) out += `range ${a.range}, `;
    out += `${a.target || "one target"}. `;
    out += `<em>Hit:</em> ${a.damage || "—"}`;
    if (a.extra) out += ` ${a.extra}`;
    if (a.notes) out += ` ${a.notes}`;
    return out + `<br>`;
  }

  if (a.kind === "save") {
    let out = `<strong>${a.name}.</strong> `;
    if (a.range) out += `Range ${a.range}. `;
    if (a.area) out += `Area ${a.area}. `;

    const abil = a.save?.ability || "—";
    const dc = a.save?.dc ?? "—";
    out += `Each target must make a DC ${dc} ${abil} saving throw. `;

    const fmtOutcome = (x, fallback) => {
      if (!x) return fallback;
      if (typeof x === "string") return x;
      let parts = [];
      if (x.damage) parts.push(x.damage === "half" ? "half damage" : x.damage);
      if (x.condition) parts.push(x.condition);
      if (x.effect) parts.push(x.effect);
      return parts.length ? parts.join(", ") : fallback;
    };

    out += `<em>Failure:</em> ${fmtOutcome(a.onFail, "—")}. `;
    out += `<em>Success:</em> ${fmtOutcome(a.onSave, "—")}. `;
    if (a.notes) out += `${a.notes}`;
    return out + `<br>`;
  }

  return `<strong>${a.name}.</strong> ${a.text || ""}<br>`;
}

function renderActionSection(title, list) {
  if (!Array.isArray(list) || list.length === 0) return "";
  let out = `<strong>${title}</strong><br>`;
  for (const a of list) out += renderNativeAction(a);
  out += `<br>`;
  return out;
}

/* ---------- RENDER (uses derivedEncumbrance) ---------- */

function render() {
  if (!config.base) return;

  const derived = getDerivedBase();
  const enc = derivedEncumbrance(derived);
  const pts = totalPoints();

  const agilityWarning = (enc.enc === "Encumbered") ? "⚠ Agility halved due to load" : null;

  const mode = enc.moveMode;
  const primaryMove = getMovementBlock(derived, mode);

  // NEW: show all movement modes if present (fly/swim/ground/burrow/climb)
  const speedLines = [];
  if (mode !== "none") {
    speedLines.push(
      `<strong>Speed</strong> ${mode} ${primaryMove.standard ?? 0} ft. (max ${enc.maxSpeed} ft.)`
    );
  } else {
    speedLines.push(`<strong>Speed</strong> —`);
  }

  const extraModes = ["fly", "swim", "ground", "burrow", "climb"].filter(m => m !== mode);
  for (const m of extraModes) {
    if (hasMoveBlock(derived[m])) {
      const blk = getMovementBlock(derived, m);
      speedLines.push(`<strong>${traitLabel(m)}</strong> ${blk.standard} ft. (max ${blk.max} ft.)`);
    }
  }

  let html = `
    <h2>${derived.name}</h2>
    <em>${derived.size} ${derived.type}</em><br>
    <strong>Point Cost</strong> ${pts} pts
    <hr>

    <strong>Armor Class</strong> ${derived.baseAC}<br>
    <strong>Hit Points</strong> ${derived.baseHP}<br>
    ${speedLines.join("<br>")}<br>
    <strong>Climb Rate</strong> ${derived.climbRate ?? "—"}<br>
    <strong>Acceleration</strong> ${derived.acceleration ?? "—"}<br>

    <hr>

    STR ${derived.strength} (${abilityMod(derived.strength)})
    DEX ${derived.dex} (${abilityMod(derived.dex)})
    CON ${derived.con} (${abilityMod(derived.con)})

    <hr>

    <strong>Agility</strong> ${enc.agility}
    ${agilityWarning ? `<br><strong>${agilityWarning}</strong>` : ""}<br>
    <strong>Encumbrance</strong> ${enc.enc} (${enc.payload} / ${enc.cap} lb)
    <hr>
  `;

  /* ===== CREW STATS ON PRINTED SHEET ===== */
  const crewGroups = getCrewGroups();
  if (!config.crewStats) config.crewStats = {};
  html += `<strong>Crew</strong><br>`;
  crewGroups.forEach(g => {
    const crew = config.crewStats[g.id] || { dexMod: 0, profBonus: 0 };
    const dexMod = Number.isFinite(+crew.dexMod) ? +crew.dexMod : 0;
    const pb = Number.isFinite(+crew.profBonus) ? +crew.profBonus : 0;
    html += `
      <strong>${g.label}</strong>: DEX mod ${dexMod >= 0 ? "+" : ""}${dexMod}, PB ${pb >= 0 ? "+" : ""}${pb}<br>
    `;
  });
  html += `<hr>`;
  /* ===== END CREW SECTION ===== */

  html += renderActionSection("Actions", derived.actions);
  html += renderActionSection("Bonus Actions", derived.bonusActions);
  html += renderActionSection("Reactions", derived.reactions);
  html += renderActionSection("Legendary Actions", derived.legendaryActions);

  // Mounted weapons
  html += `<strong>Mounted Weapons</strong><br>`;
  const points = getDerivedMountingPoints();
  const groups = getCrewGroups();

  for (let mp of points) {
    const sel = config.mounts[mp.id] || { weaponId: "none", qty: 0 };
    const w = weaponById(sel.weaponId);
    if (!w || w.id === "none" || !sel.qty) continue;

    const crewGroupId = mp.crewGroup || groups[0].id;
    const crew = config.crewStats[crewGroupId] || { dexMod: 0, profBonus: 0 };
    const proficient = !!config.proficiencies[mp.id];

    // Ranged mounted weapons use crew DEX; melee mounted weapons use the platform STR (natural-attack convention).
    const wk = weaponKind(w);
    const ability = (wk === "melee") ? "str" : "dex";
    const abilityBonus = (wk === "melee") ? abilityMod(derived.strength) : (crew.dexMod || 0);

    const atk = abilityBonus + (proficient ? (crew.profBonus || 0) : 0);

    const traitsText = Array.isArray(w.traits) && w.traits.length
      ? w.traits.map(traitLabel).join(", ")
      : "—";

    html += `
      <strong>${w.name}</strong> ×${sel.qty} (${mp.arc})<br>
      Attack: +${atk} to hit<br>
      Hit: ${w.damage}<br>
      ${wk === "melee" ? ("Reach: " + (w.reach || "5 ft")) : ("Range: " + (w.range || "—"))}<br>
      Traits: ${traitsText}<br>
      Points: ${(w.points || 0) * sel.qty} pts<br><br>
    `;
  }

  // Traits (with descriptions)
  if (Array.isArray(derived.traits) && derived.traits.length) {
    html += `<hr><strong>Traits</strong><br>`;
    derived.traits.forEach(t => {
      const tr = TRAITS[t];
      if (tr) html += `<strong>${tr.name}.</strong> ${tr.desc}<br>`;
      else html += `<strong>${traitLabel(t)}.</strong><br>`;
    });
  }

  const statblock = document.getElementById("statblock");
  if (statblock) statblock.innerHTML = html;
}

/* ---------- ROLL20 EXPORTER ---------- */

function exportModObjects(modIds) {
  if (!Array.isArray(modIds)) return [];
  return modIds
    .filter(Boolean)
    .map(id => {
      const m = modById(id);
      return { id, name: m?.name || id, desc: m?.desc || "" };
    });
}

function exportTraitObjects(traitIds) {
  if (!Array.isArray(traitIds)) return [];
  return traitIds
    .filter(Boolean)
    .map(id => {
      const tr = TRAITS?.[id];
      return { id, name: tr?.name || traitLabel(id), desc: tr?.desc || "" };
    });
}

function buildRoll20Export() {
  const base = getDerivedBase(); // mods applied
  const enc = derivedEncumbrance(base); // single source of truth for agility/speed
  const points = getDerivedMountingPoints();
  const groups = getCrewGroups();

  const mountedWeapons = [];
  for (const mp of points) {
    const sel = config.mounts[mp.id] || { weaponId: "none", qty: 0 };
    if (!sel.qty || sel.weaponId === "none") continue;

    // Fail-safe: don't export illegal selections
    if (!isWeaponAllowed(sel.weaponId)) continue;

    const w = weaponById(sel.weaponId);
    if (!w) continue;

    const crewGroupId = mp.crewGroup || groups[0].id;
    const crew = config.crewStats[crewGroupId] || { dexMod: 0, profBonus: 0 };
    const proficient = !!config.proficiencies[mp.id];
    const atk = (crew.dexMod || 0) + (proficient ? (crew.profBonus || 0) : 0);

    mountedWeapons.push({
      mountPointId: mp.id,
      mountPointLabel: mp.label,
      crewGroupId,
      name: w.name,
      weaponId: w.id,
      qty: sel.qty,
      arc: mp.arc,

      attackType: wk,          // "ranged" or "melee"
      ability,                 // "dex" or "str"
      attackBonus: atk,

      damage: w.damage,
      range: (wk === "ranged") ? (w.range || "") : "",
      reach: (wk === "melee") ? (w.reach || "5 ft") : "",

      target: w.target || "one target",
      extra: w.extra || "",
      traits: Array.isArray(w.traits) ? w.traits : []
    });
  }

  // Export movement for all modes:
  const mode = enc.moveMode;
  const primary = getMovementBlock(base, mode);

  // For the primary mode, use enc.maxSpeed (encumbrance-adjusted)
  const primaryMaxAdjusted = (mode !== "none") ? enc.maxSpeed : 0;

  const fly    = hasMoveBlock(base.fly)    ? getMovementBlock(base, "fly")    : { standard: 0, max: 0 };
  const ground = hasMoveBlock(base.ground) ? getMovementBlock(base, "ground") : { standard: 0, max: 0 };
  const swim   = hasMoveBlock(base.swim)   ? getMovementBlock(base, "swim")   : { standard: 0, max: 0 };
  const burrow = hasMoveBlock(base.burrow) ? getMovementBlock(base, "burrow") : { standard: 0, max: 0 };
  const climb  = hasMoveBlock(base.climb)  ? getMovementBlock(base, "climb")  : { standard: 0, max: 0 };

  return {
    schema: "flying-combat-config-v1",

    baseId: config.base?.id || "",
    baseName: base.name,
    baseType: base.type,
    baseSize: base.size,

    saddleId: config.saddle?.id || null,
    modIds: [...config.mods],
    mods: exportModObjects(config.mods),

    stats: {
      ac: base.baseAC,
      hp: base.baseHP,
      str: base.strength,
      dex: base.dex,
      con: base.con,
      agility: enc.agility
    },

    movement: {
      mode,
      standard: primary.standard ?? 0,
      max: primaryMaxAdjusted,

      // modes (with *_max). Primary mode gets encumbrance-adjusted max.
      fly: fly.standard ?? 0,
      fly_max: (mode === "fly") ? primaryMaxAdjusted : (fly.max ?? 0),

      ground: ground.standard ?? 0,
      ground_max: (mode === "ground") ? primaryMaxAdjusted : (ground.max ?? 0),

      swim: swim.standard ?? 0,
      swim_max: (mode === "swim") ? primaryMaxAdjusted : (swim.max ?? 0),

      burrow: burrow.standard ?? 0,
      burrow_max: (mode === "burrow") ? primaryMaxAdjusted : (burrow.max ?? 0),

      climb: climb.standard ?? 0,
      climb_max: (mode === "climb") ? primaryMaxAdjusted : (climb.max ?? 0),

      climb_rate: base.climbRate ?? "—",
      acceleration: base.acceleration ?? "—"
    },

    encumbrance: {
      carried_weight: enc.payload,
      capacity: enc.cap,
      state: enc.enc
    },

    weaponAllowlist: Array.isArray(base.weaponAllowlist) ? [...base.weaponAllowlist] : null,

    traits: exportTraitObjects(base.traits),

    actions: (() => {
      const list = Array.isArray(base.actions) ? [...base.actions] : [];
      const acc = (base.acceleration ?? '').toString().trim();
      if (acc) {
        // Export acceleration as a rollable Roll20 action (kept as a statline in the web renderer)
        list.push({ name: 'Acceleration', kind: 'text', text: `Acceleration: [[${acc}]]` });
      }
      return list;
    })(),
    bonusActions: Array.isArray(base.bonusActions) ? base.bonusActions : [],
    reactions: Array.isArray(base.reactions) ? base.reactions : [],
    legendaryActions: Array.isArray(base.legendaryActions) ? base.legendaryActions : [],

    mountedWeapons,

    crewStats: JSON.parse(JSON.stringify(config.crewStats || {})),
    proficiencies: JSON.parse(JSON.stringify(config.proficiencies || {}))
  };
}

async function exportRoll20JSON() {
  const payload = buildRoll20Export();
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  alert("Roll20 export JSON copied to clipboard!");
}

/* ---------- START ---------- */

loadData();
