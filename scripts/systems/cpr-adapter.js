import { SystemAdapter } from './system-adapter.js';

export class CyberpunkRedAdapter extends SystemAdapter {
    constructor() {
        super();
        this.id = "cyberpunk-red-core";
    }

    /**
     * Получение данных актера для CPR
     * Возвращает список "типов взлома", привязанных к TECH и соответствующим навыкам
     */
    getActorData(actor) {
        // Определяем типы задач, которые будут отображаться в UI вместо названий статов
        const stats = [
            { id: "pickLock", label: "Механический (TECH)", icon: "fas fa-key" },
            { id: "electronics", label: "Электронный (TECH)", icon: "fas fa-microchip" },
            { id: "basicTech", label: "Технический (TECH)", icon: "fas fa-tools" }
        ];

        if (!actor) {
            return { stats: stats, toolBonus: 0, toolName: null };
        }

        // Ищем навыки по internalId (самый надежный способ, не зависит от языка)
        const skills = actor.items.filter(i => i.type === "skill");
        
        const pickLockSkill = skills.find(i => i.system.internalId === "pick-lock");
        const electronicsSkill = skills.find(i => i.system.internalId === "electronics-security-tech");
        const basicTechSkill = skills.find(i => i.system.internalId === "basic-tech");
        
        // Базовая характеристика TECH (ТЕХ)
        const techStat = actor.system.stats.tech?.value || 0;

        // Расчет итогового модификатора: ТЕХ + Уровень Навыка
        stats[0].mod = techStat + (pickLockSkill?.system.level || 0);
        stats[1].mod = techStat + (electronicsSkill?.system.level || 0);
        stats[2].mod = techStat + (basicTechSkill?.system.level || 0);

        return {
            stats: stats,
            toolBonus: 0, 
            toolName: null
        };
    }

    /**
     * Выполнение броска (1d10 + Mod против DV)
     */
    async performRoll(actor, { statId, dc, bonusFormula, advantage }) {
        const actorData = this.getActorData(actor);
        const totalMod = actorData.stats.find(s => s.id === statId)?.mod || 0;

        // Названия для лога в чате
        const skillNames = {
            pickLock: "Взлом механического замка",
            electronics: "Обход электронной защиты",
            basicTech: "Техническое вскрытие"
        };
        const skillName = skillNames[statId] || "Техника";

        // В CPR используется 1d10 (с учетом взрывных единиц и десяток, но тут упрощенно для модуля)
        let formula = "1d10";
        let finalFormula = `${formula} + ${totalMod}`;
        
        if (bonusFormula) {
            const cleanBonus = bonusFormula.startsWith('+') ? bonusFormula : `+ ${bonusFormula}`;
            finalFormula += ` ${cleanBonus}`;
        }

        const roll = await new Roll(finalFormula).evaluate();
        
        return {
            total: roll.total,
            success: roll.total >= dc, 
            roll: roll
        };
    }

    /**
     * Получение DV (Difficulty Value) замка
     */
    getDC(targetDoc) {
        // В CPR используется DV. Проверяем флаги или системные значения
        if (targetDoc.system?.DV) return targetDoc.system.DV;
        const flags = targetDoc.getFlag("nock-nock", "nockData");
        return flags?.dc || 15; // По умолчанию DV 15 (средне)
    }
}
