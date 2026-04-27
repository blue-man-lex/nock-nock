import { NOCK_CONST } from "../core/constants.js";
import { nockSocket } from "../core/main.js";
import { SystemManager } from "../systems/system-manager.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class NockLockpickApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(targetDoc, type, options = {}) {
        super(options);
        this.targetDoc = targetDoc;
        this.type = type;
        
        // Получаем адаптер для определения начального стата
        const adapter = SystemManager.get();
        const actorData = adapter.getActorData(game.user.character);
        this.selectedStat = actorData.stats[0]?.id || "dex";
        
        this.bonusValue = ""; 
        this.advantage = 0;
    }

    static DEFAULT_OPTIONS = {
        id: "nock-lockpick-window",
        tag: "div",
        window: { title: "Взлом замка", resizable: false, controls: [] },
        position: { width: 500, height: "auto" },
        classes: ["nock-lockpick-app"],
        actions: {
            setStat: this._onSetStat,
            toggleAdvantage: this._onToggleAdvantage,
            rollDice: this._onRollDice,
            useKey: this._onUseKey
        }
    };

    static PARTS = {
        main: { template: "modules/nock-nock/templates/lockpick.hbs" }
    };

    _onRender(context, options) {
        super._onRender(context, options);
        const bonusInput = this.element.querySelector("#custom-bonus-text");
        if (bonusInput) {
            bonusInput.addEventListener("change", (e) => {
                this.bonusValue = e.target.value;
            });
        }
    }

    async _prepareContext(options) {
        const adapter = SystemManager.get();
        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        const dc = adapter.getDC(this.targetDoc);
        
        const character = game.user.character;
        const actorData = adapter.getActorData(character);
        
        // Проверка доступности выбранного стата (если в модуле есть ограничение по статам)
        const allowedStats = flags.allowedStats || {};
        const hasAllowedConstraints = Object.values(allowedStats).some(v => v === true);
        
        if (hasAllowedConstraints && !allowedStats[this.selectedStat]) {
            const firstAllowed = Object.keys(allowedStats).find(k => allowedStats[k]);
            if (firstAllowed) this.selectedStat = firstAllowed;
        }
        
        let hasKey = false;
        if (flags.key?.uuid && character) {
            hasKey = !!character.items.find(i => i.uuid === flags.key.uuid || i.name === flags.key.name);
        }

        const currentStat = actorData.stats.find(s => s.id === this.selectedStat);
        const statMod = currentStat?.mod || 0;
        const toolBonus = actorData.toolBonus || 0;
        const toolName = actorData.toolName;

        let numericCustomBonus = 0;
        let customFormulaDisplay = "";
        if (this.bonusValue) {
            try {
                if (this.bonusValue.toLowerCase().match(/[dд]/)) {
                    customFormulaDisplay = this.bonusValue.trim();
                } else {
                    numericCustomBonus = Roll.safeEval(this.bonusValue) || 0;
                }
            } catch (err) {
                customFormulaDisplay = this.bonusValue.trim();
            }
        }

        let baseTotal = statMod + toolBonus + numericCustomBonus;
        let displayTotal = customFormulaDisplay ? `${baseTotal > 0 ? baseTotal + ' + ' : ''}${customFormulaDisplay}` : baseTotal;
        
        const maxAttempts = flags.maxAttempts || 0;
        const failedAttempts = flags.failedAttempts || 0;
        let remaining = "∞";
        let isJammed = false;
        
        if (maxAttempts > 0) {
            remaining = Math.max(0, maxAttempts - failedAttempts);
            isJammed = remaining === 0;
        }
        
        return {
            flags: { ...flags, dc: dc },
            allowedStats: actorData.stats.reduce((acc, s) => {
                acc[s.id] = hasAllowedConstraints ? (allowedStats[s.id] || false) : true;
                return acc;
            }, {}),
            statsList: actorData.stats, // Передаем список статов для шаблона
            targetName: this.type === 'door' ? "Дверь" : this.targetDoc.name,
            hasKey: hasKey,
            keyData: flags.key,
            selectedStat: this.selectedStat,
            statMod: statMod,
            toolBonus: toolBonus,
            toolName: toolName,
            bonusValue: this.bonusValue,
            numericCustomBonus: numericCustomBonus,
            customFormulaDisplay: customFormulaDisplay,
            displayTotal: displayTotal,
            advantage: this.advantage,
            remainingAttempts: remaining,
            isJammed: isJammed,
            isCPR: adapter.id === "cyberpunk-red-core" // Флаг для спец-логики в шаблоне если надо
        };
    }

    static _onSetStat(event, target) {
        this.selectedStat = target.dataset.stat;
        this.render(true);
    }

    static _onToggleAdvantage(event, target) {
        this.advantage = parseInt(target.dataset.val);
        this.render(true);
    }

    static async _onUseKey() {
        ui.notifications.info("Вы использовали ключ...");
        await nockSocket.executeAsGM("requestUnlock", { uuid: this.targetDoc.uuid });
        this.close();
    }

    static async _onRollDice(event, target) {
        const adapter = SystemManager.get();
        const flags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
        const dc = adapter.getDC(this.targetDoc);
        
        const maxAttempts = flags.maxAttempts || 0;
        const failedAttempts = flags.failedAttempts || 0;
        
        if (maxAttempts > 0 && failedAttempts >= maxAttempts) {
            ui.notifications.error("Замок заклинило! Больше попыток нет.");
            return;
        }

        const circle = this.element.querySelector(".roll-circle");
        circle.classList.add("nock-shake");
        await new Promise(r => setTimeout(r, 400));
        circle.classList.remove("nock-shake");
        
        const rollResult = await adapter.performRoll(game.user.character, {
            statId: this.selectedStat,
            dc: dc,
            bonusFormula: this.bonusValue,
            advantage: this.advantage
        });

        const success = rollResult.success;
        const roll = rollResult.roll;
        
        let attemptsText = "";
        if (!success && maxAttempts > 0) {
            const newRemaining = Math.max(0, maxAttempts - (failedAttempts + 1));
            if (newRemaining === 0) {
                attemptsText = "<br><span style='color: #e84118; font-weight: bold;'>⚠️ ЗАМОК ЗАКЛИНИЛО!</span>";
            } else {
                attemptsText = `<br><span style='color: #000000ff;'>Осталось попыток: ${newRemaining}</span>`;
            }
        }

        const flavor = `
            <div style="text-align: center; border: 2px solid ${success ? '#4cd137' : '#e84118'}; border-radius: 8px; padding: 10px; background: rgba(0,0,0,0.1); box-shadow: inset 0 0 10px ${success ? 'rgba(76, 209, 55, 0.2)' : 'rgba(232, 65, 24, 0.2)'};">
                <h3 style="margin: 0; color: ${success ? '#4cd137' : '#e84118'}; text-transform: uppercase; letter-spacing: 2px;">
                    ${success ? '<i class="fas fa-unlock"></i> УСПЕХ' : '<i class="fas fa-lock"></i> ПРОВАЛ'}
                </h3>
                <div style="font-size: 0.85em; color: #888; margin-top: 5px;">
                    Цель: ${this.type === 'door' ? 'Дверь' : this.targetDoc.name} (DC/DV ${dc})
                    ${attemptsText}
                </div>
            </div>
        `;
        
        await roll.toMessage({
            speaker: ChatMessage.getSpeaker({actor: game.user.character}),
            flavor: flavor
        });
        
        if (success) {
            ui.notifications.info(`Успех! Результат: ${roll.total}`);
            await nockSocket.executeAsGM("requestUnlock", { uuid: this.targetDoc.uuid });
            this.close();
        } else {
            ui.notifications.error("Неудача...");
            
            const isNowJammed = maxAttempts > 0 && (failedAttempts + 1) >= maxAttempts;
            if (!isNowJammed) {
                const failSound = game.settings.get(NOCK_CONST.MODULE_ID, "failSound");
                if (failSound) {
                    foundry.audio.AudioHelper.play({ src: failSound, volume: 0.6 }, true);
                }
            }

            await nockSocket.executeAsGM("recordFailure", { uuid: this.targetDoc.uuid });
            this.render(true);
            
            const newFlags = this.targetDoc.getFlag(NOCK_CONST.MODULE_ID, NOCK_CONST.FLAGS.DATA) || {};
            if (maxAttempts > 0 && (newFlags.failedAttempts || 0) >= maxAttempts) {
                const jamSound = game.settings.get(NOCK_CONST.MODULE_ID, "jamSound");
                if (jamSound) {
                    foundry.audio.AudioHelper.play({ src: jamSound, volume: 0.8 }, true);
                }
            }
        }
    }
}

