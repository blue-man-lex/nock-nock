import { SystemAdapter } from './system-adapter.js';

export class CyberpunkRedAdapter extends SystemAdapter {
    constructor() {
        super();
        this.id = "cyberpunk-red-core";
    }

    /**
     * Получение данных актера для CPR
     */
    getActorData(actor) {
        const stats = [
            { id: "pickLock", label: "Механический (TECH)", icon: "fas fa-key" },
            { id: "electronics", label: "Электронный (TECH)", icon: "fas fa-microchip" },
            { id: "basicTech", label: "Технический (TECH)", icon: "fas fa-tools" }
        ];

        if (!actor) return { stats: stats, toolBonus: 0, toolName: null };

        // 1. Извлекаем стат TECH
        const techData = actor.system.stats?.tech;
        // Приоритет: total (итоговый), actual или value (база)
        const techStat = techData?.total ?? techData?.value ?? techData?.actual ?? 0;

        // 2. Поиск навыков
        // В CPR навыки - это айтемы типа 'skill'
        const skills = actor.items.filter(i => i.type === "skill");
        
        const findSkillRobust = (keywords) => {
            return skills.find(i => {
                const iName = i.name.toLowerCase();
                const iId = i.system.internalId || "";
                
                // Сначала проверяем ID (самый надежный способ)
                if (keywords.ids && keywords.ids.some(id => iId === id)) return true;
                
                // Затем проверяем по ключевым словам (для локализаций)
                // Обязательно проверяем, что навык относится к категории Техники
                const isTechSkill = i.system.category === "techniqueSkills" || i.system.stat === "tech";
                if (isTechSkill && keywords.terms && keywords.terms.some(term => iName.includes(term.toLowerCase()))) {
                    return true;
                }
                return false;
            });
        };

        const pickLockSkill = findSkillRobust({ 
            ids: ["pickLock", "pick-lock"], 
            terms: ["pick lock", "взлом", "отмыч"] 
        });
        
        const electronicsSkill = findSkillRobust({ 
            ids: ["electronicsAndSecurityTech", "electronics-security-tech", "electronics"], 
            terms: ["electronics", "электрон", "безопасн"] 
        });
        
        const basicTechSkill = findSkillRobust({ 
            ids: ["basicTech", "basic-tech"], 
            terms: ["basic tech", "техник", "знание тех"] 
        });
        
        const getSkillLevel = (skill) => {
            if (!skill) return 0;
            // Проверяем все возможные поля уровней
            return skill.system.level ?? skill.system.rank ?? skill.system.value ?? 0;
        };

        // Расчет итоговых модификаторов
        stats[0].mod = techStat + getSkillLevel(pickLockSkill);
        stats[1].mod = techStat + getSkillLevel(electronicsSkill);
        stats[2].mod = techStat + getSkillLevel(basicTechSkill);

        return {
            stats: stats,
            toolBonus: 0, 
            toolName: null
        };
    }

    async performRoll(actor, { statId, dc, bonusFormula, advantage }) {
        const actorData = this.getActorData(actor);
        const currentStat = actorData.stats.find(s => s.id === statId);
        const totalMod = currentStat?.mod || 0;

        // В CPR используется 1d10
        let formula = "1d10";
        let finalFormula = `${formula} + ${totalMod}`;
        
        if (bonusFormula) {
            const trimmed = bonusFormula.trim();
            const cleanBonus = trimmed.startsWith('+') || trimmed.startsWith('-') ? trimmed : `+ ${trimmed}`;
            finalFormula += ` ${cleanBonus}`;
        }

        const roll = await new Roll(finalFormula).evaluate();
        
        return {
            total: roll.total,
            success: roll.total >= dc, 
            roll: roll
        };
    }

    getDC(targetDoc) {
        if (targetDoc.system?.DV) return targetDoc.system.DV;
        const flags = targetDoc.getFlag("nock-nock", "nockData");
        return flags?.dc || 15; 
    }
}
