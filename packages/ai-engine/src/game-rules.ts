/**
 * Auto-generate the game rules text from actual code definitions.
 * This is the ONLY description of the world the LLM receives.
 * If it's not here, it doesn't exist for the agent.
 *
 * Call once at startup. Cache the result.
 */

import { RESOURCES, RECIPES, GATHERING, SEASONS, SEASON_ORDER } from './world-rules.js';

export function buildGameRules(): string {
  const sections: string[] = [];

  // ═══ PREAMBLE ═══
  sections.push(`YOU ARE A CHARACTER IN A SURVIVAL VILLAGE.

You have a body. It hungers, tires, and can die. Death is permanent — no respawn, no second chance. Everything you built dies with you.

Each turn you pick ONE action from a menu. The menu shows everything you can do right now. If an action is not in your menu, you cannot do it.

Your action menu IS your reality.`);

  // ═══ DEATH & VITALS ═══
  sections.push(`DEATH & VITALS:
Hunger and health are scored 0–100. Hunger rises ~1/hour while awake (+0.3/hour sleeping outdoors; property owners sleep at no hunger cost).
At hunger ≥70, health drains slowly. At hunger ≥85, health drains faster. At health 0, you die permanently — you lose everything. No resurrection.
- Hunger: 0 (full) → 100 (starving). Eating food reduces it by the food's nutrition value.
- Energy: 0 (exhausted) → 100 (fresh). Actions cost energy. rest recovers +15. sleep recovers +40. Energy ≤5 drains health.
- Health: 0 (dead) → 100 (healthy). Passive regen +2/hour when hunger <70 and energy >20. Medicine heals directly.`);

  // ═══ FOOD TABLE ═══
  const rawFood = Object.values(RESOURCES).filter(r => (r.type === 'raw' || r.type === 'food') && r.nutritionValue > 0);
  rawFood.sort((a, b) => b.nutritionValue - a.nutritionValue);

  let foodTable = 'FOOD (eat to reduce hunger):\n';
  foodTable += 'Item             | Hunger | Energy | Heal  | Spoils | Notes\n';
  foodTable += '-----------------|--------|--------|-------|--------|------\n';

  for (const r of rawFood) {
    const name = r.name.padEnd(16);
    const nut = ('-' + r.nutritionValue).padEnd(7);
    const eng = (r.energyValue ? '+' + r.energyValue : '-').padEnd(7);
    const heal = (r.healValue ? '+' + r.healValue : '-').padEnd(6);
    const spoil = (r.spoilDays + 'd').padEnd(7);
    foodTable += `${name} | ${nut} | ${eng} | ${heal} | ${spoil} | ${r.description}\n`;
  }

  sections.push(foodTable.trim());

  // ═══ MATERIALS ═══
  const materials = Object.values(RESOURCES).filter(r => r.type === 'material');
  let matSection = 'MATERIALS (for crafting, not edible):';
  for (const r of materials) {
    matSection += `\n• ${r.name} — ${r.description}`;
  }
  sections.push(matSection);

  // ═══ TOOLS ═══
  const tools = Object.values(RESOURCES).filter(r => r.type === 'tool');
  let toolSection = 'TOOLS (improve actions):';
  for (const r of tools) {
    toolSection += `\n• ${r.name} — ${r.description}`;
  }
  sections.push(toolSection);

  // ═══ MEDICINE ═══
  const medicine = Object.values(RESOURCES).filter(r => r.type === 'medicine');
  let medSection = 'MEDICINE:';
  for (const r of medicine) {
    medSection += `\n• ${r.name} — heals ${r.healValue} hp. ${r.description}`;
  }
  sections.push(medSection);

  // ═══ GATHERING TABLE ═══
  let gatherTable = 'WHERE TO FIND RESOURCES:\n';
  gatherTable += 'Location       | Resource    | Chance | Yield   | Stock/day | Skill needed  | Tool bonus\n';
  gatherTable += '---------------|-------------|--------|---------|-----------|---------------|----------\n';

  for (const g of GATHERING) {
    const loc = g.location.padEnd(14);
    const res = g.yields[0].resource.padEnd(12);
    const chance = (Math.round(g.baseSuccessChance * 100) + '%').padEnd(7);
    const yieldStr = (g.yields[0].minQty + '-' + g.yields[0].maxQty).padEnd(8);
    const stock = (g.dailyStock + '/day').padEnd(10);
    const skill = g.minSkillLevel > 0
      ? (`${g.skill} lv${g.minSkillLevel}`).padEnd(14)
      : 'none'.padEnd(14);
    const tool = g.toolBonus ? `${g.toolBonus} (2x yield)` : '-';
    gatherTable += `${loc} | ${res} | ${chance} | ${yieldStr} | ${stock} | ${skill} | ${tool}\n`;
  }

  gatherTable += '\nDaily limits are shared across ALL agents. If 10 people gather wheat, the farm runs out faster.';
  gatherTable += '\nSuccess improves +5% per skill level (capped at 95%).';

  sections.push(gatherTable.trim());

  // ═══ RECIPES TABLE ═══
  let recipeTable = 'CRAFTING RECIPES:\n';
  recipeTable += 'Recipe              | Where     | Ingredients                  | Produces          | Skill        | Tool needed\n';
  recipeTable += '--------------------|-----------|------------------------------|-------------------|--------------|----------\n';

  for (const r of RECIPES) {
    const name = r.name.padEnd(19);
    const loc = r.location.padEnd(9);
    const inputs = r.inputs.map(i => `${i.qty}x ${i.resource}`).join(' + ').padEnd(29);
    const outputs = r.outputs.map(o => `${o.qty}x ${o.resource}`).join(', ').padEnd(18);
    const skill = (`${r.skill} lv${r.minSkillLevel}`).padEnd(13);
    const tool = r.toolRequired || '-';
    recipeTable += `${name} | ${loc} | ${inputs} | ${outputs} | ${skill} | ${tool}\n`;
  }

  sections.push(recipeTable.trim());

  // ═══ HUNGER MATH ═══
  sections.push(`HUNGER & SURVIVAL MATH:
• Hunger rises ~1 per hour (~24 per day)
• At hunger 70+, health starts draining
• At health 0, you die
• Raw wheat (-15 hunger) = need ~2/day just to break even
• Bread (-20) or stew (-30) are significantly more efficient
• On raw wheat alone, you fall behind by ~9 hunger/day
• Cooking is not optional — it's survival arithmetic`);

  // ═══ SEASONS ═══
  let seasonSection = 'SEASONS (30 days each):';
  for (const name of SEASON_ORDER) {
    const def = SEASONS[name];
    const mults = def.gatherMultipliers;
    const multStr = Object.entries(mults).map(([k, v]) => `${k} ${v}x`).join(', ');
    seasonSection += `\n• ${name}: ${def.description} Multipliers: ${multStr}.`;
    if (def.coldDamagePerHour > 0) {
      seasonSection += ` Cold damage: ${def.coldDamagePerHour}/hour without shelter.`;
    }
  }
  sections.push(seasonSection);

  // ═══ ACTIONS ═══
  sections.push(`YOUR POSSIBLE ACTIONS:

Physical (depends on location and inventory):
• gather_[resource] — collect a resource at this location
• eat_[food] — eat food you're carrying
• craft_[recipe] — combine ingredients (at the right location)
• rest — recover energy

Social (requires someone at your location, replace NAME with first name in lowercase):
• talk_NAME — start a conversation
• give_NAME — hand items to them. Rep +3
• trade_NAME — propose a swap. Rep +2 each on success
• steal_NAME — take from them (40% success). Rep -10. Public news
• fight_NAME — attack (both take damage 5-14). Rep -8. Public news
• confront_NAME — public confrontation, forces response
• threaten_NAME — public threat. Rep -3
• ally_NAME — create/invite to group. Trust +20 both ways
• betray_NAME — leave shared group. Trust -30 with all members. Public news
• kick_NAME — (leaders only) expel member. Rep -5 for kicked

Community:
• post_board — write a public message on village board
• propose_rule — suggest a rule (village votes at end of day, majority passes, max 1/day)
• propose_group_rule — (leaders only) set group rule directly
• call_meeting — summon nearby agents (3+ needed)
• claim_AREA — propose claiming unclaimed area. Goes to vote

Movement:
• go_[location] — walk to a known place

Every action on this list is a real game mechanic. There are no other actions. If you want to do something not on this list, you cannot.`);

  // ═══ HOW THE WORLD WORKS ═══
  sections.push(`HOW THE WORLD WORKS:

Items: All items are in personal inventories. You carry what you have. give moves one item from you to someone at your location. There is no shared storage.

Rules: Anyone can propose a rule. Every rule must specify what action is required, who it applies to, and what happens to violators. Everyone votes at day's end. Majority passes. Passed rules are shown to everyone on every decision. Violating costs rep -10.

Groups: ally_NAME creates or invites. Leader can kick and set rules. betray_NAME leaves. Dissolves at ≤1 member. Roles are social labels — they don't change your action menu.

Property: Claim via claim_AREA, village votes. Owners sleep with no overnight hunger. Trespassers lose reputation.

Board: Public message wall. Announcements, accusations, proposals. Everyone reads it.

Interaction: You can only interact with people at your location. You don't know where others are unless you go look. Board posts are the only way to reach everyone.

Promises: Tracked. Your fulfillment rate affects reputation. Only promise things you can do with the actions above.

Reputation: Public score. Adjusted by: generosity (+3), fair trade (+2), threatening (-3), theft (-10), violence (-8), rule violation (-10).

Skills: farming, fishing, foraging, cooking, crafting, building, medicine, woodwork. Level 0–10. Higher = better success (+5%/level) and bonus yield.

KEY PRINCIPLE: Every action listed above is a real mechanic with real consequences. Stealing, fighting, threatening, and betrayal are valid choices for the right character. Your character is not obligated to be good — they are obligated to be REAL.`);

  return sections.join('\n\n');
}
