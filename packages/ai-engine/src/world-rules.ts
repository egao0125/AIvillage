// ============================================================================
// AI Village — World Rules v1
// All game data + pure resolution functions. No side effects, no LLM.
// The LLM decides what to attempt. These rules decide what happens.
// ============================================================================

import type { Season } from '@ai-village/shared';
export type { Season };

// --- Types ---

export interface ResourceDef {
  id: string;
  name: string;
  type: 'food' | 'material' | 'tool' | 'medicine';
  weight: number;
  tradeValue: number;
  nutritionValue: number;   // 0 for non-food
  healValue: number;        // 0 for non-medicine
  spoilDays: number;        // 0 = never spoils
}

export interface GatherDef {
  id: string;
  description: string;
  location: string;
  skill: string;
  yields: { resource: string; baseQty: number; bonusQty: number }[];
  dailyStock: number;
  toolBonus?: string;
  seasonModifiers: Record<Season, number>;
  energyCost: number;
  durationMinutes: number;
  minSkillLevel: number;
}

export interface RecipeDef {
  id: string;
  name: string;
  location: string;
  skill: string;
  minSkillLevel: number;
  ingredients: { resource: string; qty: number }[];
  outputs: { resource: string; qty: number }[];
  toolRequired?: string;
  energyCost: number;
  durationMinutes: number;
}

export interface BuildingDef {
  id: string;
  name: string;
  materials: { resource: string; qty: number }[];
  toolRequired: string;
  minBuildingSkill: number;
  sessionsRequired: number;
  energyPerSession: number;
  capacity: number;
  coldProtection: number;
  stormResistance: number;
  effect?: string;
}

export interface SkillDef {
  id: string;
  name: string;
  xpPerSuccess: number;
  xpPerLevel: number;
  maxLevel: number;
  minTeachLevel: number;
}

export interface TradeProposal {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  offering: { resource: string; qty: number }[];
  requesting: { resource: string; qty: number }[];
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  expiresAt: number;
}

// --- Resources (9 raw + crafted) ---

export const RESOURCES: Record<string, ResourceDef> = {
  // Raw resources
  wheat:      { id: 'wheat',      name: 'Wheat',      type: 'food',     weight: 1, tradeValue: 2, nutritionValue: 5,  healValue: 0, spoilDays: 5 },
  vegetables: { id: 'vegetables', name: 'Vegetables', type: 'food',     weight: 1, tradeValue: 2, nutritionValue: 6,  healValue: 0, spoilDays: 3 },
  fish:       { id: 'fish',       name: 'Fish',       type: 'food',     weight: 2, tradeValue: 3, nutritionValue: 8,  healValue: 0, spoilDays: 1 },
  mushrooms:  { id: 'mushrooms',  name: 'Mushrooms',  type: 'food',     weight: 1, tradeValue: 2, nutritionValue: 4,  healValue: 0, spoilDays: 2 },
  herbs:      { id: 'herbs',      name: 'Herbs',      type: 'material', weight: 1, tradeValue: 3, nutritionValue: 0,  healValue: 0, spoilDays: 7 },
  flowers:    { id: 'flowers',    name: 'Flowers',    type: 'material', weight: 1, tradeValue: 1, nutritionValue: 0,  healValue: 0, spoilDays: 3 },
  wood:       { id: 'wood',       name: 'Wood',       type: 'material', weight: 3, tradeValue: 2, nutritionValue: 0,  healValue: 0, spoilDays: 0 },
  clay:       { id: 'clay',       name: 'Clay',       type: 'material', weight: 4, tradeValue: 2, nutritionValue: 0,  healValue: 0, spoilDays: 0 },
  stone:      { id: 'stone',      name: 'Stone',      type: 'material', weight: 5, tradeValue: 3, nutritionValue: 0,  healValue: 0, spoilDays: 0 },

  // Crafted foods
  bread:         { id: 'bread',         name: 'Bread',             type: 'food',     weight: 1, tradeValue: 5,  nutritionValue: 12, healValue: 0, spoilDays: 7 },
  stew:          { id: 'stew',          name: 'Stew',              type: 'food',     weight: 2, tradeValue: 8,  nutritionValue: 18, healValue: 0, spoilDays: 3 },
  dried_fish:    { id: 'dried_fish',    name: 'Dried Fish',        type: 'food',     weight: 1, tradeValue: 5,  nutritionValue: 7,  healValue: 0, spoilDays: 20 },
  pickled_veg:   { id: 'pickled_veg',   name: 'Pickled Vegetables',type: 'food',     weight: 2, tradeValue: 6,  nutritionValue: 10, healValue: 0, spoilDays: 30 },
  herb_tea:      { id: 'herb_tea',      name: 'Herb Tea',          type: 'food',     weight: 1, tradeValue: 4,  nutritionValue: 3,  healValue: 5, spoilDays: 5 },

  // Crafted materials
  bricks:  { id: 'bricks',  name: 'Bricks',  type: 'material', weight: 5, tradeValue: 5, nutritionValue: 0, healValue: 0, spoilDays: 0 },
  planks:  { id: 'planks',  name: 'Planks',  type: 'material', weight: 2, tradeValue: 4, nutritionValue: 0, healValue: 0, spoilDays: 0 },
  rope:    { id: 'rope',    name: 'Rope',    type: 'material', weight: 1, tradeValue: 4, nutritionValue: 0, healValue: 0, spoilDays: 0 },

  // Medicine
  poultice: { id: 'poultice', name: 'Poultice', type: 'medicine', weight: 1, tradeValue: 6, nutritionValue: 0, healValue: 20, spoilDays: 10 },

  // Tools (never spoil)
  fishing_rod: { id: 'fishing_rod', name: 'Fishing Rod', type: 'tool', weight: 2, tradeValue: 8,  nutritionValue: 0, healValue: 0, spoilDays: 0 },
  hoe:         { id: 'hoe',         name: 'Hoe',         type: 'tool', weight: 3, tradeValue: 8,  nutritionValue: 0, healValue: 0, spoilDays: 0 },
  axe:         { id: 'axe',         name: 'Axe',         type: 'tool', weight: 3, tradeValue: 10, nutritionValue: 0, healValue: 0, spoilDays: 0 },
  hammer:      { id: 'hammer',      name: 'Hammer',      type: 'tool', weight: 3, tradeValue: 10, nutritionValue: 0, healValue: 0, spoilDays: 0 },
  mortar:      { id: 'mortar',      name: 'Mortar',      type: 'tool', weight: 4, tradeValue: 7,  nutritionValue: 0, healValue: 0, spoilDays: 0 },
};


// --- Skills ---

export const SKILLS: Record<string, SkillDef> = {
  farming:     { id: 'farming',     name: 'Farming',     xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10, minTeachLevel: 3 },
  fishing:     { id: 'fishing',     name: 'Fishing',     xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10, minTeachLevel: 3 },
  foraging:    { id: 'foraging',    name: 'Foraging',    xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10, minTeachLevel: 3 },
  woodcutting: { id: 'woodcutting', name: 'Woodcutting', xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10, minTeachLevel: 3 },
  cooking:     { id: 'cooking',     name: 'Cooking',     xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10, minTeachLevel: 3 },
  crafting:    { id: 'crafting',    name: 'Crafting',    xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10, minTeachLevel: 3 },
  building:    { id: 'building',    name: 'Building',    xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10, minTeachLevel: 3 },
  herbalism:   { id: 'herbalism',   name: 'Herbalism',   xpPerSuccess: 10, xpPerLevel: 50, maxLevel: 10, minTeachLevel: 3 },
};


// --- Gathering Sources ---

const ALL_SEASONS: Record<Season, number> = { spring: 1.0, summer: 1.0, autumn: 1.0, winter: 1.0 };

export const GATHERING: GatherDef[] = [
  {
    id: 'farm_wheat', description: 'Harvest wheat from the fields',
    location: 'farm', skill: 'farming',
    yields: [{ resource: 'wheat', baseQty: 2, bonusQty: 1 }],
    dailyStock: 12, toolBonus: 'hoe',
    seasonModifiers: { spring: 1.0, summer: 1.2, autumn: 0.8, winter: 0.0 },
    energyCost: 8, durationMinutes: 20, minSkillLevel: 0,
  },
  {
    id: 'farm_veg', description: 'Pick vegetables from the garden plots',
    location: 'farm', skill: 'farming',
    yields: [{ resource: 'vegetables', baseQty: 2, bonusQty: 1 }],
    dailyStock: 8, toolBonus: 'hoe',
    seasonModifiers: { spring: 1.2, summer: 1.0, autumn: 0.8, winter: 0.0 },
    energyCost: 8, durationMinutes: 20, minSkillLevel: 0,
  },
  {
    id: 'lake_fish', description: 'Fish in the lake',
    location: 'lake', skill: 'fishing',
    yields: [{ resource: 'fish', baseQty: 1, bonusQty: 1 }],
    dailyStock: 10, toolBonus: 'fishing_rod',
    seasonModifiers: { spring: 1.0, summer: 1.2, autumn: 1.0, winter: 0.1 },
    energyCost: 10, durationMinutes: 30, minSkillLevel: 0,
  },
  {
    id: 'lake_clay', description: 'Dig clay from the lake banks',
    location: 'lake', skill: 'foraging',
    yields: [{ resource: 'clay', baseQty: 2, bonusQty: 1 }],
    dailyStock: 6,
    seasonModifiers: { spring: 1.0, summer: 1.0, autumn: 1.0, winter: 0.5 },
    energyCost: 12, durationMinutes: 25, minSkillLevel: 0,
  },
  {
    id: 'forest_wood', description: 'Chop wood in the forest',
    location: 'forest', skill: 'woodcutting',
    yields: [{ resource: 'wood', baseQty: 2, bonusQty: 1 }],
    dailyStock: 15, toolBonus: 'axe',
    seasonModifiers: { spring: 1.0, summer: 1.0, autumn: 1.0, winter: 0.7 },
    energyCost: 12, durationMinutes: 25, minSkillLevel: 0,
  },
  {
    id: 'forest_mushrooms', description: 'Forage for mushrooms',
    location: 'forest', skill: 'foraging',
    yields: [{ resource: 'mushrooms', baseQty: 2, bonusQty: 1 }],
    dailyStock: 8,
    seasonModifiers: { spring: 0.8, summer: 1.0, autumn: 1.5, winter: 0.0 },
    energyCost: 6, durationMinutes: 20, minSkillLevel: 0,
  },
  {
    id: 'garden_herbs', description: 'Gather herbs from the garden',
    location: 'garden', skill: 'foraging',
    yields: [{ resource: 'herbs', baseQty: 2, bonusQty: 1 }],
    dailyStock: 8,
    seasonModifiers: { spring: 1.2, summer: 1.0, autumn: 0.8, winter: 0.3 },
    energyCost: 6, durationMinutes: 15, minSkillLevel: 0,
  },
  {
    id: 'garden_flowers', description: 'Pick flowers',
    location: 'garden', skill: 'foraging',
    yields: [{ resource: 'flowers', baseQty: 2, bonusQty: 1 }],
    dailyStock: 6,
    seasonModifiers: { spring: 1.5, summer: 1.2, autumn: 0.5, winter: 0.0 },
    energyCost: 4, durationMinutes: 10, minSkillLevel: 0,
  },
  {
    id: 'quarry_stone', description: 'Collect stone from the southern woods',
    location: 'forest_south', skill: 'foraging',
    yields: [{ resource: 'stone', baseQty: 1, bonusQty: 1 }],
    dailyStock: 6,
    seasonModifiers: { spring: 1.0, summer: 1.0, autumn: 1.0, winter: 0.5 },
    energyCost: 15, durationMinutes: 30, minSkillLevel: 0,
  },
];


// --- Recipes (foods + materials + tools + medicine) ---

export const RECIPES: RecipeDef[] = [
  // Crafted foods
  { id: 'bake_bread',    name: 'Bake Bread',           location: 'bakery',   skill: 'cooking',  minSkillLevel: 1, ingredients: [{ resource: 'wheat', qty: 2 }],                                              outputs: [{ resource: 'bread', qty: 1 }],        energyCost: 5,  durationMinutes: 20 },
  { id: 'cook_stew',     name: 'Cook Stew',            location: 'cafe',     skill: 'cooking',  minSkillLevel: 2, ingredients: [{ resource: 'vegetables', qty: 1 }, { resource: 'fish', qty: 1 }],             outputs: [{ resource: 'stew', qty: 1 }],         energyCost: 6,  durationMinutes: 25 },
  { id: 'dry_fish',      name: 'Dry Fish',             location: 'cafe',     skill: 'cooking',  minSkillLevel: 1, ingredients: [{ resource: 'fish', qty: 2 }],                                                outputs: [{ resource: 'dried_fish', qty: 1 }],   energyCost: 4,  durationMinutes: 15 },
  { id: 'pickle_veg',    name: 'Pickle Vegetables',    location: 'cafe',     skill: 'cooking',  minSkillLevel: 2, ingredients: [{ resource: 'vegetables', qty: 2 }, { resource: 'herbs', qty: 1 }],            outputs: [{ resource: 'pickled_veg', qty: 1 }],  energyCost: 5,  durationMinutes: 20 },
  { id: 'brew_tea',      name: 'Brew Herb Tea',        location: 'cafe',     skill: 'cooking',  minSkillLevel: 1, ingredients: [{ resource: 'herbs', qty: 1 }],                                               outputs: [{ resource: 'herb_tea', qty: 1 }],     energyCost: 3,  durationMinutes: 10 },

  // Crafted materials
  { id: 'fire_bricks',   name: 'Fire Bricks',          location: 'bakery',   skill: 'crafting', minSkillLevel: 1, ingredients: [{ resource: 'clay', qty: 3 }],                                                outputs: [{ resource: 'bricks', qty: 2 }],       energyCost: 8,  durationMinutes: 30 },
  { id: 'cut_planks',    name: 'Cut Planks',           location: 'workshop', skill: 'crafting', minSkillLevel: 1, ingredients: [{ resource: 'wood', qty: 2 }],                                                outputs: [{ resource: 'planks', qty: 2 }],       energyCost: 8,  durationMinutes: 20, toolRequired: 'axe' },
  { id: 'make_rope',     name: 'Make Rope',            location: 'workshop', skill: 'crafting', minSkillLevel: 1, ingredients: [{ resource: 'herbs', qty: 2 }],                                               outputs: [{ resource: 'rope', qty: 1 }],         energyCost: 5,  durationMinutes: 15 },

  // Tools
  { id: 'make_fishing_rod', name: 'Make Fishing Rod',  location: 'workshop', skill: 'crafting', minSkillLevel: 1, ingredients: [{ resource: 'wood', qty: 2 }, { resource: 'rope', qty: 1 }],                  outputs: [{ resource: 'fishing_rod', qty: 1 }],  energyCost: 6,  durationMinutes: 20 },
  { id: 'make_hoe',         name: 'Make Hoe',          location: 'workshop', skill: 'crafting', minSkillLevel: 1, ingredients: [{ resource: 'wood', qty: 1 }, { resource: 'stone', qty: 1 }],                  outputs: [{ resource: 'hoe', qty: 1 }],          energyCost: 6,  durationMinutes: 20 },
  { id: 'make_axe',         name: 'Make Axe',          location: 'workshop', skill: 'crafting', minSkillLevel: 2, ingredients: [{ resource: 'wood', qty: 2 }, { resource: 'stone', qty: 1 }, { resource: 'rope', qty: 1 }], outputs: [{ resource: 'axe', qty: 1 }], energyCost: 8, durationMinutes: 25 },
  { id: 'make_hammer',      name: 'Make Hammer',       location: 'workshop', skill: 'crafting', minSkillLevel: 2, ingredients: [{ resource: 'wood', qty: 1 }, { resource: 'stone', qty: 1 }, { resource: 'rope', qty: 1 }], outputs: [{ resource: 'hammer', qty: 1 }], energyCost: 8, durationMinutes: 25 },
  { id: 'make_mortar',      name: 'Make Mortar',       location: 'workshop', skill: 'crafting', minSkillLevel: 1, ingredients: [{ resource: 'stone', qty: 1 }, { resource: 'clay', qty: 1 }],                  outputs: [{ resource: 'mortar', qty: 1 }],       energyCost: 5,  durationMinutes: 15 },

  // Medicine
  { id: 'make_poultice', name: 'Make Poultice',        location: 'clinic',   skill: 'herbalism', minSkillLevel: 1, ingredients: [{ resource: 'herbs', qty: 2 }],                                              outputs: [{ resource: 'poultice', qty: 1 }],     energyCost: 4,  durationMinutes: 15, toolRequired: 'mortar' },
];


// --- Buildings ---

export const BUILDINGS: Record<string, BuildingDef> = {
  lean_to:         { id: 'lean_to',         name: 'Lean-To',         materials: [{ resource: 'wood', qty: 5 }],                                                                              toolRequired: 'none',   minBuildingSkill: 0, sessionsRequired: 1, energyPerSession: 10, capacity: 2,  coldProtection: 30, stormResistance: 10 },
  wood_shelter:    { id: 'wood_shelter',    name: 'Wood Shelter',    materials: [{ resource: 'wood', qty: 10 }, { resource: 'rope', qty: 1 }],                                                toolRequired: 'none',   minBuildingSkill: 1, sessionsRequired: 2, energyPerSession: 12, capacity: 3,  coldProtection: 50, stormResistance: 30 },
  wood_house:      { id: 'wood_house',      name: 'Wood House',      materials: [{ resource: 'planks', qty: 4 }, { resource: 'rope', qty: 2 }],                                              toolRequired: 'hammer', minBuildingSkill: 2, sessionsRequired: 3, energyPerSession: 15, capacity: 4,  coldProtection: 60, stormResistance: 50 },
  stone_house:     { id: 'stone_house',     name: 'Stone House',     materials: [{ resource: 'bricks', qty: 10 }, { resource: 'planks', qty: 4 }, { resource: 'rope', qty: 2 }],             toolRequired: 'hammer', minBuildingSkill: 3, sessionsRequired: 4, energyPerSession: 18, capacity: 5,  coldProtection: 90, stormResistance: 80 },
  storehouse:      { id: 'storehouse',      name: 'Storehouse',      materials: [{ resource: 'planks', qty: 6 }, { resource: 'rope', qty: 2 }],                                              toolRequired: 'hammer', minBuildingSkill: 2, sessionsRequired: 2, energyPerSession: 12, capacity: 0,  coldProtection: 0,  stormResistance: 70, effect: 'doubles inventory cap for owner' },
  workshop_ext:    { id: 'workshop_ext',    name: 'Workshop Extension', materials: [{ resource: 'planks', qty: 4 }, { resource: 'bricks', qty: 3 }],                                         toolRequired: 'hammer', minBuildingSkill: 3, sessionsRequired: 3, energyPerSession: 15, capacity: 0,  coldProtection: 0,  stormResistance: 60, effect: '+1 crafting output at workshop' },
  community_hall:  { id: 'community_hall',  name: 'Community Hall',  materials: [{ resource: 'bricks', qty: 8 }, { resource: 'planks', qty: 6 }, { resource: 'rope', qty: 4 }],              toolRequired: 'hammer', minBuildingSkill: 4, sessionsRequired: 6, energyPerSession: 20, capacity: 12, coldProtection: 80, stormResistance: 70 },
};


// --- Resolution Functions (pure, no side effects) ---

export interface GatherResult {
  success: boolean;
  reason?: string;
  itemsGained: { resource: string; qty: number }[];
  energySpent: number;
  skillXpGained: number;
  durationMinutes: number;
}

export function resolveGather(
  def: GatherDef,
  skillLevel: number,
  energy: number,
  hasTool: boolean,
  season: Season,
  remainingStock: number,
): GatherResult {
  const fail = (reason: string): GatherResult => ({
    success: false, reason, itemsGained: [], energySpent: 0, skillXpGained: 0, durationMinutes: 0,
  });

  if (energy < def.energyCost) return fail('too tired');

  const seasonMod = def.seasonModifiers[season];
  if (seasonMod <= 0) return fail(`nothing grows here in ${season}`);

  if (remainingStock <= 0) return fail('already picked clean today — try again tomorrow');

  const items: { resource: string; qty: number }[] = [];
  for (const y of def.yields) {
    let qty = y.baseQty;
    if (skillLevel >= 3) qty += y.bonusQty;
    if (hasTool) qty *= 2;
    qty = Math.floor(qty * seasonMod);
    qty = Math.max(1, Math.min(qty, remainingStock));
    items.push({ resource: y.resource, qty });
  }

  const xp = SKILLS[def.skill]?.xpPerSuccess ?? 10;

  return {
    success: true,
    itemsGained: items,
    energySpent: def.energyCost,
    skillXpGained: xp,
    durationMinutes: def.durationMinutes,
  };
}


export interface CraftResult {
  success: boolean;
  reason?: string;
  itemsConsumed: { resource: string; qty: number }[];
  itemsProduced: { resource: string; qty: number }[];
  energySpent: number;
  skillXpGained: number;
  durationMinutes: number;
}

export function resolveCraft(
  recipe: RecipeDef,
  skillLevel: number,
  energy: number,
  inventory: { resource: string; qty: number }[],
  hasTool: boolean,
): CraftResult {
  const fail = (reason: string): CraftResult => ({
    success: false, reason, itemsConsumed: [], itemsProduced: [], energySpent: 0, skillXpGained: 0, durationMinutes: 0,
  });

  if (skillLevel < recipe.minSkillLevel) {
    return fail(`need ${recipe.skill} level ${recipe.minSkillLevel} (you have level ${skillLevel})`);
  }

  if (energy < recipe.energyCost) return fail('too tired');

  if (recipe.toolRequired && !hasTool) {
    return fail(`need a ${recipe.toolRequired}`);
  }

  for (const ing of recipe.ingredients) {
    const have = inventory.find(i => i.resource === ing.resource);
    if (!have || have.qty < ing.qty) {
      return fail(`need ${ing.qty} ${ing.resource} (have ${have?.qty ?? 0})`);
    }
  }

  const xp = SKILLS[recipe.skill]?.xpPerSuccess ?? 10;

  return {
    success: true,
    itemsConsumed: recipe.ingredients.map(i => ({ resource: i.resource, qty: i.qty })),
    itemsProduced: recipe.outputs.map(o => ({ resource: o.resource, qty: o.qty })),
    energySpent: recipe.energyCost,
    skillXpGained: xp,
    durationMinutes: recipe.durationMinutes,
  };
}


export interface TeachResult {
  success: boolean;
  reason?: string;
  studentNewLevel: number;
  durationMinutes: number;
}

export function resolveTeach(
  skillId: string,
  teacherLevel: number,
  studentLevel: number,
): TeachResult {
  const skillDef = SKILLS[skillId];
  if (!skillDef) {
    return { success: false, reason: `unknown skill: ${skillId}`, studentNewLevel: studentLevel, durationMinutes: 0 };
  }

  if (teacherLevel < skillDef.minTeachLevel) {
    return { success: false, reason: `need ${skillDef.name} level ${skillDef.minTeachLevel} to teach (you have ${teacherLevel})`, studentNewLevel: studentLevel, durationMinutes: 0 };
  }

  if (studentLevel >= teacherLevel) {
    return { success: false, reason: `student already knows as much as you`, studentNewLevel: studentLevel, durationMinutes: 0 };
  }

  if (studentLevel >= skillDef.maxLevel) {
    return { success: false, reason: `student already at max level`, studentNewLevel: studentLevel, durationMinutes: 0 };
  }

  return {
    success: true,
    studentNewLevel: studentLevel + 1,
    durationMinutes: 30,
  };
}


export interface TradeValidation {
  success: boolean;
  reason?: string;
}

export function validateTrade(
  proposal: TradeProposal,
  fromInventory: { resource: string; qty: number }[],
  toInventory: { resource: string; qty: number }[],
): TradeValidation {
  // Check proposer has what they're offering
  for (const item of proposal.offering) {
    const have = fromInventory.find(i => i.resource === item.resource);
    if (!have || have.qty < item.qty) {
      return { success: false, reason: `proposer doesn't have ${item.qty} ${item.resource}` };
    }
  }

  // Check acceptor has what's being requested
  for (const item of proposal.requesting) {
    const have = toInventory.find(i => i.resource === item.resource);
    if (!have || have.qty < item.qty) {
      return { success: false, reason: `acceptor doesn't have ${item.qty} ${item.resource}` };
    }
  }

  return { success: true };
}


// --- Query Functions ---

export function getGatherOptions(location: string): GatherDef[] {
  return GATHERING.filter(g => g.location === location);
}

export function getAvailableRecipes(location: string, skills: Record<string, number>): RecipeDef[] {
  return RECIPES.filter(r => r.location === location && (skills[r.skill] ?? 0) >= r.minSkillLevel);
}

export function getBuildableStructures(buildingLevel: number): BuildingDef[] {
  return Object.values(BUILDINGS).filter(b => b.minBuildingSkill <= buildingLevel);
}

export function getResourceDef(id: string): ResourceDef | undefined {
  return RESOURCES[id];
}
