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

/* ---------- WEAPON RESTRICTIONS (BASE + MOUNTPOINT) ---------- */

/**
 * If the derived base (vehicle/mount) has `weaponAllowlist: ["id1","id2",...]`,
 * only those weapon ids may be selected on any mounting point (unless a mountpoint has its own allowlist).
 *
 * If a mounting point has `weaponAllowlist: [...]`, that list OVERRIDES the base list for that point.
 */
function getBaseWeaponAllowlist() {
  const derived = getDerivedBase?.() || config.base || {};
  const list = derived.weaponAllowlist;
  return Array.isArray(list) && list.length ? list : null;
}

function getMountpointWeaponAllowlist(mp) {
  const list = mp?.weaponAllowlist;
  return Array.isArray(list) && list.length ? list : null;
}

/**
 * Returns the effective allowlist for a specific mounting point:
 * 1) mp.weaponAllowlist (if present)
 * 2) base.weaponAllowlist (if present)
 * 3) null (no restriction)
 */
function getEffectiveWeaponAllowlist(mp) {
  return getMountpointWeaponAllowlist(mp) || getBaseWeaponAllowlist();
}

function isWeaponAllowedOnMountpoint(weaponId, mp) {
  const allow = getEffectiveWeaponAllowlist(mp);
  if (!allow) return true;
  return allow.includes(weaponId);
}

/**
 * Clears any illegal selections whenever we rebuild the UI (mods/base changes, etc.)
 * Uses the CURRENT derived mounting points so per-mountpoint allowlists are respected.
 */
function sanitizeIllegalSelections(mountingPoints) {
  const points = Array.isArray(mountingPoints) ? mountingPoints : [];
  const mpById = Object.fromEntries(points.map(p => [p.id, p]));

  for (const slot of Object.keys(config.mounts || {})) {
    const sel = config.mounts[slot];
    if (!sel) continue;

    const mp = mpById[slot] || null;
    const wid = sel.weaponId;

    if (wid && wid !== "none" && !isWeaponAllowedOnMountpoint(wid, mp)) {
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

    // Optional: swimBonus / burrowBonus / climbBonus
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

  // Enforce allowlists whenever we rebuild the UI (mods/base changes, etc.)
  sanitizeIllegalSelections(mountingPoints);

  const baseAllow = getBaseWeaponAllowlist();

  mountingPoints.forEach(mp => {
    if (!config.mounts[mp.id]) config.mounts[mp.id] = { weaponId: "none", qty: 0 };
    if (config.proficiencies[mp.id] === undefined) config.proficiencies[mp.id] = false;

    const effAllow = getEffectiveWeaponAllowlist(mp);

    const fittingWeapons = weapons
      .filter(w => maxQtyForMount(mp, w) >= 1)
      .filter(w => isWeaponCompatible(mp, w))
      .filter(w => !effAllow || effAllow.includes(w.id));

    const weaponOptions = fittingWeapons
      .map(w => `<option value="${w.id}" ${config.mounts[mp.id].weaponId === w.id ? "selected" : ""}>${w.name} (${w.points || 0} pts)</option>`)
      .join("");

    // If current selection is illegal under effective allowlist, clear it
    const currentWeapon = weaponById(config.mounts[mp.id].weaponId);
    if (currentWeapon && currentWeapon.id !== "none" && !isWeaponAllowedOnMountpoint(currentWeapon.id, mp)) {
      config.mounts[mp.id].weaponId = "none";
      config.mounts[mp.id].qty = 0;
      config.proficiencies[mp.id] = false;
    }

    const refreshedWeapon = weaponById(config.mounts[mp.id].weaponId);

    let qtyOptions = `<option value="0">0</option>`;
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

    const restrictionNote = effAllow
      ? `<div style="font-size:0.9em; opacity:0.85;"><em>Restricted Loadout:</em> this mounting point can only equip specific weapons/ordnance.</div>`
      : "";

    const baseRestrictionNote = (!effAllow && baseAllow)
      ? `<div style="font-size:0.9em; opacity:0.85;"><em>Restricted Loadout:</em> this platform can only equip specific weapons/ordnance.</div>`
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
      ${restrictionNote || baseRestrictionNote}
      <br><br>
    `;
  });
}

function setMountWeapon(slot, weaponId) {
  const points = getDerivedMountingPoints();
  const mp = points.find(p => p.id === slot) || null;

  // Hard block: don’t allow selecting non-allowlisted weapons for THIS mountpoint
  if (weaponId !== "none" && !isWeaponAllowedOnMountpoint(weaponId, mp)) {
    alert("That weapon cannot be equipped on this mounting point.");
    setupWeapons(points);
    return;
  }

  config.mounts[slot] = config.mounts[slot] || { weaponId: "none", qty: 0 };
  config.mounts[slot].weaponId = weaponId;

  if (weaponId === "none") config.mounts[slot].qty = 0;
  else config.mounts[slot].qty = Math.max(1, config.mounts[slot].qty || 1);

  setupWeapons(points);
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

  return { payload, cap, agility, maxSpe
