/**
 * Базовый класс для системных адаптеров Nock Nock
 */
export class SystemAdapter {
    constructor() {
        this.id = "generic";
    }

    /** Данные для UI (характеристики/навыки) */
    getActorData(actor) {
        return {
            stats: [],
            toolBonus: 0,
            toolName: null
        };
    }

    /** Логика броска */
    async performRoll(actor, { statId, dc, bonusFormula, advantage }) {
        throw new Error("performRoll must be implemented");
    }

    /** Получение сложности (DC/DV) */
    getDC(targetDoc) {
        // Используем правильный путь к флагу lockData.dc
        return targetDoc.getFlag("nock-nock", "lockData.dc") || 15;
    }
}
