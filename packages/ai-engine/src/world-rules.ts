// ============================================================================
// AI Village — World Rules
// The physics of the world. No LLM involved. Every action that changes
// the world mechanically is defined here. The LLM decides WHAT to do.
// This file decides WHAT HAPPENS.
// ============================================================================

// --- Resources ---
// Every physical thing in the world. If it doesn't appear here, it doesn't exist.

export interface ResourceDef {
  id: string;
  name: string;
  type: 'raw' | 'food' | 'material' | 'tool' | 'medicine' | 'container' | 'currency_candidate';
  perishable: boolean;
  spoilDays: number;          // 0 = never spoils. Game days until the item disappears.
  nutritionValue: number;     // How much hunger it reduces when eaten (0 if not food)
  energyValue: number;        // How much energy it restores when consumed (0 if N/A)
  healValue: number;          // How much health it restores (0 if not medicine)
  baseTradeValue: number;     // Rough barter equivalence. Emergent prices override this.
  weight: number;             // 1 = light, 5 = heavy. Affects carry capacity.
  stackable: boolean;         // Can multiple units occupy one inventory slot?
  maxStack: number;           // Max per slot if stackable
  description: string;
}

export const RESOURCES: Record<string, ResourceDef> = {
  // === Raw gathered resources ===
  wheat:      { id: 'wheat',      name: 'wheat',       type: 'raw',       perishable: true,  spoilDays: 5,  nutritionValue: 5,  energyValue: 0,  healValue: 0,  baseTradeValue: 2,  weight: 1, stackable: true,  maxStack: 10, description: 'Raw wheat from the farm' },
  vegetables: { id: 'vegetables', name: 'vegetables',  type: 'raw',       perishable: true,  spoilDays: 3,  nutritionValue: 8,  energyValue: 2,  healValue: 0,  baseTradeValue: 3,  weight: 1, stackable: true,  maxStack: 10, description: 'Fresh vegetables from the farm' },
  fish:       { id: 'fish',       name: 'fish',        type: 'raw',       perishable: true,  spoilDays: 1,  nutritionValue: 12, energyValue: 0,  healValue: 0,  baseTradeValue: 4,  weight: 1, stackable: true,  maxStack: 5,  description: 'Fresh fish from the lake. Spoils fast.' },
  mushrooms:  { id: 'mushrooms',  name: 'mushrooms',   type: 'raw',       perishable: true,  spoilDays: 2,  nutritionValue: 6,  energyValue: 0,  healValue: 0,  baseTradeValue: 2,  weight: 1, stackable: true,  maxStack: 10, description: 'Wild mushrooms from the forest floor' },
  herbs:      { id: 'herbs',      name: 'herbs',       type: 'raw',       perishable: true,  spoilDays: 4,  nutritionValue: 2,  energyValue: 0,  healValue: 5,  baseTradeValue: 5,  weight: 1, stackable: true,  maxStack: 10, description: 'Medicinal herbs from the garden' },
  flowers:    { id: 'flowers',    name: 'flowers',     type: 'raw',       perishable: true,  spoilDays: 2,  nutritionValue: 0,  energyValue: 0,  healValue: 0,  baseTradeValue: 1,  weight: 1, stackable: true,  maxStack: 10, description: 'Wildflowers. Pretty but not useful... unless gifted.' },
  wood:       { id: 'wood',       name: 'wood',        type: 'material',  perishable: false, spoilDays: 0,  nutritionValue: 0,  energyValue: 0,  healValue: 0,  baseTradeValue: 3,  weight: 3, stackable: true,  maxStack: 5,  description: 'Lumber from the forest' },
  clay:       { id: 'clay',       name: 'clay',        type: 'material',  perishable: false, spoilDays: 0,  nutritionValue: 0,  energyValue: 0,  healValue: 0,  baseTradeValue: 3,  weight: 2, stackable: true,  maxStack: 5,  description: 'Wet clay from the lake banks' },
  stone:      { id: 'stone',      name: 'stone',       type: 'material',  perishable: false, spoilDays: 0,  nutritionValue: 0,  energyValue: 0,  healValue: 0,  baseTradeValue: 2,  weight: 4, stackable: true,  maxStack: 3,  description: 'River stones from the lake shore' },

  // === Crafted food (longer lasting, better nutrition) ===
  bread:        { id: 'bread',        name: 'bread',        type: 'food',     perishable: true,  spoilDays: 8,  nutritionValue: 20, energyValue: 5,  healValue: 0,  baseTradeValue: 8,  weight: 1, stackable: true,  maxStack: 5, description: 'Baked bread. Filling and keeps well.' },
  stew:         { id: 'stew',         name: 'stew',         type: 'food',     perishable: true,  spoilDays: 2,  nutritionValue: 30, energyValue: 10, healValue: 5,  baseTradeValue: 12, weight: 2, stackable: false, maxStack: 1, description: 'Hot stew. The best meal in the village.' },
  dried_fish:   { id: 'dried_fish',   name: 'dried fish',   type: 'food',     perishable: true,  spoilDays: 20, nutritionValue: 10, energyValue: 0,  healValue: 0,  baseTradeValue: 7,  weight: 1, stackable: true,  maxStack: 10, description: 'Preserved fish. Keeps for weeks.' },
  pickled_veg:  { id: 'pickled_veg',  name: 'pickled vegetables', type: 'food', perishable: true, spoilDays: 30, nutritionValue: 7, energyValue: 2, healValue: 0, baseTradeValue: 6, weight: 1, stackable: true, maxStack: 10, description: 'Preserved vegetables in brine. Winter staple.' },
  herb_tea:     { id: 'herb_tea',     name: 'herb tea',     type: 'food',     perishable: true,  spoilDays: 1,  nutritionValue: 3,  energyValue: 15, healValue: 3,  baseTradeValue: 4,  weight: 1, stackable: false, maxStack: 1, description: 'Warm tea brewed from herbs. Restores energy.' },

  // === Crafted materials ===
  bricks:   { id: 'bricks',   name: 'bricks',   type: 'material',  perishable: false, spoilDays: 0, nutritionValue: 0, energyValue: 0, healValue: 0, baseTradeValue: 8,  weight: 4, stackable: true, maxStack: 5, description: 'Fired clay bricks. Strong building material.' },
  planks:   { id: 'planks',   name: 'planks',    type: 'material',  perishable: false, spoilDays: 0, nutritionValue: 0, energyValue: 0, healValue: 0, baseTradeValue: 6,  weight: 3, stackable: true, maxStack: 5, description: 'Sawn wood planks. Ready for building.' },
  rope:     { id: 'rope',     name: 'rope',      type: 'material',  perishable: false, spoilDays: 0, nutritionValue: 0, energyValue: 0, healValue: 0, baseTradeValue: 5,  weight: 1, stackable: true, maxStack: 5, description: 'Twisted plant fiber rope.' },

  // === Tools (durable, improve action yields) ===
  fishing_rod:  { id: 'fishing_rod',  name: 'fishing rod',  type: 'tool', perishable: false, spoilDays: 0, nutritionValue: 0, energyValue: 0, healValue: 0, baseTradeValue: 15, weight: 2, stackable: false, maxStack: 1, description: 'Doubles fish yield per attempt.' },
  hoe:          { id: 'hoe',          name: 'hoe',          type: 'tool', perishable: false, spoilDays: 0, nutritionValue: 0, energyValue: 0, healValue: 0, baseTradeValue: 12, weight: 2, stackable: false, maxStack: 1, description: 'Doubles farm yield per attempt.' },
  axe:          { id: 'axe',          name: 'axe',          type: 'tool', perishable: false, spoilDays: 0, nutritionValue: 0, energyValue: 0, healValue: 0, baseTradeValue: 12, weight: 2, stackable: false, maxStack: 1, description: 'Doubles wood yield per attempt.' },
  hammer:       { id: 'hammer',       name: 'hammer',       type: 'tool', perishable: false, spoilDays: 0, nutritionValue: 0, energyValue: 0, healValue: 0, baseTradeValue: 10, weight: 2, stackable: false, maxStack: 1, description: 'Required for building. Halves build time.' },
  mortar:       { id: 'mortar',       name: 'mortar & pestle', type: 'tool', perishable: false, spoilDays: 0, nutritionValue: 0, energyValue: 0, healValue: 0, baseTradeValue: 8, weight: 2, stackable: false, maxStack: 1, description: 'Required for medicine crafting.' },
  pottery:      { id: 'pottery',      name: 'pottery jar',  type: 'container', perishable: false, spoilDays: 0, nutritionValue: 0, energyValue: 0, healValue: 0, baseTradeValue: 6, weight: 2, stackable: false, maxStack: 1, description: 'Doubles spoil time of food stored with it.' },

  // === Medicine ===
  medicine:     { id: 'medicine',     name: 'medicine',     type: 'medicine', perishable: true, spoilDays: 10, nutritionValue: 0, energyValue: 5, healValue: 30, baseTradeValue: 20, weight: 1, stackable: true, maxStack: 5, description: 'Herbal medicine. Heals injuries and sickness.' },
  poultice:     { id: 'poultice',     name: 'poultice',     type: 'medicine', perishable: true, spoilDays: 5,  nutritionValue: 0, energyValue: 0, healValue: 15, baseTradeValue: 10, weight: 1, stackable: true, maxStack: 5, description: 'Simple herb compress. Minor healing.' },
};


// --- Skills ---
// Every learnable skill. Level 0 = untrained, 10 = master.
// Skill affects: success chance, yield multiplier, unlocks recipes at certain levels.

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  xpPerSuccess: number;       // XP gained per successful action using this skill
  xpPerLevel: number;         // XP required to gain one level (flat for simplicity)
  maxLevel: number;
}

export const SKILLS: Record<string, SkillDef> = {
  farming:   { id: 'farming',   name: 'farming',   description: 'Growing and harvesting crops',          xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10 },
  fishing:   { id: 'fishing',   name: 'fishing',   description: 'Catching fish',                         xpPerSuccess: 12, xpPerLevel: 60, maxLevel: 10 },
  foraging:  { id: 'foraging',  name: 'foraging',  description: 'Finding mushrooms, herbs, and flowers',  xpPerSuccess: 8,  xpPerLevel: 40, maxLevel: 10 },
  cooking:   { id: 'cooking',   name: 'cooking',   description: 'Preparing meals from raw ingredients',   xpPerSuccess: 15, xpPerLevel: 70, maxLevel: 10 },
  crafting:  { id: 'crafting',  name: 'crafting',  description: 'Making tools, pottery, rope, bricks',    xpPerSuccess: 15, xpPerLevel: 70, maxLevel: 10 },
  building:  { id: 'building',  name: 'building',  description: 'Constructing and repairing structures',  xpPerSuccess: 20, xpPerLevel: 100, maxLevel: 10 },
  medicine:  { id: 'medicine',  name: 'herbalism', description: 'Preparing medicine from herbs',           xpPerSuccess: 20, xpPerLevel: 80, maxLevel: 10 },
  woodwork:  { id: 'woodwork',  name: 'woodwork',  description: 'Cutting wood and making planks',         xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10 },
};


// --- Gathering ---
// What you get when you harvest from a location. Success and yield depend on skill.

export interface GatherDef {
  id: string;
  location: string;           // area ID where this can be done
  skill: string;              // which skill governs this
  minSkillLevel: number;      // minimum skill to attempt (0 = anyone)
  baseDuration: number;       // game-minutes per attempt
  energyCost: number;         // energy consumed per attempt
  baseSuccessChance: number;  // 0.0-1.0 at skill level 0. Increases with skill.
  yields: { resource: string; minQty: number; maxQty: number }[];
  toolBonus?: string;         // tool ID that doubles yield
  seasonModifier?: Partial<Record<Season, number>>; // multiplier per season (default 1.0)
  dailyStock: number;         // max total gathers from this source per day (across all agents)
  description: string;
}

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export const GATHERING: GatherDef[] = [
  // --- Farm ---
  { id: 'farm_wheat',    location: 'farm', skill: 'farming', minSkillLevel: 0, baseDuration: 45, energyCost: 8,
    baseSuccessChance: 0.6, yields: [{ resource: 'wheat', minQty: 1, maxQty: 3 }],
    toolBonus: 'hoe', seasonModifier: { spring: 0.8, summer: 1.2, autumn: 1.0, winter: 0.0 },
    dailyStock: 12, description: 'Harvest wheat from the fields' },

  { id: 'farm_veg',      location: 'farm', skill: 'farming', minSkillLevel: 1, baseDuration: 40, energyCost: 7,
    baseSuccessChance: 0.5, yields: [{ resource: 'vegetables', minQty: 1, maxQty: 2 }],
    toolBonus: 'hoe', seasonModifier: { spring: 1.0, summer: 1.3, autumn: 0.8, winter: 0.0 },
    dailyStock: 8, description: 'Harvest vegetables from the fields' },

  // --- Lake ---
  { id: 'lake_fish',     location: 'lake', skill: 'fishing', minSkillLevel: 0, baseDuration: 60, energyCost: 10,
    baseSuccessChance: 0.4, yields: [{ resource: 'fish', minQty: 0, maxQty: 2 }],
    toolBonus: 'fishing_rod', seasonModifier: { spring: 1.0, summer: 1.0, autumn: 0.8, winter: 0.1 },
    dailyStock: 10, description: 'Fish in the lake' },

  { id: 'lake_clay',     location: 'lake', skill: 'foraging', minSkillLevel: 0, baseDuration: 30, energyCost: 6,
    baseSuccessChance: 0.7, yields: [{ resource: 'clay', minQty: 1, maxQty: 2 }],
    seasonModifier: { spring: 1.0, summer: 1.0, autumn: 1.0, winter: 0.3 },
    dailyStock: 8, description: 'Dig clay from the lake banks' },

  { id: 'lake_stone',    location: 'lake', skill: 'foraging', minSkillLevel: 0, baseDuration: 40, energyCost: 8,
    baseSuccessChance: 0.8, yields: [{ resource: 'stone', minQty: 1, maxQty: 2 }],
    dailyStock: 6, description: 'Collect stones from the shore' },

  // --- Forest ---
  { id: 'forest_wood',   location: 'forest', skill: 'woodwork', minSkillLevel: 0, baseDuration: 50, energyCost: 12,
    baseSuccessChance: 0.7, yields: [{ resource: 'wood', minQty: 1, maxQty: 2 }],
    toolBonus: 'axe', seasonModifier: { spring: 1.0, summer: 1.0, autumn: 1.0, winter: 0.6 },
    dailyStock: 15, description: 'Chop wood in the forest' },

  { id: 'forest_mushroom', location: 'forest', skill: 'foraging', minSkillLevel: 0, baseDuration: 35, energyCost: 5,
    baseSuccessChance: 0.5, yields: [{ resource: 'mushrooms', minQty: 1, maxQty: 3 }],
    seasonModifier: { spring: 0.8, summer: 0.6, autumn: 1.5, winter: 0.2 },
    dailyStock: 8, description: 'Forage for mushrooms' },

  // --- Southern Woods (same as forest but riskier, slightly more yield) ---
  { id: 'south_wood',    location: 'forest_south', skill: 'woodwork', minSkillLevel: 0, baseDuration: 50, energyCost: 14,
    baseSuccessChance: 0.65, yields: [{ resource: 'wood', minQty: 1, maxQty: 3 }],
    toolBonus: 'axe', seasonModifier: { spring: 1.0, summer: 1.0, autumn: 1.0, winter: 0.5 },
    dailyStock: 10, description: 'Chop wood in the dense southern woods' },

  // --- Garden ---
  { id: 'garden_herbs',  location: 'garden', skill: 'foraging', minSkillLevel: 0, baseDuration: 30, energyCost: 4,
    baseSuccessChance: 0.6, yields: [{ resource: 'herbs', minQty: 1, maxQty: 2 }],
    seasonModifier: { spring: 1.2, summer: 1.0, autumn: 0.8, winter: 0.1 },
    dailyStock: 6, description: 'Gather medicinal herbs' },

  { id: 'garden_flowers', location: 'garden', skill: 'foraging', minSkillLevel: 0, baseDuration: 20, energyCost: 3,
    baseSuccessChance: 0.8, yields: [{ resource: 'flowers', minQty: 1, maxQty: 3 }],
    seasonModifier: { spring: 1.5, summer: 1.2, autumn: 0.5, winter: 0.0 },
    dailyStock: 10, description: 'Pick wildflowers' },
];


// --- Recipes (Crafting) ---
// Transform inputs into outputs. Requires a location, a skill level, time, and energy.

export interface RecipeDef {
  id: string;
  name: string;
  category: 'cooking' | 'crafting' | 'building' | 'medicine';
  location: string;           // area ID where this must be done
  skill: string;              // governing skill
  minSkillLevel: number;      // minimum to attempt
  duration: number;           // game-minutes
  energyCost: number;
  inputs: { resource: string; qty: number }[];
  outputs: { resource: string; qty: number }[];
  toolRequired?: string;      // must have this tool in inventory
  skillBonusYield?: boolean;  // if true, higher skill = chance of extra output
  description: string;
}

export const RECIPES: RecipeDef[] = [
  // === Cooking (at bakery or café) ===
  { id: 'bake_bread',   name: 'bake bread',   category: 'cooking', location: 'bakery', skill: 'cooking', minSkillLevel: 0,
    duration: 30, energyCost: 5,
    inputs: [{ resource: 'wheat', qty: 2 }],
    outputs: [{ resource: 'bread', qty: 1 }],
    skillBonusYield: true,
    description: 'Bake wheat into bread at the bakery oven' },

  { id: 'cook_stew',    name: 'cook stew',    category: 'cooking', location: 'cafe', skill: 'cooking', minSkillLevel: 2,
    duration: 45, energyCost: 8,
    inputs: [{ resource: 'vegetables', qty: 2 }, { resource: 'fish', qty: 1 }],
    outputs: [{ resource: 'stew', qty: 1 }],
    skillBonusYield: true,
    description: 'Cook a hearty stew at the café stove' },

  { id: 'dry_fish',     name: 'dry fish',   category: 'cooking', location: 'cafe', skill: 'cooking', minSkillLevel: 1,
    duration: 60, energyCost: 4,
    inputs: [{ resource: 'fish', qty: 2 }],
    outputs: [{ resource: 'dried_fish', qty: 2 }],
    description: 'Preserve fish by drying. Lasts much longer.' },

  { id: 'pickle_veg',   name: 'pickle vegetables', category: 'cooking', location: 'cafe', skill: 'cooking', minSkillLevel: 2,
    duration: 40, energyCost: 4,
    inputs: [{ resource: 'vegetables', qty: 3 }],
    outputs: [{ resource: 'pickled_veg', qty: 3 }],
    description: 'Preserve vegetables in brine. Essential for winter.' },

  { id: 'brew_tea',     name: 'brew herb tea', category: 'cooking', location: 'cafe', skill: 'cooking', minSkillLevel: 0,
    duration: 15, energyCost: 2,
    inputs: [{ resource: 'herbs', qty: 1 }],
    outputs: [{ resource: 'herb_tea', qty: 1 }],
    description: 'Brew a restorative tea' },

  // === Crafting (at workshop) ===
  { id: 'fire_bricks',  name: 'fire bricks',  category: 'crafting', location: 'bakery', skill: 'crafting', minSkillLevel: 1,
    duration: 60, energyCost: 8,
    inputs: [{ resource: 'clay', qty: 3 }],
    outputs: [{ resource: 'bricks', qty: 2 }],
    description: 'Fire clay into bricks at the bakery oven' },

  { id: 'cut_planks',   name: 'cut planks',   category: 'crafting', location: 'workshop', skill: 'woodwork', minSkillLevel: 1,
    duration: 40, energyCost: 10,
    inputs: [{ resource: 'wood', qty: 2 }],
    outputs: [{ resource: 'planks', qty: 3 }],
    toolRequired: 'axe',
    description: 'Cut logs into planks at the workshop' },

  { id: 'make_rope',    name: 'make rope',    category: 'crafting', location: 'workshop', skill: 'crafting', minSkillLevel: 0,
    duration: 30, energyCost: 5,
    inputs: [{ resource: 'herbs', qty: 2 }],
    outputs: [{ resource: 'rope', qty: 1 }],
    description: 'Twist plant fibers into rope' },

  { id: 'make_pottery', name: 'make pottery', category: 'crafting', location: 'bakery', skill: 'crafting', minSkillLevel: 2,
    duration: 50, energyCost: 6,
    inputs: [{ resource: 'clay', qty: 2 }],
    outputs: [{ resource: 'pottery', qty: 1 }],
    description: 'Shape and fire a pottery jar for food storage' },

  // === Tool crafting (at workshop) ===
  { id: 'make_fishing_rod', name: 'make fishing rod', category: 'crafting', location: 'workshop', skill: 'crafting', minSkillLevel: 1,
    duration: 45, energyCost: 6,
    inputs: [{ resource: 'wood', qty: 1 }, { resource: 'rope', qty: 1 }],
    outputs: [{ resource: 'fishing_rod', qty: 1 }],
    description: 'Craft a fishing rod from wood and rope' },

  { id: 'make_hoe',     name: 'make hoe',     category: 'crafting', location: 'workshop', skill: 'crafting', minSkillLevel: 1,
    duration: 40, energyCost: 8,
    inputs: [{ resource: 'wood', qty: 1 }, { resource: 'stone', qty: 2 }],
    outputs: [{ resource: 'hoe', qty: 1 }],
    description: 'Craft a farming hoe' },

  { id: 'make_axe',     name: 'make axe',     category: 'crafting', location: 'workshop', skill: 'crafting', minSkillLevel: 2,
    duration: 45, energyCost: 10,
    inputs: [{ resource: 'wood', qty: 1 }, { resource: 'stone', qty: 2 }, { resource: 'rope', qty: 1 }],
    outputs: [{ resource: 'axe', qty: 1 }],
    description: 'Craft a woodcutting axe' },

  { id: 'make_hammer',  name: 'make hammer',  category: 'crafting', location: 'workshop', skill: 'crafting', minSkillLevel: 2,
    duration: 40, energyCost: 8,
    inputs: [{ resource: 'wood', qty: 1 }, { resource: 'stone', qty: 1 }],
    outputs: [{ resource: 'hammer', qty: 1 }],
    description: 'Craft a building hammer' },

  { id: 'make_mortar',  name: 'make mortar',  category: 'crafting', location: 'workshop', skill: 'crafting', minSkillLevel: 1,
    duration: 30, energyCost: 5,
    inputs: [{ resource: 'stone', qty: 2 }],
    outputs: [{ resource: 'mortar', qty: 1 }],
    description: 'Carve a mortar and pestle from stone' },

  // === Medicine (at clinic or garden) ===
  { id: 'make_medicine', name: 'make medicine', category: 'medicine', location: 'hospital', skill: 'medicine', minSkillLevel: 2,
    duration: 40, energyCost: 5,
    inputs: [{ resource: 'herbs', qty: 3 }],
    outputs: [{ resource: 'medicine', qty: 1 }],
    toolRequired: 'mortar',
    description: 'Prepare proper medicine from herbs' },

  { id: 'make_poultice', name: 'make poultice', category: 'medicine', location: 'garden', skill: 'medicine', minSkillLevel: 0,
    duration: 20, energyCost: 3,
    inputs: [{ resource: 'herbs', qty: 1 }],
    outputs: [{ resource: 'poultice', qty: 1 }],
    description: 'Crush herbs into a simple healing compress' },
];


// --- Buildings ---
// Multi-session construction projects. Require materials, skill, tool, and time.

export interface BuildingDef {
  id: string;
  name: string;
  category: 'shelter' | 'workshop_upgrade' | 'storage' | 'defense' | 'communal';
  materials: { resource: string; qty: number }[];
  toolRequired: string;       // must have this tool
  minBuildingSkill: number;
  sessionsRequired: number;   // how many work sessions (each = ~60 game-minutes + energyCost)
  energyPerSession: number;
  baseDurability: number;     // starting durability when complete
  maxCapacity: number;        // how many agents can use it simultaneously
  effects: BuildingEffect[];
  stormResistance: number;    // 0.0-1.0 — reduces storm damage by this factor
  description: string;
}

export interface BuildingEffect {
  type: 'hunger_reduction' | 'energy_regen' | 'cold_protection' | 'storage_bonus'
      | 'craft_speed' | 'gather_bonus' | 'heal_bonus' | 'trade_bonus';
  value: number;              // multiplier or flat bonus depending on type
}

export const BUILDINGS: Record<string, BuildingDef> = {
  lean_to: {
    id: 'lean_to', name: 'lean-to shelter', category: 'shelter',
    materials: [{ resource: 'wood', qty: 5 }],
    toolRequired: 'none', minBuildingSkill: 0, sessionsRequired: 1, energyPerSession: 10,
    baseDurability: 40, maxCapacity: 2, stormResistance: 0.2,
    effects: [
      { type: 'cold_protection', value: 0.3 },
      { type: 'energy_regen', value: 1.2 },
    ],
    description: 'A crude shelter from branches. Better than nothing in winter.',
  },

  wood_shelter: {
    id: 'wood_shelter', name: 'wooden shelter', category: 'shelter',
    materials: [{ resource: 'planks', qty: 6 }, { resource: 'rope', qty: 2 }],
    toolRequired: 'hammer', minBuildingSkill: 1, sessionsRequired: 3, energyPerSession: 12,
    baseDurability: 80, maxCapacity: 3, stormResistance: 0.5,
    effects: [
      { type: 'cold_protection', value: 0.6 },
      { type: 'energy_regen', value: 1.5 },
      { type: 'hunger_reduction', value: 0.8 },
    ],
    description: 'A solid wood cabin. Comfortable shelter for a small group.',
  },

  stone_house: {
    id: 'stone_house', name: 'stone house', category: 'shelter',
    materials: [{ resource: 'bricks', qty: 10 }, { resource: 'planks', qty: 4 }, { resource: 'rope', qty: 2 }],
    toolRequired: 'hammer', minBuildingSkill: 3, sessionsRequired: 5, energyPerSession: 15,
    baseDurability: 150, maxCapacity: 5, stormResistance: 0.85,
    effects: [
      { type: 'cold_protection', value: 0.9 },
      { type: 'energy_regen', value: 1.8 },
      { type: 'hunger_reduction', value: 0.7 },
      { type: 'storage_bonus', value: 2.0 },
    ],
    description: 'A sturdy brick house. Near-immune to storms. Room for many.',
  },

  smokehouse: {
    id: 'smokehouse', name: 'smokehouse', category: 'storage',
    materials: [{ resource: 'bricks', qty: 4 }, { resource: 'wood', qty: 3 }],
    toolRequired: 'hammer', minBuildingSkill: 2, sessionsRequired: 2, energyPerSession: 10,
    baseDurability: 60, maxCapacity: 1, stormResistance: 0.4,
    effects: [{ type: 'storage_bonus', value: 3.0 }],
    description: 'Smoke-dries food. Triples preservation time for food stored here.',
  },

  upgraded_workshop: {
    id: 'upgraded_workshop', name: 'improved workshop', category: 'workshop_upgrade',
    materials: [{ resource: 'planks', qty: 4 }, { resource: 'stone', qty: 3 }],
    toolRequired: 'hammer', minBuildingSkill: 2, sessionsRequired: 2, energyPerSession: 10,
    baseDurability: 80, maxCapacity: 2, stormResistance: 0.5,
    effects: [{ type: 'craft_speed', value: 0.7 }],
    description: 'Better workbench and tools. Crafting takes 30% less time here.',
  },

  watchtower: {
    id: 'watchtower', name: 'watchtower', category: 'defense',
    materials: [{ resource: 'wood', qty: 8 }, { resource: 'rope', qty: 3 }],
    toolRequired: 'hammer', minBuildingSkill: 2, sessionsRequired: 3, energyPerSession: 12,
    baseDurability: 60, maxCapacity: 1, stormResistance: 0.3,
    effects: [{ type: 'gather_bonus', value: 1.2 }],
    description: 'Overlooks the area. Nearby agents gather 20% more efficiently.',
  },

  community_hall: {
    id: 'community_hall', name: 'community hall', category: 'communal',
    materials: [{ resource: 'bricks', qty: 8 }, { resource: 'planks', qty: 6 }, { resource: 'rope', qty: 4 }],
    toolRequired: 'hammer', minBuildingSkill: 4, sessionsRequired: 6, energyPerSession: 15,
    baseDurability: 120, maxCapacity: 10, stormResistance: 0.7,
    effects: [
      { type: 'trade_bonus', value: 1.3 },
      { type: 'energy_regen', value: 1.3 },
    ],
    description: 'A large gathering place. Improves trade and rest for everyone nearby.',
  },
};


// --- Seasons ---
// How the world changes through the year. 30 game-days per season.

export const SEASON_LENGTH = 30; // game-days per season
export const SEASON_ORDER: Season[] = ['spring', 'summer', 'autumn', 'winter'];

export interface SeasonDef {
  temperature: { min: number; max: number };       // abstract 0-100
  weatherWeights: Record<string, number>;           // relative probability of each weather type
  coldDamagePerHour: number;                        // health lost per hour without shelter when temp < 20
  stormChance: number;                              // probability per weather check that weather is "storm"
  description: string;
}

export const SEASONS: Record<Season, SeasonDef> = {
  spring: {
    temperature: { min: 35, max: 65 },
    weatherWeights: { clear: 4, rain: 3, fog: 2, storm: 1 },
    coldDamagePerHour: 0,
    stormChance: 0.1,
    description: 'Mild and wet. Farms begin producing. Herbs are plentiful.',
  },
  summer: {
    temperature: { min: 60, max: 95 },
    weatherWeights: { clear: 5, heatwave: 2, storm: 2, rain: 1 },
    coldDamagePerHour: 0,
    stormChance: 0.15,
    description: 'Hot and productive. Peak farm output. Storms can be violent.',
  },
  autumn: {
    temperature: { min: 30, max: 60 },
    weatherWeights: { clear: 3, rain: 3, fog: 3, storm: 1 },
    coldDamagePerHour: 0,
    stormChance: 0.1,
    description: 'Cooling down. Mushrooms peak. Last chance to stockpile.',
  },
  winter: {
    temperature: { min: 0, max: 30 },
    weatherWeights: { snow: 4, storm: 3, fog: 2, clear: 1 },
    coldDamagePerHour: 0.5,
    stormChance: 0.25,
    description: 'Farms dead. Lake mostly frozen. Without shelter and stored food, you die.',
  },
};


// --- Action Resolution (Deterministic) ---
// Given an agent's intent, resolve the mechanical outcome without LLM.

export interface GatherAttemptResult {
  success: boolean;
  reason?: string;              // why it failed: "no stock left", "skill too low", "wrong season", "not enough energy"
  itemsGained: { resource: string; qty: number }[];
  skillXpGained: number;
  energySpent: number;
  durationMinutes: number;
}

export interface CraftAttemptResult {
  success: boolean;
  reason?: string;
  itemsConsumed: { resource: string; qty: number }[];
  itemsProduced: { resource: string; qty: number }[];
  skillXpGained: number;
  energySpent: number;
  durationMinutes: number;
}

export interface BuildSessionResult {
  success: boolean;
  reason?: string;
  materialsConsumed: { resource: string; qty: number }[];   // only consumed on first session
  sessionNumber: number;       // which session this was (1-based)
  totalSessions: number;       // how many sessions total
  complete: boolean;           // true if building is now done
  energySpent: number;
  skillXpGained: number;
}

/**
 * Resolve a gathering attempt. Pure function — caller applies results to world state.
 */
export function resolveGather(
  gatherDef: GatherDef,
  agentSkillLevel: number,
  agentEnergy: number,
  hasTool: boolean,
  currentSeason: Season,
  dailyGathersRemaining: number,
): GatherAttemptResult {
  // Check energy
  if (agentEnergy < gatherDef.energyCost) {
    return { success: false, reason: 'not enough energy', itemsGained: [], skillXpGained: 0, energySpent: 0, durationMinutes: 0 };
  }

  // Check skill minimum
  if (agentSkillLevel < gatherDef.minSkillLevel) {
    return { success: false, reason: `need ${gatherDef.skill} level ${gatherDef.minSkillLevel}`, itemsGained: [], skillXpGained: 0, energySpent: 0, durationMinutes: 0 };
  }

  // Check daily stock
  if (dailyGathersRemaining <= 0) {
    return { success: false, reason: 'nothing left to gather here today', itemsGained: [], skillXpGained: 0, energySpent: gatherDef.energyCost, durationMinutes: gatherDef.baseDuration };
  }

  // Season multiplier
  const seasonMul = gatherDef.seasonModifier?.[currentSeason] ?? 1.0;
  if (seasonMul <= 0) {
    return { success: false, reason: `nothing grows here in ${currentSeason}`, itemsGained: [], skillXpGained: 0, energySpent: gatherDef.energyCost * 0.5, durationMinutes: gatherDef.baseDuration * 0.5 };
  }

  // Success chance: base + 5% per skill level, capped at 95%
  const successChance = Math.min(0.95, gatherDef.baseSuccessChance + agentSkillLevel * 0.05);
  const roll = Math.random();

  if (roll > successChance) {
    // Failed attempt — no energy cost so agents can retry without death-spiralling
    return {
      success: false, reason: 'found nothing this time',
      itemsGained: [],
      skillXpGained: Math.floor(SKILLS[gatherDef.skill]?.xpPerSuccess * 0.3) || 1,
      energySpent: 0,
      durationMinutes: gatherDef.baseDuration,
    };
  }

  // Calculate yield
  const items: { resource: string; qty: number }[] = [];
  for (const y of gatherDef.yields) {
    let baseQty = y.minQty + Math.floor(Math.random() * (y.maxQty - y.minQty + 1));
    // Skill bonus: +1 per 3 skill levels
    baseQty += Math.floor(agentSkillLevel / 3);
    // Tool bonus: double
    if (hasTool && gatherDef.toolBonus) baseQty *= 2;
    // Season modifier
    baseQty = Math.max(1, Math.round(baseQty * seasonMul));
    items.push({ resource: y.resource, qty: baseQty });
  }

  return {
    success: true,
    itemsGained: items,
    skillXpGained: SKILLS[gatherDef.skill]?.xpPerSuccess || 10,
    energySpent: gatherDef.energyCost,
    durationMinutes: gatherDef.baseDuration,
  };
}

/**
 * Resolve a crafting/cooking attempt. Pure function.
 */
export function resolveCraft(
  recipe: RecipeDef,
  agentSkillLevel: number,
  agentEnergy: number,
  agentInventory: { resource: string; qty: number }[],
  hasTool: boolean,
): CraftAttemptResult {
  // Check energy
  if (agentEnergy < recipe.energyCost) {
    return { success: false, reason: 'not enough energy', itemsConsumed: [], itemsProduced: [], skillXpGained: 0, energySpent: 0, durationMinutes: 0 };
  }

  // Check skill
  if (agentSkillLevel < recipe.minSkillLevel) {
    return { success: false, reason: `need ${recipe.skill} level ${recipe.minSkillLevel}`, itemsConsumed: [], itemsProduced: [], skillXpGained: 0, energySpent: 0, durationMinutes: 0 };
  }

  // Check tool
  if (recipe.toolRequired && !hasTool) {
    return { success: false, reason: `need a ${recipe.toolRequired}`, itemsConsumed: [], itemsProduced: [], skillXpGained: 0, energySpent: 0, durationMinutes: 0 };
  }

  // Check ingredients
  for (const input of recipe.inputs) {
    const have = agentInventory.find(i => i.resource === input.resource);
    if (!have || have.qty < input.qty) {
      return { success: false, reason: `need ${input.qty} ${input.resource} (have ${have?.qty ?? 0})`, itemsConsumed: [], itemsProduced: [], skillXpGained: 0, energySpent: 0, durationMinutes: 0 };
    }
  }

  // Consume inputs
  const consumed = recipe.inputs.map(i => ({ resource: i.resource, qty: i.qty }));

  // Produce outputs (skill bonus: chance of +1 for every 2 skill levels above minimum)
  const produced = recipe.outputs.map(o => {
    let qty = o.qty;
    if (recipe.skillBonusYield) {
      const bonusLevels = agentSkillLevel - recipe.minSkillLevel;
      const bonusChance = Math.min(0.5, bonusLevels * 0.1);
      if (Math.random() < bonusChance) qty += 1;
    }
    return { resource: o.resource, qty };
  });

  return {
    success: true,
    itemsConsumed: consumed,
    itemsProduced: produced,
    skillXpGained: SKILLS[recipe.skill]?.xpPerSuccess || 15,
    energySpent: recipe.energyCost,
    durationMinutes: recipe.duration,
  };
}


// --- Teaching ---

export interface TeachResult {
  success: boolean;
  reason?: string;
  skill: string;
  studentNewLevel: number;
  xpGained: number;
  durationMinutes: number;
}

export function resolveTeach(
  skill: string,
  teacherLevel: number,
  studentLevel: number,
): TeachResult {
  const minTeacherLevel = 3;
  if (teacherLevel < minTeacherLevel) {
    return { success: false, reason: `teacher needs ${skill} level ${minTeacherLevel}+`, skill, studentNewLevel: studentLevel, xpGained: 0, durationMinutes: 0 };
  }

  // Student gains up to teacher level minus 1
  const maxStudentLevel = teacherLevel - 1;
  if (studentLevel >= maxStudentLevel) {
    return { success: false, reason: `student already at level ${studentLevel}, teacher can only teach up to ${maxStudentLevel}`, skill, studentNewLevel: studentLevel, xpGained: 0, durationMinutes: 0 };
  }

  // Teaching grants enough XP to reach next level (or close to it)
  const skillDef = SKILLS[skill];
  if (!skillDef) {
    return { success: false, reason: `unknown skill: ${skill}`, skill, studentNewLevel: studentLevel, xpGained: 0, durationMinutes: 0 };
  }

  const xpGained = Math.floor(skillDef.xpPerLevel * 0.8); // 80% of a level per teaching session
  const newLevel = Math.min(maxStudentLevel, studentLevel + 1);

  return {
    success: true,
    skill,
    studentNewLevel: newLevel,
    xpGained,
    durationMinutes: 60,
  };
}


// --- Trade ---

export interface TradeProposal {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  offering: { resource: string; qty: number }[];
  requesting: { resource: string; qty: number }[];
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: number;
  expiresAt: number;           // auto-expire if not resolved
  conversationId?: string;     // the conversation where this was proposed
}

export interface TradeResult {
  success: boolean;
  reason?: string;
  fromGave: { resource: string; qty: number }[];
  toGave: { resource: string; qty: number }[];
}

export function validateTrade(
  proposal: TradeProposal,
  fromInventory: { resource: string; qty: number }[],
  toInventory: { resource: string; qty: number }[],
): TradeResult {
  // Check the offering agent has what they're offering
  for (const item of proposal.offering) {
    const have = fromInventory.find(i => i.resource === item.resource);
    if (!have || have.qty < item.qty) {
      return { success: false, reason: `${proposal.fromAgentId} doesn't have ${item.qty} ${item.resource}`, fromGave: [], toGave: [] };
    }
  }

  // Check the receiving agent has what's being requested
  for (const item of proposal.requesting) {
    const have = toInventory.find(i => i.resource === item.resource);
    if (!have || have.qty < item.qty) {
      return { success: false, reason: `${proposal.toAgentId} doesn't have ${item.qty} ${item.resource}`, fromGave: [], toGave: [] };
    }
  }

  return {
    success: true,
    fromGave: proposal.offering,
    toGave: proposal.requesting,
  };
}


// --- Lookup helpers ---

export function getGatherOptions(location: string): GatherDef[] {
  return GATHERING.filter(g => g.location === location);
}

export function getRecipeOptions(location: string, skill: string, skillLevel: number): RecipeDef[] {
  return RECIPES.filter(r =>
    r.location === location &&
    r.skill === skill &&
    r.minSkillLevel <= skillLevel
  );
}

export function getAvailableRecipes(location: string, agentSkills: Record<string, number>): RecipeDef[] {
  return RECIPES.filter(r =>
    r.location === location &&
    (agentSkills[r.skill] ?? 0) >= r.minSkillLevel
  );
}

export function getBuildableStructures(agentBuildingSkill: number): BuildingDef[] {
  return Object.values(BUILDINGS).filter(b => agentBuildingSkill >= b.minBuildingSkill);
}

export function getResourceDef(id: string): ResourceDef | undefined {
  return RESOURCES[id];
}
