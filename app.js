let mounts = []
let vehicles = []
let saddles = []
let weapons = []
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
  crewStats: {}
}

/* ---------- LOAD DATA ---------- */

async function loadData() {
  try {
    const mountsRes = await fetch("data/mounts.json"); if (!mountsRes.ok) throw new Error("mounts.json not found")
    const vehiclesRes = await fetch("data/vehicles.json"); if (!vehiclesRes.ok) throw new Error("vehicles.json not found")
    const saddlesRes = await fetch("data/saddles.json"); if (!saddlesRes.ok) throw new Error("saddles.json not found")
    const weaponsRes = await fetch("data/weapons.json"); if (!weaponsRes.ok) throw new Error("weapons.json not found")
    const traitsRes = await fetch("data/traits.json"); if (!traitsRes.ok) throw new Error("traits.json not found")

    mounts = await mountsRes.json()
    vehicles = await vehiclesRes.json()
    saddles = await saddlesRes.json()
    weapons = await weaponsRes.json()

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

  document.getElementById("saddleSection").style.display = config.mount ? "block" : "none"

  if (config.mount) setupMount()
  else setupVehicle()

  render()
}

/* ---------- MOUNTS ---------- */

function setupMount() {
  const saddleSelect = document.getElementById("saddleSelect")
  saddleSelect.innerHTML = ""

  const mountTags = config.mount.tags || []

  // Saddle restrictions supported:
  // - allowedSizes: ["Large", ...] (required)
  // - allowedMountIds: ["white_wyvern", ...] (optional)
  // - allowedMountTags: ["wyvern", "griffon", ...] (optional)
  //
  // Matching rule:
  // - Size must match
  // - If any restriction exists (ids or tags), must match at least one of them
  const validSaddles = saddles
    .filter(s => (s.allowedSizes || []).includes(config.mount.size))
    .filter(s => {
      const hasIds = Array.isArray(s.allowedMountIds) && s.allowedMountIds.length > 0
      const hasTags = Array.isArray(s.allowedMountTags) && s.allowedMountTags.length > 0
      if (!hasIds && !hasTags) return true // generic saddle
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
    render()
  }

  selectSaddle(validSaddles[0].id)
  render()
}

function selectSaddle(id) {
  config.saddle = saddles.find(s => s.id === id) || null
  if (!config.saddle) return

  setupCrewUI(getCrewGroups())
  setupWeapons(getMountingPoints())
}

/* ---------- VEHICLES ---------- */

function setupVehicle() {
  setupCrewUI(getCrewGroups())
  setupWeapons(getMountingPoints())
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

/* ---------- MOUNTING POINTS / WEAPONS ---------- */

function getMountingPoints() {
  if (config.vehicle) return config.vehicle.mountingPoints || []
  if (config.saddle) return config.saddle.mountingPoints || []
  return []
}

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
  ui.innerHTML = ""

  mountingPoints.forEach(mp => {
    if (!config.mounts[mp.id]) config.mounts[mp.id] = { weaponId: "none", qty: 0 }
    if (config.proficiencies[mp.id] === undefined) config.proficiencies[mp.id] = false

    const fittingWeapons = weapons.filter(w => maxQtyFor(mp.size, w.size) >= 1)

    const weaponOptions = fittingWeapons
      .map(w => `<option value="${w.id}" ${config.mounts[mp.id].weaponId === w.id ? "selected" : ""}>${w.name}</option>`)
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

  setupWeapons(getMountingPoints())
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
  if (config.saddle) total += config.saddle.weight
  Object.values(config.mounts).forEach(sel => {
    const w = weaponById(sel.weaponId)
    if (!w || w.id === "none") return
    total += (w.weight || 0) * (sel.qty || 0)
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

/* ---------- ACTION RENDERER (supports: attack, save, text) ---------- */

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

/* ---------- SECTION RENDER HELPERS ---------- */

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

  const payload = loadWeight()
  const cap = capacity(config.base)

  let agility = config.base.agility
  let maxSpeed = config.base.fly.max
  let enc = "Normal"
  let agilityWarning = null

  if (payload > cap * 0.5) {
    enc = "Encumbered"
    agility = Math.ceil(config.base.agility / 2)
    agilityWarning = "⚠ Agility halved due to load"
  }
  if (payload > cap) {
    enc = "Heavily Encumbered"
    maxSpeed -= 20
  }
  if (payload > cap * 1.5) enc = "Overloaded"

  let html = `
    <h2>${config.base.name}</h2>
    <em>${config.base.size} ${config.base.type}</em>
    <hr>

    <strong>Armor Class</strong> ${config.base.baseAC}<br>
    <strong>Hit Points</strong> ${config.base.baseHP}<br>
    <strong>Speed</strong> fly ${config.base.fly.standard} ft. (max ${maxSpeed} ft.)<br>

    <hr>

    STR ${config.base.strength} (${abilityMod(config.base.strength)})
    DEX ${config.base.dex} (${abilityMod(config.base.dex)})
    CON ${config.base.con} (${abilityMod(config.base.con)})

    <hr>

    <strong>Agility</strong> ${agility}
    ${agilityWarning ? `<br><strong>${agilityWarning}</strong>` : ""}<br>
    <strong>Encumbrance</strong> ${enc} (${payload} / ${cap} lb)
    <hr>
  `

  // ✅ All native action types supported
  html += renderActionSection("Actions", config.base.actions)
  html += renderActionSection("Bonus Actions", config.base.bonusActions)
  html += renderActionSection("Reactions", config.base.reactions)
  html += renderActionSection("Legendary Actions", config.base.legendaryActions)

  // Mounted weapons section
  html += `<strong>Mounted Weapons</strong><br>`
  const points = getMountingPoints()
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
      Traits: ${traitsText}<br><br>
    `
  }

  // Traits descriptions
  if (Array.isArray(config.base.traits) && config.base.traits.length) {
    html += `<hr><strong>Traits</strong><br>`
    config.base.traits.forEach(t => {
      const tr = TRAITS[t]
      if (tr) html += `<strong>${tr.name}.</strong> ${tr.desc}<br>`
      else html += `<strong>${traitLabel(t)}.</strong><br>` // fallback shows missing ids
    })
  }

  document.getElementById("statblock").innerHTML = html
}

/* ---------- START ---------- */

loadData()
