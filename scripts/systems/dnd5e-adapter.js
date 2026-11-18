import { SystemAdapter } from './system-adapter.js';

export class Dnd5eAdapter extends SystemAdapter {
    constructor() {
        super();
        this.id = "dnd5e";
    }

    getActorData(actor) {
        // Базовый список статов для dnd5e
        const stats = [
            { id: "dex", label: "Ловкость (DEX)", mod: actor?.system.abilities.dex?.mod || 0 },
            { id: "str", label: "Сила (STR)", mod: actor?.system.abilities.str?.mod || 0 },
            { id: "int", label: "Интеллект (INT)", mod: actor?.system.abilities.int?.mod || 0 }
        ];

        if (!actor) {
            return {
                stats: stats,
                toolBonus: 0,
                toolName: null
            };
        }

        // Поиск инструментов вора (в инвентаре или в навыках владения инструментами)
        const lockpickTool = actor.items.find(i => 
            i.name?.toLowerCase().includes("вора") || 
            i.name?.toLowerCase().includes("thiev") ||
            i.system?.toolType === "thief"
        );

        const thiefSkillProf = actor.system?.tools?.thief?.value ?? actor.system?.tools?.thievery?.value ?? 0;
        const profBonus = actor.system?.attributes?.prof || 2;
        
        let toolBonus = 0;
        let toolName = lockpickTool?.name || null;

        if (thiefSkillProf > 0) {
            toolBonus = Math.round(profBonus * thiefSkillProf);
            if (!toolName) toolName = "Владение воровскими инструментами";
        } else if (lockpickTool) {
            toolBonus = profBonus;
        }

        return {
            stats: stats,
            toolBonus: toolBonus,
            toolName: toolName
        };
    }

    async performRoll(actor, { statId, dc, bonusFormula, advantage }) {
        let formula = "1d20";
        if (advantage === 1) formula = "2d20kh1";
        if (advantage === -1) formula = "2d20kl1";

        const actorData = this.getActorData(actor);
        const statMod = actorData.stats.find(s => s.id === statId)?.mod || 0;
        
        let finalFormula = `${formula} + ${statMod} + ${actorData.toolBonus}`;
        if (bonusFormula) {
            const trimmed = String(bonusFormula).trim();
            if (trimmed) {
                const cleanBonus = (trimmed.startsWith('+') || trimmed.startsWith('-')) ? trimmed : `+ ${trimmed}`;
                finalFormula += ` ${cleanBonus}`;
            }
        }

        const roll = await new Roll(finalFormula).evaluate();
        return {
            total: roll.total,
            success: roll.total >= dc,
            roll: roll
        };
    }
}
