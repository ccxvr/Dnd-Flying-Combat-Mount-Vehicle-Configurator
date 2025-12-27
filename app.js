let mounts = []
let vehicles = []
let saddles = []
let weapons = []
let mods = []
let TRAITS = {}

const SIZE_ORDER = ["XS", "S", "M", "L", "XL"]
const SIZE_UNITS = { XS: 1, S: 2, M: 4, L: 8, XL: 16 }

const SIZE_CAPACITY_MULT = {
  Tiny: 0.5,
  Small: 1,
  Medium: 1,
  Large: 2,
  Huge: 4,
  Gargantuan: 8
}

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
}

/* ---------- LOAD DATA ---------- */

async function loadData() {
  try {
    const mountsRes = await fetch("data/mounts.json"); if (!mountsRes.ok) throw new Error("mounts.json not found")
    const vehiclesRes = await fetch("data/vehicles.json"); if (!vehiclesRes.ok) throw new Error("vehicles.json not found")
    const saddlesRes = await fetch("data/saddles.json"); if (!saddlesRes.ok) throw new Error("saddles.json not found")
    const weaponsRes = await fetch("data/weapons.json"); if (!weaponsRes.ok) throw new Error("weapons.json not found")
    const traitsRes = await fetch("data/traits.json"); if (!traitsRes.ok) throw new Error("traits.json not found")
    const modsRes = await fetch("data/mods.json"); if (!modsRes.ok) throw new Error("mods.json not found")

    mounts = await mountsRes.json()
    vehicles = await vehiclesRes.json()
    saddles = await saddlesRes.json()
    weapons = await weaponsRes.json()
    mods = await modsRes.json()

    const traitsJson = await traitsRes.json()

    // Accept either:
    // 1) [{id,name,desc}, ...]
    // 2) {"hover":{name,desc}, ...}
    // 3) {"mountVehicleTraits": {...}}  (legacy)
    if (Array.isArray(traitsJson)) {
      TRAITS = Object.fromEntries(
        traitsJson
          .filter(t => t && t.id)
          .map(t => [t.id, { name: t.name || t.id, desc: t.desc || "" }])
      )
    } else if (traitsJson && typeof traitsJson === "object") {
      if (traitsJson.mountVehicleTraits && typeof traitsJson.mountVehicleTraits === "object") {
        TRAITS = traitsJson.mountVehicleTraits
      } else {
        TRAITS = traitsJson
      }
    } else {
      TRAITS = {}
    }

    init()
  } catch (e) {
    console.error("DATA LOAD ERROR:", e)
    const baseSelect = document.getElementById("baseSelect")
    if (baseSelect) baseSelect.innerHTML = `<option>(Failed to load data — check console)</option>`
  }
}

/* ---------- INIT ---------- */

function init() {
  const select = document.getElementById("baseSelect")
  select.innerHTML = ""

  const allBases = [...mounts, ...vehicles]
  if (allBases.length === 0) {
    select.innerHTML = `<option>(No mounts/vehicles loaded)</option>`
    return
  }

  allBases.forEach(b => {
    select.innerHTML += `<option value="${b.id}">${b.name} (${b.type})</option>`
  })

  select.onchange = () => selectBase(select.value)
  selectBase(allBases[0].id)
  render()
}

/* ---------- BASE SELECTION ---------- */

function selectBase(id) {
  config.mount = mounts.find(m => m.id === id) || null
  config.vehicle = vehicles.find(v => v.id === id) || null
  config.base = config.mount || config.vehicle

  if (config.vehicle) config.saddle = null

  config.mounts = {}
  config.proficiencies = {}
  config.crewStats = {}
  config.mods = []

  document.getElementById("saddleSection").style.display = config.mount ? "block" : "none"

  if (config.mount) setupMount()
  else setupVehicle()

  setupModsUI() // NEW
  render()
}

/* ---------- MOUNTS ---------- */

function setupMount() {
  const saddleSelect = document.getElementById("saddleSelect")
  saddleSelect.innerHTML = ""

  const mountTags = config.mount.tags || []

  const validSaddles = saddles
    .filter(s => (s.allowedSizes || []).includes(config.mount.size))
    .filter(s => {
      const hasIds = Array.isArray(s.allowedMountIds) && s.allowedMountIds.length > 0
      const hasTags = Array.isArray(s.allowedMountTags) && s.allowedMountTags.length > 0
      if (!hasIds && !hasTags) return true
      const byIdOk = hasIds && s.allowedMountIds.includes(config.mount.id)
      const byTagOk = hasTags && s.allowedMountTags.some(t => mountTags.includes(t))
      return byIdOk || byTagOk
    })

  if (validSaddles.length === 0) {
    saddleSelect.innerHTML = `<option value="">(No valid saddles)</option>`
    config.saddle = null
    document.getElementById("weaponsUI").innerHTML = "<em>No saddle available for this mount.</em>"
    document.getElementById("crewUI").innerHTML = ""
    render()
    return
  }

  validSaddles.forEach(s => {
    saddleSelect.innerHTML += `<option value="${s.id}">${s.name}</option>`
  })

  saddleSelect.onchange = () => {
    selectSaddle(saddleSelect.value)
    setupModsUI()
    render()
  }

  selectSaddle(validSaddles[0].id)
  setupModsUI()
  render()
}

function selectSaddle(id) {
  config.saddle = saddles.find(s => s.id === id) || null
  if (!config.saddle) return

  setupCrewUI(getCrewGroups())
  setupWeapons(getDerivedMountingPoints())
}

/* ---------- VEHICLES ---------- */

function setupVehicle() {
  setupCrewUI(getCrewGroups())
  setupWeapons(getDerivedMountingPoints())
}

/* ---------- CREW ---------- */

function getCrewGroups() {
  if (config.vehicle && Array.isArray(config.vehicle.crewGroups)) return config.vehicle.crewGroups
  if (config.saddle && Array.isArray(config.saddle.crewGroups)) return config.saddle.crewGroups
  return [{ id: "operator", label: "Operator" }]
}

function setupCrewUI(groups) {
  const crewUI = document.getElementById("crewUI")
  if (!crewUI) return

  crewUI.innerHTML = ""

  groups.forEach(g => {
    if (!config.crewStats[g.id]) config.crewStats[g.id] = { dexMod: 0, profBonus: 0 }

    crewUI.innerHTML += `
      <strong>${g.label}</strong><br>
      DEX modifier:
      <input type="number" value="${config.crewStats[g.id].dexMod}" style="width:80px"
        onchange="setCrewDex('${g.id}', this.value)">
      Proficiency bonus:
      <input type="number" value="${config.crewStats[g.id].profBonus}" style="width:80px"
        onchange="setCrewPB('${g.id}', this.value)">
      <br><br>
    `
  })
}

function setCrewDex(groupId, val) {
  config.crewStats[groupId] = config.crewStats[groupId] || { dexMod: 0, profBonus: 0 }
  config.crewStats[groupId].dexMod = +val
  render()
}

function setCrewPB(groupId, val) {
  config.crewStats[groupId] = config.crewStats[groupId] || { dexMod: 0, profBonus: 0 }
  config.crewStats[groupId].profBonus = +val
  render()
}

/* ---------- MODS ---------- */

// Expected mods.json entries (example schema):
// {
//   "id":"reinforced_rigging",
//   "name":"Reinforced Rigging",
//   "points":2,
//   "desc":"...optional...",
//   "requires": { "baseType": ["Mount","Vehicle"], "tags":["wyvern"], "ids":["white_wyvern"] },
//   "effects": {
//      "addTraits":["tough_skin"],
//      "addMountingPoints":[{...}],
//      "statBonuses": { "baseAC": 1, "baseHP": 10, "strength": 2, "agility": 1, "carryMultiplier": 1 },
//      "flyBonus": { "standard": 10, "max": 30 },
//      "set": { "acceleration":"2d6", "climbRate":"1/2" }
//   }
// }

function baseKind() {
  return config.vehicle ? "Vehicle" : "Mount"
}
function baseTags() {
  return (config.mount?.tags || config.vehicle?.tags || [])
}
function baseId() {
  return config.base?.id || ""
}

function modById(id) {
  return mods.find(m => m.id === id) || null
}

function isModAllowed(mod) {
  if (!mod) return false
  const req = mod.requires || {}

  if (Array.isArray(req.baseType) && req.baseType.length) {
    if (!req.baseType.includes(baseKind())) return false
  }
  if (Array.isArray(req.ids) && req.ids.length) {
    if (!req.ids.includes(baseId())) return false
  }
  if (Array.isArray(req.tags) && req.tags.length) {
    const tags = baseTags()
    if (!req.tags.some(t => tags.includes(t))) return false
  }
  return true
}

function setupModsUI() {
  const modsSection = document.getElementById("modsSection")
  const modsSelect = document.getElementById("modsSelect")
  const modsList = document.getElementById("modsList")

  // If your HTML doesn’t have these yet, add them (see snippet below).
  if (!modsSection || !modsSelect || !modsList) return

  modsSection.style.display = "block"
  modsSelect.innerHTML = ""

  const available = mods.filter(isModAllowed)
  if (available.length === 0) {
    modsSelect.innerHTML = `<option value="">(No mods available)</option>`
  } else {
    available.forEach(m => {
      modsSelect.innerHTML += `<option value="${m.id}">${m.name} (${m.points || 0} pts)</option>`
    })
  }

  renderModsList()
  // Also refresh weapons if mods add mounting points
  setupWeapons(getDerivedMountingPoints())
}

function addSelectedMod() {
  const sel = document.getElementById("modsSelect")
  if (!sel || !sel.value) return
  const id = sel.value
  if (config.mods.includes(id)) return
  config.mods.push(id)
  renderModsList()
  setupWeapons(getDerivedMountingPoints())
  render()
}

function removeMod(id) {
  config.mods = config.mods.filter(x => x !== id)
  renderModsList()
  setupWeapons(getDerivedMountingPoints())
  render()
}

function renderModsList() {
  const modsList = document.getElementById("modsList")
  if (!modsList) return

  if (!config.mods.length) {
    modsList.innerHTML = `<em>No mods selected.</em>`
    return
  }

  modsList.innerHTML = config.mods
    .map(id => {
      const m = modById(id)
      if (!m) return ""
      return `
        <div style="margin-bottom:6px;">
          <strong>${m.name}</strong> (${m.points || 0} pts)
          <button onclick="removeMod('${m.id}')" style="margin-left:8px;">Remove</button>
          ${m.desc ? `<div style="font-size:0.9em; opacity:0.9;">${m.desc}</div>` : ""}
        </div>
      `
    })
    .join("")
}

function applyModsToBase(base) {
  // clone
  const b = JSON.parse(JSON.stringify(base || {}))
  b.traits = Array.isArray(b.traits) ? [...b.traits] : []
  b.fly = b.fly || { standard: 0, max: 0 }

  for (const id of config.mods) {
    const m = modById(id)
    if (!m || !isModAllowed(m)) continue
    const fx = m.effects || {}

    // add traits
    if (Array.isArray(fx.addTraits)) {
      for (const t of fx.addTraits) if (t && !b.traits.includes(t)) b.traits.push(t)
    }

    // numeric stat bonuses
    if (fx.statBonuses && typeof fx.statBonuses === "object") {
      for (const k of Object.keys(fx.statBonuses)) {
        const delta = +fx.statBonuses[k]
        if (!Number.isFinite(delta)) continue
        b[k] = (Number(b[k]) || 0) + delta
      }
    }

    // fly bonus
    if (fx.flyBonus && typeof fx.flyBonus === "object") {
      if (Number.isFinite(+fx.flyBonus.standard)) b.fly.standard = (b.fly.standard || 0) + (+fx.flyBonus.standard)
      if (Number.isFinite(+fx.flyBonus.max)) b.fly.max = (b.fly.max || 0) + (+fx.flyBonus.max)
    }

    // set/override fields
    if (fx.set && typeof fx.set === "object") {
      for (const k of Object.keys(fx.set)) b[k] = fx.set[k]
    }
  }

  return b
}

function getDerivedBase() {
  return applyModsToBase(config.base)
}

function getDerivedMountingPoints() {
  // start from saddle/vehicle
  let points = []
  if (config.vehicle) points = (config.vehicle.mountingPoints || []).map(p => ({ ...p }))
  else if (config.saddle) points = (config.saddle.mountingPoints || []).map(p => ({ ...p }))

  // add mod mounting points
  for (const id of config.mods) {
    const m = modById(id)
    if (!m || !isModAllowed(m)) continue
    const add = m.effects?.addMountingPoints
    if (Array.isArray(add)) {
      for (const mp of add) {
        if (!mp || !mp.id) continue
        // avoid collisions
        const uniqueId = points.some(p => p.id === mp.id) ? `${mp.id}_${m.id}` : mp.id
        points.push({ ...mp, id: uniqueId })
      }
    }
  }

  return points
}

/* ---------- MOUNTING POINTS / WEAPONS ---------- */

function weaponById(id) {
  return weapons.find(w => w.id === id) || null
}

function maxQtyFor(mpSize, weaponSize) {
  const mpUnits = SIZE_UNITS[mpSize] ?? 0
  const wUnits = SIZE_UNITS[weaponSize] ?? 999
  if (mpUnits === 0 || wUnits === 0) return 0
  return Math.floor(mpUnits / wUnits)
}

function setupWeapons(mountingPoints) {
  const ui = document.getElementById("weaponsUI")
  if (!ui) return
  ui.innerHTML = ""

  mountingPoints.forEach(mp => {
    if (!config.mounts[mp.id]) config.mounts[mp.id] = { weaponId: "none", qty: 0 }
    if (config.proficiencies[mp.id] === undefined) config.proficiencies[mp.id] = false

    const fittingWeapons = weapons.filter(w => maxQtyFor(mp.size, w.size) >= 1)

    const weaponOptions = fittingWeapons
      .map(w => `<option value="${w.id}" ${config.mounts[mp.id].weaponId === w.id ? "selected" : ""}>${w.name} (${w.points || 0} pts)</option>`)
      .join("")

    const currentWeapon = weaponById(config.mounts[mp.id].weaponId)
    let qtyOptions = `<option value="0">0</option>`
    if (currentWeapon && currentWeapon.id !== "none") {
      const maxQ = maxQtyFor(mp.size, currentWeapon.size)
      if (config.mounts[mp.id].qty > maxQ) config.mounts[mp.id].qty = maxQ
      if (config.mounts[mp.id].qty === 0) config.mounts[mp.id].qty = 1

      qtyOptions = Array.from({ length: maxQ + 1 }, (_, i) =>
        `<option value="${i}" ${config.mounts[mp.id].qty === i ? "selected" : ""}>${i}</option>`
      ).join("")
    }

    const crewGroups = getCrewGroups()
    const crewGroupId = mp.crewGroup || crewGroups[0].id
    const crewGroupLabel = (crewGroups.find(g => g.id === crewGroupId) || crewGroups[0]).label

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
      <br><br>
    `
  })
}

function setMountWeapon(slot, weaponId) {
  config.mounts[slot] = config.mounts[slot] || { weaponId: "none", qty: 0 }
  config.mounts[slot].weaponId = weaponId

  if (weaponId === "none") config.mounts[slot].qty = 0
  else config.mounts[slot].qty = Math.max(1, config.mounts[slot].qty || 1)

  setupWeapons(getDerivedMountingPoints())
  render()
}

function setMountQty(slot, qty) {
  config.mounts[slot] = config.mounts[slot] || { weaponId: "none", qty: 0 }
  config.mounts[slot].qty = +qty
  render()
}

function setProf(slot, value) {
  config.proficiencies[slot] = (value === "yes")
  render()
}

/* ---------- WEIGHT (CARRIED ONLY) ---------- */

function loadWeight() {
  let total = 0
  if (config.saddle) total += (config.saddle.weight || 0)
  Object.values(config.mounts).forEach(sel => {
    const w = weaponById(sel.weaponId)
    if (!w || w.id === "none") return
    total += (w.weight || 0) * (sel.qty || 0)
  })
  return total
}

/* ---------- POINT COST ---------- */

function totalPoints() {
  let total = 0
  if (config.base) total += (config.base.points || 0)
  if (config.saddle) total += (config.saddle.points || 0)

  for (const id of config.mods) {
    const m = modById(id)
    if (m) total += (m.points || 0)
  }

  Object.values(config.mounts).forEach(sel => {
    const w = weaponById(sel.weaponId)
    if (!w || w.id === "none") return
    total += (w.points || 0) * (sel.qty || 0)
  })

  return total
}

/* ---------- HELPERS ---------- */

function abilityMod(score) {
  return Math.floor((score - 10) / 2)
}

function capacity(base) {
  const sizeMult = SIZE_CAPACITY_MULT[base.size] || 1
  const carryMult = base.carryMultiplier || 1
  return base.strength * 15 * sizeMult * carryMult
}

function traitLabel(traitId) {
  return String(traitId)
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
}

/* ---------- ACTION RENDERER ---------- */

function renderNativeAction(a) {
  if (!a || !a.name) return ""

  if (a.kind === "attack") {
    let out = `<strong>${a.name}.</strong> `
    const label = (a.attackType === "ranged" || a.type === "ranged") ? "Ranged Weapon Attack" : "Melee Weapon Attack"
    out += `${label}: +${a.toHit} to hit, `
    if (a.reach) out += `reach ${a.reach}, `
    if (a.range) out += `range ${a.range}, `
    out += `${a.target || "one target"}. `
    out += `<em>Hit:</em> ${a.damage || "—"}`
    if (a.extra) out += ` ${a.extra}`
    if (a.notes) out += ` ${a.notes}`
    return out + `<br>`
  }

  if (a.kind === "save") {
    let out = `<strong>${a.name}.</strong> `
    if (a.range) out += `Range ${a.range}. `
    if (a.area) out += `Area ${a.area}. `

    const abil = a.save?.ability || "—"
    const dc = a.save?.dc ?? "—"
    out += `Each target must make a DC ${dc} ${abil} saving throw. `

    const fmtOutcome = (x, fallback) => {
      if (!x) return fallback
      if (typeof x === "string") return x
      let parts = []
      if (x.damage) parts.push(x.damage === "half" ? "half damage" : x.damage)
      if (x.condition) parts.push(x.condition)
      if (x.effect) parts.push(x.effect)
      return parts.length ? parts.join(", ") : fallback
    }

    out += `<em>Failure:</em> ${fmtOutcome(a.onFail, "—")}. `
    out += `<em>Success:</em> ${fmtOutcome(a.onSave, "—")}. `
    if (a.notes) out += `${a.notes}`
    return out + `<br>`
  }

  return `<strong>${a.name}.</strong> ${a.text || ""}<br>`
}

function renderActionSection(title, list) {
  if (!Array.isArray(list) || list.length === 0) return ""
  let out = `<strong>${title}</strong><br>`
  for (const a of list) out += renderNativeAction(a)
  out += `<br>`
  return out
}

/* ---------- RENDER ---------- */

function render() {
  if (!config.base) return

  const derived = getDerivedBase()

  const payload = loadWeight()
  const cap = capacity(derived)

  let agility = derived.agility
  let maxSpeed = derived.fly?.max ?? 0
  let enc = "Normal"
  let agilityWarning = null

  if (payload > cap * 0.5) {
    enc = "Encumbered"
    agility = Math.ceil((derived.agility || 0) / 2)
    agilityWarning = "⚠ Agility halved due to load"
  }
  if (payload > cap) {
    enc = "Heavily Encumbered"
    maxSpeed = Math.max(0, (maxSpeed || 0) - 20)
  }
  if (payload > cap * 1.5) enc = "Overloaded"

  const pts = totalPoints()

  let html = `
    <h2>${derived.name}</h2>
    <em>${derived.size} ${derived.type}</em><br>
    <strong>Point Cost</strong> ${pts} pts
    <hr>

    <strong>Armor Class</strong> ${derived.baseAC}<br>
    <strong>Hit Points</strong> ${derived.baseHP}<br>
    <strong>Speed</strong> fly ${derived.fly?.standard ?? 0} ft. (max ${maxSpeed} ft.)<br>
    <strong>Climb Rate</strong> ${derived.climbRate ?? "—"}<br>
    <strong>Acceleration</strong> ${derived.acceleration ?? "—"}<br>

    <hr>

    STR ${derived.strength} (${abilityMod(derived.strength)})
    DEX ${derived.dex} (${abilityMod(derived.dex)})
    CON ${derived.con} (${abilityMod(derived.con)})

    <hr>

    <strong>Agility</strong> ${agility}
    ${agilityWarning ? `<br><strong>${agilityWarning}</strong>` : ""}<br>
    <strong>Encumbrance</strong> ${enc} (${payload} / ${cap} lb)
    <hr>
  `

  // Native action types
  html += renderActionSection("Actions", derived.actions)
  html += renderActionSection("Bonus Actions", derived.bonusActions)
  html += renderActionSection("Reactions", derived.reactions)
  html += renderActionSection("Legendary Actions", derived.legendaryActions)

  // Mounted weapons
  html += `<strong>Mounted Weapons</strong><br>`
  const points = getDerivedMountingPoints()
  const groups = getCrewGroups()

  for (let mp of points) {
    const sel = config.mounts[mp.id] || { weaponId: "none", qty: 0 }
    const w = weaponById(sel.weaponId)
    if (!w || w.id === "none" || !sel.qty) continue

    const crewGroupId = mp.crewGroup || groups[0].id
    const crew = config.crewStats[crewGroupId] || { dexMod: 0, profBonus: 0 }
    const proficient = !!config.proficiencies[mp.id]
    const atk = (crew.dexMod || 0) + (proficient ? (crew.profBonus || 0) : 0)

    const traitsText = Array.isArray(w.traits) && w.traits.length
      ? w.traits.map(traitLabel).join(", ")
      : "—"

    html += `
      <strong>${w.name}</strong> ×${sel.qty} (${mp.arc})<br>
      Attack: +${atk} to hit<br>
      Hit: ${w.damage}<br>
      Range: ${w.range || "—"}<br>
      Traits: ${traitsText}<br>
      Points: ${(w.points || 0) * sel.qty} pts<br><br>
    `
  }

  // Traits
  if (Array.isArray(derived.traits) && derived.traits.length) {
    html += `<hr><strong>Traits</strong><br>`
    derived.traits.forEach(t => {
      const tr = TRAITS[t]
      if (tr) html += `<strong>${tr.name}.</strong> ${tr.desc}<br>`
      else html += `<strong>${traitLabel(t)}.</strong><br>`
    })
  }

  document.getElementById("statblock").innerHTML = html
}
/*------Roll20 exporter----*/
function buildRoll20Export() {
  const base = getDerivedBase();                 // ✅ export what you render (mods applied)
  const points = getDerivedMountingPoints();     // ✅ correct function
  const groups = getCrewGroups();

  // build mounted weapons list
  const mountedWeapons = [];
  for (const mp of points) {
    const sel = config.mounts[mp.id] || { weaponId: "none", qty: 0 };
    if (!sel.qty || sel.weaponId === "none") continue;

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
      attackBonus: atk,
      damage: w.damage,
      range: w.range || "",
      traits: Array.isArray(w.traits) ? w.traits : []
    });
  }

  return {
    schema: "flying-combat-config-v1",

    // identity (IMPORTANT for token image stability later)
    baseId: config.base?.id || "",
    baseName: base.name,
    baseType: base.type,
    baseSize: base.size,

    // loadout
    saddleId: config.saddle?.id || null,
    modIds: [...config.mods],

    // stats (derived = matches UI)
    stats: {
      ac: base.baseAC,
      hp: base.baseHP,
      str: base.strength,
      dex: base.dex,
      con: base.con,
      agility: base.agility
    },

    movement: {
      fly: base.fly?.standard ?? 0,
      fly_max: base.fly?.max ?? 0,
      climb_rate: base.climbRate ?? "—",
      acceleration: base.acceleration ?? "—"
    },

    encumbrance: {
      carried_weight: loadWeight(),
      capacity: capacity(base)
    },

    traits: Array.isArray(base.traits) ? base.traits : [],
    actions: Array.isArray(base.actions) ? base.actions : [],
    bonusActions: Array.isArray(base.bonusActions) ? base.bonusActions : [],
    reactions: Array.isArray(base.reactions) ? base.reactions : [],
    legendaryActions: Array.isArray(base.legendaryActions) ? base.legendaryActions : [],

    mountedWeapons,

    // optional: store crew inputs so import can reconstruct attack bonuses
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

loadData()



