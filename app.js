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
 * Movement helpers:
 * Supports bases that define:
 *  - fly:    {standard, max}
 *  - ground: {standard, max}
 * Can also support both at once.
 */
function hasMoveBlock(x) {
  return x && typeof x === "object" && Number.isFinite(+x.standard);
}

function getMovementMode(base) {
  // Prefer fly if present (matches existing flying-combat default behavior)
  if (hasMoveBlock(base?.fly)) return "fly";
  if (hasMoveBlock(base?.ground)) return "ground";
  return "none";
}

function getMovementBlock(base, mode) {
  if (!base) return { standard: 0, max: 0 };
  if (mode === "fly" && hasMoveBlock(base.fly)) {
    return { standard: +base.fly.standard || 0, max: +base.fly.max || 0 };
  }
  if (mode === "ground" && hasMoveBlock(base.ground)) {
    return { standard: +base.ground.standard || 0, max: +base.ground.max || 0 };
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

  const validSaddles = saddles
    .filter(s => (s.allowedSizes || []).includes(config.mount.size))
    .filter(s => {
      const hasIds = Array.isArray(s.allowedMountIds) && s.allowedMountIds.length > 0;
      const hasTags = Array.isArray(s.allowedMountTags) && s.allowedMountTags.length > 0;
      if (!hasIds && !hasTags) return true;
      const byIdOk = hasIds && s.allowedMountIds.includes(config.mount.id);
      const byTagOk = hasTags && s.allowedMountTags.some(t => mountTags.includes(t));
      return byIdOk || byTagOk;
    });

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
  if (config.vehicle && Array.isArray(config.vehicle.crewGroups)) return config.vehicle.crewGroups;
  if (config.saddle && Array.isArray(config.saddle.crewGroups)) return config.saddle.crewGroups;
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

  // Preserve movement blocks if present; do NOT force-create fly anymore.
  if (hasMoveBlock(b.fly)) b.fly = { standard: +b.fly.standard || 0, max: +b.fly.max || 0 };
  if (hasMoveBlock(b.ground)) b.ground = { standard: +b.ground.standard || 0, max: +b.ground.max || 0 };

  // Preserve optional weapon allowlist if present
  if (Array.isArray(b.weaponAllowlist)) b.weaponAllowlist = [...b.weaponAllowlist];

  for (const id of config.mods) {
    const m = modById(id);
    if (!m || !isModAllowed(m)) continue;
    const fx = m.effects || {};

    if (Array.isArray(fx.addTraits)) {
      for (const t of fx.addTraits) if (t && !b.traits.includes(t)) b.traits.push(t);
